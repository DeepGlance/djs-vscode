// Ported from dmd/doc.d (module dmd.doc).
//
// The Ddoc generator: `gendocfile` turns a parsed (and, for a `.d` module, semantically analysed) Module
// into the HTML that `-D` writes, by collecting the doc comments of the module and its members into
// Ddoc macro text, rewriting the Markdown extensions into macros, and expanding the macros (dmacro.ts).
//
// IN_LLVM RESOLUTION (_config.md §1, IN_LLVM ON). doc.d has one `version (IN_LLVM)` arm, dmd/doc.d:69-72
// (`m.checkAndAddOutputFile(m.docfile);`), kept. Its callee is a bodiless `extern(C++)` declaration
// (dmodule.d:1045) whose body, LDC's C++ (gen/modules.cpp:71), dmodule.ts ports.
//
// Other version blocks: `version (all)` in `Escape.escapeChar` (dmd/doc.d:650) keeps its body and drops
// the dead `else` (dmd/doc.d:655-674); `version (none)` in escapeStrayParenthesis (dmd/doc.d:1003-1009) and in
// ToDocBuffer's three aggregate visits (dmd/doc.d:1844/:1857/:1877) is dropped.
//
// DECLARATION INVENTORY (14 §3 item 2). Every top-level declaration of doc.d is translated, in D order:
// gendocfile (:67), escapeDdocString (:178), DocComment (:224), escapetable (:634), Escape (:641),
// Section (:680), ParamSection (:744), MacroSection (:903), Sections (:912), isCVariadicParameter (:915),
// getEponymousMember (:926), getEponymousParent (:942), ddoc_default and the four ddoc_decl_* strings
// (:950-:954), escapeStrayParenthesis (:970), skipNonQualScopes (:1085), emitAnchorName (:1092),
// emitAnchor (:1122), getCodeIndent (:1252), expandTemplateMixinComments (:1266), emitMemberComments
// (:1285), emitVisibility x3 (:1326/:1333/:1342), emitComment (:1348), toDocBuffer (:1632), isDitto
// (:1948), skipwhitespace x2 (:1962/:1968), skipChars (:1993), replaceChar (:2028), toLowercase (:2070),
// getMarkdownIndent (:2112), skippastident (:2126), skipPastIdentWithDots (:2159), skippastURL (:2224),
// removeBlankLineMacro (:2269), replaceMarkdownThematicBreak (:2293), detectAtxHeadingLevel (:2329),
// removeAnyAtxHeadingSuffix (:2353), endMarkdownHeading (:2397), endAllMarkdownQuotes (:2418),
// endAllListsAndQuotes (:2440), replaceMarkdownEmphasis (:2458), isIdentifier (:2537), isKeyword
// (:2579), isTypeFunction (:2592), isFunctionParameter x2 (:2608/:2626), isEponymousFunctionParameter
// (:2641), isTemplateParameter (:2690), isReservedName (:2716), MarkdownDelimiter (:2763), MarkdownList
// (:2783), MarkdownLink (:2999), MarkdownLinkReferences (:3577), TableColumnAlignment (:3841),
// parseTableDelimiterRow (:3862), startTable (:3913), replaceTableRow (:3948), endTable (:4075),
// endRowAndTable (:4096), highlightText (:4114), highlightCode x2 (:4967/:5003), highlightCode3 (:5129),
// highlightCode2 (:5144), isCVariadicArg (:5219), isIdStart (:5228), isIdTail (:5250), isIndentWS (:5271),
// utfStride (:5279), stripLeadingNewlines (:5289). Dropped: the C++-ABI `gendocfile(Module, const char*,
// size_t, ...)` overload (dmd/doc.d:216, 04 §1 rule 5: its only caller is cxxfrontend.d:119).
//
// NAMES (04 §1 Form B). Same-arity overload sets get a suffix on every form but the bare one:
//   - skipwhitespace: the `const(char)*` form keeps the name; the slice form is `skipwhitespaceSlice`;
//   - isFunctionParameter: the `Dsymbols*` form (five callers) keeps the name; the `Dsymbol` form is
//     `isFunctionParameterDsymbol`;
//   - highlightCode: three callers each; the first-declared `Dsymbol` form keeps the name, the `Dsymbols*`
//     form is `highlightCodeFromDsymbols`;
//   - emitVisibility: the `Declaration` form (two callers, first declared of the tied pair) keeps the
//     name; `emitVisibilityFromImport`, `emitVisibilityFromVisibility`.
// D-private declarations (dmd/doc.d:629 `private:`) that doc.test.ts reaches are exported with a
// `// D module-private` note (10 §1.7).
//
// POINTER MODEL (02 §11, 06 §5.5). A D `const(char)*` that the code walks is a cursor: the byte store
// plus an index, `(buf: DString, p: number)`, which is also the `fp_t` shape dmacro.ts fixes for
// `isIdStart`/`isIdTail`. A D comment pointer (`Dsymbol.comment`) arrives as the view that starts at the
// pointer; the walkers read it through `storeOf`, the whole backing store from that byte, because D's
// pointer reads past a slice's end into the bytes that follow it (ParamSection reads the newline after
// its body, dmd/doc.d:866). Reading past the store yields 0 (`at`), the NUL that terminates every C string
// the lexer hands over. `p2 - p1` between two views of one store is `ptrDiff`.
//
// VALUE STRUCTS (03). DocComment and MarkdownLinkReferences are always held by pointer or `ref`: classes.
// MarkdownDelimiter, MarkdownList and MarkdownLink are copied by value (array element reads, `~=`, AA
// store and load): classes with `copy()`, called at each D copy point. Escape is held by pointer.
//
// VISITOR CENSUS (13 §7): doc.d declares two visitor classes, `EmitComment` (dmd/doc.d:1350, nested in
// emitComment) and `ToDocBuffer` (dmd/doc.d:1634, nested in toDocBuffer), each a `Visitor` subclass emitted as
// a class nested in its function (Idiom A), one `visitX` per D `visit(X)` override.
//
// DECLARED DIVERGENCE (11 §2.6), one: highlightCodeFromDsymbols (dmd/doc.d:5068-5087) writes
// `paramLens[parami]` into an `Array!size_t` that was only reserved, so the write lands past `length`
// (release `opIndex` is `data.ptr[i]`, root/array.d:321) and the `foreach` over `paramLens` (dmd/doc.d:5106)
// sees zero elements. The port leaves the slot unwritten and iterates the empty array: what the binary
// observes.
//
// IMPORT EDGES (01 §4.4/§4.8). doc.d imports dmd.hdrgen, a value import used inside function bodies. The
// reverse edge, hdrgen.d's `import dmd.doc;` (for escapeDdocString), is a registration slot owned by hdrgen.ts:
// a value import of this module from hdrgen.ts, even last, breaks loading (hdrgen.ts records the measurement),
// so this module hands `escapeDdocString` over at the end of its body (`registerEscapeDdocString`). The `*sem`
// modules (dsymbolsem, templatesem, typesem) are imported LAST, after every AST-node module; the two Visitor
// subclasses are nested in functions, so at load time this module reads only `Visitor` (a load-order root),
// the theme string and the hoisted registrar.

import { assert, assertUnreachable } from "../assert.js";
import type { DString } from "../dstring.js";
import { cstr, cstrlen, ds, dsConcat, dsEmpty, dsEquals } from "../dstring.js";
import { default_ddoc_theme } from "./res/default_ddoc_theme.js";
import { FileType, STC, TY, VarArg } from "./astenums.js";
import { isAnyContinue, isAnyIdentifierCharacter, isAnyStart } from "./common/charactertables.js";
import { OutBuffer } from "./common/outbuffer.js";
import { Include } from "./cond.js";
import { PASS, SearchOpt, Visibility } from "./dsymbol.js";
import { ErrorSinkNull } from "./errorsink.js";
import type { ErrorSink } from "./errorsink.js";
import { global } from "./globals.js";
import {
    dsymbolToCBuffer, expToCBuffer, functionToBufferFull, HdrGenState, registerEscapeDdocString,
    templateParameterToCBuffer, typeToCBuffer, visibilityToBuffer,
} from "./hdrgen.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Lexer } from "./lexer.js";
import { Loc } from "./location.js";
import { Array as DArray } from "./root/array.js";
import { Port } from "./root/port.js";
import { iequals, toDString } from "./root/string.js";
import { utf_decodeChar } from "./root/utf.js";
import { TOK, Token } from "./tokens.js";
import { Visitor } from "./visitor/index.js";

import type { AggregateDeclaration } from "./aggregate.js";
import type { Dsymbols } from "./arraytypes.js";
import type { AttribDeclaration, ConditionalDeclaration, VisibilityDeclaration } from "./attrib.js";
import type { ClassDeclaration } from "./dclass.js";
import type { AliasDeclaration, Declaration, TypeInfoDeclaration } from "./declaration.js";
import type { EnumDeclaration, EnumMember } from "./denum.js";
import type { Import } from "./dimport.js";
import type { MacroTable } from "./dmacro.js";
import type { Module } from "./dmodule.js";
import type { Scope } from "./dscope.js";
import type { StructDeclaration } from "./dstruct.js";
import type { Dsymbol, ScopeDsymbol } from "./dsymbol.js";
import type { TemplateDeclaration, TemplateMixin, TemplateParameter } from "./dtemplate.js";
import type {
    DtorDeclaration, InvariantDeclaration, PostBlitDeclaration, StaticCtorDeclaration,
    StaticDtorDeclaration, UnitTestDeclaration,
} from "./func.js";
import type { Parameter, Type, TypeFunction } from "./mtype.js";
// last: 01 §4.8 — value imports of the semantic half of the core SCC, read only inside function bodies.
import { dsymbolSemantic, getType, include, isAbstract, scopeCreateGlobal, search, searchScope } from "./dsymbolsem.js";
import { computeOneMember } from "./templatesem.js";
import { toDsymbol } from "./typesem.js";

// ── helpers (no upstream .d source) ────────────────────────────────────────────────────────────

/// `out`/`ref` single-slot box (03 §3.3 / §7).
interface Ref<T> {
    value: T;
}

/// The byte at `i` of a C-string store. Past the end of the store D finds the terminating NUL; the
/// port reads 0 there (06 §5.5).
function at(s: DString, i: number): number {
    const c = s[i];
    return c === undefined ? 0 : c;
}

/// D's pointer `s.ptr` for a slice the D code reads past `s.length`: the rest of `s`'s backing store,
/// starting at `s`'s first byte (index 0 is `*s.ptr`).
function storeOf(s: DString): DString {
    return new Uint8Array(s.buffer, s.byteOffset);
}

/// D's pointer difference `a.ptr - b.ptr` between two views of one backing store.
function ptrDiff(a: DString, b: DString): number {
    assert(a.buffer === b.buffer);
    return a.byteOffset - b.byteOffset;
}

/// `p[0 .. n]` read from a cursor: `n` bytes, 0 past the store (the D slice reads them from memory).
function bytesAt(s: DString, p: number, n: number): DString {
    const r = new Uint8Array(n);
    for (let k = 0; k < n; k++) r[k] = at(s, p + k);
    return r;
}

/// `m` as the Dsymbol it is. Module IS-A Dsymbol; the cast is needed only because Module.errors (uint)
/// is an audited field-shadow of Dsymbol.errors (bool) (dmodule.ts), which breaks structural subtyping
/// (the main.ts `asDsymbol` precedent).
function asDsymbol(m: Module): Dsymbol {
    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    return m as unknown as Dsymbol;
}

/// `m` as the ScopeDsymbol it is (same shadowed pair as `asDsymbol`).
function asScopeDsymbol(m: Module): ScopeDsymbol {
    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    return m as unknown as ScopeDsymbol;
}

// `core.stdc.ctype` in the C locale, on a byte (dmd/doc.d:16). Bytes >= 0x80 are in no class.
function isalpha(c: number): boolean {
    return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
function isdigit(c: number): boolean {
    return c >= 0x30 && c <= 0x39;
}
function isalnum(c: number): boolean {
    return isalpha(c) || isdigit(c);
}
function isupper(c: number): boolean {
    return c >= 0x41 && c <= 0x5a;
}
function isspace(c: number): boolean {
    return c === 0x20 || (c >= 0x09 && c <= 0x0d);
}
function ispunct(c: number): boolean {
    return (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
}

/****************************************************
 * Generate Ddoc text for Module `m` and append it to `outbuf` (dmd/doc.d:67).
 * Params:
 *      m = Module
 *      ddoctext = combined text of .ddoc files for macro definitions
 *      datetime = the 26 bytes returned by ctime() (`global.datetime`)
 *      eSink = send error messages to eSink
 *      outbuf = append the Ddoc text to this
 *
 * Preconditions: `m` is parsed; for a `.d` module, semantic analysis has run (the member walk reads
 * types and runs `dsymbolSemantic` on template mixins). Postconditions: `outbuf` holds the expanded
 * page with CR-LF newlines and the 0xFF macro escapes removed; `m.macrotable` and `m._escapetable` hold
 * the theme, the .ddoc files and the module's own Macros:/ESCAPES sections. Diagnostics: Ddoc warnings
 * through the scope's sink, and an error to `eSink` when macro expansion hits `global.recursionLimit`.
 */
export function gendocfile(m: Module, ddoctext: DString, datetime: DString, eSink: ErrorSink,
    outbuf: OutBuffer): void {
    m.checkAndAddOutputFile(m.docfile);   // version (IN_LLVM), dmd/doc.d:71

    // Load internal default macros first
    DocComment.parseMacros(escapetable(m), m.macrotable, ddoc_default);

    // Ddoc files override default macros
    DocComment.parseMacros(escapetable(m), m.macrotable, ddoctext);

    const sc = scopeCreateGlobal(m, eSink); // create root scope
    const mcomment = m.comment();   // `m.comment`
    const dc = DocComment.parse(asDsymbol(m), mcomment);
    dc.pmacrotable = m.macrotable;
    dc.escapetable = escapetable(m);
    sc.lastdc = dc;
    // Generate predefined macros
    // Set the title to be the name of the module
    {
        const p = toDString(m.toPrettyChars())!;
        m.macrotable.define(ds("TITLE"), p);
    }
    // Set time macros
    m.macrotable.define(ds("DATETIME"), datetime.subarray(0, 26));
    m.macrotable.define(ds("YEAR"), datetime.subarray(20, 20 + 4));

    const srcfilename = m.srcfile.toString();
    m.macrotable.define(ds("SRCFILENAME"), srcfilename);
    const docfilename = m.docfile.toString();
    m.macrotable.define(ds("DOCFILENAME"), docfilename);
    if (dc.copyright !== null) {
        dc.copyright.nooutput = 1;
        m.macrotable.define(ds("COPYRIGHT"), dc.copyright.body_);
    }

    const buf = new OutBuffer();
    if (m.filetype === FileType.ddoc) {
        const loc = m.md !== null ? m.md.loc : m.loc;

        let commentlen = mcomment !== null ? cstrlen(storeOf(mcomment)) : 0;
        const a: Dsymbols = new DArray<Dsymbol | null>();
        // https://issues.dlang.org/show_bug.cgi?id=9764
        // Don't push m in a, to prevent emphasize ddoc file name.
        if (dc.macros !== null) {
            // a Macros: section exists only when DocComment.parse saw a non-null comment (dmd/doc.d:239)
            commentlen = ptrDiff(dc.macros.name, mcomment!);
            dc.macros.write(loc, dc, sc, a, buf);
        }
        // `m.comment[0 .. commentlen]`: a null comment slices to the empty slice
        buf.write(mcomment !== null ? storeOf(mcomment).subarray(0, commentlen) : dsEmpty);
        highlightText(sc, a, loc, buf, 0);
    } else {
        const a: Dsymbols = new DArray<Dsymbol | null>();
        a.push(asDsymbol(m));
        dc.writeSections(sc, a, buf);
        emitMemberComments(asScopeDsymbol(m), buf, sc);
    }
    //printf("BODY= '%.*s'\n", cast(int)buf.length, buf.data);
    m.macrotable.define(ds("BODY"), buf.opSliceAll());

    const buf2 = new OutBuffer();
    buf2.writestring(ds("$(DDOC)"));
    const end: Ref<number> = { value: buf2.length() };

    // Expand buf in place with macro expansions
    const success = m.macrotable.expand(buf2, 0, end, null, global.recursionLimit, isIdStart, isIdTail);
    if (!success)
        eSink.error(Loc.initial, ds("DDoc macro expansion limit exceeded; more than %d expansions."),
            global.recursionLimit);

    /* Remove all the escape sequences from buf,
     * and make CR-LF the newline.
     */
    const slice = buf2.opSliceAll();
    outbuf.reserve(slice.length);
    const p = slice;
    for (let j = 0; j < slice.length; j++) {
        const c = p[j];
        if (c === 0xff && j + 1 < slice.length) {
            j++;
            continue;
        }
        if (c === 0x0a /* '\n' */)
            outbuf.writeByte(0x0d /* '\r' */);
        else if (c === 0x0d /* '\r' */) {
            outbuf.writestring(ds("\r\n"));
            if (j + 1 < slice.length && p[j + 1] === 0x0a) {
                j++;
            }
            continue;
        }
        outbuf.writeByte(c);
    }
}

/****************************************************
 * Having unmatched parentheses can hose the output of Ddoc,
 * as the macros depend on properly nested parentheses.
 * This function replaces all ( with $(LPAREN) and ) with $(RPAREN)
 * to preserve text literally. This also means macros in the
 * text won't be expanded. (dmd/doc.d:178)
 *
 * Rewrites `buf[start .. $]` in place; `$` becomes `$(DOLLAR)` too. Called by hdrgen.ts under
 * `hgs.ddoc` and by highlightCode2.
 */
export function escapeDdocString(buf: OutBuffer, start: number): void {
    for (let u = start; u < buf.length(); u++) {
        const c = buf.opIndex(u);
        switch (c) {
            case 0x24 /* '$' */:
                buf.remove(u, 1);
                buf.insert(u, ds("$(DOLLAR)"));
                u += 8;
                break;
            case 0x28 /* '(' */:
                buf.remove(u, 1); //remove the (
                buf.insert(u, ds("$(LPAREN)")); //insert this instead
                u += 8; //skip over newly inserted macro
                break;
            case 0x29 /* ')' */:
                buf.remove(u, 1); //remove the )
                buf.insert(u, ds("$(RPAREN)")); //insert this instead
                u += 8; //skip over newly inserted macro
                break;
            default:
                break;
        }
    }
}

// dropped: `void gendocfile(Module m, const char* ddoctext_ptr, size_t ddoctext_length, ...)` (dmd/doc.d:216) —
// the C++-ABI overload; its only caller is cxxfrontend.d:119 (04 §1 rule 5). It slices
// `ddoctext_ptr[0 .. ddoctext_length]` and forwards, with no NUL truncation.

/***********************************************************
 * The parsed doc comment of one declaration (dmd/doc.d:224): its sections, plus the summary, Copyright: and
 * Macros: sections picked out of them, and the declarations it documents (`a`, more than one when
 * `ditto` comments follow). Always held by pointer in D, so a reference class here.
 */
export class DocComment {
    sections: Sections = new DArray<Section | null>();  // Section*[]
    summary: Section | null = null;
    copyright: Section | null = null;
    macros: Section | null = null;
    pmacrotable: MacroTable | null = null;
    escapetable: Escape | null = null;
    a: Dsymbols = new DArray<Dsymbol | null>();

    /**
     * Parse `comment` into sections for the declaration `s` (dmd/doc.d:234). A null comment gives a
     * DocComment with no sections. `comment` is the C string the lexer collected, read up to its NUL.
     */
    static parse(s: Dsymbol, comment: DString | null): DocComment {
        //printf("parse(%s): '%s'\n", s.toChars(), comment);
        const dc = new DocComment();
        dc.a.push(s);
        if (comment === null)
            return dc;
        dc.parseSections(comment);
        for (let i = 0; i < dc.sections.length; i++) {
            const sec = dc.sections.opIndex(i)!;
            if (iequals(ds("copyright"), sec.name)) {
                dc.copyright = sec;
            }
            if (iequals(ds("macros"), sec.name)) {
                dc.macros = sec;
            }
        }
        return dc;
    }

    /************************************************
     * Parse macros out of Macros: section (dmd/doc.d:264).
     * Macros are of the form:
     *      name1 = value1
     *
     *      name2 = value2
     *
     * An `ESCAPES` macro fills `escapetable` instead (parseEscapes). The macro names and texts stored in
     * `pmacrotable` are views into `m`, not copies, as in D.
     */
    static parseMacros(escapetable: Escape | null, pmacrotable: MacroTable, m: DString): void {
        const s = storeOf(m);
        let p = 0;
        const len = m.length;
        const pend = p + len;
        let tempstart = 0;   // D: null; always written (`tempstart = p`) before it is read
        let templen = 0;
        let namestart = 0;   // D: null; read only while namelen != 0
        let namelen = 0; // !=0 if line continuation
        let textstart = 0;   // D: null; read only while namelen != 0
        let textlen = 0;

        // L1 (dmd/doc.d:332), the output of the pending macro: SHARED tail, reached by fall-through inside
        // the loop and by the backward jump at Ldone (dmd/doc.d:362).
        const L1Tail = (): void => {
            //printf("macro '%.*s' = '%.*s'\n", cast(int)namelen, namestart, cast(int)textlen, textstart);
            if (iequals(ds("ESCAPES"), s.subarray(namestart, namestart + namelen)))
                DocComment.parseEscapes(escapetable, s.subarray(textstart, textstart + textlen));
            else
                pmacrotable.define(s.subarray(namestart, namestart + namelen),
                    s.subarray(textstart, textstart + textlen));
            namelen = 0;
        };

        Lwhile: while (p < pend) {
            let gotoLskipline = false;   // SKIP-FLAG for the jumps to Lskipline (dmd/doc.d:298/:324)
            // BLOCK-EXIT: `break Lbody` jumps to Ltext (dmd/doc.d:297/:323), or to Lskipline with the flag set
            Lbody: {
                // Skip to start of macro
                for (;;) {
                    if (p >= pend)
                        break Lwhile; // goto Ldone (dmd/doc.d:282)
                    switch (at(s, p)) {
                        case 0x20 /* ' ' */:
                        case 0x09 /* '\t' */:
                            p++;
                            continue;
                        case 0x0d /* '\r' */:
                        case 0x0a /* '\n' */:
                            p++;
                            continue Lwhile; // goto Lcont (dmd/doc.d:292)
                        default:
                            if (isIdStart(s, p))
                                break;
                            if (namelen)
                                break Lbody; // goto Ltext (dmd/doc.d:297) — continuation of prev macro
                            gotoLskipline = true;
                            break Lbody; // goto Lskipline (dmd/doc.d:298)
                    }
                    break;
                }
                tempstart = p;
                for (;;) {
                    if (p >= pend)
                        break Lwhile; // goto Ldone (dmd/doc.d:306)
                    if (!isIdTail(s, p))
                        break;
                    p += utfStride(s, p);
                }
                templen = p - tempstart;
                for (;;) {
                    if (p >= pend)
                        break Lwhile; // goto Ldone (dmd/doc.d:315)
                    if (!(at(s, p) === 0x20 || at(s, p) === 0x09))
                        break;
                    p++;
                }
                if (at(s, p) !== 0x3d /* '=' */) {
                    if (namelen)
                        break Lbody; // goto Ltext (dmd/doc.d:323) — continuation of prev macro
                    gotoLskipline = true;
                    break Lbody; // goto Lskipline (dmd/doc.d:324)
                }
                p++;
                if (p >= pend)
                    break Lwhile; // goto Ldone (dmd/doc.d:328)
                if (namelen) {
                    // Output existing macro
                    L1Tail();
                    if (p >= pend)
                        break Lwhile;
                }
                namestart = tempstart;
                namelen = templen;
                while (p < pend && (at(s, p) === 0x20 || at(s, p) === 0x09))
                    p++;
                textstart = p;
            }
            if (!gotoLskipline) {
                // Ltext:
                while (p < pend && at(s, p) !== 0x0d && at(s, p) !== 0x0a)
                    p++;
                textlen = p - textstart;
                p++;
                //printf("p = %p, pend = %p\n", p, pend);
                // Lcont:
                continue;
            }
            // Lskipline:
            // Ignore this line
            while (p < pend && at(s, p) !== 0x0d && at(s, p) !== 0x0a)
                p++;
        }
        // Ldone:
        if (namelen) {
            // Ldone is reached only with p >= pend, so the `if (p >= pend) break;` that follows L1
            // (dmd/doc.d:339) leaves the loop again.
            assert(p >= pend);
            L1Tail(); // goto L1 (dmd/doc.d:362) — write out last one
        }
    }

    /**************************************
     * Parse escapes of the form:
     *      /c/string/
     * where c is a single character.
     * Multiple escapes can be separated
     * by whitespace and/or commas. (dmd/doc.d:372)
     *
     * A null `escapetable` gets a fresh table that is dropped on return, as in D (the pointer
     * parameter is reassigned locally).
     */
    static parseEscapes(escapetable: Escape | null, text: DString): void {
        if (escapetable === null) {
            escapetable = new Escape();
            // memset(escapetable, 0, Escape.sizeof) (dmd/doc.d:377): a fresh Escape is all-null already
        }
        //printf("parseEscapes('%.*s') pescapetable = %p\n", cast(int)text.length, text.ptr, escapetable);
        const s = storeOf(text);
        let p = 0;
        const pend = p + text.length;
        for (;;) {
            for (;;) {
                if (p + 4 >= pend)
                    return;
                const b = at(s, p);
                if (!(b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a || b === 0x2c /* ',' */))
                    break;
                p++;
            }
            if (at(s, p) !== 0x2f /* '/' */ || at(s, p + 2) !== 0x2f)
                return;
            const c = at(s, p + 1);
            p += 3;
            const start = p;
            for (;;) {
                if (p >= pend)
                    return;
                if (at(s, p) === 0x2f)
                    break;
                p++;
            }
            const len = p - start;
            // memcpy into a fresh `xmalloc(len + 1)` block, NUL-terminated: an independent copy
            const str = s.slice(start, start + len);
            assert(c < 255);   // `strings[c]` on the `char.max`-slot static array (see Escape)
            escapetable.strings[c] = str;
            //printf("\t%c = '%s'\n", c, s);
            p++;
        }
    }

    /*****************************************
     * Parse next paragraph out of *pcomment.
     * Update *pcomment to point past paragraph.
     * Returns NULL if no more paragraphs.
     * If paragraph ends in 'identifier:',
     * then (*pcomment)[0 .. idlen] is the identifier. (dmd/doc.d:421)
     *
     * Appends one Section per paragraph/tagged section to `sections`; the section names and bodies are
     * views into `comment`'s store.
     */
    parseSections(comment: DString): void {
        const s = storeOf(comment);
        let p: number;
        let idstart = 0; // dead-store to prevent spurious warning
        let idlen: number;
        let name: number | null = null;
        let namelen = 0;
        //printf("parseSections('%s')\n", comment);
        p = 0;
        while (at(s, p)) {
            const pstart0 = p;
            p = skipwhitespace(s, p);
            let pstart = p;
            let pend = p;

            // Undo indent if starting with a list item
            if ((at(s, p) === 0x2d || at(s, p) === 0x2b || at(s, p) === 0x2a) &&
                (at(s, p + 1) === 0x20 || at(s, p + 1) === 0x09))
                pstart = pstart0;
            else {
                let pitem = p;
                while (at(s, pitem) >= 0x30 && at(s, pitem) <= 0x39)
                    ++pitem;
                if (pitem > p && at(s, pitem) === 0x2e && (at(s, pitem + 1) === 0x20 || at(s, pitem + 1) === 0x09))
                    pstart = pstart0;
            }

            /* Find end of section, which is ended by one of:
             *      'identifier:' (but not inside a code section)
             *      '\0'
             */
            idlen = 0;
            let inCode = 0;
            // BLOCK-EXIT: the jumps to L1 (dmd/doc.d:506/:514) leave this loop to the label that follows it: `break L1`
            L1: for (;;) {
                // Check for start/end of a code section
                if (at(s, p) === 0x2d || at(s, p) === 0x60 || at(s, p) === 0x7e) {
                    const c = at(s, p);
                    let numdash = 0;
                    while (at(s, p) === c) {
                        ++numdash;
                        p++;
                    }
                    // BUG: handle UTF PS and LS too
                    if ((!at(s, p) || at(s, p) === 0x0d || at(s, p) === 0x0a || (!inCode && c !== 0x2d)) &&
                        numdash >= 3) {
                        inCode = inCode === c ? 0 : c;   // `inCode == c ? false : c`
                        if (inCode) {
                            // restore leading indentation
                            while (pstart0 < pstart && isIndentWS(s, pstart - 1))
                                --pstart;
                        }
                    }
                    pend = p;
                }
                if (!inCode && isIdStart(s, p)) {
                    let q = p + utfStride(s, p);
                    while (isIdTail(s, q))
                        q += utfStride(s, q);

                    // Detected tag ends it
                    if (at(s, q) === 0x3a /* ':' */ && isupper(at(s, p)) &&
                        (isspace(at(s, q + 1)) || at(s, q + 1) === 0)) {
                        idlen = q - p;
                        idstart = p;
                        for (pend = p; pend > pstart; pend--) {
                            if (at(s, pend - 1) === 0x0a)
                                break;
                        }
                        p = q + 1;
                        break;
                    }
                }
                for (;;) {
                    if (!at(s, p))
                        break L1; // goto L1 (dmd/doc.d:506)
                    if (at(s, p) === 0x0a) {
                        p++;
                        if (at(s, p) === 0x0a && !this.summary && !namelen && !inCode) {
                            pend = p;
                            p++;
                            break L1; // goto L1 (dmd/doc.d:514)
                        }
                        break;
                    }
                    p++;
                    pend = p;
                }
                p = skipwhitespace(s, p);
            }
            // L1:
            if (namelen || pstart < pend) {
                // `name[0 .. namelen]`: a null `name` slices to the empty slice
                const nameSlice = name !== null ? s.subarray(name, name + namelen) : dsEmpty;
                let sec: Section;
                if (iequals(ds("Params"), nameSlice))
                    sec = new ParamSection();
                else if (iequals(ds("Macros"), nameSlice))
                    sec = new MacroSection();
                else
                    sec = new Section();
                sec.name = nameSlice;
                sec.body_ = s.subarray(pstart, pend);
                sec.nooutput = 0;
                //printf("Section: '%.*s' = '%.*s'\n", cast(int)s.namelen, s.name, cast(int)s.bodylen, s.body);
                this.sections.push(sec);
                if (!this.summary && !namelen)
                    this.summary = sec;
            }
            if (idlen) {
                name = idstart;
                namelen = idlen;
            } else {
                name = null;
                namelen = 0;
                if (!at(s, p))
                    break;
            }
        }
    }

    /**
     * Write the sections and the documented unittests of the symbols `a` as `$(DDOC_SECTIONS ...)`
     * (dmd/doc.d:556); writes a lone newline instead when there is nothing to write.
     * Precondition: `a.length > 0` (asserted).
     */
    writeSections(sc: Scope, a: Dsymbols, buf: OutBuffer): void {
        assert(a.length);
        //printf("DocComment::writeSections()\n");
        let loc = a.opIndex(0)!.loc;
        const m = a.opIndex(0)!.isModule();
        if (m !== null) {
            if (m.md !== null)
                loc = m.md.loc;
        }
        const offset1 = buf.length();
        buf.writestring(ds("$(DDOC_SECTIONS "));
        const offset2 = buf.length();
        for (let i = 0; i < this.sections.length; i++) {
            const sec = this.sections.opIndex(i)!;
            if (sec.nooutput)
                continue;
            //printf("Section: '%.*s' = '%.*s'\n", cast(int)sec.namelen, sec.name, cast(int)sec.bodylen, sec.body);
            if (!sec.name.length && i === 0) {
                buf.writestring(ds("$(DDOC_SUMMARY "));
                const o = buf.length();
                buf.write(sec.body_);
                escapeStrayParenthesis(loc, buf, o, true, sc.eSink!);
                highlightText(sc, a, loc, buf, o);
                buf.writestring(ds(")"));
            } else
                sec.write(loc, this, sc, a, buf);
        }
        for (let i = 0; i < a.length; i++) {
            let s = a.opIndex(i)!;
            const td = getEponymousParent(s);
            if (td !== null)
                s = td;
            for (let utd = s.ddocUnittest(); utd !== null; utd = utd.ddocUnittest()) {
                const utdcomment = utd.comment();   // `utd.comment`
                if (utd.visibility.kind === Visibility.Kind.private_ || utdcomment === null || utd.fbody === null)
                    continue;
                // Strip whitespaces to avoid showing empty summary
                const cs = storeOf(utdcomment);
                let c = 0;
                while (at(cs, c) === 0x20 || at(cs, c) === 0x09 || at(cs, c) === 0x0a || at(cs, c) === 0x0d)
                    ++c;
                buf.writestring(ds("$(DDOC_EXAMPLES "));
                const o = buf.length();
                buf.writestring(cstr(cs.subarray(c)));   // writestring(cast(char*)c): the bytes up to the NUL
                if (utd.codedoc !== null) {
                    const cd = storeOf(utd.codedoc);
                    const codedoc = stripLeadingNewlines(cd, 0);
                    let n = getCodeIndent(cd, codedoc);
                    while (n-- > 0)
                        buf.writeByte(0x20);
                    buf.writestring(ds("----\n"));
                    buf.writestring(cstr(cd.subarray(codedoc)));
                    buf.writestring(ds("----\n"));
                    highlightText(sc, a, loc, buf, o);
                }
                buf.writestring(ds(")"));
            }
        }
        if (buf.length() === offset2) {
            /* Didn't write out any sections, so back out last write
             */
            buf.setsize(offset1);
            buf.writestring(ds("\n"));
        } else
            buf.writestring(ds(")"));
    }
}

// private: (dmd/doc.d:629) — the declarations below are module-private in D.

/** Lazily initializes and returns the escape table.
Turns out it eats a lot of memory. (dmd/doc.d:634)
*/
function escapetable(_this: Module): Escape {
    if (_this._escapetable === null)
        _this._escapetable = new Escape();
    return _this._escapetable;
}

/**
 * The ESCAPES table (dmd/doc.d:641): the replacement text for each character, null when the character is
 * not escaped. D declares `const(char)[][char.max] strings`, 255 slots, so `0xFF` has none.
 */
export class Escape { // D module-private; exported for dmodule.ts's `import type` of `_escapetable`
    strings: (DString | null)[] = Array.from({ length: 255 }, (): DString | null => null);

    /***************************************
     * Find character string to replace c with. (dmd/doc.d:648)
     */
    escapeChar(c: number): DString | null {
        // version (all) — the table lookup; the dead `else` arm (dmd/doc.d:655-674) is dropped.
        //printf("escapeChar('%c') => %p, %p\n", c, strings, strings[c].ptr);
        assert(c < 255);   // `strings[c]` on the `char.max`-slot static array: D's bounds check
        return this.strings[c];
    }
}

/// The standard section names Section.write maps to their own `DDOC_<NAME>` macro (dmd/doc.d:696 `static
/// immutable table`).
const sectionTable: readonly DString[] = Object.freeze([
    ds("AUTHORS"),
    ds("BUGS"),
    ds("COPYRIGHT"),
    ds("DATE"),
    ds("DEPRECATED"),
    ds("EXAMPLES"),
    ds("HISTORY"),
    ds("LICENSE"),
    ds("RETURNS"),
    ds("SEE_ALSO"),
    ds("STANDARDS"),
    ds("THROWS"),
    ds("VERSION"),
]);

/***********************************************************
 * One section of a doc comment (dmd/doc.d:680): `name` is empty for the summary and description paragraphs,
 * `body_` is a view into the comment's store, and `nooutput` suppresses it (the Copyright: section).
 */
class Section {
    name: DString = dsEmpty;
    body_: DString = dsEmpty;
    nooutput = 0;

    /// `override string toString() const { assert(0); }` (dmd/doc.d:686).
    toString(): string {
        assertUnreachable();
    }

    /**
     * Write this section as Ddoc macro text (dmd/doc.d:691): a standard section as `$(DDOC_<NAME> body)`,
     * any other named one as `$(DDOC_SECTION $(DDOC_SECTION_H name) body)`, an unnamed one as
     * `$(DDOC_DESCRIPTION body)`; the body has its stray parentheses escaped and its text highlighted.
     * Precondition: `a.length > 0` (asserted).
     */
    write(loc: Loc, _dc: DocComment, sc: Scope, a: Dsymbols, buf: OutBuffer): void {
        assert(a.length);
        // BLOCK-EXIT: `break L1` is the jump to L1 (dmd/doc.d:717)
        L1: {
            if (this.name.length) {
                for (const entry of sectionTable) {
                    if (iequals(entry, this.name)) {
                        buf.printf(ds("$(DDOC_%s "), entry);
                        break L1; // goto L1 (dmd/doc.d:717)
                    }
                }
                buf.writestring(ds("$(DDOC_SECTION "));
                // Replace _ characters with spaces
                buf.writestring(ds("$(DDOC_SECTION_H "));
                const o = buf.length();
                for (const c of this.name)
                    buf.writeByte((c === 0x5f /* '_' */) ? 0x20 : c);
                escapeStrayParenthesis(loc, buf, o, false, sc.eSink!);
                buf.writestring(ds(")"));
            } else {
                buf.writestring(ds("$(DDOC_DESCRIPTION "));
            }
        }
        // L1:
        const o = buf.length();
        buf.write(this.body_);
        escapeStrayParenthesis(loc, buf, o, true, sc.eSink!);
        highlightText(sc, a, loc, buf, o);
        buf.writestring(ds(")"));
    }
}

/***********************************************************
 * A Params: section (dmd/doc.d:744): written as a `$(DDOC_PARAMS ...)` table of `name = description` rows.
 */
class ParamSection extends Section {
    /**
     * Write the parameter rows (dmd/doc.d:746). A row whose name matches no function parameter (nor a
     * template parameter) draws the warning "Ddoc: function declaration has no parameter"; for a lone
     * function, a row count different from the parameter count draws "Ddoc: parameter count mismatch".
     * The body is walked as a C string: the newline that ends its last line lies past `body_.length`.
     */
    override write(loc: Loc, _dc: DocComment, sc: Scope, a: Dsymbols, buf: OutBuffer): void {
        assert(a.length);
        const s = a.opIndex(0)!; // test
        const b = storeOf(this.body_);
        let p = 0;
        const len = this.body_.length;
        const pend = p + len;
        let tempstart = 0;   // D: null; always written (`tempstart = p`) before it is read
        let templen = 0;
        let namestart = 0;   // D: null; read only while namelen != 0
        let namelen = 0; // !=0 if line continuation
        let textstart = 0;   // D: null; read only while namelen != 0
        let textlen = 0;
        let paramcount = 0;
        buf.writestring(ds("$(DDOC_PARAMS "));

        // `p[0 .. cast(size_t)(pend - p)]`: past `pend` the size_t length wraps, and the slice then
        // reaches to the end of the store.
        const restToPend = (): DString => b.subarray(p, p <= pend ? pend : b.length);

        // L1 (dmd/doc.d:804), the output of the pending parameter row: SHARED tail, reached by fall-through
        // inside the loop and by the backward jump after it (dmd/doc.d:879).
        const L1Tail = (): void => {
            //printf("param '%.*s' = '%.*s'\n", cast(int)namelen, namestart, cast(int)textlen, textstart);
            ++paramcount;
            const hgs = new HdrGenState();
            buf.writestring(ds("$(DDOC_PARAM_ROW "));
            {
                buf.writestring(ds("$(DDOC_PARAM_ID "));
                {
                    const o = buf.length();
                    const name = b.subarray(namestart, namestart + namelen);
                    let fparam = isFunctionParameter(a, name);
                    if (fparam === null) {
                        // Comments on a template might refer to function parameters within.
                        // Search the parameters of nested eponymous functions (with the same name.)
                        fparam = isEponymousFunctionParameter(a, name);
                    }
                    const isCVariadic = isCVariadicParameter(a, name);
                    if (isCVariadic) {
                        buf.writestring(ds("..."));
                    } else if (fparam !== null && fparam.type !== null && fparam.ident !== null) {
                        typeToCBuffer(fparam.type, buf, fparam.ident, hgs);
                    } else {
                        if (isTemplateParameter(a, b.subarray(namestart), namelen) !== null) {
                            // 10236: Don't count template parameters for params check
                            --paramcount;
                        } else if (fparam === null) {
                            sc.eSink!.warning(s.loc, ds("Ddoc: function declaration has no parameter '%.*s'"),
                                namelen, b.subarray(namestart));
                        }
                        buf.write(name);
                    }
                    escapeStrayParenthesis(loc, buf, o, true, sc.eSink!);
                    highlightCodeFromDsymbols(sc, a, buf, o);
                }
                buf.writestring(ds(")"));
                buf.writestring(ds("$(DDOC_PARAM_DESC "));
                {
                    const o = buf.length();
                    buf.write(b.subarray(textstart, textstart + textlen));
                    escapeStrayParenthesis(loc, buf, o, true, sc.eSink!);
                    highlightText(sc, a, loc, buf, o);
                }
                buf.writestring(ds(")"));
            }
            buf.writestring(ds(")"));
            namelen = 0;
        };

        Lwhile: while (p < pend) {
            let gotoLskipline = false;   // SKIP-FLAG for the jumps to Lskipline (dmd/doc.d:781/:798)
            // BLOCK-EXIT: `break Lbody` jumps to Ltext (dmd/doc.d:779/:796), or to Lskipline with the flag set
            Lbody: {
                // Skip to start of macro
                for (;;) {
                    switch (at(b, p)) {
                        case 0x20 /* ' ' */:
                        case 0x09 /* '\t' */:
                            p++;
                            continue;
                        case 0x0a /* '\n' */:
                            p++;
                            continue Lwhile; // goto Lcont (dmd/doc.d:774)
                        default:
                            if (isIdStart(b, p) || isCVariadicArg(restToPend()))
                                break;
                            if (namelen)
                                break Lbody; // goto Ltext (dmd/doc.d:779)
                            // continuation of prev macro
                            gotoLskipline = true;
                            break Lbody; // goto Lskipline (dmd/doc.d:781)
                    }
                    break;
                }
                tempstart = p;
                while (isIdTail(b, p))
                    p += utfStride(b, p);
                if (isCVariadicArg(restToPend()))
                    p += 3;
                templen = p - tempstart;
                while (at(b, p) === 0x20 || at(b, p) === 0x09)
                    p++;
                if (at(b, p) !== 0x3d /* '=' */) {
                    if (namelen)
                        break Lbody; // goto Ltext (dmd/doc.d:796)
                    // continuation of prev macro
                    gotoLskipline = true;
                    break Lbody; // goto Lskipline (dmd/doc.d:798)
                }
                p++;
                if (namelen) {
                    // Output existing param
                    L1Tail();
                    if (p >= pend)
                        break Lwhile;
                }
                namestart = tempstart;
                namelen = templen;
                while (at(b, p) === 0x20 || at(b, p) === 0x09)
                    p++;
                textstart = p;
            }
            if (!gotoLskipline) {
                // Ltext:
                while (at(b, p) !== 0x0a) {
                    // D reads on through memory until a newline; past the store the port fails loudly
                    assert(p < b.length);
                    p++;
                }
                textlen = p - textstart;
                p++;
                // Lcont:
                continue;
            }
            // Lskipline:
            // Ignore this line
            while (at(b, p++) !== 0x0a) {
                assert(p <= b.length);   // as at Ltext: no newline left in the store
            }
        }
        if (namelen) {
            // The loop ends only with p >= pend, so the `if (p >= pend) break;` that follows L1 (dmd/doc.d:857)
            // leaves the loop again.
            assert(p >= pend);
            L1Tail(); // goto L1 (dmd/doc.d:879) — write out last one
        }
        buf.writestring(ds(")"));
        const tf = a.length === 1 ? isTypeFunction(s) : null;
        if (tf !== null) {
            const pcount = (tf.parameterList.parameters !== null ? tf.parameterList.parameters.length : 0) +
                (tf.parameterList.varargs === VarArg.variadic ? 1 : 0);
            if (pcount !== paramcount) {
                sc.eSink!.warning(s.loc, ds("Ddoc: parameter count mismatch, expected %llu, got %llu"),
                    BigInt(pcount), BigInt(paramcount));
                if (paramcount === 0) {
                    // Chances are someone messed up the format
                    sc.eSink!.warningSupplemental(s.loc, ds("Note that the format is `param = description`"));
                }
            }
        }
    }
}

/***********************************************************
 * A Macros: section (dmd/doc.d:903): writes nothing; its definitions go into the macro table.
 */
class MacroSection extends Section {
    /** Parse the body as macro definitions into `dc`'s macro table (dmd/doc.d:905). */
    override write(_loc: Loc, dc: DocComment, _sc: Scope, _a: Dsymbols, _buf: OutBuffer): void {
        //printf("MacroSection::write()\n");
        DocComment.parseMacros(dc.escapetable, dc.pmacrotable!, this.body_);
    }
}

/// `alias Sections = Array!(Section);` (dmd/doc.d:912)
type Sections = DArray<Section | null>;

/// Workaround for missing Parameter instance for variadic params. (it's unnecessary to instantiate one).
/// (dmd/doc.d:915) True when `p` is `...` and one of `a` is a C-variadic function.
function isCVariadicParameter(a: Dsymbols, p: DString): boolean {
    for (const member of a) {
        const tf = isTypeFunction(member!);
        if (tf !== null && tf.parameterList.varargs === VarArg.variadic && dsEquals(p, ds("...")))
            return true;
    }
    return false;
}

/// The member a template documents as itself (dmd/doc.d:926): its aggregate or function one-member, or a
/// variable one-member when there is no constraint; null otherwise (an enum member, for compilable/ddoc9.d).
function getEponymousMember(td: TemplateDeclaration): Dsymbol | null {
    computeOneMember(td);
    if (td.onemember === null)
        return null;
    const ad = td.onemember.isAggregateDeclaration();
    if (ad !== null)
        return ad;
    const fd = td.onemember.isFuncDeclaration();
    if (fd !== null)
        return fd;
    const em = td.onemember.isEnumMember();
    if (em !== null)
        return null;    // Keep backward compatibility. See compilable/ddoc9.d
    const vd = td.onemember.isVarDeclaration();
    if (vd !== null)
        return td.constraint !== null ? null : vd;
    return null;
}

/// The template `s` is the eponymous member of, or null (dmd/doc.d:942).
function getEponymousParent(s: Dsymbol): TemplateDeclaration | null {
    if (s.parent === null)
        return null;
    const td = s.parent.isTemplateDeclaration();
    return (td !== null && getEponymousMember(td) !== null) ? td : null;
}

/// `immutable ddoc_default = import("default_ddoc_theme." ~ ddoc_ext);` (dmd/doc.d:950)
const ddoc_default: DString = ds(default_ddoc_theme);
const ddoc_decl_s: DString = ds("$(DDOC_DECL ");
const ddoc_decl_e: DString = ds(")\n");
const ddoc_decl_dd_s: DString = ds("$(DDOC_DECL_DD ");
const ddoc_decl_dd_e: DString = ds(")\n");

/****************************************************
 * Having unmatched parentheses can hose the output of Ddoc,
 * as the macros depend on properly nested parentheses.
 *
 * Fix by replacing unmatched ( with $(LPAREN) and unmatched ) with $(RPAREN). (dmd/doc.d:970)
 *
 * Params:
 *  loc   = source location of start of text. It is a mutable copy to allow incrementing its linenum,
 *          for printing the correct line number when an error is encountered in a multiline block of ddoc.
 *  buf   = an OutBuffer containing the DDoc
 *  start = the index within buf to start replacing unmatched parentheses
 *  respectBackslashEscapes = if true, always replace parentheses that are
 *    directly preceeded by a backslash with $(LPAREN) or $(RPAREN) instead of
 *    counting them as stray parentheses
 *  eSink = where the "Ddoc: Stray" warnings go
 */
function escapeStrayParenthesis(loc: Loc, buf: OutBuffer, start: number, respectBackslashEscapes: boolean,
    eSink: ErrorSink): void {
    let par_open = 0;
    let inCode = 0;
    let atLineStart = true;
    for (let u = start; u < buf.length(); u++) {
        const c = buf.opIndex(u);
        switch (c) {
            case 0x28 /* '(' */:
                if (!inCode)
                    par_open++;
                atLineStart = false;
                break;
            case 0x29 /* ')' */:
                if (!inCode) {
                    if (par_open === 0) {
                        //stray ')'
                        eSink.warning(loc, ds("Ddoc: Stray ')'. This may cause incorrect Ddoc output. " +
                            "Use $(RPAREN) instead for unpaired right parentheses."));
                        buf.remove(u, 1); //remove the )
                        buf.insert(u, ds("$(RPAREN)")); //insert this instead
                        u += 8; //skip over newly inserted macro
                    } else
                        par_open--;
                }
                atLineStart = false;
                break;
            case 0x0a /* '\n' */:
                atLineStart = true;
                // dropped: version (none) `loc.linnum++;` (dmd/doc.d:1003-1009)
                break;
            case 0x20 /* ' ' */:
            case 0x0d /* '\r' */:
            case 0x09 /* '\t' */:
                break;
            case 0x2d /* '-' */:
            case 0x60 /* '`' */:
            case 0x7e /* '~' */: {
                // Issue 15465: don't try to escape unbalanced parens inside code
                // blocks.
                let numdash = 1;
                for (++u; u < buf.length() && buf.opIndex(u) === c; ++u)
                    ++numdash;
                --u;
                if (c === 0x60 || (atLineStart && numdash >= 3)) {
                    if (inCode === c)
                        inCode = 0;
                    else if (!inCode)
                        inCode = c;
                }
                atLineStart = false;
                break;
            }
            case 0x5c /* '\\' */:
                // replace backslash-escaped parens with their macros
                if (!inCode && respectBackslashEscapes && u + 1 < buf.length()) {
                    if (buf.opIndex(u + 1) === 0x28 || buf.opIndex(u + 1) === 0x29) {
                        const paren = buf.opIndex(u + 1) === 0x28 ? ds("$(LPAREN)") : ds("$(RPAREN)");
                        buf.remove(u, 2); //remove the \)
                        buf.insert(u, paren); //insert this instead
                        u += 8; //skip over newly inserted macro
                    } else if (buf.opIndex(u + 1) === 0x5c)
                        ++u;
                }
                break;
            default:
                atLineStart = false;
                break;
        }
    }
    if (par_open) { // if any unmatched lparens
        par_open = 0;
        for (let u = buf.length(); u > start;) {
            u--;
            const c = buf.opIndex(u);
            switch (c) {
                case 0x29 /* ')' */:
                    par_open++;
                    break;
                case 0x28 /* '(' */:
                    if (par_open === 0) {
                        //stray '('
                        eSink.warning(loc, ds("Ddoc: Stray '('. This may cause incorrect Ddoc output. " +
                            "Use $(LPAREN) instead for unpaired left parentheses."));
                        buf.remove(u, 1); //remove the (
                        buf.insert(u, ds("$(LPAREN)")); //insert this instead
                    } else
                        par_open--;
                    break;
                default:
                    break;
            }
        }
    }
}

// Basically, this is to skip over things like private{} blocks in a struct or
// class definition that don't add any components to the qualified name. (dmd/doc.d:1085)
function skipNonQualScopes(sc: Scope | null): Scope | null {
    while (sc !== null && sc.scopesym === null)
        sc = sc.enclosing;
    return sc;
}

/// Write the anchor name of `s` (dmd/doc.d:1092): its dotted qualified name, with the parents first when
/// `includeParent`, `this` for a constructor. Returns whether anything was written.
function emitAnchorName(buf: OutBuffer, s: Dsymbol | null, sc: Scope | null, includeParent: boolean): boolean {
    if (s === null || s.isPackage() !== null || s.isModule() !== null)
        return false;
    // Add parent names first
    let dot = false;
    const eponymousParent = getEponymousParent(s);
    if ((includeParent && s.parent !== null) || eponymousParent !== null)
        dot = emitAnchorName(buf, s.parent, sc, includeParent);
    else if (includeParent && sc !== null)
        dot = emitAnchorName(buf, sc.scopesym, skipNonQualScopes(sc.enclosing), includeParent);
    // Eponymous template members can share the parent anchor name
    if (eponymousParent !== null)
        return dot;
    if (dot)
        buf.writeByte(0x2e /* '.' */);
    // Use "this" not "__ctor"
    const td = s.isTemplateDeclaration();
    computeOneMember(td);   // `td.computeOneMember()`: UFCS on a possibly-null td, which the callee tests
    if (s.isCtorDeclaration() !== null ||
        (td !== null && td.onemember !== null && td.onemember.isCtorDeclaration() !== null)) {
        buf.writestring(ds("this"));
    } else {
        buf.writestring(s.ident !== null ? s.ident.toString() : ds("__anonymous"));
    }
    return true;
}

/// Write the `$(DDOC_ANCHOR name)` (or, `forHeader`, `$(DDOC_HEADER_ANCHOR name, shortname)`) macro for
/// `s` (dmd/doc.d:1122), numbering repeated names `.2`, `.3`, ... per scope; a public import writes one
/// anchor per imported name. Records the anchor in `sc.prevAnchor` and `sc.anchorCounts`.
function emitAnchor(buf: OutBuffer, s: Dsymbol, sc: Scope, forHeader = false): void {
    let ident: Identifier;
    {
        const anc = new OutBuffer();
        emitAnchorName(anc, s, skipNonQualScopes(sc), true);
        ident = Identifier.idPool(anc.opSliceAll());
    }

    // `cast(void*)ident in sc.anchorCounts`: a null AA has no entries
    const pcount = sc.anchorCounts !== null && sc.anchorCounts.has(ident);
    let count = 0;   // typeof(*pcount) count — uint
    if (!forHeader) {
        if (pcount) {
            // Existing anchor,
            // don't write an anchor for matching consecutive ditto symbols
            const td = getEponymousParent(s);
            if (sc.prevAnchor === ident && sc.lastdc !== null &&
                (isDitto(s.comment()) || (td !== null && isDitto(td.comment()))))
                return;

            count = sc.anchorCounts!.get(ident)! + 1;   // `++*pcount`
            sc.anchorCounts!.set(ident, count);
        } else {
            // the D AA is allocated on first insert, into this scope's slot (dscope.ts anchorCounts)
            if (sc.anchorCounts === null)
                sc.anchorCounts = new Map();
            sc.anchorCounts.set(ident, 1);
            count = 1;
        }
    }

    // cache anchor name
    sc.prevAnchor = ident;
    const macroName = forHeader ? ds("DDOC_HEADER_ANCHOR") : ds("DDOC_ANCHOR");

    const imp = s.isImport();
    if (imp !== null) {
        // For example: `public import core.stdc.string : memcpy, memcmp;`
        if (imp.aliases.length > 0) {
            for (let i = 0; i < imp.aliases.length; i++) {
                // Need to distinguish between
                // `public import core.stdc.string : memcpy, memcmp;` and
                // `public import core.stdc.string : copy = memcpy, compare = memcmp;`
                const a = imp.aliases.opIndex(i);
                const id = a !== null ? a : imp.names.opIndex(i)!;
                const loc = Loc.initial;   // `auto loc = Loc.init;`
                const pscopesym: Ref<Dsymbol | null> = { value: null };
                const symFromId = searchScope(sc, loc, id, pscopesym);
                if (symFromId !== null) {
                    emitAnchor(buf, symFromId, sc, forHeader);
                }
            }
        } else {
            // For example: `public import str = core.stdc.string;`
            if (imp.aliasId !== null) {
                const symbolName = imp.aliasId.toString();

                buf.printf(ds("$(%.*s %.*s"), macroName.length, macroName, symbolName.length, symbolName);

                if (forHeader) {
                    buf.printf(ds(", %.*s"), symbolName.length, symbolName);
                }
            } else {
                // The general case:  `public import core.stdc.string;`

                // fully qualify imports so `core.stdc.string` doesn't appear as `core`
                const printFullyQualifiedImport = (): void => {
                    for (const pid of imp.packages ?? []) {   // a null D slice iterates nothing
                        buf.printf(ds("%s."), pid.toChars());
                    }
                    buf.writestring(imp.id!.toString());
                };

                buf.printf(ds("$(%.*s "), macroName.length, macroName);
                printFullyQualifiedImport();

                if (forHeader) {
                    buf.printf(ds(", "));
                    printFullyQualifiedImport();
                }
            }

            buf.writeByte(0x29 /* ')' */);
        }
    } else {
        // buf.writestring("<<<");
        // buf.writestring(typeof(ident).stringof);
        // buf.writestring(">>>");
        // auto symbolName = ident.toString();
        const symbolName = toDString(ident.toChars())!;
        buf.printf(ds("$(%.*s %.*s"), macroName.length, macroName, symbolName.length, symbolName);

        // only append count once there's a duplicate
        if (count > 1)
            buf.printf(ds(".%u"), count);

        if (forHeader) {
            let shortIdent: Identifier;
            {
                const anc = new OutBuffer();
                emitAnchorName(anc, s, skipNonQualScopes(sc), false);
                shortIdent = Identifier.idPool(anc.opSliceAll());
            }

            const shortName = shortIdent.toString();
            buf.printf(ds(", %.*s"), shortName.length, shortName);
        }

        buf.writeByte(0x29 /* ')' */);
    }
}

/******************************* emitComment **********************************/

/** Get leading indentation from 'src' which represents lines of code. (dmd/doc.d:1252) */
function getCodeIndent(src: DString | null, p: number): number {
    while (src !== null && (at(src, p) === 0x0d || at(src, p) === 0x0a))
        ++p; // skip until we find the first non-empty line
    let codeIndent = 0;
    while (src !== null && (at(src, p) === 0x20 || at(src, p) === 0x09)) {
        codeIndent++;
        p++;
    }
    return codeIndent;
}

/** Recursively expand template mixin member docs into the scope. (dmd/doc.d:1266) */
function expandTemplateMixinComments(tm: TemplateMixin, buf: OutBuffer, sc: Scope): void {
    if (tm.semanticRun === PASS.initial)
        dsymbolSemantic(tm, sc);
    const td = (tm !== null && tm.tempdecl !== null) ? tm.tempdecl.isTemplateDeclaration() : null;
    if (td !== null && td.members !== null) {
        for (let i = 0; i < td.members.length; i++) {
            const sm = td.members.opIndex(i)!;
            const tmc = sm.isTemplateMixin();
            if (tmc !== null && tmc.comment() !== null)
                expandTemplateMixinComments(tmc, buf, sc);
            else
                emitComment(sm, buf, sc);
        }
    }
}

/// Write the doc comments of the members of `sds` inside the `$(DDOC_*_MEMBERS ...)` macro for its kind,
/// in a scope pushed for `sds` (dmd/doc.d:1285); writes nothing when no member is documented.
function emitMemberComments(sds: ScopeDsymbol, buf: OutBuffer, sc: Scope): void {
    if (sds.members === null)
        return;
    //printf("ScopeDsymbol::emitMemberComments() %s\n", toChars());
    let m = ds("$(DDOC_MEMBERS ");
    if (sds.isTemplateDeclaration() !== null)
        m = ds("$(DDOC_TEMPLATE_MEMBERS ");
    else if (sds.isClassDeclaration() !== null)
        m = ds("$(DDOC_CLASS_MEMBERS ");
    else if (sds.isStructDeclaration() !== null)
        m = ds("$(DDOC_STRUCT_MEMBERS ");
    else if (sds.isEnumDeclaration() !== null)
        m = ds("$(DDOC_ENUM_MEMBERS ");
    else if (sds.isModule() !== null)
        m = ds("$(DDOC_MODULE_MEMBERS ");
    const offset1 = buf.length(); // save starting offset
    buf.writestring(m);
    const offset2 = buf.length(); // to see if we write anything
    sc = sc.push(sds);
    // the pushed scope is released at one normal-path line whose result nothing uses (11 §2.5)
    try {
        for (let i = 0; i < sds.members.length; i++) {
            const s = sds.members.opIndex(i)!;
            //printf("\ts = '%s'\n", s.toChars());
            // only expand if parent is a non-template (semantic won't work)
            if (s.comment() !== null && s.isTemplateMixin() !== null && s.parent !== null &&
                s.parent.isTemplateDeclaration() === null)
                expandTemplateMixinComments(s.isTemplateMixin()!, buf, sc);
            emitComment(s, buf, sc);
        }
        emitComment(null, buf, sc);
    } finally {
        sc.pop();
    }
    if (buf.length() === offset2) {
        /* Didn't write out any members, so back out last write
         */
        buf.setsize(offset1);
    } else
        buf.writestring(ds(")"));
}

/// `emitVisibility(ref OutBuffer buf, Import i)` (dmd/doc.d:1326).
function emitVisibilityFromImport(buf: OutBuffer, i: Import): void {
    // imports are private by default, which is different from other declarations
    // so they should explicitly show their visibility
    emitVisibilityFromVisibility(buf, i.visibility);
}

/// `emitVisibility(ref OutBuffer buf, Declaration d)` (dmd/doc.d:1333): only a visibility other than
/// undefined or public is written.
function emitVisibility(buf: OutBuffer, d: Declaration): void {
    const vis = d.visibility;
    if (vis.kind !== Visibility.Kind.undefined && vis.kind !== Visibility.Kind.public_) {
        emitVisibilityFromVisibility(buf, vis);
    }
}

/// `emitVisibility(ref OutBuffer buf, Visibility vis)` (dmd/doc.d:1342).
function emitVisibilityFromVisibility(buf: OutBuffer, vis: Visibility): void {
    visibilityToBuffer(buf, vis);
    buf.writeByte(0x20 /* ' ' */);
}

/**
 * Emit the doc comment of `s` (dmd/doc.d:1348). The comment of a symbol is held in `sc.lastdc` and written
 * when the NEXT documented symbol (or the `null` end marker) arrives, so that `ditto` comments can join
 * the previous one; `s === null` flushes the pending comment. Undocumented, private and compiler-
 * generated symbols write nothing; attribute and conditional declarations recurse into their members.
 */
function emitComment(s: Dsymbol | null, buf: OutBuffer, sc: Scope): void {
    /*
     * dmd/doc.d:1350 — `extern (C++) final class EmitComment : Visitor`, nested in this function. IDIOM A
     * (13 §7): each `visit(X)` override is `visitX` (13 §1).
     */
    class EmitComment extends Visitor {
        // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
        buf: OutBuffer;
        sc: Scope;

        constructor(buf: OutBuffer, sc: Scope) {
            super();
            this.buf = buf;
            this.sc = sc;
        }

        override visitDsymbol(_s: Dsymbol): void {
        }

        override visitInvariantDeclaration(_s: InvariantDeclaration): void {
        }

        override visitUnitTestDeclaration(_s: UnitTestDeclaration): void {
        }

        override visitPostBlitDeclaration(_s: PostBlitDeclaration): void {
        }

        override visitDtorDeclaration(_s: DtorDeclaration): void {
        }

        override visitStaticCtorDeclaration(_s: StaticCtorDeclaration): void {
        }

        override visitStaticDtorDeclaration(_s: StaticDtorDeclaration): void {
        }

        override visitTypeInfoDeclaration(_s: TypeInfoDeclaration): void {
        }

        /// Flush the pending doc comment of `sc` and start one for `s` with comment `com` (dmd/doc.d:1395); a
        /// `ditto` comment instead adds `s` to the pending one.
        emit(sc: Scope, s: Dsymbol | null, com: DString | null): void {
            if (s !== null && sc.lastdc !== null && isDitto(com)) {
                sc.lastdc.a.push(s);
                return;
            }
            // Put previous doc comment if exists
            const dc = sc.lastdc;
            if (dc !== null) {
                assert(dc.a.length > 0, "Expects at least one declaration for a" +
                    "documentation comment");

                const symbol = dc.a.opIndex(0)!;

                this.buf.writestring(ds("$(DDOC_MEMBER"));
                this.buf.writestring(ds("$(DDOC_MEMBER_HEADER"));
                emitAnchor(this.buf, symbol, sc, true);
                this.buf.writeByte(0x29 /* ')' */);

                // Put the declaration signatures as the document 'title'
                this.buf.writestring(ddoc_decl_s);
                for (let i = 0; i < dc.a.length; i++) {
                    const sx = dc.a.opIndex(i)!;
                    // the added linebreaks in here make looking at multiple
                    // signatures more appealing
                    if (i === 0) {
                        const o = this.buf.length();
                        toDocBuffer(sx, this.buf, sc);
                        highlightCode(sc, sx, this.buf, o);
                        this.buf.writestring(ds("$(DDOC_OVERLOAD_SEPARATOR)"));
                        continue;
                    }
                    this.buf.writestring(ds("$(DDOC_DITTO "));
                    {
                        const o = this.buf.length();
                        toDocBuffer(sx, this.buf, sc);
                        highlightCode(sc, sx, this.buf, o);
                    }
                    this.buf.writestring(ds("$(DDOC_OVERLOAD_SEPARATOR)"));
                    this.buf.writeByte(0x29 /* ')' */);
                }
                this.buf.writestring(ddoc_decl_e);
                // Put the ddoc comment as the document 'description'
                this.buf.writestring(ddoc_decl_dd_s);
                {
                    dc.writeSections(sc, dc.a, this.buf);
                    const sds = dc.a.opIndex(0)!.isScopeDsymbol();
                    if (sds !== null)
                        emitMemberComments(sds, this.buf, sc);
                }
                this.buf.writestring(ddoc_decl_dd_e);
                this.buf.writeByte(0x29 /* ')' */);
                //printf("buf.2 = [[%.*s]]\n", cast(int)(buf.length - o0), buf.data + o0);
            }
            if (s !== null) {
                const dc = DocComment.parse(s, com);
                dc.pmacrotable = sc._module!.macrotable;
                sc.lastdc = dc;
            }
        }

        override visitImport(imp: Import): void {
            if (imp.visible().kind !== Visibility.Kind.public_ && this.sc.visibility.kind !== Visibility.Kind.export_)
                return;

            const com = imp.comment();   // `imp.comment`
            if (com !== null)
                this.emit(this.sc, imp, com);
        }

        override visitDeclaration(d: Declaration): void {
            //printf("Declaration::emitComment(%p '%s'), comment = '%s'\n", d, d.toChars(), d.comment);
            //printf("type = %p\n", d.type);
            let com = d.comment();
            const td = getEponymousParent(d);
            if (td !== null) {
                if (isDitto(td.comment()))
                    com = td.comment();
                else
                    com = Lexer.combineComments(toDString(td.comment()), toDString(com), true);
            } else {
                if (d.ident === null)
                    return;
                if (d.type === null) {
                    if (d.isCtorDeclaration() === null &&
                        d.isAliasDeclaration() === null &&
                        d.isVarDeclaration() === null) {
                        return;
                    }
                }
                if (d.visibility.kind === Visibility.Kind.private_ ||
                    this.sc.visibility.kind === Visibility.Kind.private_)
                    return;
            }
            if (com === null)
                return;
            this.emit(this.sc, d, com);
        }

        override visitAggregateDeclaration(ad: AggregateDeclaration): void {
            //printf("AggregateDeclaration::emitComment() '%s'\n", ad.toChars());
            let com = ad.comment();
            const td = getEponymousParent(ad);
            if (td !== null) {
                if (isDitto(td.comment()))
                    com = td.comment();
                else
                    com = Lexer.combineComments(toDString(td.comment()), toDString(com), true);
            } else {
                if (ad.visible().kind === Visibility.Kind.private_ ||
                    this.sc.visibility.kind === Visibility.Kind.private_)
                    return;
                if (ad.comment() === null)
                    return;
            }
            if (com === null)
                return;
            this.emit(this.sc, ad, com);
        }

        override visitTemplateDeclaration(td: TemplateDeclaration): void {
            //printf("TemplateDeclaration::emitComment() '%s', kind = %s\n", td.toChars(), td.kind());
            if (td.visible().kind === Visibility.Kind.private_ || this.sc.visibility.kind === Visibility.Kind.private_)
                return;
            const com = td.comment();   // `td.comment`
            if (com === null)
                return;
            const ss = getEponymousMember(td);
            if (ss !== null) {
                ss.accept(this);
                return;
            }
            this.emit(this.sc, td, com);
        }

        override visitEnumDeclaration(ed: EnumDeclaration): void {
            if (ed.visible().kind === Visibility.Kind.private_ || this.sc.visibility.kind === Visibility.Kind.private_)
                return;
            if (ed.isAnonymous() && ed.members !== null) {
                for (let i = 0; i < ed.members.length; i++) {
                    const s = ed.members.opIndex(i)!;
                    emitComment(s, this.buf, this.sc);
                }
                return;
            }
            if (ed.comment() === null)
                return;
            if (ed.isAnonymous())
                return;
            this.emit(this.sc, ed, ed.comment());
        }

        override visitEnumMember(em: EnumMember): void {
            //printf("EnumMember::emitComment(%p '%s'), comment = '%s'\n", em, em.toChars(), em.comment);
            if (em.visible().kind === Visibility.Kind.private_ || this.sc.visibility.kind === Visibility.Kind.private_)
                return;
            if (em.comment() === null)
                return;
            this.emit(this.sc, em, em.comment());
        }

        override visitAttribDeclaration(ad: AttribDeclaration): void {
            //printf("AttribDeclaration::emitComment(sc = %p)\n", sc);
            /* A general problem with this,
             * illustrated by https://issues.dlang.org/show_bug.cgi?id=2516
             * is that attributes are not transmitted through to the underlying
             * member declarations for template bodies, because semantic analysis
             * is not done for template declaration bodies
             * (only template instantiations).
             * Hence, Ddoc omits attributes from template members.
             */
            const d = include(ad, null);
            if (d !== null) {
                for (let i = 0; i < d.length; i++) {
                    const s = d.opIndex(i)!;
                    //printf("AttribDeclaration::emitComment %s\n", s.toChars());
                    emitComment(s, this.buf, this.sc);
                }
            }
        }

        override visitVisibilityDeclaration(pd: VisibilityDeclaration): void {
            if (pd.decl !== null) {
                const scx = this.sc;
                this.sc = this.sc.copy();
                // the copied scope is popped at one normal-path line whose result is consumed: the
                // capture-in-finally shape (11 §2.5)
                let popped: Scope | null;
                try {
                    this.sc.visibility = pd.visibility.copy();
                    this.visitAttribDeclaration(pd);
                    scx.lastdc = this.sc.lastdc;
                } finally {
                    popped = this.sc.pop();
                }
                this.sc = popped!;   // `sc = sc.pop()`: the enclosing scope of the copy
            }
        }

        override visitConditionalDeclaration(cd: ConditionalDeclaration): void {
            //printf("ConditionalDeclaration::emitComment(sc = %p)\n", sc);
            if (cd.condition!.inc !== Include.notComputed) {
                this.visitAttribDeclaration(cd);
                return;
            }
            /* If generating doc comment, be careful because if we're inside
             * a template, then include(null) will fail.
             */
            const d = cd.decl !== null ? cd.decl : cd.elsedecl;
            for (let i = 0; i < d!.length; i++) {
                const s = d!.opIndex(i)!;
                emitComment(s, this.buf, this.sc);
            }
        }
    }

    const v = new EmitComment(buf, sc);
    if (s === null)
        v.emit(sc, null, null);
    else
        s.accept(v);
}

/// Write the declaration of `s` as it appears in the page title (dmd/doc.d:1632): the signature through the
/// header printer in Ddoc mode, with visibility and storage classes, ending in `;\n`.
function toDocBuffer(s: Dsymbol, buf: OutBuffer, sc: Scope): void {
    /*
     * dmd/doc.d:1634 — `extern (C++) final class ToDocBuffer : Visitor`, nested in this function. IDIOM A
     * (13 §7): each `visit(X)` override is `visitX` (13 §1).
     */
    class ToDocBuffer extends Visitor {
        // dropped: alias visit = Visitor.visit — no overload hiding in TS (13 §1)
        buf: OutBuffer;
        sc: Scope;

        constructor(buf: OutBuffer, sc: Scope) {
            super();
            this.buf = buf;
            this.sc = sc;
        }

        override visitDsymbol(s: Dsymbol): void {
            //printf("Dsymbol::toDocbuffer() %s\n", s.toChars());
            const hgs = new HdrGenState();
            hgs.ddoc = true;
            dsymbolToCBuffer(s, this.buf, hgs);
        }

        /// The attribute prefix of a declaration (dmd/doc.d:1655): deprecated, visibility, static/final/
        /// abstract and, for a non-function, the type qualifiers and storage classes.
        prefix(s: Dsymbol): void {
            if (s.isDeprecated())
                this.buf.writestring(ds("deprecated "));
            const d = s.isDeclaration();
            if (d !== null) {
                emitVisibility(this.buf, d);
                if (d.isStatic())
                    this.buf.writestring(ds("static "));
                else if (d.isFinal())
                    this.buf.writestring(ds("final "));
                else if (d.isAbstract())
                    this.buf.writestring(ds("abstract "));

                if (d.isFuncDeclaration() !== null)      // functionToBufferFull handles this
                    return;

                if (d.isImmutable())
                    this.buf.writestring(ds("immutable "));
                if (d.storage_class & STC.shared_)
                    this.buf.writestring(ds("shared "));
                if (d.isWild())
                    this.buf.writestring(ds("inout "));
                if (d.isConst())
                    this.buf.writestring(ds("const "));

                if (d.isSynchronized())
                    this.buf.writestring(ds("synchronized "));

                if (d.storage_class & STC.manifest)
                    this.buf.writestring(ds("enum "));

                // Add "auto" for the untyped variable in template members
                if (d.type === null && d.isVarDeclaration() !== null &&
                    !d.isImmutable() && !(d.storage_class & STC.shared_) && !d.isWild() && !d.isConst() &&
                    !d.isSynchronized()) {
                    this.buf.writestring(ds("auto "));
                }
            }
        }

        override visitImport(i: Import): void {
            const hgs = new HdrGenState();
            hgs.ddoc = true;
            emitVisibilityFromImport(this.buf, i);
            dsymbolToCBuffer(i, this.buf, hgs);
        }

        override visitDeclaration(d: Declaration): void {
            if (d.ident === null)
                return;
            const td = getEponymousParent(d);
            //printf("Declaration::toDocbuffer() %s, originalType = %s, td = %s\n", d.toChars(),
            //    d.originalType ? d.originalType.toChars() : "--", td ? td.toChars() : "--");
            const hgs = new HdrGenState();
            hgs.ddoc = true;
            if (d.isDeprecated())
                this.buf.writestring(ds("$(DEPRECATED "));
            this.prefix(d);
            if (d.type !== null) {
                const origType: Type = d.originalType !== null ? d.originalType : d.type;
                if (origType.ty === TY.Tfunction) {
                    // `cast(TypeFunction)origType`: the tag test above proves the class
                    functionToBufferFull(origType.isTypeFunction()!, this.buf, d.ident, hgs, td);
                } else
                    typeToCBuffer(origType, this.buf, d.ident, hgs);
            } else
                this.buf.writestring(d.ident.toString());
            if (d.isVarDeclaration() !== null && td !== null) {
                this.buf.writeByte(0x28 /* '(' */);
                if (td.origParameters !== null && td.origParameters.length) {
                    for (let i = 0; i < td.origParameters.length; i++) {
                        if (i)
                            this.buf.writestring(ds(", "));
                        templateParameterToCBuffer(td.origParameters.opIndex(i)!, this.buf, hgs);
                    }
                }
                this.buf.writeByte(0x29 /* ')' */);
            }
            // emit constraints if declaration is a templated declaration
            if (td !== null && td.constraint !== null) {
                const noFuncDecl = td.isFuncDeclaration() === null;
                if (noFuncDecl) {
                    this.buf.writestring(ds("$(DDOC_CONSTRAINT "));
                }

                expToCBuffer(td.constraint, this.buf, hgs);

                if (noFuncDecl) {
                    this.buf.writestring(ds(")"));
                }
            }
            if (d.isDeprecated())
                this.buf.writestring(ds(")"));
            this.buf.writestring(ds(";\n"));
        }

        override visitAliasDeclaration(ad: AliasDeclaration): void {
            //printf("AliasDeclaration::toDocbuffer() %s\n", ad.toChars());
            if (ad.ident === null)
                return;
            if (ad.isDeprecated())
                this.buf.writestring(ds("deprecated "));
            emitVisibility(this.buf, ad);
            this.buf.printf(ds("alias %s = "), ad.toChars());
            const s = ad.aliassym;
            if (s !== null) { // ident alias
                this.prettyPrintDsymbol(s, ad.parent);
            } else {
                const type = getType(ad);
                if (type !== null) { // type alias
                    if (type.ty === TY.Tclass || type.ty === TY.Tstruct || type.ty === TY.Tenum) {
                        // import dmd.typesem : toDsymbol; (dmd/doc.d:1780) — a module-level import here
                        const s = toDsymbol(type, null);
                        if (s !== null) // elaborate type
                            this.prettyPrintDsymbol(s, ad.parent);
                        else
                            this.buf.writestring(cstr(type.toChars()));
                    } else {
                        // simple type
                        this.buf.writestring(cstr(type.toChars()));
                    }
                }
            }
            this.buf.writestring(ds(";\n"));
        }

        /// The dotted names of the parents of `s` below its module (dmd/doc.d:1795).
        parentToBuffer(s: Dsymbol | null): void {
            if (s !== null && s.isPackage() === null && s.isModule() === null) {
                this.parentToBuffer(s.parent);
                this.buf.writestring(cstr(s.toChars()));
                this.buf.writestring(ds("."));
            }
        }

        /// Whether `s` and `p` sit in the same module (dmd/doc.d:1805).
        static inSameModule(s: Dsymbol | null, p: Dsymbol | null): boolean {
            for (; s !== null; s = s.parent) {
                if (s.isModule() !== null)
                    break;
            }
            for (; p !== null; p = p.parent) {
                if (p.isModule() !== null)
                    break;
            }
            return s === p;
        }

        /// `s`'s name as an alias target seen from `parent` (dmd/doc.d:1820).
        prettyPrintDsymbol(s: Dsymbol, parent: Dsymbol | null): void {
            if (s.parent !== null && (s.parent === parent)) { // in current scope -> naked name
                this.buf.writestring(cstr(s.toChars()));
            } else if (!ToDocBuffer.inSameModule(s, parent)) { // in another module -> full name
                this.buf.writestring(cstr(s.toPrettyChars()));
            } else { // nested in a type in this module -> full name w/o module name
                // if alias is nested in a user-type use module-scope lookup
                if (parent!.isModule() === null && parent!.isPackage() === null)
                    this.buf.writestring(ds("."));
                this.parentToBuffer(s.parent);
                this.buf.writestring(cstr(s.toChars()));
            }
        }

        override visitAggregateDeclaration(ad: AggregateDeclaration): void {
            if (ad.ident === null)
                return;
            // dropped: version (none) `emitVisibility(buf, ad);` (dmd/doc.d:1844-1847)
            this.buf.printf(ds("%s %s"), ad.kind(), ad.toChars());
            this.buf.writestring(ds(";\n"));
        }

        override visitStructDeclaration(sd: StructDeclaration): void {
            //printf("StructDeclaration::toDocbuffer() %s\n", sd.toChars());
            if (sd.ident === null)
                return;
            // dropped: version (none) `emitVisibility(buf, sd);` (dmd/doc.d:1857-1860)
            const td = getEponymousParent(sd);
            if (td !== null) {
                toDocBuffer(td, this.buf, this.sc);
            } else {
                this.buf.printf(ds("%s %s"), sd.kind(), sd.toChars());
            }
            this.buf.writestring(ds(";\n"));
        }

        override visitClassDeclaration(cd: ClassDeclaration): void {
            //printf("ClassDeclaration::toDocbuffer() %s\n", cd.toChars());
            if (cd.ident === null)
                return;
            // dropped: version (none) `emitVisibility(*buf, cd);` (dmd/doc.d:1877-1880)
            const td = getEponymousParent(cd);
            if (td !== null) {
                toDocBuffer(td, this.buf, this.sc);
            } else {
                if (cd.isInterfaceDeclaration() === null && isAbstract(cd))
                    this.buf.writestring(ds("abstract "));
                this.buf.printf(ds("%s %s"), cd.kind(), cd.toChars());
            }
            let any = 0;
            for (let i = 0; i < cd.baseclasses!.length; i++) {
                const bc = cd.baseclasses!.opIndex(i)!;
                if (bc.sym !== null && bc.sym.ident === Id.Object)
                    continue;
                if (any)
                    this.buf.writestring(ds(", "));
                else {
                    this.buf.writestring(ds(": "));
                    any = 1;
                }

                if (bc.sym !== null) {
                    this.buf.printf(ds("$(DDOC_PSUPER_SYMBOL %s)"), bc.sym.toPrettyChars());
                } else {
                    const hgs = new HdrGenState();
                    typeToCBuffer(bc.type!, this.buf, null, hgs);
                }
            }
            this.buf.writestring(ds(";\n"));
        }

        override visitEnumDeclaration(ed: EnumDeclaration): void {
            if (ed.ident === null)
                return;
            this.buf.printf(ds("%s %s"), ed.kind(), ed.toChars());
            if (ed.memtype !== null) {
                this.buf.writestring(ds(": $(DDOC_ENUM_BASETYPE "));
                const hgs = new HdrGenState();
                typeToCBuffer(ed.memtype, this.buf, null, hgs);
                this.buf.writestring(ds(")"));
            }
            this.buf.writestring(ds(";\n"));
        }

        override visitEnumMember(em: EnumMember): void {
            if (em.ident === null)
                return;
            this.buf.writestring(cstr(em.toChars()));
        }
    }

    const v = new ToDocBuffer(buf, sc);
    s.accept(v);
}

/*****************************************
 * Return true if comment consists entirely of "ditto". (dmd/doc.d:1948)
 */
function isDitto(comment: DString | null): boolean {
    if (comment !== null) {
        const s = storeOf(comment);
        const p = skipwhitespace(s, 0);
        if (Port.memicmp(bytesAt(s, p, 5), ds("ditto"), 5) === 0 && at(s, skipwhitespace(s, p + 5)) === 0)
            return true;
    }
    return false;
}

/**********************************************
 * Skip white space. (dmd/doc.d:1962) The `const(char)*` form: the cursor `p` into `s` advanced past
 * spaces, tabs and newlines, never past the NUL that ends the C string.
 */
function skipwhitespace(s: DString, p: number): number {
    // `skipwhitespace(p.toDString).ptr`: the C string from p up to its NUL, then the slice form
    const str = cstr(s.subarray(p));
    return p + (str.length - skipwhitespaceSlice(str).length);
}

/// Ditto (dmd/doc.d:1968) — `skipwhitespace(const(char)[] p)`, the slice form (04 §1 Form B).
function skipwhitespaceSlice(p: DString): DString {
    for (let idx = 0; idx < p.length; idx++) {
        const c = p[idx];
        switch (c) {
            case 0x20 /* ' ' */:
            case 0x09 /* '\t' */:
            case 0x0a /* '\n' */:
                continue;
            default:
                return p.subarray(idx);
        }
    }
    return p.subarray(p.length);
}

/************************************************
 * Scan past all instances of the given characters. (dmd/doc.d:1993)
 * Params:
 *  buf           = an OutBuffer containing the DDoc
 *  i             = the index within `buf` to start scanning from
 *  chars         = the characters to skip; order is unimportant
 * Returns: the index after skipping characters.
 */
export function skipChars(buf: OutBuffer, i: number, chars: DString): number { // D module-private
    const slice = buf.opSliceAll().subarray(i);
    Outer: for (let j = 0; j < slice.length; j++) {
        const c = slice[j];
        for (const d of chars) {
            if (d === c)
                continue Outer;
        }
        return i + j;
    }
    return buf.length();
}

/****************************************************
 * Replace all instances of `c` with `r` in the given string (dmd/doc.d:2028)
 * Params:
 *  s = the string to do replacements in
 *  c = the character to look for
 *  r = the string to replace `c` with
 * Returns: `s` with `c` replaced with `r` (`s` itself when it holds no `c`)
 */
export function replaceChar(s: DString, c: number, r: DString): DString { // D module-private
    let count = 0;
    for (const sc of s)
        if (sc === c)
            ++count;
    if (count === 0)
        return s;

    const result: DString[] = [];
    // result.reserve(s.length - count + (r.length * count)) — capacity only
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const sc = s[i];
        if (sc === c) {
            result.push(s.subarray(start, i));
            result.push(r);
            start = i + 1;
        }
    }
    result.push(s.subarray(start));
    return dsConcat(...result);
}

/**
 * Return a lowercased copy of a string. (dmd/doc.d:2070)
 * Params:
 *  s = the string to lowercase
 * Returns: the lowercase version of the string or the original if already lowercase
 */
export function toLowercase(s: DString): DString { // D module-private
    const lower: number[] = [];
    for (let i = 0; i < s.length; i++) {
        let c = s[i];
        // TODO: maybe unicode lowercase, somehow
        if (c >= 0x41 && c <= 0x5a) {
            // if (!lower.length) lower.reserve(s.length) — capacity only
            for (const b of s.subarray(lower.length, i))
                lower.push(b);   // lower ~= s[lower.length..i]
            c += 0x61 - 0x41;
            lower.push(c);
        }
    }
    if (lower.length) {
        for (const b of s.subarray(lower.length))
            lower.push(b);
        return Uint8Array.from(lower);
    }
    return s;   // lower = s
}

/************************************************
 * Get the indent from one index to another, counting tab stops as four spaces wide
 * per the Markdown spec. (dmd/doc.d:2112)
 * Params:
 *  buf   = an OutBuffer containing the DDoc
 *  from  = the index within `buf` to start counting from, inclusive
 *  to    = the index within `buf` to stop counting at, exclusive
 * Returns: the indent
 */
function getMarkdownIndent(buf: OutBuffer, from: number, to: number): number {
    const slice = buf.opSliceAll();
    if (to > slice.length)
        to = slice.length;
    let indent = 0;
    for (const c of slice.subarray(from, to))
        indent += (c === 0x09) ? 4 - (indent % 4) : 1;
    return indent;
}

/************************************************
 * Scan forward past end of identifier. (dmd/doc.d:2126)
 */
function skippastident(buf: OutBuffer, i: number): number {
    // import dmd.common.charactertables; (dmd/doc.d:2128) — a module-level import here
    const slice = buf.opSliceAll();
    while (i < slice.length) {
        const oi = i;
        const r = utf_decodeChar(slice, i);
        i = r.nextIdx;
        const c = r.dchar;
        if (r.error !== null) {
            /* Ignore UTF errors, but still consume input
             */
            break;
        }
        if (c >= 0x80) {
            // we don't care if it is start/continue here
            if (isAnyIdentifierCharacter(c))
                continue;
        } else if (isalnum(c) || c === 0x5f)
            continue;
        i = oi;
        break;
    }
    return i;
}

/************************************************
 * Scan forward past end of an identifier that might
 * contain dots (e.g. `abc.def`) (dmd/doc.d:2159)
 */
function skipPastIdentWithDots(buf: OutBuffer, i: number): number {
    // import dmd.common.charactertables; (dmd/doc.d:2161) — a module-level import here
    const slice = buf.opSliceAll();
    let lastCharWasDot = false;
    while (i < slice.length) {
        const oi = i;
        const r = utf_decodeChar(slice, i);
        i = r.nextIdx;
        const c = r.dchar;
        if (r.error !== null) {
            /* Ignore UTF errors, but still consume input
             */
            break;
        }
        if (c === 0x2e /* '.' */) {
            // We need to distinguish between `abc.def`, abc..def`, and `abc.`
            // Only `abc.def` is a valid identifier

            if (lastCharWasDot) {
                i = oi;
                break;
            }

            lastCharWasDot = true;
            continue;
        } else {
            if (c >= 0x80) {
                // we don't care if it is start/continue here
                if (isAnyIdentifierCharacter(c)) {
                    lastCharWasDot = false;
                    continue;
                }
            } else if (isalnum(c) || c === 0x5f) {
                lastCharWasDot = false;
                continue;
            }
            i = oi;
            break;
        }
    }

    // if `abc.`
    if (lastCharWasDot)
        return i - 1;

    return i;
}

/************************************************
 * Scan forward past URL starting at i.
 * We don't want to highlight parts of a URL. (dmd/doc.d:2224)
 * Returns:
 *      i if not a URL
 *      index just past it if it is a URL
 */
function skippastURL(buf: OutBuffer, i: number): number {
    const slice = buf.opSliceAll().subarray(i);
    let j: number;
    let sawdot = false;
    // BLOCK-EXIT: `break Lno` is the jump to Lno (dmd/doc.d:2238)
    Lno: {
        if (slice.length > 7 && Port.memicmp(slice, ds("http://"), 7) === 0) {
            j = 7;
        } else if (slice.length > 8 && Port.memicmp(slice, ds("https://"), 8) === 0) {
            j = 8;
        } else
            break Lno; // goto Lno (dmd/doc.d:2238)
        for (; j < slice.length; j++) {
            const c = slice[j];
            if (isalnum(c))
                continue;
            if (c === 0x2d || c === 0x5f || c === 0x3f || c === 0x3d || c === 0x25 ||
                c === 0x26 || c === 0x2f || c === 0x2b || c === 0x23 || c === 0x7e)
                continue;
            if (c === 0x2e /* '.' */) {
                sawdot = true;
                continue;
            }
            break;
        }
        if (sawdot)
            return i + j;
    }
    // Lno:
    return i;
}

/****************************************************
 * Remove a previously-inserted blank line macro. (dmd/doc.d:2269)
 * Params:
 *  buf           = an OutBuffer containing the DDoc
 *  iAt           = the index within `buf` of the start of the `$(DDOC_BLANKLINE)`
 *                  macro. Upon function return its value is set to `0`.
 *  i             = an index within `buf`. If `i` is after `iAt` then it gets
 *                  reduced by the length of the removed macro.
 */
function removeBlankLineMacro(buf: OutBuffer, iAt: Ref<number>, i: Ref<number>): void {
    if (!iAt.value)
        return;

    const macroLength = "$(DDOC_BLANKLINE)".length;
    buf.remove(iAt.value, macroLength);
    if (i.value > iAt.value)
        i.value -= macroLength;
    iAt.value = 0;
}

/****************************************************
 * Attempt to detect and replace a Markdown thematic break (HR). These are three
 * or more of the same delimiter, optionally with spaces or tabs between any of
 * them, e.g. `\n- - -\n` becomes `\n$(HR)\n` (dmd/doc.d:2293)
 * Params:
 *  buf         = an OutBuffer containing the DDoc
 *  i           = the index within `buf` of the first character of a potential
 *                thematic break. If the replacement is made `i` changes to
 *                point to the closing parenthesis of the `$(HR)` macro.
 *  iLineStart  = the index within `buf` that the thematic break's line starts at
 * Returns: whether a thematic break was replaced
 */
function replaceMarkdownThematicBreak(buf: OutBuffer, i: Ref<number>, iLineStart: number): boolean {

    const slice = buf.opSliceAll();
    const c = buf.opIndex(i.value);
    let j = i.value + 1;
    let repeat = 1;
    for (; j < slice.length; j++) {
        if (buf.opIndex(j) === c)
            ++repeat;
        else if (buf.opIndex(j) !== 0x20 && buf.opIndex(j) !== 0x09)
            break;
    }
    if (repeat >= 3) {
        if (j >= buf.length() || buf.opIndex(j) === 0x0a || buf.opIndex(j) === 0x0d) {
            buf.remove(iLineStart, j - iLineStart);
            i.value = buf.insert(iLineStart, ds("$(HR)")) - 1;
            return true;
        }
    }
    return false;
}

/****************************************************
 * Detect the level of an ATX-style heading, e.g. `## This is a heading` would
 * have a level of `2`. (dmd/doc.d:2329)
 * Params:
 *  buf   = an OutBuffer containing the DDoc
 *  i     = the index within `buf` of the first `#` character
 * Returns:
 *          the detected heading level from 1 to 6, or
 *          0 if not at an ATX heading
 */
function detectAtxHeadingLevel(buf: OutBuffer, i: number): number {
    const iHeadingStart = i;
    const iAfterHashes = skipChars(buf, i, ds("#"));
    const headingLevel = iAfterHashes - iHeadingStart;
    if (headingLevel > 6)
        return 0;

    const iTextStart = skipChars(buf, iAfterHashes, ds(" \t"));
    const emptyHeading = buf.opIndex(iTextStart) === 0x0d || buf.opIndex(iTextStart) === 0x0a;

    // require whitespace
    if (!emptyHeading && iTextStart === iAfterHashes)
        return 0;

    return headingLevel;
}

/****************************************************
 * Remove any trailing `##` suffix from an ATX-style heading. (dmd/doc.d:2353)
 * Params:
 *  buf   = an OutBuffer containing the DDoc
 *  i     = the index within `buf` to start looking for a suffix at
 */
function removeAnyAtxHeadingSuffix(buf: OutBuffer, i: number): void {
    let j = i;
    let iSuffixStart = 0;
    let iWhitespaceStart = j;
    const slice = buf.opSliceAll();
    for (; j < slice.length; j++) {
        switch (slice[j]) {
            case 0x23 /* '#' */:
                if (iWhitespaceStart && !iSuffixStart)
                    iSuffixStart = j;
                continue;
            case 0x20 /* ' ' */:
            case 0x09 /* '\t' */:
                if (!iWhitespaceStart)
                    iWhitespaceStart = j;
                continue;
            case 0x0d /* '\r' */:
            case 0x0a /* '\n' */:
                break;
            default:
                iSuffixStart = 0;
                iWhitespaceStart = 0;
                continue;
        }
        break;
    }
    if (iSuffixStart)
        buf.remove(iWhitespaceStart, j - iWhitespaceStart);
}

/****************************************************
 * Wrap text in a Markdown heading macro, e.g. `$(H2 heading text`). (dmd/doc.d:2397)
 * Params:
 *  buf           = an OutBuffer containing the DDoc
 *  iStart        = the index within `buf` that the Markdown heading starts at
 *  iEnd          = the index within `buf` of the character after the last
 *                  heading character. Is incremented by the length of the
 *                  inserted heading macro when this function ends.
 *  headingLevel  = the level (1-6) of heading to end. Is set to `0` when this
 *                  function ends.
 */
function endMarkdownHeading(buf: OutBuffer, iStart: number, iEnd: Ref<number>, headingLevel: Ref<number>): void {
    const heading = ds("$(H0 ");   // char[5] heading = "$(H0 ";
    heading[3] = 0x30 + headingLevel.value;
    buf.insert(iStart, heading);
    iEnd.value += 5;
    let iBeforeNewline = iEnd.value;
    while (buf.opIndex(iBeforeNewline - 1) === 0x0d || buf.opIndex(iBeforeNewline - 1) === 0x0a)
        --iBeforeNewline;
    buf.insert(iBeforeNewline, ds(")"));
    headingLevel.value = 0;
}

/****************************************************
 * End all nested Markdown quotes, if inside any. (dmd/doc.d:2418)
 * Params:
 *  buf         = an OutBuffer containing the DDoc
 *  i           = the index within `buf` of the character after the quote text.
 *  quoteLevel  = the current quote level. Is set to `0` when this function ends.
 * Returns: the amount that `i` was moved
 */
function endAllMarkdownQuotes(buf: OutBuffer, i: number, quoteLevel: Ref<number>): number {
    const length = quoteLevel.value;
    for (; quoteLevel.value > 0; --quoteLevel.value)
        i = buf.insert(i, ds(")"));
    return length;
}

/****************************************************
 * Convenience function to end all Markdown lists and quotes, if inside any, and
 * set `quoteMacroLevel` to `0`. (dmd/doc.d:2440)
 * Params:
 *  buf         = an OutBuffer containing the DDoc
 *  i           = the index within `buf` of the character after the list and/or
 *                quote text. Is adjusted when this function ends if any lists
 *                and/or quotes were ended.
 *  nestedLists = a set of nested lists. Upon return it will be empty.
 *  quoteLevel  = the current quote level. Is set to `0` when this function ends.
 *  quoteMacroLevel   = the macro level that the quote was started at. Is set to
 *                      `0` when this function ends.
 * Returns: the amount that `i` was moved
 */
function endAllListsAndQuotes(buf: OutBuffer, i: Ref<number>, nestedLists: MarkdownList[], quoteLevel: Ref<number>,
    quoteMacroLevel: Ref<number>): number {
    quoteMacroLevel.value = 0;   // `out int quoteMacroLevel`: reset on entry, then set (03 §3.3)
    const i0 = i.value;
    i.value += MarkdownList.endAllNestedLists(buf, i.value, nestedLists);
    i.value += endAllMarkdownQuotes(buf, i.value, quoteLevel);
    return i.value - i0;
}

/****************************************************
 * Replace Markdown emphasis with the appropriate macro,
 * e.g. `*very* **nice**` becomes `$(EM very) $(STRONG nice)`. (dmd/doc.d:2458)
 * Params:
 *  buf               = an OutBuffer containing the DDoc
 *  inlineDelimiters  = the collection of delimiters found within a paragraph. When this function returns
 *                      its length will be reduced to `downToLevel`.
 *  downToLevel       = the length within `inlineDelimiters`` to reduce emphasis to
 * Returns: the number of characters added to the buffer by the replacements
 */
function replaceMarkdownEmphasis(buf: OutBuffer, inlineDelimiters: MarkdownDelimiter[], downToLevel = 0): number {
    // `ref MarkdownDelimiter start, ref MarkdownDelimiter end`: the array elements themselves
    const replaceEmphasisPair = (start: MarkdownDelimiter, end: MarkdownDelimiter): number => {
        const count = start.count === 1 || end.count === 1 ? 1 : 2;

        let iStart = start.iStart;
        let iEnd = end.iStart;
        end.count -= count;
        start.count -= count;
        iStart += start.count;

        if (!start.count)
            start.type = 0;
        if (!end.count)
            end.type = 0;

        buf.remove(iStart, count);
        iEnd -= count;
        buf.remove(iEnd, count);

        const macroName = count >= 2 ? ds("$(STRONG ") : ds("$(EM ");
        buf.insert(iEnd, ds(")"));
        buf.insert(iStart, macroName);

        const delta = 1 + macroName.length - (count + count);
        end.iStart += count;
        return delta;
    };

    let delta = 0;
    let start = inlineDelimiters.length - 1;
    while (start >= downToLevel) {
        // find start emphasis
        while (start >= downToLevel &&
            (inlineDelimiters[start].type !== 0x2a /* '*' */ || !inlineDelimiters[start].leftFlanking))
            --start;
        if (start < downToLevel)
            break;

        // find the nearest end emphasis
        let end = start + 1;
        while (end < inlineDelimiters.length &&
            (inlineDelimiters[end].type !== inlineDelimiters[start].type ||
                inlineDelimiters[end].macroLevel !== inlineDelimiters[start].macroLevel ||
                !inlineDelimiters[end].rightFlanking))
            ++end;
        if (end === inlineDelimiters.length) {
            // the start emphasis has no matching end; if it isn't an end itself then kill it
            if (!inlineDelimiters[start].rightFlanking)
                inlineDelimiters[start].type = 0;
            --start;
            continue;
        }

        // multiple-of-3 rule
        if (((inlineDelimiters[start].leftFlanking && inlineDelimiters[start].rightFlanking) ||
                (inlineDelimiters[end].leftFlanking && inlineDelimiters[end].rightFlanking)) &&
            (inlineDelimiters[start].count + inlineDelimiters[end].count) % 3 === 0) {
            --start;
            continue;
        }

        const delta0 = replaceEmphasisPair(inlineDelimiters[start], inlineDelimiters[end]);

        for (; end < inlineDelimiters.length; ++end)
            inlineDelimiters[end].iStart += delta0;
        delta += delta0;
    }

    inlineDelimiters.length = downToLevel;
    return delta;
}

/****************************************************
 * Whether `s` names one of the symbols `a` (dmd/doc.d:2537); a public import matches its alias or its
 * fully qualified module name.
 */
function isIdentifier(a: Dsymbols, s: DString): boolean {
    for (const member of a) {
        const imp = member!.isImport();
        if (imp !== null) {
            // For example: `public import str = core.stdc.string;`
            // This checks if `s` is equal to `str`
            if (imp.aliasId !== null) {
                if (dsEquals(s, imp.aliasId.toString()))
                    return true;
            } else {
                // The general case:  `public import core.stdc.string;`

                // fully qualify imports so `core.stdc.string` doesn't appear as `core`
                let fullyQualifiedImport = dsEmpty;
                for (const pid of imp.packages ?? []) {   // a null D slice iterates nothing
                    fullyQualifiedImport = dsConcat(fullyQualifiedImport, pid.toString(), ds("."));
                }
                fullyQualifiedImport = dsConcat(fullyQualifiedImport, imp.id!.toString());

                // Check if `s` == `core.stdc.string`
                if (dsEquals(s, fullyQualifiedImport))
                    return true;
            }
        } else if (member!.ident !== null) {
            if (dsEquals(s, member!.ident.toString()))
                return true;
        }

    }
    return false;
}

/****************************************************
 * Whether `str` is `true`, `false` or `null` (dmd/doc.d:2579).
 */
function isKeyword(str: DString): boolean {
    const table = [ds("true"), ds("false"), ds("null")];
    for (const s of table) {
        if (dsEquals(str, s))
            return true;
    }
    return false;
}

/****************************************************
 * The (original) function type of `s` when it is a function with a type, else null (dmd/doc.d:2592).
 */
function isTypeFunction(s: Dsymbol): TypeFunction | null {
    const f = s.isFuncDeclaration();
    /* f.type may be NULL for template members.
     */
    if (f !== null && f.type !== null) {
        const t = f.originalType !== null ? f.originalType : f.type;
        if (t.ty === TY.Tfunction)
            return t.isTypeFunction()!;   // `cast(TypeFunction)t`: the tag test above proves the class
    }
    return null;
}

/****************************************************
 * `isFunctionParameter(Dsymbol s, const(char)[] str)` (dmd/doc.d:2608): the parameter of function `s`
 * named `str`, or null.
 */
function isFunctionParameterDsymbol(s: Dsymbol, str: DString): Parameter | null {
    const tf = isTypeFunction(s);
    if (tf !== null && tf.parameterList.parameters !== null) {
        for (const fparam of tf.parameterList.parameters) {
            if (fparam!.ident !== null && dsEquals(str, fparam!.ident.toString())) {
                return fparam;
            }
        }
    }
    return null;
}

/****************************************************
 * `isFunctionParameter(Dsymbols* a, const(char)[] p)` (dmd/doc.d:2626): the parameter named `p` of the
 * first function among `a` that has one, or null.
 */
function isFunctionParameter(a: Dsymbols, p: DString): Parameter | null {
    for (const sym of a) {
        const fparam = isFunctionParameterDsymbol(sym!, p);
        if (fparam !== null) {
            return fparam;
        }
    }
    return null;
}

/****************************************************
 * The parameter named `p` of a function that is the eponymous member of a template among `a` (or of
 * the template an alias among `a` names), following overloads (dmd/doc.d:2641).
 */
function isEponymousFunctionParameter(a: Dsymbols, p: DString): Parameter | null {
    for (const dsym of a) {
        let td = dsym!.isTemplateDeclaration();
        computeOneMember(td);   // `td.computeOneMember()`: UFCS on a possibly-null td, which the callee tests
        if (td !== null && td.onemember !== null) {
            /* Case 1: we refer to a template declaration inside the template

               /// ...ddoc...
               template case1(T) {
                 void case1(R)() {}
               }
             */
            td = td.onemember.isTemplateDeclaration();
        }
        if (td === null) {
            /* Case 2: we're an alias to a template declaration

               /// ...ddoc...
               alias case2 = case1!int;
             */
            const ad = dsym!.isAliasDeclaration();
            if (ad !== null && ad.aliassym !== null) {
                td = ad.aliassym.isTemplateDeclaration();
            }
        }
        while (td !== null) {
            const sym = getEponymousMember(td);
            if (sym !== null) {
                const fparam = isFunctionParameterDsymbol(sym, p);
                if (fparam !== null) {
                    return fparam;
                }
            }
            td = td.overnext;
        }
    }
    return null;
}

/****************************************************
 * The template parameter named `p[0 .. len]` of a template among `a` or of the eponymous parent of one
 * of them, or null (dmd/doc.d:2690). `p` is the view that starts at D's pointer.
 */
function isTemplateParameter(a: Dsymbols, p: DString, len: number): TemplateParameter | null {
    for (let i = 0; i < a.length; i++) {
        let td = a.opIndex(i)!.isTemplateDeclaration();
        // Check for the parent, if the current symbol is not a template declaration.
        if (td === null)
            td = getEponymousParent(a.opIndex(i)!);
        if (td !== null && td.origParameters !== null) {
            for (const tp of td.origParameters) {
                if (tp!.ident !== null && dsEquals(p.subarray(0, len), tp!.ident.toString())) {
                    return tp;
                }
            }
        }
    }
    return null;
}

/****************************************************
 * Return true if str is a reserved symbol name
 * that starts with a double underscore. (dmd/doc.d:2716)
 */
function isReservedName(str: DString): boolean {
    for (const s of reservedNameTable) {
        if (dsEquals(str, s))
            return true;
    }
    return false;
}

/// dmd/doc.d:2718 — `immutable string[] table` of isReservedName.
const reservedNameTable: readonly DString[] = Object.freeze([
    ds("__ctor"),
    ds("__dtor"),
    ds("__postblit"),
    ds("__invariant"),
    ds("__unitTest"),
    ds("__require"),
    ds("__ensure"),
    ds("__dollar"),
    ds("__ctfe"),
    ds("__withSym"),
    ds("__result"),
    ds("__returnLabel"),
    ds("__vptr"),
    ds("__monitor"),
    ds("__gate"),
    ds("__xopEquals"),
    ds("__xopCmp"),
    ds("__LINE__"),
    ds("__FILE__"),
    ds("__MODULE__"),
    ds("__FUNCTION__"),
    ds("__PRETTY_FUNCTION__"),
    ds("__DATE__"),
    ds("__TIME__"),
    ds("__TIMESTAMP__"),
    ds("__VENDOR__"),
    ds("__VERSION__"),
    ds("__EOF__"),
    ds("__CXXLIB__"),
    ds("__LOCAL_SIZE"),
    ds("__entrypoint"),
]);

/****************************************************
 * A delimiter for Markdown inline content like emphasis and links. (dmd/doc.d:2763)
 * A D value struct: copied at every D copy point through `copy()`.
 */
class MarkdownDelimiter {
    iStart: number;  /// the index where this delimiter starts
    count: number;      /// the length of this delimeter's start sequence
    macroLevel: number; /// the count of nested DDoc macros when the delimiter is started
    leftFlanking: boolean;  /// whether the delimiter is left-flanking, as defined by the CommonMark spec
    rightFlanking: boolean; /// whether the delimiter is right-flanking, as defined by the CommonMark spec
    atParagraphStart: boolean;  /// whether the delimiter is at the start of a paragraph
    type: number;      /// the type of delimiter, defined by its starting character

    /// The positional struct literal `MarkdownDelimiter(iStart, count, ...)`; no arguments is `.init`.
    constructor(iStart = 0, count = 0, macroLevel = 0, leftFlanking = false, rightFlanking = false,
        atParagraphStart = false, type = 0) {
        this.iStart = iStart;
        this.count = count;
        this.macroLevel = macroLevel;
        this.leftFlanking = leftFlanking;
        this.rightFlanking = rightFlanking;
        this.atParagraphStart = atParagraphStart;
        this.type = type;
    }

    /// The D struct copy (03 §2).
    copy(): MarkdownDelimiter {
        return new MarkdownDelimiter(this.iStart, this.count, this.macroLevel, this.leftFlanking, this.rightFlanking,
            this.atParagraphStart, this.type);
    }

    /// whether this describes a valid delimiter
    isValid(): boolean { return this.count !== 0; }

    /// flag this delimiter as invalid
    invalidate(): void { this.count = 0; }
}

/****************************************************
 * Info about a Markdown list. (dmd/doc.d:2783)
 * A D value struct: copied at every D copy point through `copy()`.
 */
class MarkdownList {
    orderedStart: DString | null;    /// an optional start number--if present then the list starts at this number
    iStart: number;          /// the index where the list item starts
    iContentStart: number;   /// the index where the content starts after the list delimiter
    delimiterIndent: number;    /// the level of indent the list delimiter starts at
    contentIndent: number;      /// the level of indent the content starts at
    macroLevel: number;         /// the count of nested DDoc macros when the list is started
    type: number;              /// the type of list, defined by its starting character

    /// The positional struct literal `MarkdownList(orderedStart, ...)`; no arguments is `.init`.
    constructor(orderedStart: DString | null = null, iStart = 0, iContentStart = 0, delimiterIndent = 0,
        contentIndent = 0, macroLevel = 0, type = 0) {
        this.orderedStart = orderedStart;
        this.iStart = iStart;
        this.iContentStart = iContentStart;
        this.delimiterIndent = delimiterIndent;
        this.contentIndent = contentIndent;
        this.macroLevel = macroLevel;
        this.type = type;
    }

    /// The D struct copy (03 §2); `orderedStart` is an immutable string, shared.
    copy(): MarkdownList {
        return new MarkdownList(this.orderedStart, this.iStart, this.iContentStart, this.delimiterIndent,
            this.contentIndent, this.macroLevel, this.type);
    }

    /// whether this describes a valid list
    isValid(): boolean { return this.type !== 0; }

    /****************************************************
     * Try to parse a list item, returning whether successful. (dmd/doc.d:2804)
     * Params:
     *  buf           = an OutBuffer containing the DDoc
     *  iLineStart    = the index within `buf` of the first character of the line
     *  i             = the index within `buf` of the potential list item
     * Returns: the parsed list item. Its `isValid` property describes whether parsing succeeded.
     */
    static parseItem(buf: OutBuffer, iLineStart: number, i: number): MarkdownList {
        if (buf.opIndex(i) === 0x2b || buf.opIndex(i) === 0x2d || buf.opIndex(i) === 0x2a)
            return MarkdownList.parseUnorderedListItem(buf, iLineStart, i);
        else
            return MarkdownList.parseOrderedListItem(buf, iLineStart, i);
    }

    /****************************************************
     * Return whether the context is at a list item of the same type as this list. (dmd/doc.d:2820)
     * Params:
     *  buf           = an OutBuffer containing the DDoc
     *  iLineStart    = the index within `buf` of the first character of the line
     *  i             = the index within `buf` of the list item
     * Returns: whether `i` is at a list item of the same type as this list
     */
    private isAtItemInThisList(buf: OutBuffer, iLineStart: number, i: number): boolean {
        const item = (this.type === 0x2e /* '.' */ || this.type === 0x29 /* ')' */) ?
            MarkdownList.parseOrderedListItem(buf, iLineStart, i) :
            MarkdownList.parseUnorderedListItem(buf, iLineStart, i);
        if (item.type === this.type)
            return item.delimiterIndent < this.contentIndent && item.contentIndent > this.delimiterIndent;
        return false;
    }

    /****************************************************
     * Start a Markdown list item by creating/deleting nested lists and starting the item. (dmd/doc.d:2840)
     * Params:
     *  buf           = an OutBuffer containing the DDoc
     *  iLineStart    = the index within `buf` of the first character of the line. If this function succeeds it
     *                  will be adjuested to equal `i`.
     *  i             = the index within `buf` of the list item. If this function succeeds `i` will be adjusted to
     *                  fit the inserted macro.
     *  iPrecedingBlankLine = the index within `buf` of the preceeding blank line. If non-zero and a new list was
     *                  started, the preceeding blank line is removed and this value is set to `0`.
     *  nestedLists   = a set of nested lists. If this function succeeds it may contain a new nested list.
     * Returns: `true` if a list was created
     */
    startItem(buf: OutBuffer, iLineStart: Ref<number>, i: Ref<number>, iPrecedingBlankLine: Ref<number>,
        nestedLists: MarkdownList[]): boolean {
        buf.remove(this.iStart, this.iContentStart - this.iStart);

        if (!nestedLists.length ||
            this.delimiterIndent >= nestedLists[nestedLists.length - 1].contentIndent ||
            dsEquals(buf.opSlice(iLineStart.value - 4, iLineStart.value), ds("$(LI"))) {
            // start a list macro
            nestedLists.push(this.copy());   // `nestedLists ~= this`: appends a copy
            if (this.type === 0x2e /* '.' */) {
                if (this.orderedStart !== null && this.orderedStart.length) {
                    this.iStart = buf.insert(this.iStart, ds("$(OL_START "));
                    this.iStart = buf.insert(this.iStart, this.orderedStart);
                    this.iStart = buf.insert(this.iStart, ds(",\n"));
                } else
                    this.iStart = buf.insert(this.iStart, ds("$(OL\n"));
            } else
                this.iStart = buf.insert(this.iStart, ds("$(UL\n"));

            // `removeBlankLineMacro(buf, iPrecedingBlankLine, iStart)`: `ref size_t iStart` is this field
            const iStartBox: Ref<number> = { value: this.iStart };
            removeBlankLineMacro(buf, iPrecedingBlankLine, iStartBox);
            this.iStart = iStartBox.value;
        } else if (nestedLists.length) {
            nestedLists[nestedLists.length - 1].delimiterIndent = this.delimiterIndent;
            nestedLists[nestedLists.length - 1].contentIndent = this.contentIndent;
        }

        this.iStart = buf.insert(this.iStart, ds("$(LI\n"));
        i.value = this.iStart - 1;
        iLineStart.value = i.value;

        return true;
    }

    /****************************************************
     * End all nested Markdown lists. (dmd/doc.d:2887)
     * Params:
     *  buf           = an OutBuffer containing the DDoc
     *  i             = the index within `buf` to end lists at.
     *  nestedLists   = a set of nested lists. Upon return it will be empty.
     * Returns: the amount that `i` changed
     */
    static endAllNestedLists(buf: OutBuffer, i: number, nestedLists: MarkdownList[]): number {
        const iStart = i;
        for (; nestedLists.length; --nestedLists.length)
            i = buf.insert(i, ds(")\n)"));
        return i - iStart;
    }

    /****************************************************
     * Look for a sibling list item or the end of nested list(s). (dmd/doc.d:2903)
     * Params:
     *  buf               = an OutBuffer containing the DDoc
     *  i                 = the index within `buf` to end lists at. If there was a sibling or ending lists `i`
     *                      will be adjusted to fit the macro endings.
     *  iParagraphStart   = the index within `buf` to start the next paragraph at at. May be adjusted upon return.
     *  nestedLists       = a set of nested lists. Some nested lists may have been removed from it upon return.
     */
    static handleSiblingOrEndingList(buf: OutBuffer, i: Ref<number>, iParagraphStart: Ref<number>,
        nestedLists: MarkdownList[]): void {
        const iAfterSpaces = skipChars(buf, i.value + 1, ds(" \t"));

        if (nestedLists[nestedLists.length - 1].isAtItemInThisList(buf, i.value + 1, iAfterSpaces)) {
            // end a sibling list item
            i.value = buf.insert(i.value, ds(")"));
            iParagraphStart.value = skipChars(buf, i.value, ds(" \t\r\n"));
        } else if (iAfterSpaces >= buf.length() ||
            (buf.opIndex(iAfterSpaces) !== 0x0d && buf.opIndex(iAfterSpaces) !== 0x0a)) {
            // end nested lists that are indented more than this content
            const indent = getMarkdownIndent(buf, i.value + 1, iAfterSpaces);
            while (nestedLists.length && nestedLists[nestedLists.length - 1].contentIndent > indent) {
                i.value = buf.insert(i.value, ds(")\n)"));
                --nestedLists.length;
                iParagraphStart.value = skipChars(buf, i.value, ds(" \t\r\n"));

                if (nestedLists.length &&
                    nestedLists[nestedLists.length - 1].isAtItemInThisList(buf, i.value + 1, iParagraphStart.value)) {
                    i.value = buf.insert(i.value, ds(")"));
                    ++iParagraphStart.value;
                    break;
                }
            }
        }
    }

    /****************************************************
     * Parse an unordered list item at the current position (dmd/doc.d:2941)
     * Params:
     *  buf           = an OutBuffer containing the DDoc
     *  iLineStart    = the index within `buf` of the first character of the line
     *  i             = the index within `buf` of the list item
     * Returns: the parsed list item, or a list item with type `.init` if no list item is available
     */
    private static parseUnorderedListItem(buf: OutBuffer, iLineStart: number, i: number): MarkdownList {
        if (i + 1 < buf.length() &&
            (buf.opIndex(i) === 0x2d ||
                buf.opIndex(i) === 0x2a ||
                buf.opIndex(i) === 0x2b) &&
            (buf.opIndex(i + 1) === 0x20 ||
                buf.opIndex(i + 1) === 0x09 ||
                buf.opIndex(i + 1) === 0x0d ||
                buf.opIndex(i + 1) === 0x0a)) {
            const iContentStart = skipChars(buf, i + 1, ds(" \t"));
            const delimiterIndent = getMarkdownIndent(buf, iLineStart, i);
            const contentIndent = getMarkdownIndent(buf, iLineStart, iContentStart);
            const list = new MarkdownList(null, iLineStart, iContentStart, delimiterIndent, contentIndent, 0,
                buf.opIndex(i));
            return list;
        }
        return new MarkdownList();
    }

    /****************************************************
     * Parse an ordered list item at the current position (dmd/doc.d:2969)
     * Params:
     *  buf           = an OutBuffer containing the DDoc
     *  iLineStart    = the index within `buf` of the first character of the line
     *  i             = the index within `buf` of the list item
     * Returns: the parsed list item, or a list item with type `.init` if no list item is available
     */
    private static parseOrderedListItem(buf: OutBuffer, iLineStart: number, i: number): MarkdownList {
        const iAfterNumbers = skipChars(buf, i, ds("0123456789"));
        if (iAfterNumbers - i > 0 &&
            iAfterNumbers - i <= 9 &&
            iAfterNumbers + 1 < buf.length() &&
            buf.opIndex(iAfterNumbers) === 0x2e /* '.' */ &&
            (buf.opIndex(iAfterNumbers + 1) === 0x20 ||
                buf.opIndex(iAfterNumbers + 1) === 0x09 ||
                buf.opIndex(iAfterNumbers + 1) === 0x0d ||
                buf.opIndex(iAfterNumbers + 1) === 0x0a)) {
            const iContentStart = skipChars(buf, iAfterNumbers + 1, ds(" \t"));
            const delimiterIndent = getMarkdownIndent(buf, iLineStart, i);
            const contentIndent = getMarkdownIndent(buf, iLineStart, iContentStart);
            let iNumberStart = skipChars(buf, i, ds("0"));
            if (iNumberStart === iAfterNumbers)
                --iNumberStart;
            let orderedStart: DString | null = buf.opSliceAll().subarray(iNumberStart, iAfterNumbers);
            if (dsEquals(orderedStart, ds("1")))
                orderedStart = null;
            // `orderedStart.idup`: an independent copy (null stays null)
            return new MarkdownList(orderedStart !== null ? orderedStart.slice() : null, iLineStart, iContentStart,
                delimiterIndent, contentIndent, 0, buf.opIndex(iAfterNumbers));
        }
        return new MarkdownList();
    }
}

/****************************************************
 * A Markdown link. (dmd/doc.d:2999)
 * A D value struct: copied at every D copy point through `copy()`.
 */
export class MarkdownLink { // D module-private (doc.test.ts reaches its static helpers)
    href: DString;    /// the link destination
    title: DString;   /// an optional title for the link
    label: DString;   /// an optional label for the link
    symbol: Dsymbol | null; /// an optional symbol to link to

    /// The positional struct literal `MarkdownLink(href, title, label, symbol)`; no arguments is `.init`
    /// (null strings read as empty slices).
    constructor(href: DString = dsEmpty, title: DString = dsEmpty, label: DString = dsEmpty,
        symbol: Dsymbol | null = null) {
        this.href = href;
        this.title = title;
        this.label = label;
        this.symbol = symbol;
    }

    /// The D struct copy (03 §2); the strings are never written in place, so they are shared.
    copy(): MarkdownLink {
        return new MarkdownLink(this.href, this.title, this.label, this.symbol);
    }

    /****************************************************
     * Replace a Markdown link or link definition in the form of: (dmd/doc.d:3021)
     * - Inline link: `[foo](url/ 'optional title')`
     * - Reference link: `[foo][bar]`, `[foo][]` or `[foo]`
     * - Link reference definition: `[bar]: url/ 'optional title'`
     * Params:
     *  buf               = an OutBuffer containing the DDoc
     *  i                 = the index within `buf` that points to the `]` character of the potential link.
     *                      If this function succeeds it will be adjusted to fit the inserted link macro.
     *  inlineDelimiters  = previously parsed Markdown delimiters, including emphasis and link/image starts
     *  delimiterIndex    = the index within `inlineDelimiters` of the nearest link/image starting delimiter
     *  linkReferences    = previously parsed link references. When this function returns it may contain
     *                      additional previously unparsed references.
     * Returns: whether a reference link was found and replaced at `i`
     */
    static replaceLink(buf: OutBuffer, i: Ref<number>, inlineDelimiters: MarkdownDelimiter[], delimiterIndex: number,
        linkReferences: MarkdownLinkReferences): boolean {
        const delimiter = inlineDelimiters[delimiterIndex].copy();
        let link = new MarkdownLink();

        let iEnd = link.parseReferenceDefinition(buf, i.value, delimiter);
        if (iEnd > i.value) {
            i.value = delimiter.iStart;
            link.storeAndReplaceDefinition(buf, i, iEnd, linkReferences);
            inlineDelimiters.length = delimiterIndex;
            return true;
        }

        iEnd = link.parseInlineLink(buf, i.value);
        if (iEnd === i.value) {
            iEnd = link.parseReferenceLink(buf, i.value, delimiter);
            if (iEnd > i.value) {
                const label = link.label;
                link = linkReferences.lookupReference(label, buf, i.value);
                // check rightFlanking to avoid replacing things like int[string]
                if (!link.href.length && !delimiter.rightFlanking)
                    link = linkReferences.lookupSymbol(label);
                if (!link.href.length)
                    return false;
            }
        }

        if (iEnd === i.value)
            return false;

        const delta = replaceMarkdownEmphasis(buf, inlineDelimiters, delimiterIndex);
        iEnd += delta;
        i.value += delta;
        link.replaceLink(buf, i, iEnd, delimiter);
        return true;
    }

    /****************************************************
     * Replace a Markdown link definition in the form of `[bar]: url/ 'optional title'` (dmd/doc.d:3073)
     * Params:
     *  buf               = an OutBuffer containing the DDoc
     *  i                 = the index within `buf` that points to the `]` character of the potential link.
     *                      If this function succeeds it will be adjusted to fit the inserted link macro.
     *  inlineDelimiters  = previously parsed Markdown delimiters, including emphasis and link/image starts
     *  delimiterIndex    = the index within `inlineDelimiters` of the nearest link/image starting delimiter
     *  linkReferences    = previously parsed link references. When this function returns it may contain
     *                      additional previously unparsed references.
     * Returns: whether a reference link was found and replaced at `i`
     */
    static replaceReferenceDefinition(buf: OutBuffer, i: Ref<number>, inlineDelimiters: MarkdownDelimiter[],
        delimiterIndex: number, linkReferences: MarkdownLinkReferences): boolean {
        const delimiter = inlineDelimiters[delimiterIndex].copy();
        const link = new MarkdownLink();
        const iEnd = link.parseReferenceDefinition(buf, i.value, delimiter);
        if (iEnd === i.value)
            return false;

        i.value = delimiter.iStart;
        link.storeAndReplaceDefinition(buf, i, iEnd, linkReferences);
        inlineDelimiters.length = delimiterIndex;
        return true;
    }

    /****************************************************
     * Parse a Markdown inline link in the form of `[foo](url/ 'optional title')` (dmd/doc.d:3094)
     * Params:
     *  buf   = an OutBuffer containing the DDoc
     *  i     = the index within `buf` that points to the `]` character of the inline link.
     * Returns: the index at the end of parsing the link, or `i` if parsing failed.
     */
    private parseInlineLink(buf: OutBuffer, i: number): number {
        const iEnd: Ref<number> = { value: i + 1 };   // passed by `ref` to parseHref/parseTitle
        if (iEnd.value >= buf.length() || buf.opIndex(iEnd.value) !== 0x28 /* '(' */)
            return i;
        ++iEnd.value;

        if (!this.parseHref(buf, iEnd))
            return i;

        iEnd.value = skipChars(buf, iEnd.value, ds(" \t\r\n"));
        if (buf.opIndex(iEnd.value) !== 0x29 /* ')' */) {
            if (this.parseTitle(buf, iEnd))
                iEnd.value = skipChars(buf, iEnd.value, ds(" \t\r\n"));
        }

        if (buf.opIndex(iEnd.value) !== 0x29 /* ')' */)
            return i;

        return iEnd.value + 1;
    }

    /****************************************************
     * Parse a Markdown reference link in the form of `[foo][bar]`, `[foo][]` or `[foo]` (dmd/doc.d:3125)
     * Params:
     *  buf       = an OutBuffer containing the DDoc
     *  i         = the index within `buf` that points to the `]` character of the inline link.
     *  delimiter = the delimiter that starts this link
     * Returns: the index at the end of parsing the link, or `i` if parsing failed.
     */
    private parseReferenceLink(buf: OutBuffer, i: number, delimiter: MarkdownDelimiter): number {
        const iStart: Ref<number> = { value: i + 1 };   // passed by `ref` to parseLabel
        let iEnd = iStart.value;
        if (iEnd >= buf.length())
            return i;
        if (buf.opIndex(iEnd) !== 0x5b /* '[' */ ||
            (iEnd + 1 < buf.length() && buf.opIndex(iEnd + 1) === 0x5d /* ']' */)) {
            // collapsed reference [foo][] or shortcut reference [foo]
            iStart.value = delimiter.iStart + delimiter.count - 1;
            if (buf.opIndex(iEnd) === 0x5b)
                iEnd += 2;
        }

        this.parseLabel(buf, iStart);
        if (!this.label.length)
            return i;

        if (iEnd < iStart.value)
            iEnd = iStart.value;
        return iEnd;
    }

    /****************************************************
     * Parse a Markdown reference definition in the form of `[bar]: url/ 'optional title'` (dmd/doc.d:3156)
     * Params:
     *  buf               = an OutBuffer containing the DDoc
     *  i                 = the index within `buf` that points to the `]` character of the inline link.
     *  delimiter = the delimiter that starts this link
     * Returns: the index at the end of parsing the link, or `i` if parsing failed.
     */
    private parseReferenceDefinition(buf: OutBuffer, i: number, delimiter: MarkdownDelimiter): number {
        if (!delimiter.atParagraphStart || delimiter.type !== 0x5b /* '[' */ ||
            i + 1 >= buf.length() || buf.opIndex(i + 1) !== 0x3a /* ':' */)
            return i;

        const iEnd: Ref<number> = { value: delimiter.iStart };
        this.parseLabel(buf, iEnd);
        if (this.label.length === 0 || iEnd.value !== i + 1)
            return i;

        ++iEnd.value;
        iEnd.value = skipChars(buf, iEnd.value, ds(" \t"));
        MarkdownLink.skipOneNewline(buf, iEnd);

        if (!this.parseHref(buf, iEnd) || this.href.length === 0)
            return i;

        iEnd.value = skipChars(buf, iEnd.value, ds(" \t"));
        const requireNewline = !MarkdownLink.skipOneNewline(buf, iEnd);
        const iBeforeTitle = iEnd.value;

        if (this.parseTitle(buf, iEnd)) {
            iEnd.value = skipChars(buf, iEnd.value, ds(" \t"));
            if (iEnd.value < buf.length() && buf.opIndex(iEnd.value) !== 0x0d && buf.opIndex(iEnd.value) !== 0x0a) {
                // the title must end with a newline
                this.title = this.title.subarray(0, 0);   // title.length = 0
                iEnd.value = iBeforeTitle;
            }
        }

        iEnd.value = skipChars(buf, iEnd.value, ds(" \t"));
        if (requireNewline && iEnd.value < buf.length() - 1 && buf.opIndex(iEnd.value) !== 0x0d &&
            buf.opIndex(iEnd.value) !== 0x0a)
            return i;

        return iEnd.value;
    }

    /****************************************************
     * Parse and normalize a Markdown reference label (dmd/doc.d:3204)
     * Params:
     *  buf   = an OutBuffer containing the DDoc
     *  i     = the index within `buf` that points to the `[` character at the start of the label.
     *          If this function returns a non-empty label then `i` will point just after the ']' at the end of
     *          the label.
     * Returns: the parsed and normalized label, possibly empty
     */
    private parseLabel(buf: OutBuffer, i: Ref<number>): boolean {
        if (buf.opIndex(i.value) !== 0x5b /* '[' */)
            return false;

        const slice = buf.opSliceAll();
        let j = i.value + 1;

        // Some labels have already been en-symboled; handle that
        const inSymbol = j + 15 < slice.length && dsEquals(slice.subarray(j, j + 15), ds("$(DDOC_PSYMBOL "));
        if (inSymbol)
            j += 15;

        // SHARED-ARM: `case ']'`, the target of the jump at dmd/doc.d:3233: a terminal arm (it returns on
        // both paths), so it is a local arrow and the jump site returns its result (06 §3.6)
        const closeArm = (): boolean => {
            if (this.label.length && this.label[this.label.length - 1] === 0x20)
                this.label = this.label.subarray(0, this.label.length - 1);   // --label.length
            if (this.label.length) {
                i.value = j + 1;
                return true;
            }
            return false;
        };
        // `default`, the target of the jump at dmd/doc.d:3235
        const defaultArm = (c: number): void => {
            this.label = dsConcat(this.label, Uint8Array.of(c));   // label ~= c
        };
        for (; j < slice.length; ++j) {
            const c = slice[j];
            switch (c) {
                case 0x20 /* ' ' */:
                case 0x09 /* '\t' */:
                case 0x0d /* '\r' */:
                case 0x0a /* '\n' */:
                    if (this.label.length && this.label[this.label.length - 1] !== 0x20)
                        this.label = dsConcat(this.label, ds(" "));
                    break;
                case 0x29 /* ')' */:
                    if (inSymbol && j + 1 < slice.length && slice[j + 1] === 0x5d /* ']' */) {
                        ++j;
                        return closeArm(); // goto case ']' (dmd/doc.d:3233)
                    }
                    defaultArm(c); // goto default (dmd/doc.d:3235)
                    break;
                case 0x5b /* '[' */:
                    if (slice[j - 1] !== 0x5c /* '\\' */) {
                        this.label = this.label.subarray(0, 0);   // label.length = 0
                        return false;
                    }
                    break;
                case 0x5d /* ']' */:
                    return closeArm();
                default:
                    defaultArm(c);
                    break;
            }
        }
        this.label = this.label.subarray(0, 0);   // label.length = 0
        return false;
    }

    /****************************************************
     * Parse and store a Markdown link URL, optionally enclosed in `<>` brackets (dmd/doc.d:3269)
     * Params:
     *  buf   = an OutBuffer containing the DDoc
     *  i     = the index within `buf` that points to the first character of the URL.
     *          If this function succeeds `i` will point just after the end of the URL.
     * Returns: whether a URL was found and parsed
     */
    private parseHref(buf: OutBuffer, i: Ref<number>): boolean {
        let j = skipChars(buf, i.value, ds(" \t"));

        let iHrefStart = j;
        let parenDepth = 1;
        let inPointy = false;
        const slice = buf.opSliceAll();
        // BLOCK-EXIT: `break LReturnHref` is the jump to LReturnHref (dmd/doc.d:3290/:3301/:3313)
        LReturnHref: {
            for (; j < slice.length; j++) {
                switch (slice[j]) {
                    case 0x3c /* '<' */:
                        if (!inPointy && j === iHrefStart) {
                            inPointy = true;
                            ++iHrefStart;
                        }
                        break;
                    case 0x3e /* '>' */:
                        if (inPointy && slice[j - 1] !== 0x5c /* '\\' */)
                            break LReturnHref; // goto LReturnHref (dmd/doc.d:3290)
                        break;
                    case 0x28 /* '(' */:
                        if (!inPointy && slice[j - 1] !== 0x5c)
                            ++parenDepth;
                        break;
                    case 0x29 /* ')' */:
                        if (!inPointy && slice[j - 1] !== 0x5c) {
                            --parenDepth;
                            if (!parenDepth)
                                break LReturnHref; // goto LReturnHref (dmd/doc.d:3301)
                        }
                        break;
                    case 0x20 /* ' ' */:
                    case 0x09 /* '\t' */:
                    case 0x0d /* '\r' */:
                    case 0x0a /* '\n' */:
                        if (inPointy) {
                            // invalid link
                            return false;
                        }
                        break LReturnHref; // goto LReturnHref (dmd/doc.d:3313)
                    default:
                        break;
                }
            }
            if (inPointy)
                return false;
        }
        // LReturnHref:
        const href = slice.slice(iHrefStart, j);   // `.dup`
        this.href = replaceChar(MarkdownLink.percentEncode(MarkdownLink.removeEscapeBackslashes(href)), 0x2c,
            ds("$(COMMA)"));
        i.value = j;
        if (inPointy)
            ++i.value;
        return true;
    }

    /****************************************************
     * Parse and store a Markdown link title, enclosed in parentheses or `'` or `"` quotes (dmd/doc.d:3337)
     * Params:
     *  buf   = an OutBuffer containing the DDoc
     *  i     = the index within `buf` that points to the first character of the title.
     *          If this function succeeds `i` will point just after the end of the title.
     * Returns: whether a title was found and parsed
     */
    private parseTitle(buf: OutBuffer, i: Ref<number>): boolean {
        let j = skipChars(buf, i.value, ds(" \t"));
        if (j >= buf.length())
            return false;

        let type = buf.opIndex(j);
        if (type !== 0x22 /* '"' */ && type !== 0x27 /* '\'' */ && type !== 0x28 /* '(' */)
            return false;
        if (type === 0x28)
            type = 0x29 /* ')' */;

        const iTitleStart = j + 1;
        let iNewline = 0;
        const slice = buf.opSliceAll();
        // BLOCK-EXIT: `break LEndTitle` is the jump to LEndTitle (dmd/doc.d:3361)
        LEndTitle: {
            for (j = iTitleStart; j < slice.length; j++) {
                const c = slice[j];
                switch (c) {
                    case 0x29 /* ')' */:
                    case 0x22 /* '"' */:
                    case 0x27 /* '\'' */:
                        if (type === c && slice[j - 1] !== 0x5c /* '\\' */)
                            break LEndTitle; // goto LEndTitle (dmd/doc.d:3361)
                        iNewline = 0;
                        break;
                    case 0x20 /* ' ' */:
                    case 0x09 /* '\t' */:
                    case 0x0d /* '\r' */:
                        break;
                    case 0x0a /* '\n' */:
                        if (iNewline) {
                            // no blank lines in titles
                            return false;
                        }
                        iNewline = j;
                        break;
                    default:
                        iNewline = 0;
                        break;
                }
            }
            return false;
        }
        // LEndTitle:
        const title = slice.slice(iTitleStart, j);   // `.dup`
        this.title = replaceChar(replaceChar(MarkdownLink.removeEscapeBackslashes(title), 0x2c, ds("$(COMMA)")),
            0x22, ds("$(QUOTE)"));
        i.value = j + 1;
        return true;
    }

    /****************************************************
     * Replace a Markdown link or image with the appropriate macro (dmd/doc.d:3400)
     * Params:
     *  buf       = an OutBuffer containing the DDoc
     *  i         = the index within `buf` that points to the `]` character of the inline link.
     *              When this function returns it will be adjusted to the end of the inserted macro.
     *  iLinkEnd  = the index within `buf` that points just after the last character of the link
     *  delimiter = the Markdown delimiter that started the link or image
     */
    private replaceLink(buf: OutBuffer, i: Ref<number>, iLinkEnd: number, delimiter: MarkdownDelimiter): void {
        let iAfterLink = i.value - delimiter.count;
        let macroName: DString;
        if (this.symbol !== null) {
            macroName = ds("$(SYMBOL_LINK ");
        } else if (this.title.length) {
            if (delimiter.type === 0x5b /* '[' */)
                macroName = ds("$(LINK_TITLE ");
            else
                macroName = ds("$(IMAGE_TITLE ");
        } else {
            if (delimiter.type === 0x5b)
                macroName = ds("$(LINK2 ");
            else
                macroName = ds("$(IMAGE ");
        }
        buf.remove(delimiter.iStart, delimiter.count);
        buf.remove(i.value - delimiter.count, iLinkEnd - i.value);
        iLinkEnd = buf.insert(delimiter.iStart, macroName);
        iLinkEnd = buf.insert(iLinkEnd, this.href);
        iLinkEnd = buf.insert(iLinkEnd, ds(", "));
        iAfterLink += macroName.length + this.href.length + 2;
        if (this.title.length) {
            iLinkEnd = buf.insert(iLinkEnd, this.title);
            iLinkEnd = buf.insert(iLinkEnd, ds(", "));
            iAfterLink += this.title.length + 2;

            // Link macros with titles require escaping commas
            for (let j = iLinkEnd; j < iAfterLink; ++j)
                if (buf.opIndex(j) === 0x2c /* ',' */) {
                    buf.remove(j, 1);
                    j = buf.insert(j, ds("$(COMMA)")) - 1;
                    iAfterLink += 7;
                }
        }
        // TODO: if image, remove internal macros, leaving only text
        buf.insert(iAfterLink, ds(")"));
        i.value = iAfterLink;
    }

    /****************************************************
     * Store the Markdown link definition and remove it from `buf` (dmd/doc.d:3458)
     * Params:
     *  buf               = an OutBuffer containing the DDoc
     *  i                 = the index within `buf` that points to the `[` character at the start of the link definition.
     *                      When this function returns it will be adjusted to exclude the link definition.
     *  iEnd              = the index within `buf` that points just after the end of the definition
     *  linkReferences    = previously parsed link references. When this function returns it may contain
     *                      an additional reference.
     */
    private storeAndReplaceDefinition(buf: OutBuffer, i: Ref<number>, iEnd: number,
        linkReferences: MarkdownLinkReferences): void {
        // Remove the definition and trailing whitespace
        iEnd = skipChars(buf, iEnd, ds(" \t\r\n"));
        buf.remove(i.value, iEnd - i.value);
        i.value -= 2;

        const lowercaseLabel = keyOf(toLowercase(this.label));
        if (!linkReferences.references.has(lowercaseLabel))
            linkReferences.references.set(lowercaseLabel, this.copy());
    }

    /****************************************************
     * Remove Markdown escaping backslashes from the given string (dmd/doc.d:3476)
     * Params:
     *  s = the string to remove escaping backslashes from
     * Returns: `s` without escaping backslashes in it (`s` is rewritten in place, as in D)
     */
    static removeEscapeBackslashes(s: DString): DString { // D module-private
        if (!s.length)
            return s;

        // avoid doing anything if there isn't anything to escape
        let i: number;
        for (i = 0; i < s.length - 1; ++i)
            if (s[i] === 0x5c /* '\\' */ && ispunct(s[i + 1]))
                break;
        if (i === s.length - 1)
            return s;

        // copy characters backwards, then truncate
        let j = i + 1;
        s[i] = s[j];
        for (++i, ++j; j < s.length; ++i, ++j) {
            if (j < s.length - 1 && s[j] === 0x5c && ispunct(s[j + 1]))
                ++j;
            s[i] = s[j];
        }
        return s.subarray(0, s.length - (j - i));   // s.length -= (j - i)
    }

    /****************************************************
     * Percent-encode (AKA URL-encode) the given string (dmd/doc.d:3520)
     * Params:
     *  s = the string to percent-encode
     * Returns: `s` with special characters percent-encoded
     */
    static percentEncode(s: DString): DString { // D module-private
        const shouldEncode = (c: number): boolean => {
            return ((c < 0x30 && c !== 0x21 && c !== 0x23 && c !== 0x24 && c !== 0x25 && c !== 0x26 && c !== 0x27 &&
                    c !== 0x28 && c !== 0x29 && c !== 0x2a && c !== 0x2b && c !== 0x2c && c !== 0x2d && c !== 0x2e &&
                    c !== 0x2f)
                || (c > 0x39 && c < 0x41 && c !== 0x3a && c !== 0x3b && c !== 0x3d && c !== 0x3f && c !== 0x40)
                || (c > 0x5a && c < 0x61 && c !== 0x5b && c !== 0x5d && c !== 0x5f)
                || (c > 0x7a && c !== 0x7e));
        };

        for (let i = 0; i < s.length; ++i) {
            if (shouldEncode(s[i])) {
                const hexDigits = ds("0123456789ABCDEF");
                const encoded1 = hexDigits[s[i] >> 4];
                const encoded2 = hexDigits[s[i] & 0x0f];
                s = dsConcat(s.subarray(0, i), Uint8Array.of(0x25 /* '%' */, encoded1, encoded2), s.subarray(i + 1));
                i += 2;
            }
        }
        return s;
    }

    /**************************************************
     * Skip a single newline at `i` (dmd/doc.d:3561)
     * Params:
     *  buf   = an OutBuffer containing the DDoc
     *  i     = the index within `buf` to start looking at.
     *          If this function succeeds `i` will point after the newline.
     * Returns: whether a newline was skipped
     */
    private static skipOneNewline(buf: OutBuffer, i: Ref<number>): boolean {
        if (i.value < buf.length() && buf.opIndex(i.value) === 0x0d)
            ++i.value;
        if (i.value < buf.length() && buf.opIndex(i.value) === 0x0a) {
            ++i.value;
            return true;
        }
        return false;
    }
}

/// The key of a `MarkdownLink[string]` AA: an injective Latin-1 encoding of the bytes (the dmacro.ts
/// `keyOf` scheme), so two keys are equal exactly when the D strings are.
function keyOf(str: DString): string {
    let s = "";
    for (let i = 0; i < str.length; i++) s += String.fromCharCode(str[i]);
    return s;
}

/**************************************************
 * A set of Markdown link references. (dmd/doc.d:3577) Held by `ref` in D: a reference class.
 */
export class MarkdownLinkReferences { // D module-private (doc.test.ts reaches `split`)
    references: Map<string, MarkdownLink> = new Map();    // link references keyed by normalized label
    symbols: Map<string, MarkdownLink> = new Map();       // link symbols keyed by name
    _scope: Scope | null = null;      // the current scope
    extractedAll = false;  // the index into the buffer of the last-parsed reference

    /**************************************************
     * Look up a reference by label, searching through the rest of the buffer if needed.
     * Symbols in the current scope are searched for if the DDoc doesn't define the reference. (dmd/doc.d:3593)
     * Params:
     *  label = the label to find the reference for
     *  buf   = an OutBuffer containing the DDoc
     *  i     = the index within `buf` to start searching for references at
     * Returns: a link. If the `href` member has a value then the reference is valid.
     */
    lookupReference(label: DString, buf: OutBuffer, i: number): MarkdownLink {
        const lowercaseLabel = keyOf(toLowercase(label));
        if (!this.references.has(lowercaseLabel))
            this.extractReferences(buf, i);

        if (this.references.has(lowercaseLabel))
            return this.references.get(lowercaseLabel)!.copy();

        return new MarkdownLink();
    }

    /**
     * Look up the link for the D symbol with the given name.
     * If found, the link is cached in the `symbols` member. (dmd/doc.d:3612)
     * Params:
     *  name  = the name of the symbol
     * Returns: the link for the symbol or a link with a `null` href
     */
    lookupSymbol(name: DString): MarkdownLink {
        const key = keyOf(name);
        if (this.symbols.has(key))
            return this.symbols.get(key)!.copy();

        const ids = MarkdownLinkReferences.split(name, 0x2e /* '.' */);

        let link = new MarkdownLink();
        let id = Identifier.lookup(ids[0]);
        if (id !== null) {
            const loc = Loc.initial;
            const pscopesym: Ref<Dsymbol | null> = { value: null };
            let symbol = searchScope(this._scope!, loc, id, pscopesym, SearchOpt.ignoreErrors);
            for (let i = 1; symbol !== null && i < ids.length; ++i) {
                id = Identifier.lookup(ids[i]);
                symbol = id !== null ? search(symbol, loc, id, SearchOpt.ignoreErrors) : null;
            }
            if (symbol !== null)
                link = new MarkdownLink(this.createHref(symbol), dsEmpty, name, symbol);
        }

        this.symbols.set(key, link.copy());
        return link;
    }

    /**************************************************
     * Remove and store all link references from the document, in the form of
     * `[label]: href "optional title"` (dmd/doc.d:3647)
     * Params:
     *  buf   = an OutBuffer containing the DDoc
     *  i     = the index within `buf` to start looking at
     * Returns: whether a reference was extracted
     */
    private extractReferences(buf: OutBuffer, i: number): void {
        const isFollowedBySpace = (buf: OutBuffer, i: number): boolean => {
            return i + 1 < buf.length() && (buf.opIndex(i + 1) === 0x20 || buf.opIndex(i + 1) === 0x09);
        };

        if (this.extractedAll)
            return;

        let leadingBlank = false;
        let inCode = 0;   // `int inCode = false;`
        let newParagraph = true;
        const delimiters: MarkdownDelimiter[] = [];
        for (; i < buf.length(); ++i) {
            const c = buf.opIndex(i);
            // The jumps to case '+' and to case '`' (dmd/doc.d:3726/:3728) reach arms that are straight-line
            // statements ending in `break`: each arm body is a local arrow (06 §3.6(b)).
            const plusArm = (): void => {
                if (leadingBlank && !inCode && isFollowedBySpace(buf, i))
                    newParagraph = true;
                else
                    leadingBlank = false;
            };
            const backtickArm = (): void => {
                if (leadingBlank && i + 2 < buf.length() && buf.opIndex(i + 1) === c && buf.opIndex(i + 2) === c) {
                    inCode = inCode === c ? 0 : c;   // `inCode == c ? false : c`
                    i = skipChars(buf, i, Uint8Array.of(c)) - 1;
                    newParagraph = true;
                }
                leadingBlank = false;
            };
            switch (c) {
                case 0x20 /* ' ' */:
                case 0x09 /* '\t' */:
                    break;
                case 0x0a /* '\n' */:
                    if (leadingBlank && !inCode)
                        newParagraph = true;
                    leadingBlank = true;
                    break;
                case 0x5c /* '\\' */:
                    ++i;
                    break;
                case 0x23 /* '#' */:
                    if (leadingBlank && !inCode)
                        newParagraph = true;
                    leadingBlank = false;
                    break;
                case 0x3e /* '>' */:
                    if (leadingBlank && !inCode)
                        newParagraph = true;
                    break;
                case 0x2b /* '+' */:
                    plusArm();
                    break;
                case 0x30: case 0x31: case 0x32: case 0x33: case 0x34:
                case 0x35: case 0x36: case 0x37: case 0x38: case 0x39: // case '0': .. case '9':
                    if (leadingBlank && !inCode) {
                        i = skipChars(buf, i, ds("0123456789"));
                        if (i < buf.length() &&
                            (buf.opIndex(i) === 0x2e || buf.opIndex(i) === 0x29) &&
                            isFollowedBySpace(buf, i))
                            newParagraph = true;
                        else
                            leadingBlank = false;
                    }
                    break;
                case 0x2a /* '*' */:
                    if (leadingBlank && !inCode) {
                        newParagraph = true;
                        if (!isFollowedBySpace(buf, i))
                            leadingBlank = false;
                    }
                    break;
                case 0x60 /* '`' */:
                case 0x7e /* '~' */:
                    backtickArm();
                    break;
                case 0x2d /* '-' */:
                    if (leadingBlank && !inCode && isFollowedBySpace(buf, i)) {
                        plusArm(); // goto case '+' (dmd/doc.d:3726)
                        break;
                    } else {
                        backtickArm(); // goto case '`' (dmd/doc.d:3728)
                        break;
                    }
                case 0x5b /* '[' */:
                    if (leadingBlank && !inCode && newParagraph)
                        delimiters.push(new MarkdownDelimiter(i, 1, 0, false, false, true, c));
                    break;
                case 0x5d /* ']' */: {
                    const iBox: Ref<number> = { value: i };
                    if (delimiters.length && !inCode &&
                        MarkdownLink.replaceReferenceDefinition(buf, iBox, delimiters, delimiters.length - 1, this))
                        --iBox.value;
                    i = iBox.value;
                    break;
                }
                default:
                    if (leadingBlank)
                        newParagraph = false;
                    leadingBlank = false;
                    break;
            }
        }
        this.extractedAll = true;
    }

    /**
     * Split a string by a delimiter, excluding the delimiter. (dmd/doc.d:3755)
     * Params:
     *  s         = the string to split
     *  delimiter = the character to split by
     * Returns: the resulting array of strings
     */
    static split(s: DString, delimiter: number): DString[] { // D module-private
        const result: DString[] = [];
        let iStart = 0;
        for (let i = 0; i < s.length; i++)
            if (s[i] === delimiter) {
                result.push(s.subarray(iStart, i));
                iStart = i + 1;
            }
        result.push(s.subarray(iStart));
        return result;
    }

    /**
     * Create a HREF for the given D symbol.
     * The HREF is relative to the current location if possible. (dmd/doc.d:3787)
     * Params:
     *  symbol    = the symbol to create a HREF for.
     * Returns: the resulting href
     */
    private createHref(symbol: Dsymbol | null): DString {
        let root = symbol!;

        let lref = dsEmpty;
        while (symbol !== null && symbol.ident !== null && symbol.isModule() === null) {
            if (lref.length)
                lref = dsConcat(ds("."), lref);
            lref = dsConcat(symbol.ident.toString(), lref);
            symbol = symbol.parent;
        }

        let path = dsEmpty;
        if (symbol !== null && symbol.ident !== null && symbol.isModule() !== this._scope!._module) {
            do {
                root = symbol!;

                // If the module has a file name, we're done
                const m = symbol!.isModule();
                if (m !== null)
                    if (m.docfile.toBool()) {
                        path = m.docfile.toString();
                        break;
                    }

                if (path.length)
                    path = dsConcat(ds("_"), path);
                path = dsConcat(symbol!.ident!.toString(), path);
                symbol = symbol!.parent;
            } while (symbol !== null && symbol.ident !== null);

            if (symbol === null && path.length)
                path = dsConcat(path, ds("$(DOC_EXTENSION)"));
        }

        // Attempt an absolute URL if not in the same package
        while (root.parent !== null)
            root = root.parent;
        let scopeRoot = asDsymbol(this._scope!._module!);
        while (scopeRoot.parent !== null)
            scopeRoot = scopeRoot.parent;
        if (scopeRoot !== root) {
            path = dsConcat(ds("$(DOC_ROOT_"), root.ident!.toString(), ds(")"), path);
            lref = dsConcat(ds("."), lref);  // remote URIs like Phobos and Mir use .prefixes
        }

        return dsConcat(path, ds("#"), lref);
    }
}

/// dmd/doc.d:3841
enum TableColumnAlignment {
    none,
    left,
    center,
    right,
}

/****************************************************
 * Parse a Markdown table delimiter row in the form of `| -- | :-- | :--: | --: |`
 * where the example text has four columns with the following alignments:
 * default, left, center, and right. The first and last pipes are optional. If a
 * delimiter row is found it will be removed from `buf`. (dmd/doc.d:3862)
 *
 * Params:
 *  buf     = an OutBuffer containing the DDoc
 *  iStart  = the index within `buf` that the delimiter row starts at
 *  inQuote   = whether the table is inside a quote
 *  columnAlignments = alignments to populate for each column
 * Returns: the index of the end of the parsed delimiter, or `0` if not found
 */
function parseTableDelimiterRow(buf: OutBuffer, iStart: number, inQuote: boolean,
    columnAlignments: TableColumnAlignment[]): number {
    let i = skipChars(buf, iStart, inQuote ? ds(">| \t") : ds("| \t"));
    while (i < buf.length() && buf.opIndex(i) !== 0x0d && buf.opIndex(i) !== 0x0a) {
        const leftColon = buf.opIndex(i) === 0x3a /* ':' */;
        if (leftColon)
            ++i;

        if (i >= buf.length() || buf.opIndex(i) !== 0x2d /* '-' */)
            break;
        i = skipChars(buf, i, ds("-"));

        const rightColon = i < buf.length() && buf.opIndex(i) === 0x3a;
        i = skipChars(buf, i, ds(": \t"));

        if (i >= buf.length() ||
            (buf.opIndex(i) !== 0x7c /* '|' */ && buf.opIndex(i) !== 0x0d && buf.opIndex(i) !== 0x0a))
            break;
        i = skipChars(buf, i, ds("| \t"));

        columnAlignments.push((leftColon && rightColon) ? TableColumnAlignment.center :
            leftColon ? TableColumnAlignment.left :
                rightColon ? TableColumnAlignment.right :
                    TableColumnAlignment.none);
    }

    if (i < buf.length() && buf.opIndex(i) !== 0x0d && buf.opIndex(i) !== 0x0a && buf.opIndex(i) !== 0x29 /* ')' */) {
        columnAlignments.length = 0;
        return 0;
    }

    if (i < buf.length() && buf.opIndex(i) === 0x0d) ++i;
    if (i < buf.length() && buf.opIndex(i) === 0x0a) ++i;
    return i;
}

/****************************************************
 * Look for a table delimiter row, and if found parse the previous row as a
 * table header row. If both exist with a matching number of columns, start a
 * table. (dmd/doc.d:3913)
 *
 * Params:
 *  buf       = an OutBuffer containing the DDoc
 *  iStart    = the index within `buf` that the table header row starts at, inclusive
 *  iEnd      = the index within `buf` that the table header row ends at, exclusive
 *  inQuote   = whether the table is inside a quote
 *  inlineDelimiters = delimiters containing columns separators and any inline emphasis
 *  columnAlignments = the parsed alignments for each column
 * Returns: the number of characters added by starting the table, or `0` if unchanged
 */
function startTable(buf: OutBuffer, iStart: number, iEnd: number, inQuote: boolean,
    inlineDelimiters: MarkdownDelimiter[], columnAlignments: TableColumnAlignment[]): number {
    columnAlignments.length = 0;   // `out TableColumnAlignment[] columnAlignments`: reset on entry (03 §3.3)
    const iDelimiterRowEnd = parseTableDelimiterRow(buf, iEnd + 1, inQuote, columnAlignments);
    if (iDelimiterRowEnd) {
        const delta: Ref<number> = { value: 0 };
        if (replaceTableRow(buf, iStart, iEnd, inlineDelimiters, columnAlignments, true, delta)) {
            buf.remove(iEnd + delta.value, iDelimiterRowEnd - iEnd);
            buf.insert(iEnd + delta.value, ds("$(TBODY "));
            buf.insert(iStart, ds("$(TABLE "));
            return delta.value + 15;
        }
    }

    columnAlignments.length = 0;
    return 0;
}

/****************************************************
 * Replace a Markdown table row in the form of table cells delimited by pipes:
 * `| cell | cell | cell`. The first and last pipes are optional. (dmd/doc.d:3948)
 *
 * Params:
 *  buf       = an OutBuffer containing the DDoc
 *  iStart    = the index within `buf` that the table row starts at, inclusive
 *  iEnd      = the index within `buf` that the table row ends at, exclusive
 *  inlineDelimiters = delimiters containing columns separators and any inline emphasis
 *  columnAlignments = alignments for each column
 *  headerRow = if `true` then the number of columns will be enforced to match
 *              `columnAlignments.length` and the row will be surrounded by a
 *              `THEAD` macro
 *  delta     = the number of characters added by replacing the row, or `0` if unchanged
 * Returns: `true` if a table row was found and replaced
 */
function replaceTableRow(buf: OutBuffer, iStart: number, iEnd: number, inlineDelimiters: MarkdownDelimiter[],
    columnAlignments: readonly TableColumnAlignment[], headerRow: boolean, delta: Ref<number>): boolean {
    delta.value = 0;

    if (!columnAlignments.length || iStart === iEnd)
        return false;

    iStart = skipChars(buf, iStart, ds(" \t"));
    let cellCount = 0;
    for (const delimiter of inlineDelimiters)
        if (delimiter.type === 0x7c /* '|' */ && !delimiter.leftFlanking)
            ++cellCount;
    let ignoreLast = inlineDelimiters.length > 0 && inlineDelimiters[inlineDelimiters.length - 1].type === 0x7c;
    if (ignoreLast) {
        const last = inlineDelimiters[inlineDelimiters.length - 1];
        const iLast = skipChars(buf, last.iStart + last.count, ds(" \t"));
        ignoreLast = iLast >= iEnd;
    }
    if (!ignoreLast)
        ++cellCount;

    if (headerRow && cellCount !== columnAlignments.length)
        return false;

    const replaceTableCell = (iCellStart: number, iCellEnd: number, cellIndex: number, di: number): void => {
        const eDelta = replaceMarkdownEmphasis(buf, inlineDelimiters, di);
        delta.value += eDelta;
        iCellEnd += eDelta;

        // strip trailing whitespace and delimiter
        let i = iCellEnd - 1;
        while (i > iCellStart && (buf.opIndex(i) === 0x7c || buf.opIndex(i) === 0x20 || buf.opIndex(i) === 0x09))
            --i;
        ++i;
        buf.remove(i, iCellEnd - i);
        delta.value -= iCellEnd - i;
        iCellEnd = i;

        buf.insert(iCellEnd, ds(")"));
        ++delta.value;

        // strip initial whitespace and delimiter
        i = skipChars(buf, iCellStart, ds("| \t"));
        buf.remove(iCellStart, i - iCellStart);
        delta.value -= i - iCellStart;

        // The jumps to `default` (dmd/doc.d:4004/:4008/:4012): the default arm is a local arrow, called by the
        // jump sites (06 §3.6); from `right` it is textually next and the arm falls through to it.
        const defaultArm = (): void => {
            buf.insert(iCellStart, headerRow ? ds("$(TH_ALIGN ") : ds("$(TD_ALIGN "));
            delta.value += 11;
        };
        switch (columnAlignments[cellIndex]) {
            case TableColumnAlignment.none:
                buf.insert(iCellStart, headerRow ? ds("$(TH ") : ds("$(TD "));
                delta.value += 5;
                break;
            case TableColumnAlignment.left:
                buf.insert(iCellStart, ds("left, "));
                delta.value += 6;
                defaultArm(); // goto default (dmd/doc.d:4004)
                break;
            case TableColumnAlignment.center:
                buf.insert(iCellStart, ds("center, "));
                delta.value += 8;
                defaultArm(); // goto default (dmd/doc.d:4008)
                break;
            case TableColumnAlignment.right:
                buf.insert(iCellStart, ds("right, "));
                delta.value += 7;
                // goto default (dmd/doc.d:4012); -> fall through to the next arm (JS no-break fallthrough)
            // eslint-disable-next-line no-fallthrough
            default:
                defaultArm();
                break;
        }
    };

    let cellIndex = cellCount - 1;
    let iCellEnd = iEnd;
    // `foreach_reverse (di, delimiter; inlineDelimiters)` walks the slice it started with: the length is
    // read once and each element is read (copied) from that memory, while replaceTableCell shrinks the
    // array itself. `walked` holds the elements of that slice.
    const walked = inlineDelimiters.slice();
    for (let di = walked.length - 1; di >= 0; di--) {
        const delimiter = walked[di].copy();
        if (delimiter.type === 0x7c /* '|' */) {
            if (ignoreLast && di === inlineDelimiters.length - 1) {
                ignoreLast = false;
                continue;
            }

            if (cellIndex >= columnAlignments.length) {
                // kill any extra cells
                buf.remove(delimiter.iStart, iEnd + delta.value - delimiter.iStart);
                delta.value -= iEnd + delta.value - delimiter.iStart;
                iCellEnd = iEnd + delta.value;
                --cellIndex;
                continue;
            }

            replaceTableCell(delimiter.iStart, iCellEnd, cellIndex, di);
            iCellEnd = delimiter.iStart;
            --cellIndex;
        }
    }

    // if no starting pipe, replace from the start
    if (cellIndex >= 0)
        replaceTableCell(iStart, iCellEnd, cellIndex, 0);

    buf.insert(iEnd + delta.value, ds(")"));
    buf.insert(iStart, ds("$(TR "));
    delta.value += 6;

    if (headerRow) {
        buf.insert(iEnd + delta.value, ds(")"));
        buf.insert(iStart, ds("$(THEAD "));
        delta.value += 9;
    }

    return true;
}

/****************************************************
 * End a table, if in one. (dmd/doc.d:4075)
 *
 * Params:
 *  buf = an OutBuffer containing the DDoc
 *  i   = the index within `buf` to end the table at
 *  columnAlignments = alignments for each column; upon return is set to length `0`
 * Returns: the number of characters added by ending the table, or `0` if unchanged
 */
function endTable(buf: OutBuffer, i: number, columnAlignments: TableColumnAlignment[]): number {
    if (!columnAlignments.length)
        return 0;

    buf.insert(i, ds("))"));
    columnAlignments.length = 0;
    return 2;
}

/****************************************************
 * End a table row and then the table itself. (dmd/doc.d:4096)
 *
 * Params:
 *  buf       = an OutBuffer containing the DDoc
 *  iStart    = the index within `buf` that the table row starts at, inclusive
 *  iEnd      = the index within `buf` that the table row ends at, exclusive
 *  inlineDelimiters = delimiters containing columns separators and any inline emphasis
 *  columnAlignments = alignments for each column; upon return is set to length `0`
 * Returns: the number of characters added by replacing the row, or `0` if unchanged
 */
function endRowAndTable(buf: OutBuffer, iStart: number, iEnd: number, inlineDelimiters: MarkdownDelimiter[],
    columnAlignments: TableColumnAlignment[]): number {
    const delta: Ref<number> = { value: 0 };
    replaceTableRow(buf, iStart, iEnd, inlineDelimiters, columnAlignments, false, delta);
    delta.value += endTable(buf, iEnd + delta.value, columnAlignments);
    return delta.value;
}

/**************************************************
 * Highlight text section. (dmd/doc.d:4114)
 *
 * Params:
 *  scope = the current parse scope
 *  a     = an array of D symbols at the current scope
 *  loc   = source location of start of text. It is a mutable copy to allow incrementing its linenum,
 *          for printing the correct line number when an error is encountered in a multiline block of ddoc.
 *  buf   = an OutBuffer containing the DDoc
 *  offset = the index within buf to start highlighting
 *
 * Rewrites `buf[offset .. $]` in place: escapes `<`, `>` and `&`, turns the Markdown extensions
 * (headings, lists, quotes, tables, emphasis, links, code spans and fenced code) into Ddoc macros, and
 * wraps known identifiers in the DDOC_AUTO_* macros. An unclosed `---` code section is an error.
 */
function highlightText(sc: Scope, a: Dsymbols, loc: Loc, buf: OutBuffer, offset: number): void {
    loc = loc.copy();   // `Loc loc` is a by-value parameter that nextLine() mutates (03 §9.1, the Loc row)
    loc.nextLine();

    //printf("highlightText()\n");
    let leadingBlank = true;
    const iParagraphStart: Ref<number> = { value: offset };
    const iPrecedingBlankLine: Ref<number> = { value: 0 };
    const headingLevel: Ref<number> = { value: 0 };
    let headingMacroLevel = 0;
    const quoteLevel: Ref<number> = { value: 0 };
    let lineQuoted = false;
    const quoteMacroLevel: Ref<number> = { value: 0 };
    const nestedLists: MarkdownList[] = [];
    let inlineDelimiters: MarkdownDelimiter[] = [];
    const linkReferences = new MarkdownLinkReferences();
    const columnAlignments: TableColumnAlignment[] = [];
    let tableRowDetected = false;
    let inCode = 0;
    let inBacktick = 0;
    let macroLevel = 0;
    let previousMacroLevel = 0;
    let parenLevel = 0;
    let iCodeStart = 0; // start of code section
    let codeFenceLength = 0;
    let codeIndent = 0;
    let codeLanguage = dsEmpty;
    const iLineStart: Ref<number> = { value: offset };
    linkReferences._scope = sc;
    {
        // `i` is passed by `ref` to the Markdown helpers: a box (03 §3.2)
        const i: Ref<number> = { value: offset };
        for (i.value = offset; i.value < buf.length(); i.value++) {
            let c = buf.opIndex(i.value);
            // `Lcont: switch (c)` (dmd/doc.d:4146). The jump to Lcont re-dispatches on the current `c`, and the
            // jumps to a case or to `default` enter that arm with `c` unchanged
            // (dmd/doc.d:4402/:4458/:4482/:4532/:4537/:4640/:4703):
            // `arm` is the label control enters, and `continue Ldispatch` is the jump. A §2 record covers
            // the cross-case shape.
            let arm = c;
            Ldispatch: for (;;) {
                switch (arm) {
                    case 0x20 /* ' ' */:
                    case 0x09 /* '\t' */:
                        break;
                    case 0x0a /* '\n' */:
                        if (inBacktick) {
                            // `inline code` is only valid if contained on a single line
                            // otherwise, the backticks should be output literally.
                            //
                            // This lets things like `output from the linker' display
                            // unmolested while keeping the feature consistent with GitHub.
                            inBacktick = 0;
                            inCode = 0; // the backtick also assumes we're in code
                            // Nothing else is necessary since the DDOC_BACKQUOTED macro is
                            // inserted lazily at the close quote, meaning the rest of the
                            // text is already OK.
                        }
                        if (headingLevel.value) {
                            i.value += replaceMarkdownEmphasis(buf, inlineDelimiters);
                            endMarkdownHeading(buf, iParagraphStart.value, i, headingLevel);
                            removeBlankLineMacro(buf, iPrecedingBlankLine, i);
                            ++i.value;
                            iParagraphStart.value = skipChars(buf, i.value, ds(" \t\r\n"));
                        }

                        if (tableRowDetected && !columnAlignments.length)
                            i.value += startTable(buf, iLineStart.value, i.value, lineQuoted, inlineDelimiters,
                                columnAlignments);
                        else if (columnAlignments.length) {
                            const delta: Ref<number> = { value: 0 };
                            if (replaceTableRow(buf, iLineStart.value, i.value, inlineDelimiters, columnAlignments,
                                false, delta))
                                i.value += delta.value;
                            else
                                i.value += endTable(buf, i.value, columnAlignments);
                        }

                        if (!inCode && nestedLists.length && !quoteLevel.value)
                            MarkdownList.handleSiblingOrEndingList(buf, i, iParagraphStart, nestedLists);

                        iPrecedingBlankLine.value = 0;
                        if (!inCode && i.value === iLineStart.value && i.value + 1 < buf.length()) { // if "\n\n"
                            i.value += endTable(buf, i.value, columnAlignments);
                            if (!lineQuoted && quoteLevel.value)
                                endAllListsAndQuotes(buf, i, nestedLists, quoteLevel, quoteMacroLevel);
                            i.value += replaceMarkdownEmphasis(buf, inlineDelimiters);

                            // if we don't already know about this paragraph break then
                            // insert a blank line and record the paragraph break
                            if (iParagraphStart.value <= i.value) {
                                iPrecedingBlankLine.value = i.value;
                                i.value = buf.insert(i.value, ds("$(DDOC_BLANKLINE)"));
                                iParagraphStart.value = i.value + 1;
                            }
                        } else if (inCode &&
                            i.value === iLineStart.value &&
                            i.value + 1 < buf.length() &&
                            !lineQuoted &&
                            quoteLevel.value) { // if "\n\n" in quoted code
                            inCode = 0;
                            i.value = buf.insert(i.value, ds(")"));
                            i.value += endAllMarkdownQuotes(buf, i.value, quoteLevel);
                            quoteMacroLevel.value = 0;
                        }
                        leadingBlank = true;
                        lineQuoted = false;
                        tableRowDetected = false;
                        iLineStart.value = i.value + 1;
                        loc.nextLine();

                        // update the paragraph start if we just entered a macro
                        if (previousMacroLevel < macroLevel && iParagraphStart.value < iLineStart.value)
                            iParagraphStart.value = iLineStart.value;
                        previousMacroLevel = macroLevel;
                        break;

                    case 0x3c /* '<' */: {
                        leadingBlank = false;
                        if (inCode)
                            break;
                        const slice = buf.opSliceAll();
                        let p = i.value;   // `auto p = &slice[i]`: the cursor into buf's store
                        const se = escapetable(sc._module!).escapeChar(0x3c);
                        // BLOCK-EXIT: `break L1` is the jump to L1 (dmd/doc.d:4248)
                        L1: {
                            if (se !== null && dsEquals(se, ds("&lt;"))) {
                                // Generating HTML
                                // Skip over comments
                                if (buf.opIndex(p + 1) === 0x21 /* '!' */ && buf.opIndex(p + 2) === 0x2d &&
                                    buf.opIndex(p + 3) === 0x2d) {
                                    let j = i.value + 4;
                                    p += 4;
                                    for (;;) {
                                        if (j === slice.length)
                                            break L1; // goto L1 (dmd/doc.d:4248)
                                        if (buf.opIndex(p) === 0x2d && buf.opIndex(p + 1) === 0x2d &&
                                            buf.opIndex(p + 2) === 0x3e /* '>' */) {
                                            i.value = j + 2; // place on closing '>'
                                            break;
                                        }
                                        j++;
                                        p++;
                                    }
                                    break;
                                }
                                // Skip over HTML tag
                                if (isalpha(buf.opIndex(p + 1)) || (buf.opIndex(p + 1) === 0x2f /* '/' */ &&
                                    isalpha(buf.opIndex(p + 2)))) {
                                    let j = i.value + 2;
                                    p += 2;
                                    for (;;) {
                                        if (j === slice.length)
                                            break;
                                        if (buf.opIndex(p) === 0x3e /* '>' */) {
                                            i.value = j; // place on closing '>'
                                            break;
                                        }
                                        j++;
                                        p++;
                                    }
                                    break;
                                }
                            }
                        }
                        // L1:
                        // Replace '<' with '&lt;' character entity
                        if (se !== null && se.length) {
                            buf.remove(i.value, 1);
                            i.value = buf.insert(i.value, se);
                            i.value--; // point to ';'
                        }
                        break;
                    }

                    case 0x3e /* '>' */: {
                        if (leadingBlank && (!inCode || quoteLevel.value)) {
                            lineQuoted = true;
                            let lineQuoteLevel = 1;
                            let iAfterDelimiters = i.value + 1;
                            for (; iAfterDelimiters < buf.length(); ++iAfterDelimiters) {
                                const c0 = buf.opIndex(iAfterDelimiters);
                                if (c0 === 0x3e)
                                    ++lineQuoteLevel;
                                else if (c0 !== 0x20 && c0 !== 0x09)
                                    break;
                            }
                            if (!quoteMacroLevel.value)
                                quoteMacroLevel.value = macroLevel;
                            buf.remove(i.value, iAfterDelimiters - i.value);

                            if (quoteLevel.value < lineQuoteLevel) {
                                i.value += endRowAndTable(buf, iLineStart.value, i.value, inlineDelimiters,
                                    columnAlignments);
                                if (nestedLists.length) {
                                    const indent = getMarkdownIndent(buf, iLineStart.value, i.value);
                                    if (indent < nestedLists[nestedLists.length - 1].contentIndent)
                                        i.value += MarkdownList.endAllNestedLists(buf, i.value, nestedLists);
                                }

                                for (; quoteLevel.value < lineQuoteLevel; ++quoteLevel.value) {
                                    i.value = buf.insert(i.value, ds("$(BLOCKQUOTE\n"));
                                    iLineStart.value = iParagraphStart.value = i.value;
                                }
                                --i.value;
                            } else {
                                --i.value;
                                if (nestedLists.length)
                                    MarkdownList.handleSiblingOrEndingList(buf, i, iParagraphStart, nestedLists);
                            }
                            break;
                        }

                        leadingBlank = false;
                        if (inCode)
                            break;
                        // Replace '>' with '&gt;' character entity
                        const se = escapetable(sc._module!).escapeChar(0x3e);
                        if (se !== null && se.length) {
                            buf.remove(i.value, 1);
                            i.value = buf.insert(i.value, se);
                            i.value--; // point to ';'
                        }
                        break;
                    }

                    case 0x26 /* '&' */: {
                        leadingBlank = false;
                        if (inCode)
                            break;
                        const p = i.value;   // `char* p = cast(char*)&buf[].ptr[i]`
                        if (buf.opIndex(p + 1) === 0x23 /* '#' */ || isalpha(buf.opIndex(p + 1)))
                            break;
                        // already a character entity
                        // Replace '&' with '&amp;' character entity
                        const se = escapetable(sc._module!).escapeChar(0x26);
                        if (se !== null) {
                            buf.remove(i.value, 1);
                            i.value = buf.insert(i.value, se);
                            i.value--; // point to ';'
                        }
                        break;
                    }

                    case 0x60 /* '`' */: {
                        const iAfterDelimiter = skipChars(buf, i.value, ds("`"));
                        const count = iAfterDelimiter - i.value;

                        if (inBacktick === count) {
                            inBacktick = 0;
                            inCode = 0;
                            const codebuf = new OutBuffer();
                            codebuf.write(buf.opSlice(iCodeStart + count, i.value));
                            // escape the contents, but do not perform highlighting except for DDOC_PSYMBOL
                            highlightCodeFromDsymbols(sc, a, codebuf, 0);
                            escapeStrayParenthesis(loc, codebuf, 0, false, sc.eSink!);
                            buf.remove(iCodeStart, i.value - iCodeStart + count); // also trimming off the current `
                            const pre = ds("$(DDOC_BACKQUOTED ");
                            i.value = buf.insert(iCodeStart, pre);
                            i.value = buf.insert(i.value, codebuf.opSliceAll());
                            i.value = buf.insert(i.value, ds(")"));
                            // point to the ending ) so when the for loop does i++, it will see the next character
                            i.value--;
                            break;
                        }

                        // Perhaps we're starting or ending a Markdown code block
                        if (leadingBlank && count >= 3) {
                            let moreBackticks = false;
                            for (let j = iAfterDelimiter; !moreBackticks && j < buf.length(); ++j)
                                if (buf.opIndex(j) === 0x60)
                                    moreBackticks = true;
                                else if (buf.opIndex(j) === 0x0d || buf.opIndex(j) === 0x0a)
                                    break;
                            if (!moreBackticks) {
                                arm = 0x2d;
                                continue Ldispatch; // goto case '-' (dmd/doc.d:4402)
                            }
                        }

                        if (inCode) {
                            if (inBacktick)
                                i.value = iAfterDelimiter - 1;
                            break;
                        }
                        inCode = c;
                        inBacktick = count;
                        codeIndent = 0; // inline code is not indented
                        // All we do here is set the code flags and record
                        // the location. The macro will be inserted lazily
                        // so we can easily cancel the inBacktick if we come
                        // across a newline character.
                        iCodeStart = i.value;
                        i.value = iAfterDelimiter - 1;
                        break;
                    }

                    case 0x23 /* '#' */: {
                        /* A line beginning with # indicates an ATX-style heading. */
                        if (leadingBlank && !inCode) {
                            leadingBlank = false;

                            headingLevel.value = detectAtxHeadingLevel(buf, i.value);
                            if (!headingLevel.value)
                                break;

                            i.value += endRowAndTable(buf, iLineStart.value, i.value, inlineDelimiters,
                                columnAlignments);
                            if (!lineQuoted && quoteLevel.value)
                                i.value += endAllListsAndQuotes(buf, iLineStart, nestedLists, quoteLevel,
                                    quoteMacroLevel);

                            // remove the ### prefix, including whitespace
                            i.value = skipChars(buf, i.value + headingLevel.value, ds(" \t"));
                            buf.remove(iLineStart.value, i.value - iLineStart.value);
                            i.value = iParagraphStart.value = iLineStart.value;

                            removeAnyAtxHeadingSuffix(buf, i.value);
                            --i.value;

                            headingMacroLevel = macroLevel;
                        }
                        break;
                    }

                    case 0x7e /* '~' */: {
                        if (leadingBlank) {
                            // Perhaps we're starting or ending a Markdown code block
                            const iAfterDelimiter = skipChars(buf, i.value, ds("~"));
                            if (iAfterDelimiter - i.value >= 3) {
                                arm = 0x2d;
                                continue Ldispatch; // goto case '-' (dmd/doc.d:4458)
                            }
                        }
                        leadingBlank = false;
                        break;
                    }

                    case 0x2d /* '-' */:
                        /* A line beginning with --- delimits a code section.
                         * inCode tells us if it is start or end of a code section.
                         */
                        if (leadingBlank) {
                            if (!inCode && c === 0x2d) {
                                const list = MarkdownList.parseItem(buf, iLineStart.value, i.value);
                                if (list.isValid()) {
                                    if (replaceMarkdownThematicBreak(buf, i, iLineStart.value)) {
                                        removeBlankLineMacro(buf, iPrecedingBlankLine, i);
                                        iParagraphStart.value = skipChars(buf, i.value + 1, ds(" \t\r\n"));
                                        break;
                                    } else {
                                        arm = 0x2b;
                                        continue Ldispatch; // goto case '+' (dmd/doc.d:4482)
                                    }
                                }
                            }

                            let istart = i.value;
                            let eollen = 0;
                            leadingBlank = false;
                            const c0 = c; // if we jumped here from case '`' or case '~'
                            let iInfoString = 0;
                            if (!inCode)
                                codeLanguage = codeLanguage.subarray(0, 0);   // codeLanguage.length = 0
                            for (;;) {
                                ++i.value;
                                if (i.value >= buf.length())
                                    break;
                                c = buf.opIndex(i.value);
                                if (c === 0x0a) {
                                    eollen = 1;
                                    break;
                                }
                                if (c === 0x0d) {
                                    eollen = 1;
                                    if (i.value + 1 >= buf.length())
                                        break;
                                    if (buf.opIndex(i.value + 1) === 0x0a) {
                                        eollen = 2;
                                        break;
                                    }
                                }
                                // BUG: handle UTF PS and LS too
                                if (c !== c0 || iInfoString) {
                                    if (!iInfoString && !inCode && i.value - istart >= 3) {
                                        // Start a Markdown info string, like ```ruby
                                        codeFenceLength = i.value - istart;
                                        i.value = iInfoString = skipChars(buf, i.value, ds(" \t"));
                                    } else if (iInfoString && c !== 0x60) {
                                        if (!codeLanguage.length && (c === 0x20 || c === 0x09))
                                            codeLanguage = buf.opSlice(iInfoString, i.value).slice();   // .idup
                                    } else {
                                        iInfoString = 0;
                                        arm = c;
                                        continue Ldispatch; // goto Lcont (dmd/doc.d:4532)
                                    }
                                }
                            }
                            if (i.value - istart < 3 || (inCode && (inCode !== c0 ||
                                (inCode !== 0x2d && i.value - istart < codeFenceLength)))) {
                                arm = c;
                                continue Ldispatch; // goto Lcont (dmd/doc.d:4537)
                            }
                            if (iInfoString) {
                                if (!codeLanguage.length)
                                    codeLanguage = buf.opSlice(iInfoString, i.value).slice();   // .idup
                            } else
                                codeFenceLength = i.value - istart;

                            // We have the start/end of a code section
                            // Remove the entire --- line, including blanks and \n
                            buf.remove(iLineStart.value, i.value - iLineStart.value + eollen);
                            i.value = iLineStart.value;
                            if (eollen)
                                leadingBlank = true;
                            if (inCode && (i.value <= iCodeStart)) {
                                // Empty code section, just remove it completely.
                                inCode = 0;
                                break;
                            }
                            if (inCode) {
                                inCode = 0;
                                // The code section is from iCodeStart to i
                                const codebuf = new OutBuffer();
                                codebuf.write(buf.opSlice(iCodeStart, i.value));
                                codebuf.writeByte(0);
                                // Remove leading indentations from all lines
                                let lineStart = true;
                                // `char*` cursors p, q, endp into codebuf's store: indices from its start
                                let endp = codebuf.length();
                                for (let p = 0; p < endp;) {
                                    if (lineStart) {
                                        let j = codeIndent;
                                        let q = p;
                                        while (j-- > 0 && q < endp && isIndentWS(codebuf.opSliceAll(), q))
                                            ++q;
                                        codebuf.remove(p, q - p);
                                        assert(0 <= p);
                                        assert(p < codebuf.length());
                                        lineStart = false;
                                        endp = codebuf.length(); // update
                                        continue;
                                    }
                                    if (codebuf.opIndex(p) === 0x0a)
                                        lineStart = true;
                                    ++p;
                                }
                                if (!codeLanguage.length || dsEquals(codeLanguage, ds("dlang")) ||
                                    dsEquals(codeLanguage, ds("d")))
                                    highlightCode2(sc, a, codebuf, 0);
                                else
                                    codebuf.remove(codebuf.length() - 1, 1);    // remove the trailing 0 byte
                                escapeStrayParenthesis(loc, codebuf, 0, false, sc.eSink!);
                                buf.remove(iCodeStart, i.value - iCodeStart);
                                i.value = buf.insert(iCodeStart, codebuf.opSliceAll());
                                i.value = buf.insert(i.value, ds(")\n"));
                                i.value -= 2; // in next loop, c should be '\n'
                            } else {
                                i.value += endRowAndTable(buf, iLineStart.value, i.value, inlineDelimiters,
                                    columnAlignments);
                                if (!lineQuoted && quoteLevel.value) {
                                    const delta = endAllListsAndQuotes(buf, iLineStart, nestedLists, quoteLevel,
                                        quoteMacroLevel);
                                    i.value += delta;
                                    istart += delta;
                                }

                                inCode = c0;
                                codeIndent = istart - iLineStart.value; // save indent count
                                if (codeLanguage.length && !dsEquals(codeLanguage, ds("dlang")) &&
                                    !dsEquals(codeLanguage, ds("d"))) {
                                    // backslash-escape
                                    for (let j = 0; j < codeLanguage.length - 1; ++j)
                                        if (codeLanguage[j] === 0x5c /* '\\' */ && ispunct(codeLanguage[j + 1]))
                                            codeLanguage = dsConcat(codeLanguage.subarray(0, j),
                                                codeLanguage.subarray(j + 1));

                                    i.value = buf.insert(i.value, ds("$(OTHER_CODE "));
                                    i.value = buf.insert(i.value, codeLanguage);
                                    i.value = buf.insert(i.value, ds(","));
                                } else
                                    i.value = buf.insert(i.value, ds("$(D_CODE "));
                                iCodeStart = i.value;
                                i.value--; // place i on >
                                leadingBlank = true;
                            }
                        }
                        break;

                    case 0x5f /* '_' */: {
                        if (leadingBlank && !inCode && replaceMarkdownThematicBreak(buf, i, iLineStart.value)) {
                            i.value += endRowAndTable(buf, iLineStart.value, i.value, inlineDelimiters,
                                columnAlignments);
                            if (!lineQuoted && quoteLevel.value)
                                i.value += endAllListsAndQuotes(buf, iLineStart, nestedLists, quoteLevel,
                                    quoteMacroLevel);
                            removeBlankLineMacro(buf, iPrecedingBlankLine, i);
                            iParagraphStart.value = skipChars(buf, i.value + 1, ds(" \t\r\n"));
                            break;
                        }
                        arm = -1;   // no case label: the `default` arm
                        continue Ldispatch; // goto default (dmd/doc.d:4640)
                    }

                    case 0x2b /* '+' */:
                    case 0x30: case 0x31: case 0x32: case 0x33: case 0x34:
                    case 0x35: case 0x36: case 0x37: case 0x38: case 0x39: { // case '0': .. case '9':
                        if (leadingBlank && !inCode) {
                            const list = MarkdownList.parseItem(buf, iLineStart.value, i.value);
                            if (list.isValid()) {
                                // Avoid starting a numbered list in the middle of a paragraph
                                if (!nestedLists.length && list.orderedStart !== null && list.orderedStart.length &&
                                    iParagraphStart.value < iLineStart.value) {
                                    i.value += list.orderedStart.length - 1;
                                    break;
                                }

                                i.value += endRowAndTable(buf, iLineStart.value, i.value, inlineDelimiters,
                                    columnAlignments);
                                if (!lineQuoted && quoteLevel.value) {
                                    const delta = endAllListsAndQuotes(buf, iLineStart, nestedLists, quoteLevel,
                                        quoteMacroLevel);
                                    i.value += delta;
                                    list.iStart += delta;
                                    list.iContentStart += delta;
                                }

                                list.macroLevel = macroLevel;
                                list.startItem(buf, iLineStart, i, iPrecedingBlankLine, nestedLists);
                                break;
                            }
                        }
                        leadingBlank = false;
                        break;
                    }

                    case 0x2a /* '*' */: {
                        if (inCode || inBacktick) {
                            leadingBlank = false;
                            break;
                        }

                        if (leadingBlank) {
                            // Check for a thematic break
                            if (replaceMarkdownThematicBreak(buf, i, iLineStart.value)) {
                                i.value += endRowAndTable(buf, iLineStart.value, i.value, inlineDelimiters,
                                    columnAlignments);
                                if (!lineQuoted && quoteLevel.value)
                                    i.value += endAllListsAndQuotes(buf, iLineStart, nestedLists, quoteLevel,
                                        quoteMacroLevel);
                                removeBlankLineMacro(buf, iPrecedingBlankLine, i);
                                iParagraphStart.value = skipChars(buf, i.value + 1, ds(" \t\r\n"));
                                break;
                            }

                            // An initial * indicates a Markdown list item
                            const list = MarkdownList.parseItem(buf, iLineStart.value, i.value);
                            if (list.isValid()) {
                                arm = 0x2b;
                                continue Ldispatch; // goto case '+' (dmd/doc.d:4703)
                            }
                        }

                        // Markdown emphasis
                        const leftC = i.value > offset ? buf.opIndex(i.value - 1) : 0;
                        const iAfterEmphasis = skipChars(buf, i.value + 1, ds("*"));
                        const rightC = iAfterEmphasis < buf.length() ? buf.opIndex(iAfterEmphasis) : 0;
                        const count = iAfterEmphasis - i.value;
                        const leftFlanking = (rightC !== 0 && !isspace(rightC)) &&
                            (!ispunct(rightC) || leftC === 0 || isspace(leftC) || ispunct(leftC));
                        const rightFlanking = (leftC !== 0 && !isspace(leftC)) &&
                            (!ispunct(leftC) || rightC === 0 || isspace(rightC) || ispunct(rightC));
                        const emphasis = new MarkdownDelimiter(i.value, count, macroLevel, leftFlanking, rightFlanking,
                            false, c);

                        if (!emphasis.leftFlanking && !emphasis.rightFlanking) {
                            i.value = iAfterEmphasis - 1;
                            break;
                        }

                        inlineDelimiters.push(emphasis.copy());   // `~=` appends a copy
                        i.value += emphasis.count;
                        --i.value;
                        break;
                    }

                    case 0x21 /* '!' */: {
                        leadingBlank = false;

                        if (inCode)
                            break;

                        if (i.value < buf.length() - 1 && buf.opIndex(i.value + 1) === 0x5b /* '[' */) {
                            const imageStart = new MarkdownDelimiter(i.value, 2, macroLevel, false, false, false, c);
                            inlineDelimiters.push(imageStart);
                            ++i.value;
                        }
                        break;
                    }
                    case 0x5b /* '[' */: {
                        if (inCode) {
                            leadingBlank = false;
                            break;
                        }

                        const leftC = i.value > offset ? buf.opIndex(i.value - 1) : 0;
                        const rightFlanking = leftC !== 0 && !isspace(leftC) && !ispunct(leftC);
                        const atParagraphStart = leadingBlank && iParagraphStart.value >= iLineStart.value;
                        const linkStart = new MarkdownDelimiter(i.value, 1, macroLevel, false, rightFlanking,
                            atParagraphStart, c);
                        inlineDelimiters.push(linkStart);
                        leadingBlank = false;
                        break;
                    }
                    case 0x5d /* ']' */: {
                        leadingBlank = false;

                        if (inCode)
                            break;

                        for (let d = inlineDelimiters.length - 1; d >= 0; --d) {
                            const delimiter = inlineDelimiters[d].copy();
                            if (delimiter.type === 0x5b /* '[' */ || delimiter.type === 0x21 /* '!' */) {
                                if (delimiter.isValid() &&
                                    MarkdownLink.replaceLink(buf, i, inlineDelimiters, d, linkReferences)) {
                                    // if we removed a reference link then we're at line start
                                    if (i.value <= delimiter.iStart)
                                        leadingBlank = true;

                                    // don't nest links
                                    if (delimiter.type === 0x5b)
                                        for (--d; d >= 0; --d)
                                            if (inlineDelimiters[d].type === 0x5b)
                                                inlineDelimiters[d].invalidate();
                                } else {
                                    // nothing found, so kill the delimiter
                                    inlineDelimiters = inlineDelimiters.slice(0, d)
                                        .concat(inlineDelimiters.slice(d + 1));
                                }
                                break;
                            }
                        }
                        break;
                    }

                    case 0x7c /* '|' */: {
                        if (inCode) {
                            leadingBlank = false;
                            break;
                        }

                        tableRowDetected = true;
                        inlineDelimiters.push(new MarkdownDelimiter(i.value, 1, macroLevel, leadingBlank, false, false,
                            c));
                        leadingBlank = false;
                        break;
                    }

                    case 0x5c /* '\\' */: {
                        leadingBlank = false;
                        if (inCode || i.value + 1 >= buf.length())
                            break;

                        /* Escape Markdown special characters */
                        const c1 = buf.opIndex(i.value + 1);
                        if (ispunct(c1)) {
                            buf.remove(i.value, 1);

                            let se = escapetable(sc._module!).escapeChar(c1);
                            if (se === null)
                                se = c1 === 0x24 /* '$' */ ? ds("$(DOLLAR)") :
                                    c1 === 0x2c /* ',' */ ? ds("$(COMMA)") : null;
                            if (se !== null) {
                                buf.remove(i.value, 1);
                                i.value = buf.insert(i.value, se);
                                i.value--; // point to escaped char
                            }
                        }
                        break;
                    }

                    case 0x24 /* '$' */: {
                        /* Look for the start of a macro, '$(Identifier'
                         */
                        leadingBlank = false;
                        if (inCode || inBacktick)
                            break;
                        const slice = buf.opSliceAll();
                        const p = i.value;   // `auto p = &slice[i]`
                        if (at(slice, p + 1) === 0x28 /* '(' */ && isIdStart(slice, p + 2))
                            ++macroLevel;
                        break;
                    }

                    case 0x28 /* '(' */: {
                        if (!inCode && i.value > offset && buf.opIndex(i.value - 1) !== 0x24 /* '$' */)
                            ++parenLevel;
                        break;
                    }

                    case 0x29 /* ')' */: {   /* End of macro
                                                */
                        leadingBlank = false;
                        if (inCode || inBacktick)
                            break;
                        if (parenLevel > 0)
                            --parenLevel;
                        else if (macroLevel) {
                            let downToLevel = inlineDelimiters.length;
                            while (downToLevel > 0 && inlineDelimiters[downToLevel - 1].macroLevel >= macroLevel)
                                --downToLevel;
                            if (headingLevel.value && headingMacroLevel >= macroLevel) {
                                endMarkdownHeading(buf, iParagraphStart.value, i, headingLevel);
                                removeBlankLineMacro(buf, iPrecedingBlankLine, i);
                            }
                            i.value += endRowAndTable(buf, iLineStart.value, i.value, inlineDelimiters,
                                columnAlignments);
                            while (nestedLists.length && nestedLists[nestedLists.length - 1].macroLevel >= macroLevel) {
                                i.value = buf.insert(i.value, ds(")\n)"));
                                --nestedLists.length;
                            }
                            if (quoteLevel.value && quoteMacroLevel.value >= macroLevel)
                                i.value += endAllMarkdownQuotes(buf, i.value, quoteLevel);
                            i.value += replaceMarkdownEmphasis(buf, inlineDelimiters, downToLevel);

                            --macroLevel;
                            quoteMacroLevel.value = 0;
                        }
                        break;
                    }

                    default: {
                        leadingBlank = false;
                        if (sc._module!.filetype === FileType.ddoc || inCode)
                            break;
                        const slice = buf.opSliceAll();
                        const start = i.value;   // `const start = cast(char*)buf[].ptr + i`
                        if (isIdStart(slice, start)) {
                            const j = skippastident(buf, i.value);
                            if (i.value < j) {
                                const k = skippastURL(buf, i.value);
                                if (i.value < k) {
                                    /* The URL is buf[i..k]
                                     */
                                    if (macroLevel)
                                        /* Leave alone if already in a macro
                                         */
                                        i.value = k - 1;
                                    else {
                                        /* Replace URL with '$(DDOC_LINK_AUTODETECT URL)'
                                         */
                                        i.value = buf.bracket(i.value, ds("$(DDOC_LINK_AUTODETECT "), k, ds(")")) - 1;
                                    }
                                    break;
                                }
                            } else
                                break;
                            const len = j - i.value;
                            const ident = buf.opSlice(start, start + len);   // `start[0 .. len]`
                            // leading '_' means no highlight unless it's a reserved symbol name
                            if (c === 0x5f /* '_' */ && (i.value === 0 || !isdigit(buf.opIndex(start - 1))) &&
                                (i.value === buf.length() - 1 || !isReservedName(ident))) {
                                buf.remove(i.value, 1);
                                i.value = buf.bracket(i.value, ds("$(DDOC_AUTO_PSYMBOL_SUPPRESS "), j - 1, ds(")")) - 1;
                                break;
                            }
                            if (isIdentifier(a, ident)) {
                                i.value = buf.bracket(i.value, ds("$(DDOC_AUTO_PSYMBOL "), j, ds(")")) - 1;
                                break;
                            }
                            if (isKeyword(ident)) {
                                i.value = buf.bracket(i.value, ds("$(DDOC_AUTO_KEYWORD "), j, ds(")")) - 1;
                                break;
                            }
                            if (isFunctionParameter(a, ident) !== null) {
                                //printf("highlighting arg '%s', i = %d, j = %d\n", arg.ident.toChars(), i, j);
                                i.value = buf.bracket(i.value, ds("$(DDOC_AUTO_PARAM "), j, ds(")")) - 1;
                                break;
                            }
                            i.value = j - 1;
                        }
                        break;
                    }
                }
                break;
            }
        }
    }

    if (inCode === 0x2d /* '-' */)
        sc.eSink!.error(loc, ds("unmatched `---` in DDoc comment"));
    else if (inCode)
        buf.insert(buf.length(), ds(")"));

    const i: Ref<number> = { value: buf.length() };
    if (headingLevel.value) {
        endMarkdownHeading(buf, iParagraphStart.value, i, headingLevel);
        removeBlankLineMacro(buf, iPrecedingBlankLine, i);
    }
    i.value += endRowAndTable(buf, iLineStart.value, i.value, inlineDelimiters, columnAlignments);
    i.value += replaceMarkdownEmphasis(buf, inlineDelimiters);
    endAllListsAndQuotes(buf, i, nestedLists, quoteLevel, quoteMacroLevel);
}

/**************************************************
 * Highlight code for DDOC section. (dmd/doc.d:4967)
 *
 * Inserts the `$(DDOC_ANCHOR ...)` of `s` at `offset`, then highlights `buf[offset .. $]` as the
 * declaration of `s`; a selective public import highlights each imported symbol instead.
 */
function highlightCode(sc: Scope, s: Dsymbol, buf: OutBuffer, offset: number): void {
    const imp = s.isImport();
    if (imp !== null && imp.aliases.length > 0) {
        // For example: `public import core.stdc.string : memcpy, memcmp;`
        for (let i = 0; i < imp.aliases.length; i++) {
            // Need to distinguish between
            // `public import core.stdc.string : memcpy, memcmp;` and
            // `public import core.stdc.string : copy = memcpy, compare = memcmp;`
            const a = imp.aliases.opIndex(i);
            const id = a !== null ? a : imp.names.opIndex(i)!;
            const loc = Loc.initial;   // `auto loc = Loc.init;`
            const pscopesym: Ref<Dsymbol | null> = { value: null };
            const symFromId = searchScope(sc, loc, id, pscopesym);
            if (symFromId !== null) {
                highlightCode(sc, symFromId, buf, offset);
            }
        }
    } else {
        const ancbuf = new OutBuffer();
        emitAnchor(ancbuf, s, sc);
        buf.insert(offset, ancbuf.opSliceAll());
        offset += ancbuf.length();

        const a: Dsymbols = new DArray<Dsymbol | null>();
        a.push(s);
        highlightCodeFromDsymbols(sc, a, buf, offset);
    }
}

/****************************************************
 * `highlightCode(Scope* sc, Dsymbols* a, ref OutBuffer buf, size_t offset)` (dmd/doc.d:5003): escape
 * `buf[offset .. $]` and wrap the names of `a` in `$(DDOC_PSYMBOL ...)` and their parameters in
 * `$(DDOC_PARAM ...)`; the first template parameter list of a templated function among `a` is wrapped
 * in `$(DDOC_TEMPLATE_PARAM_LIST ...)`.
 */
function highlightCodeFromDsymbols(sc: Scope, a: Dsymbols, buf: OutBuffer, offset: number): void {
    //printf("highlightCode(a = '%s')\n", a.toChars());
    let resolvedTemplateParameters = false;

    for (let i = offset; i < buf.length(); i++) {
        const c = buf.opIndex(i);
        const se = escapetable(sc._module!).escapeChar(c);
        if (se !== null && se.length) {
            buf.remove(i, 1);
            i = buf.insert(i, se);
            i--; // point to ';'
            continue;
        }
        const start = i;   // `char* start = cast(char*)buf[].ptr + i`
        if (isIdStart(buf.opSliceAll(), start)) {
            let j = skipPastIdentWithDots(buf, i);
            if (i < j) {
                const len = j - i;
                if (isIdentifier(a, buf.opSlice(start, start + len))) {
                    i = buf.bracket(i, ds("$(DDOC_PSYMBOL "), j, ds(")")) - 1;
                    continue;
                }
            }

            j = skippastident(buf, i);
            if (i < j) {
                const len = j - i;
                if (isIdentifier(a, buf.opSlice(start, start + len))) {
                    i = buf.bracket(i, ds("$(DDOC_PSYMBOL "), j, ds(")")) - 1;
                    continue;
                }
                if (isFunctionParameter(a, buf.opSlice(start, start + len)) !== null) {
                    //printf("highlighting arg '%s', i = %d, j = %d\n", arg.ident.toChars(), i, j);
                    i = buf.bracket(i, ds("$(DDOC_PARAM "), j, ds(")")) - 1;
                    continue;
                }
                i = j - 1;
            }
        } else if (!resolvedTemplateParameters) {
            const previ = i;

            // hunt for template declarations:
            for (let symi = 0; symi < a.length; symi++) {
                const fd = a.opIndex(symi)!.isFuncDeclaration();

                if (fd === null || fd.parent === null || fd.parent.isTemplateDeclaration() === null) {
                    continue;
                }

                const td = fd.parent.isTemplateDeclaration()!;

                // build the template parameters
                const paramLens = new DArray<number>();
                paramLens.reserve(td.parameters!.length);

                const parametersBuf = new OutBuffer();
                const hgs = new HdrGenState();

                parametersBuf.writeByte(0x28 /* '(' */);

                for (let parami = 0; parami < td.parameters!.length; parami++) {
                    const tp = td.parameters!.opIndex(parami)!;

                    if (parami)
                        parametersBuf.writestring(ds(", "));

                    // `size_t lastOffset = parametersBuf.length;` (dmd/doc.d:5083), and after the print
                    // `paramLens[parami] = parametersBuf.length - lastOffset;` (dmd/doc.d:5087): the declared
                    // divergence of the file header. The store lands past `paramLens.length` (0) and the
                    // binary never reads it back, so the port makes neither the store nor its operand.
                    templateParameterToCBuffer(tp, parametersBuf, hgs);
                }
                parametersBuf.writeByte(0x29 /* ')' */);

                const templateParams = parametersBuf.opSliceAll();

                //printf("templateDecl: %s\ntemplateParams: %s\nstart: %s\n", td.toChars(), templateParams, start);
                if (dsEquals(buf.opSlice(start, start + templateParams.length), templateParams)) {
                    const templateParamListMacro = ds("$(DDOC_TEMPLATE_PARAM_LIST ");
                    buf.bracket(i, templateParamListMacro, i + templateParams.length, ds(")"));

                    // We have the parameter list. While we're here we might
                    // as well wrap the parameters themselves as well

                    // + 1 here to take into account the opening paren of the
                    // template param list
                    i += templateParamListMacro.length + 1;

                    for (const len of paramLens) {
                        i = buf.bracket(i, ds("$(DDOC_TEMPLATE_PARAM "), i + len, ds(")"));
                        // increment two here for space + comma
                        i += 2;
                    }

                    resolvedTemplateParameters = true;
                    // reset i to be positioned back before we found the template
                    // param list this assures that anything within the template
                    // param list that needs to be escaped or otherwise altered
                    // has an opportunity for that to happen outside of this context
                    i = previ;

                    continue;
                }
            }
        }
    }
}

/****************************************
 * Write the bytes `src[p .. pend]` to `buf`, each through the module's escape table (dmd/doc.d:5129).
 */
function highlightCode3(sc: Scope, buf: OutBuffer, src: DString, p: number, pend: number): void {
    for (; p < pend; p++) {
        const se = escapetable(sc._module!).escapeChar(at(src, p));
        if (se !== null && se.length)
            buf.writestring(se);
        else
            buf.writeByte(at(src, p));
    }
}

/**************************************************
 * Highlight code for CODE section. (dmd/doc.d:5144)
 *
 * Lexes `buf` (NUL-terminated by the caller) as D, discarding lexer errors, and replaces
 * `buf[offset .. $]` with the escaped tokens, wrapping symbols, parameters, comments, strings and
 * keywords in their D_* macros.
 */
function highlightCode2(sc: Scope, a: Dsymbols, buf: OutBuffer, offset: number): void {
    const eSinkNull = new ErrorSinkNull();

    const base = buf.opSliceAll();   // `cast(char*)buf[].ptr`: the store the lexer and the token pointers walk
    const lex = new Lexer(null, base, 0, buf.length() - 1, false, true,
        eSinkNull,  // ignore errors
        global.compileEnv);
    const res = new OutBuffer();
    let lastp = 0;   // `const(char)* lastp = cast(char*)buf[].ptr`
    //printf("highlightCode2('%.*s')\n", cast(int)(buf.length - 1), buf[].ptr);
    res.reserve(buf.length());
    for (;;) {
        const tok = new Token();
        lex.scan(tok);
        const tokptr = ptrDiff(tok.ptr!, base);   // `tok.ptr` as a cursor into `base`
        highlightCode3(sc, res, base, lastp, tokptr);
        let highlight: DString | null = null;
        switch (tok.value) {
            case TOK.identifier: {
                if (!sc)
                    break;
                const len = lex.p - tokptr;
                if (isIdentifier(a, base.subarray(tokptr, tokptr + len))) {
                    highlight = ds("$(D_PSYMBOL ");
                    break;
                }
                if (isFunctionParameter(a, base.subarray(tokptr, tokptr + len)) !== null) {
                    //printf("highlighting arg '%s', i = %d, j = %d\n", arg.ident.toChars(), i, j);
                    highlight = ds("$(D_PARAM ");
                    break;
                }
                break;
            }
            case TOK.comment:
                highlight = ds("$(D_COMMENT ");
                break;
            case TOK.string_:
            case TOK.interpolated:
                highlight = ds("$(D_STRING ");
                break;
            default:
                if (tok.isKeyword())
                    highlight = ds("$(D_KEYWORD ");
                break;
        }
        if (highlight !== null) {
            res.writestring(highlight);
            const o = res.length();
            highlightCode3(sc, res, base, tokptr, lex.p);
            if (tok.value === TOK.comment || tok.value === TOK.string_ || tok.value === TOK.interpolated)
                /* https://issues.dlang.org/show_bug.cgi?id=7656
                 * https://issues.dlang.org/show_bug.cgi?id=7715
                 * https://issues.dlang.org/show_bug.cgi?id=10519
                 */
                escapeDdocString(res, o);
            res.writeByte(0x29 /* ')' */);
        } else
            highlightCode3(sc, res, base, tokptr, lex.p);
        if (tok.value === TOK.endOfFile)
            break;
        lastp = lex.p;
    }
    buf.setsize(offset);
    buf.writeBuffer(res);
}

/****************************************
 * Determine if p points to the start of a "..." parameter identifier. (dmd/doc.d:5219)
 */
function isCVariadicArg(p: DString): boolean {
    return p.length >= 3 && dsEquals(p.subarray(0, 3), ds("..."));
}

/****************************************
 * Determine if p points to the start of an identifier. (dmd/doc.d:5228)
 * `p` is the cursor `(buf, p)`, the `fp_t` shape of dmacro.ts.
 */
function isIdStart(buf: DString, p: number): boolean {
    // import dmd.common.charactertables; (dmd/doc.d:5230) — a module-level import here
    let c = at(buf, p);
    if (isalpha(c) || c === 0x5f /* '_' */)
        return true;
    if (c >= 0x80) {
        const r = utf_decodeChar(bytesAt(buf, p, 4), 0);   // `utf_decodeChar(p[0 .. 4], i, c)`
        c = r.dchar;
        if (r.error !== null)
            return false; // ignore errors
        if (isAnyStart(c))
            return true;
    }
    return false;
}

/****************************************
 * Determine if p points to the rest of an identifier. (dmd/doc.d:5250)
 * `p` is the cursor `(buf, p)`, the `fp_t` shape of dmacro.ts.
 */
function isIdTail(buf: DString, p: number): boolean {
    // import dmd.common.charactertables; (dmd/doc.d:5252) — a module-level import here
    let c = at(buf, p);
    if (isalnum(c) || c === 0x5f /* '_' */)
        return true;
    if (c >= 0x80) {
        const r = utf_decodeChar(bytesAt(buf, p, 4), 0);   // `utf_decodeChar(p[0 .. 4], i, c)`
        c = r.dchar;
        if (r.error !== null)
            return false; // ignore errors
        if (isAnyContinue(c))
            return true;
    }
    return false;
}

/****************************************
 * Determine if p points to the indentation space. (dmd/doc.d:5271)
 */
function isIndentWS(buf: DString, p: number): boolean {
    return (at(buf, p) === 0x20) || (at(buf, p) === 0x09);
}

/*****************************************
 * Return number of bytes in UTF character. (dmd/doc.d:5279)
 */
function utfStride(buf: DString, p: number): number {
    const c = at(buf, p);
    if (c < 0x80)
        return 1;
    const r = utf_decodeChar(bytesAt(buf, p, 4), 0); // ignore errors, but still consume input
    return r.nextIdx;
}

/// Advance the cursor `p` into `s` past leading newlines (dmd/doc.d:5289). D tests
/// `s && *s == '\n' || *s == '\r'`: the `\r` operand dereferences `s` without the null test.
function stripLeadingNewlines(s: DString | null, p: number): number {
    while ((s !== null && at(s, p) === 0x0a) || at(s!, p) === 0x0d)
        p++;

    return p;
}

// The `dmd.doc` registration slot of hdrgen.ts (hdrgen.d:30 `import dmd.doc;`, 01 §4.4): hand the provider
// over from this module body. Not a D statement.
registerEscapeDdocString(escapeDdocString);
