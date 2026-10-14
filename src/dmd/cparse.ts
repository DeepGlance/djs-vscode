// Ported from dmd/cparse.d (module dmd.cparse).
//
// Takes a token stream from the lexer, and parses it into an abstract syntax tree. Specification: C11.
//
// MONOMORPHIZATION (13 §3): the D source is `final class CParser(AST) : Parser!AST`. parse.ts ports
// `Parser` for exactly one AST (`astcodegen`) as `export class Parser extends Lexer`, so the `(AST)`
// template parameter is dropped, every `AST.X` is the concrete class `X` imported from its module, and
// CParser is `export class CParser extends Parser`. The constructor's `TARGET` template parameter
// collapses to `TargetC`: both D callers pass `target.c` (dmodule.d:802, iasm/gcc.d:48/:592).
//
// NESTED TYPES (02 §4): cparse.d declares LVL, DTR, SCW, MOD, Specifier and RTFlags inside the class
// (dmd/cparse.d:4599-4864). They are hoisted to module scope with their D names and are referenced here by
// those names. The function-local enums `TKW` of cparseDeclarationSpecifiers (dmd/cparse.d:2389) and
// `AsmQualifiers` of cparseGnuAsm (dmd/cparse.d:3500) are hoisted to module scope the same way, just above
// the class: a TS `enum` inside a function body is re-created on every call.
//
// IMPORTS mirror parse.ts's spelling (same names, `Array as DArray`). The hoisted `MOD` is cparse's own
// qualifier enum; astenums' `MOD` type alias is never imported here, so no alias is needed.
// dropped: import core.stdc.stdio (printf only, in comments) and core.stdc.string : memcpy (01 Rule 3.7).
// dropped: import dmd.root.rmem (mem.xmalloc_noscan becomes a fresh Uint8Array, 03 §8).
// dropped: dmd/cparse.d:32-33 `LDC_pre_2084` — version(LDC) is ON (_config.md §1) and the host compiler that
//   builds ldc2 1.43 has `__VERSION__ >= 2084`, so the manifest constant is `false` at translation time
//   and every `static if (LDC_pre_2084)` resolves to its `else` arm (07); nothing reads it at run time.
//
// NARROWING (02 §11.4): a test group on the mutable `this.token.value` re-reads it into a fresh `const tv`
// after every mutating call; no `as TOK` assertions.
//
// SHADOWED FIELD (02 §11.5b): toConst (dmd/cparse.d:4943) writes TypeTag's own `mod` (mtype.d:2145), which
// mtype.ts declares as `modTag`, apart from Type.mod.
//
// DECLARED DIVERGENCES (11 §2.6):
//  - cparseStructDeclaration (dmd/cparse.d:4223) reads `id.name` of a bit-field declarator unchecked;
//    ldc2 segfaults there on `struct S { int (1) : 3; };`, the port fails the assert at the site. A D defect.

import type { CompileEnv } from "./lexer.js";
import type { ErrorSink } from "./errorsink.js";
import { ErrorSinkLatch } from "./errorsink.js";
import { Loc } from "./location.js";
import { Identifier } from "./identifier.js";
import { Id } from "./id.js";
import { Token, TOK, EXP } from "./tokens.js";
import { OutBuffer } from "./common/outbuffer.js";
import { ds, dsConcat, dsEquals, dsSubslice } from "../dstring.js";
import type { DString } from "../dstring.js";
import { assert, SwitchError } from "../assert.js";

import {
    STC,
    LINK,
    VarArg,
    MODFlags,
    PINLINE,
    structalign_t,
    Tvoid,
    Tpointer,
    Tsarray,
    Tfunction,
} from "./astenums.js";

import {
    // mtype
    Type,
    TypeFunction,
    TypeIdentifier,
    TypeTypeof,
    TypeVector,
    TypePointer,
    TypeSArray,
    TypeTag,
    Parameter,
    ParameterList,
} from "./mtype.js";
import type { TypeNext } from "./mtype.js";

import type {
    Dsymbols,
    Expressions,
    Objects,
    Statements,
    Types,
    TemplateParameters,
} from "./arraytypes.js";

// Runtime Array constructors for the arraytypes aliases (they are `Array<T>` value imports).
import { Array as DArray } from "./root/array.js";

import {
    // expression
    Expression,
    IntegerExp,
    RealExp,
    IdentifierExp,
    StringExp,
    TypeExp,
    AssertExp,
    DotIdExp,
    CallExp,
    ArrayExp,
    ScopeExp,
    AddrExp,
    PreExp,
    PostExp,
    PtrExp,
    NegExp,
    UAddExp,
    NotExp,
    ComExp,
    CastExp,
    MulExp,
    DivExp,
    ModExp,
    AddExp,
    MinExp,
    ShlExp,
    ShrExp,
    EqualExp,
    CmpExp,
    AndExp,
    XorExp,
    OrExp,
    LogicalExp,
    CondExp,
    AssignExp,
    AddAssignExp,
    MinAssignExp,
    MulAssignExp,
    DivAssignExp,
    ModAssignExp,
    AndAssignExp,
    OrAssignExp,
    XorAssignExp,
    ShlAssignExp,
    ShrAssignExp,
    CommaExp,
    DeclarationExp,
    FuncExp,
    CompoundLiteralExp,
    GenericExp,
    ArgumentLabel,
} from "./expression.js";

import { AliasDeclaration, VarDeclaration, BitFieldDeclaration } from "./declaration.js";

import { FuncDeclaration, FuncLiteralDeclaration } from "./func.js";

import { Dsymbol, CAsmDeclaration } from "./dsymbol.js";
import type { ScopeDsymbol } from "./dsymbol.js";

import { LinkDeclaration, AlignDeclaration, AnonDeclaration, DeprecatedDeclaration } from "./attrib.js";

import {
    // statement
    Statement,
    ExpStatement,
    CompoundStatement,
    CompoundDeclarationStatement,
    ScopeStatement,
    LabelStatement,
    WhileStatement,
    DoStatement,
    ForStatement,
    IfStatement,
    StaticAssertStatement,
    SwitchStatement,
    CaseStatement,
    CaseRangeStatement,
    DefaultStatement,
    GotoStatement,
    ReturnStatement,
    BreakStatement,
    ContinueStatement,
    AsmStatement,
    CompoundAsmStatement,
} from "./statement.js";

import type { Initializer } from "./init.js";
import {
    // init
    ExpInitializer,
    VoidInitializer,
    DefaultInitializer,
    CInitializer,
    DesigInit,
    Designator,
} from "./init.js";

import { TemplateInstance, TemplateDeclaration, TemplateParameter, TemplateTypeParameter } from "./dtemplate.js";
import { StaticAssert } from "./staticassert.js";
import { Import } from "./dimport.js";
import { EnumDeclaration, EnumMember } from "./denum.js";
import { StructDeclaration, UnionDeclaration } from "./dstruct.js";
import type { Module } from "./dmodule.js";
import type { TargetC } from "./target.js";
// typesem after the AST-node modules (01 §4.8), as dmd/cparse.d:30 imports it last
import { addSTC, makeImmutable, size, nextOf } from "./typesem.js";
import { Parser, ParseStatementFlags } from "./parse.js";
// last: the registrar of dmodule.ts's `CParser` slot (end of this file); a value edge into the core SCC
import { registerCParser } from "./dmodule.js";
// last: the registrar of iasm/gcc.ts's `CParser` slot (end of this file; its LOAD ORDER note): dmd/iasm/gcc.d:27
// `import dmd.cparse;` inverted
import { registerGccAsmCParser } from "./iasm/gcc.js";

// ---------------------------------------------------------------------------------------------
// Types nested in `CParser` (dmd/cparse.d:4599-4864), hoisted to module scope (02 §4.1): a TS class
// body cannot declare an enum or a nested class. They keep their D names and stay file-private;
// no module outside cparse.d names them (`CParser!AST.LVL` has no reader in the 1.43 frontend).
// ---------------------------------------------------------------------------------------------

/**************
 * Declaration context (dmd/cparse.d:4599, CParser-scoped `enum LVL`).
 */
enum LVL {
    global = 1, /// global
    parameter = 2, /// function parameter (declarations for function identifier-list)
    prototype = 4, /// function prototype
    local = 8, /// local
    member = 0x10, /// struct member
}

/// Types of declarator to parse (dmd/cparse.d:4609, CParser-scoped `enum DTR`).
enum DTR {
    xdirect_fd = 0, /// C11 6.7.6 direct-declarator, allow to start function definition
    xdirect = 1, /// C11 6.7.6 direct-declarator
    xabstract = 2, /// C11 6.7.7 abstract-declarator
    xparameter = 3, /// parameter declarator may be either direct or abstract
}

/// C11 6.7.1 Storage-class specifiers (dmd/cparse.d:4618, CParser-scoped `enum SCW : uint`).
/// A flag set: members are OR-ed into `Specifier.scw`.
enum SCW {
    xnone = 0,
    xtypedef = 1,
    xextern = 2,
    xstatic = 4,
    x_Thread_local = 8,
    xauto = 0x10,
    xregister = 0x20,
    // C11 6.7.4 Function specifiers
    xinline = 0x40,
    x_Noreturn = 0x80,

    xnoinline = 0x100,
}

/// C11 6.7.3 Type qualifiers (dmd/cparse.d:4635, CParser-scoped `enum MOD : uint`). A flag set.
/// Not astenums' `MOD` (the `ubyte` type-modifier alias, whose values are `MODFlags`): this module
/// never imports that one, and D's `MODFlags.const_` stays `MODFlags.const_`:
/// dmd/cparse.d:4943 — `tt.mod |= MODFlags.const_;`
enum MOD {
    xnone = 0,
    xconst = 1,
    xvolatile = 2,
    xrestrict = 4,
    x_Atomic = 8,
    x__stdcall = 0x10, // Windows linkage extension
}

/**********************************
 * Aggregate for all the various specifiers (dmd/cparse.d:4648, CParser-scoped `struct Specifier`).
 *
 * VALUE type (02 §2): a by-value move copies through `copy()`. Every method of CParser takes it
 * `ref` / `const ref`, which is the object itself (03 §3.2). D default-initializes every field; the
 * field initializers below are those defaults, so `new Specifier()` is D's `Specifier specifier;`.
 */
class Specifier {
    noreturn = false; /// noreturn attribute
    naked = false; /// naked attribute
    _nothrow = false; /// nothrow attribute
    _pure = false; /// pure attribute
    dllimport = false; /// dllimport attribute
    dllexport = false; /// dllexport attribute
    _deprecated = false; /// deprecated attribute
    depMsg: Expression | null = null; /// deprecated message
    vector_size = 0; /// positive power of 2 multipe of base type size

    scw: SCW = SCW.xnone; /// storage-class specifiers
    mod: MOD = MOD.xnone; /// type qualifiers
    alignAttrs: Expressions | null = null; /// __attribute__((aligned))
    alignasExps: Expressions | null = null; /// _Alignas()
    lastAlignas: Expression | null = null; /// Last _Alignas() for errors
    packalign: structalign_t = new structalign_t(); /// #pragma pack alignment value

    /// Field-wise copy (03 §2): class references and container pointers are shared, the nested
    /// value struct `packalign` is copied.
    copy(): Specifier {
        const c = new Specifier();
        c.noreturn = this.noreturn;
        c.naked = this.naked;
        c._nothrow = this._nothrow;
        c._pure = this._pure;
        c.dllimport = this.dllimport;
        c.dllexport = this.dllexport;
        c._deprecated = this._deprecated;
        c.depMsg = this.depMsg;
        c.vector_size = this.vector_size;
        c.scw = this.scw;
        c.mod = this.mod;
        c.alignAttrs = this.alignAttrs;
        c.alignasExps = this.alignasExps;
        c.lastAlignas = this.lastAlignas;
        c.packalign = this.packalign.copy();
        return c;
    }
}

/**************
 * Flags for realType (dmd/cparse.d:4859, CParser-scoped `private enum RTFlags`).
 */
enum RTFlags {
    realfloat,
    imaginary,
    complex,
}

/// Type-specifier keyword bits of cparseDeclarationSpecifiers (dmd/cparse.d:2389, a function-local
/// `enum TKW : uint` hoisted to module scope, 02 §4). Only that method reads it.
enum TKW {
    xnone      = 0,
    xchar      = 1,
    xsigned    = 2,
    xunsigned  = 4,
    xshort     = 8,
    xint       = 0x10,
    xlong      = 0x20,
    xllong     = 0x40,
    xfloat     = 0x80,
    xdouble    = 0x100,
    xtag       = 0x400,
    xident     = 0x800,
    xvoid      = 0x1000,
    xbool      = 0x4000,
    ximaginary = 0x8000,
    xcomplex   = 0x10000,
    x_Atomic   = 0x20000,
    xint128    = 0x40000,
}

/// D function-local enum of cparseGnuAsm (dmd/cparse.d:3500), hoisted to module scope.
enum AsmQualifiers { none = 0, goto_ = 1, inline = 2, volatile = 4, }

/***********************************************************
 * The ImportC parser (dmd/cparse.d:37). One instance parses one preprocessed C translation unit:
 * the caller constructs it, calls `nextToken()` once, then `parseModule()`.
 *
 * C cannot be parsed without knowing whether an identifier names a type, so the parser keeps a
 * scoped symbol table of typedefs (`typedefTab`) while it parses. Not reentrant: one parse per
 * instance, single-threaded like the rest of the frontend.
 */
export class CParser extends Parser {
    symbols: Dsymbols | null = null;      // symbols declared in current scope

    addFuncName = false;                  /// add declaration of __func__ to function symbol table
    refFuncName = false;                  // declaration of __FUNCTION__
    pretFuncName = false;                 // declaration for __PRETTY_FUNCTION__
    importBuiltins = false;               /// seen use of C compiler builtins, so import __importc_builtins;

    private packalign: structalign_t = new structalign_t();  // current state of #pragma pack alignment

    // #pragma pack stack
    private records: DArray<Identifier | null> | null = null;  // identifers (or null)
    private packs: DArray<structalign_t> | null = null;        // parallel alignment values

    private defaultStorageClasses: STC = STC.none;
    private defaultStorageClassesStack: DArray<STC> | null = null;

    /* C cannot be parsed without determining if an identifier is a type or a variable.
     * For expressions like `(T)-3`, is it a cast or a minus expression?
     * It also occurs with `typedef int (F)(); F fun;`
     * but to build the AST we need to distinguish `fun` being a function as opposed to a variable.
     * To fix, build a symbol table for the typedefs.
     * Symbol table of typedefs indexed by Identifier cast to void*.
     * 1. if an identifier is a typedef, then it will return a non-null Type
     * 2. if an identifier is not a typedef, then it will return null
     *
     * D stores each scope as an associative array `void*[void*]` cast to `void*`; an empty scope is
     * the null AA. Here each scope is a `Map` keyed by Identifier identity, or `null` for a scope that
     * has not stored an entry yet (dmd/cparse.d:67).
     */
    /// Array of AST.Type[Identifier], typedef's indexed by Identifier
    typedefTab: DArray<Map<Identifier, Type | null> | null> = new DArray<Map<Identifier, Type | null> | null>();

    /* This is passed in as a list of #define lines, as generated by the C preprocessor with the
     * appropriate switch to emit them. We append to it any #define's and #undef's encountered in the source
     * file, as cpp with the -dD embeds them in the preprocessed output file.
     * Once the file is parsed, then the #define's are converted to D symbols and appended to the array
     * of Dsymbols returned by parseModule().
     */
    defines: OutBuffer | null = null;

    /**
     * dmd/cparse.d:77 — `extern (D) this(TARGET)(AST.Module _module`.
     *
     * Params:
     *  _module    = module being parsed; null for the iasm/gcc.d expression parsers (iasm/gcc.d:592)
     *  input      = the preprocessed C source
     *  target     = the C ABI sizes (`target.c`) copied into the lexer's C size fields
     *  defines    = the `#define` lines collected by the preprocessor, appended to while parsing; may be null
     *  compileEnv = must be non-null: its C identifier table replaces the lexer's D one
     * Unittests are never parsed in C (`doUnittests` is false).
     */
    constructor(_module: Module | null, input: DString, doDocComment: boolean, errorSink: ErrorSink,
                target: TargetC, defines: OutBuffer | null, compileEnv: CompileEnv) {
        const doUnittests = false;
        super(null, _module, input, doDocComment, errorSink, compileEnv, doUnittests);

        // `mod` is declared non-null by parse.ts (parse.ts:315); D stores the possibly-null `_module`
        // here exactly as Parser's own constructor does (parse.ts:351).
        this.mod = _module!;
        this.linkage = LINK.c;
        this.Ccompile = true;
        this.packalign.setDefault();
        this.defines = defines;

        // Configure sizes for C `long`, `long double`, `wchar_t`, ...
        this.boolsize = target.boolsize;
        this.shortsize = target.shortsize;
        this.intsize = target.intsize;
        this.longsize = target.longsize;
        this.long_longsize = target.long_longsize;
        this.long_doublesize = target.long_doublesize;
        this.wchar_tsize = target.wchar_tsize;

        // C `char` is always unsigned in ImportC

        // We know that we are parsing out C, due the parent not knowing this, we have to setup tables here.
        // D reads the constructor PARAMETER `compileEnv` (it shadows the lexer's copied field).
        this.charLookup = compileEnv.cCharLookupTable;
    }

    /********************************************
     * Parse translation unit.
     * C11 6.9
     * translation-unit:
     *    external-declaration
     *    translation-unit external-declaration
     *
     * external-declaration:
     *    function-definition
     *    declaration
     * Returns:
     *  array of Dsymbols that were declared, wrapped in one `extern (C) { ... }` LinkDeclaration,
     *  followed by an `import __importc_builtins;` when a builtin was referenced.
     * The `#define`s collected in `defines` are converted to Dsymbols at end of file (addDefines).
     */
    override parseModule(): Dsymbols {
        this.symbols = new DArray<Dsymbol | null>();
        this.typedefTab.push(null);  // C11 6.2.1-3 symbol table for "file scope"
        while (true) {
            const tv = this.token.value;
            if (tv === TOK.endOfFile) {
                this.addDefines();   // convert #define's to Dsymbols

                // wrap the symbols in `extern (C) { symbols }`
                const wrap = new DArray<Dsymbol | null>();
                const ld = new LinkDeclaration(this.token.loc, LINK.c, this.symbols);
                wrap.push(ld);

                if (this.importBuiltins) {
                    /* Seen references to C builtin functions.
                     * Import their definitions
                     */
                    // D passes `false` to the `int isstatic` parameter
                    const s = new Import(Loc.initial, null, Id.importc_builtins, null, 0);
                    wrap.push(s);
                }

                // end of file scope
                this.typedefTab.pop();
                assert(this.typedefTab.length === 0);

                return wrap;
            }

            if (tv === TOK._module) {
                this.token.value = TOK.module_;
                const oldMd = this.md;
                this.parseModuleDeclaration();
                if (oldMd !== null) {
                    // We only use the first module declaration,
                    // subsequent __module statements should only come from #included files
                    this.md = oldMd;
                }
                continue;
            }

            /* GNU Extensions
             * external-declaration:
             *    simple-asm-expr ;
             */
            if (tv === TOK.asm_) {
                this.nextToken();     // move past asm
                this.check(TOK.leftParenthesis);
                if (this.token.value !== TOK.string_)
                    this.error(ds("string literal expected for Asm Definition, not `%s`"), this.token.toChars());
                const code = this.cparsePrimaryExp();
                this.check(TOK.rightParenthesis);
                this.symbols.push(new CAsmDeclaration(code));
                this.check(TOK.semicolon);
                continue;
            }

            this.cparseDeclaration(LVL.global);
        }
    }

    /******************************************************************************/
    /********************************* Statement Parser ***************************/

    /**********************
     * C11 6.8
     * statement:
     *    labeled-statement
     *    compound-statement
     *    expression-statement
     *    selection-statement
     *    iteration-statement
     *    jump-statement
     *
     * Params:
     *      flags = PSxxxx
     *      endPtr = store location of closing brace
     *      pEndloc = if { ... statements ... }, store location of closing brace,
     *                otherwise loc of last token of statement
     * Returns:
     *      parsed statement; null after a parse error, or for a label followed by `}`
     * Both `symbols` and the typedef scope depth are restored on return.
     *
     * The labels `Lexp:`, `Ldeclaration:` and `Lerror:` are case-arm bodies reached by fall-through
     * and by jumps from other arms (06 §3.6(b), SHARED-ARM): each body is a local arrow that writes `s`,
     * called by its own arm and by every jump site, which then leaves the switch.
     */
    cparseStatement(flags: number, endPtr: { value: DString | null } | null = null,
                    pEndloc: { value: Loc } | null = null): Statement | null {
        let s: Statement | null = null;
        const loc = this.token.loc;

        const typedefTabLengthSave = this.typedefTab.length;
        const symbolsSave = this.symbols;
        if ((flags & ParseStatementFlags.scope_) !== 0) {
            this.typedefTab.push(null);      // introduce new block scope
        }

        if ((flags & (ParseStatementFlags.scope_ | ParseStatementFlags.curlyScope)) === 0) {
            this.symbols = new DArray<Dsymbol | null>();
        }

        // Lexp: (dmd/cparse.d:318)
        const Lexp = (): void => {
            const exp = this.cparseExpression();
            if (this.token.value === TOK.identifier && exp.op === EXP.identifier) {
                this.errorLoc(this.token.loc, ds("found `%s` when expecting `;` or `=`, did you mean `%s %s = %s`?"),
                              this.peek(this.token).toChars(), exp.toChars(), this.token.toChars(),
                              this.peek(this.peek(this.token)).toChars());
                this.nextToken();
            } else
                this.checkFollowing(TOK.semicolon, ds("statement"));
            s = new ExpStatement(loc, exp);
        };

        // Ldeclaration: (dmd/cparse.d:377)
        const Ldeclaration = (): void => {
            this.cparseDeclaration(LVL.local);
            if (this.symbols!.length > 1) {
                const as = new DArray<Statement | null>();
                as.reserve(this.symbols!.length);
                for (const d of this.symbols!) {
                    s = ExpStatement.fromDsymbol(loc, d);
                    as.push(s);
                }
                s = new CompoundDeclarationStatement(loc, as);
                this.symbols!.setDim(0);
            } else if (this.symbols!.length === 1) {
                const d = this.symbols!.opIndex(0);
                s = ExpStatement.fromDsymbol(loc, d);
                this.symbols!.setDim(0);
            } else
                s = new ExpStatement(loc, null);
            if ((flags & ParseStatementFlags.scope_) !== 0)
                s = new ScopeStatement(loc, s, this.token.loc);
        };

        // Lerror: (dmd/cparse.d:696)
        const Lerror = (): void => {
            this.panic();
            if (this.token.value === TOK.semicolon)
                this.nextToken();
            s = null;
        };

        const tv = this.token.value;
        switch (tv) {
            case TOK.identifier:
                /* A leading identifier can be a declaration, label, or expression.
                 * A quick check of the next token can disambiguate most cases.
                 */
                switch (this.peekNext()) {
                    case TOK.colon: {
                        // It's a label
                        const ident = this.token.ident;
                        this.nextToken();    // advance to `:`
                        this.nextToken();    // advance past `:`
                        const tv2 = this.token.value;
                        if (tv2 === TOK.rightCurly)
                            s = null;
                        else if (tv2 === TOK.leftCurly)
                            s = this.cparseStatement(ParseStatementFlags.curly | ParseStatementFlags.scope_);
                        else
                            s = this.cparseStatement(0);
                        s = new LabelStatement(loc, ident, s);
                        break;
                    }

                    case TOK.dot:
                    case TOK.arrow:
                    case TOK.plusPlus:
                    case TOK.minusMinus:
                    case TOK.leftBracket:
                    case TOK.question:
                    case TOK.assign:
                    case TOK.addAssign:
                    case TOK.minAssign:
                    case TOK.mulAssign:
                    case TOK.divAssign:
                    case TOK.modAssign:
                    case TOK.andAssign:
                    case TOK.orAssign:
                    case TOK.xorAssign:
                    case TOK.leftShiftAssign:
                    case TOK.rightShiftAssign:
                        Lexp();  // goto Lexp (dmd/cparse.d:267)
                        break;

                    case TOK.leftParenthesis: {
                        const pt = this.lookupTypedef(this.token.ident!);
                        if (pt !== null) {
                            if (pt.value !== null) {
                                Ldeclaration();  // goto Ldeclaration (dmd/cparse.d:273)
                                break;
                            }
                        }
                        Lexp();  // goto Lexp (dmd/cparse.d:275) -- function call
                        break;
                    }

                    case TOK.semicolon:
                        Lexp();  // goto Lexp (dmd/cparse.d:278)
                        break;

                    default: {
                        /* If tokens look like a declaration, assume it is one
                         */
                        if (this.startsDeclaration(this.token)) {
                            Ldeclaration();  // goto Ldeclaration (dmd/cparse.d:285)
                            break;
                        }
                        Lexp();  // goto Lexp (dmd/cparse.d:286)
                        break;
                    }
                }
                break;

            case TOK.charLiteral:
            case TOK.wcharLiteral:
            case TOK.dcharLiteral:
            case TOK.int32Literal:
            case TOK.uns32Literal:
            case TOK.int64Literal:
            case TOK.uns64Literal:
            case TOK.int128Literal:
            case TOK.uns128Literal:
            case TOK.float32Literal:
            case TOK.float64Literal:
            case TOK.float80Literal:
            case TOK.imaginary32Literal:
            case TOK.imaginary64Literal:
            case TOK.imaginary80Literal:
            case TOK.leftParenthesis:
            case TOK.and:
            case TOK.mul:
            case TOK.min:
            case TOK.add:
            case TOK.tilde:
            case TOK.not:
            case TOK.plusPlus:
            case TOK.minusMinus:
            case TOK.sizeof_:
            case TOK._Generic:
            case TOK._assert:
                Lexp();
                break;

            // type-specifiers
            case TOK.void_:
            case TOK.char_:
            case TOK.int16:
            case TOK.int32:
            case TOK.int64:
            case TOK.__int128:
            case TOK.float32:
            case TOK.float64:
            case TOK.signed:
            case TOK.unsigned:
            case TOK._Bool:
            //case TOK._Imaginary:
            case TOK._Complex:
            case TOK.struct_:
            case TOK.union_:
            case TOK.enum_:
            case TOK.typeof_:

            // storage-class-specifiers
            case TOK.typedef_:
            case TOK.extern_:
            case TOK.static_:
            case TOK._Thread_local:
            case TOK.__thread:
            case TOK.auto_:
            case TOK.register:

            // function-specifiers
            case TOK.inline:
            case TOK._Noreturn:

            // type-qualifiers
            case TOK.const_:
            case TOK.volatile:
            case TOK.restrict:
            case TOK.__stdcall:

            // alignment-specifier
            case TOK._Alignas:

            // atomic-type-specifier or type_qualifier
            case TOK._Atomic:

            case TOK.__attribute__:
            case TOK.__declspec:
                Ldeclaration();
                break;

            case TOK._Static_assert:        // _Static_assert ( constant-expression, string-literal ) ;
                s = new StaticAssertStatement(this.cparseStaticAssert());
                break;

            case TOK.leftCurly: {
                /* C11 6.8.2
                 * compound-statement:
                 *    { block-item-list (opt) }
                 *
                 * block-item-list:
                 *    block-item
                 *    block-item-list block-item
                 *
                 * block-item:
                 *    declaration
                 *    statement
                 */
                this.nextToken();
                const statements = new DArray<Statement | null>();
                while (this.token.value !== TOK.rightCurly && this.token.value !== TOK.endOfFile) {
                    statements.push(this.cparseStatement(ParseStatementFlags.curlyScope));
                }
                if (endPtr !== null)
                    endPtr.value = this.token.ptr;
                this.endloc = this.token.loc;
                if (pEndloc !== null) {
                    pEndloc.value = this.token.loc;
                    pEndloc = null; // don't set it again
                }
                s = new CompoundStatement(loc, statements);
                if ((flags & (ParseStatementFlags.scope_ | ParseStatementFlags.curlyScope)) !== 0)
                    s = new ScopeStatement(loc, s, this.token.loc);
                this.checkFollowing(TOK.rightCurly, ds("compound statement"));
                break;
            }

            case TOK.while_: {
                this.nextToken();
                this.check(TOK.leftParenthesis);
                const condition = this.cparseExpression();
                this.check(TOK.rightParenthesis);
                const endloc: { value: Loc } = { value: new Loc() };
                const _body = this.cparseStatement(ParseStatementFlags.scope_, null, endloc);
                s = new WhileStatement(loc, condition, _body, endloc.value, null);
                break;
            }

            case TOK.semicolon:
                /* C11 6.8.3 null statement
                 */
                this.nextToken();
                s = new ExpStatement(loc, null);
                break;

            case TOK.do_: {
                this.nextToken();
                const _body = this.cparseStatement(ParseStatementFlags.scope_);
                this.check(TOK.while_);
                this.check(TOK.leftParenthesis);
                const condition = this.cparseExpression();
                this.check(TOK.rightParenthesis);
                this.checkFollowing(TOK.semicolon, ds("terminating `;` required after do-while statement"));
                s = new DoStatement(loc, _body, condition, this.token.loc);
                break;
            }

            case TOK.for_: {
                let _init: Statement | null;
                let condition: Expression | null;
                let increment: Expression | null;

                this.nextToken();
                this.check(TOK.leftParenthesis);
                if (this.token.value === TOK.semicolon) {
                    _init = null;
                    this.nextToken();
                } else {
                    _init = this.cparseStatement(0);
                }
                const tv2 = this.token.value;
                if (tv2 === TOK.semicolon) {
                    condition = null;
                    this.nextToken();
                } else {
                    condition = this.cparseExpression();
                    this.checkFollowing(TOK.semicolon, ds("`for` condition"));
                }
                const tv3 = this.token.value;
                if (tv3 === TOK.rightParenthesis) {
                    increment = null;
                    this.nextToken();
                } else {
                    increment = this.cparseExpression();
                    this.check(TOK.rightParenthesis);
                }
                const endloc: { value: Loc } = { value: new Loc() };
                const _body = this.cparseStatement(ParseStatementFlags.scope_, null, endloc);
                s = new ForStatement(loc, _init, condition, increment, _body, endloc.value);
                break;
            }

            case TOK.if_: {
                this.nextToken();
                this.check(TOK.leftParenthesis);
                const condition = this.cparseExpression();
                this.check(TOK.rightParenthesis);
                const ifbody = this.cparseStatement(ParseStatementFlags.scope_);
                let elsebody: Statement | null;
                if (this.token.value === TOK.else_) {
                    this.nextToken();
                    elsebody = this.cparseStatement(ParseStatementFlags.scope_);
                } else
                    elsebody = null;
                if (condition !== null && ifbody !== null)
                    s = new IfStatement(loc, null, condition, ifbody, elsebody, this.token.loc);
                else
                    s = null; // don't propagate parsing errors
                break;
            }

            case TOK.else_:
                this.error(ds("found `else` without a corresponding `if` statement"));
                Lerror();  // goto Lerror (dmd/cparse.d:543)
                break;

            case TOK.switch_: {
                this.nextToken();
                this.check(TOK.leftParenthesis);
                const condition = this.cparseExpression();
                this.check(TOK.rightParenthesis);
                const _body = this.cparseStatement(ParseStatementFlags.scope_);
                s = new SwitchStatement(loc, null, condition, _body, false, this.token.loc);
                break;
            }

            case TOK.case_: {

                this.nextToken();
                const exp = this.cparseAssignExp();
                let expHigh: Expression | null = null;
                if (this.token.value === TOK.dotDotDot) {
                    /* Case Ranges https://gcc.gnu.org/onlinedocs/gcc/Case-Ranges.html
                     */
                    this.nextToken();
                    expHigh = this.cparseAssignExp();
                }
                this.check(TOK.colon);

                if ((flags & ParseStatementFlags.curlyScope) !== 0) {
                    const statements = new DArray<Statement | null>();
                    while (this.token.value !== TOK.case_ && this.token.value !== TOK.default_ &&
                           this.token.value !== TOK.endOfFile && this.token.value !== TOK.rightCurly) {
                        const cur = this.cparseStatement(ParseStatementFlags.curlyScope);
                        statements.push(cur);

                        // https://issues.dlang.org/show_bug.cgi?id=21739
                        // Stop at the last break s.t. the following non-case statements are
                        // not merged into the current case. This can happen for
                        // case 1: ... break;
                        // debug { case 2: ... }
                        if (cur !== null && cur.isBreakStatement() !== null)
                            break;
                    }
                    s = new CompoundStatement(loc, statements);
                } else {
                    s = this.cparseStatement(0);
                }
                s = new ScopeStatement(loc, s, this.token.loc);
                if (expHigh !== null)
                    s = new CaseRangeStatement(loc, exp, expHigh, s);
                else
                    s = new CaseStatement(loc, exp, s);
                break;
            }

            case TOK.default_: {
                this.nextToken();
                this.check(TOK.colon);

                if ((flags & ParseStatementFlags.curlyScope) !== 0) {
                    const statements = new DArray<Statement | null>();
                    while (this.token.value !== TOK.case_ && this.token.value !== TOK.default_ &&
                           this.token.value !== TOK.endOfFile && this.token.value !== TOK.rightCurly) {
                        statements.push(this.cparseStatement(ParseStatementFlags.curlyScope));
                    }
                    s = new CompoundStatement(loc, statements);
                } else
                    s = this.cparseStatement(0);
                s = new ScopeStatement(loc, s, this.token.loc);
                s = new DefaultStatement(loc, s);
                break;
            }

            case TOK.return_: {
                /*  return ;
                 *  return expression ;
                 */
                this.nextToken();
                const exp = this.token.value === TOK.semicolon ? null : this.cparseExpression();
                this.checkFollowing(TOK.semicolon, ds("`return` statement"));
                s = new ReturnStatement(loc, exp);
                break;
            }

            case TOK.break_:
                this.nextToken();
                this.checkFollowing(TOK.semicolon, ds("`break` statement"));
                s = new BreakStatement(loc, null);
                break;

            case TOK.continue_:
                this.nextToken();
                this.checkFollowing(TOK.semicolon, ds("`continue` statement"));
                s = new ContinueStatement(loc, null);
                break;

            case TOK.goto_: {
                let ident: Identifier | null;
                this.nextToken();
                const tv2 = this.token.value;
                if (tv2 === TOK.identifier) {
                    ident = this.token.ident;
                    this.nextToken();
                } else if (tv2 === TOK.mul) {
                    /* https://gcc.gnu.org/onlinedocs/gcc/Labels-as-Values.html
                     */
                    this.error(ds("`goto *` computed goto extension is not supported"));
                    ident = null;
                    this.cparseUnaryExp();   // parse and throw away
                } else {
                    this.error(ds("identifier expected following `goto`"));
                    ident = null;
                }
                s = new GotoStatement(loc, ident);
                this.checkFollowing(TOK.semicolon, ds("`goto` statement"));
                break;
            }

            case TOK.asm_:
                switch (this.peekNext()) {
                    case TOK.const_:
                    case TOK.goto_:
                    case TOK.inline:
                    case TOK.restrict:
                    case TOK.volatile:
                    case TOK.leftParenthesis:
                        s = this.cparseGnuAsm();
                        break;

                    default:
                        // ImportC extensions: parse as a D asm block.
                        s = this.parseAsm(this.compileEnv.masm);
                        break;
                }
                break;

            default:
                this.error(ds("found `%s` instead of statement"), this.token.toChars());
                Lerror();  // goto Lerror (dmd/cparse.d:694)
                break;
        }
        if (pEndloc !== null)
            pEndloc.value = this.prevloc;
        this.symbols = symbolsSave;
        this.typedefTab.setDim(typedefTabLengthSave);
        return s;
    }

    /*******************************************************************************/
    /********************************* Expression Parser ***************************/

    /**************
     * C11 6.5.17
     * expression:
     *  assignment-expression
     *  expression , assignment-expression
     */
    cparseExpression(): Expression {
        let loc = this.token.loc;

        let e = this.cparseAssignExp();
        while (this.token.value === TOK.comma) {
            this.nextToken();
            const e2 = this.cparseAssignExp();
            e = new CommaExp(loc, e, e2, false);
            loc = this.token.loc;
        }
        return e;
    }

    /*********************
     * C11 6.5.1
     * primary-expression:
     *    identifier
     *    constant
     *    string-literal
     *    ( expression )
     *    generic-selection
     *    __builtin_va_arg(assign_expression, type)
     *
     * Never returns null: on a parse error it reports and yields `0` (an IntegerExp).
     * Side effect: an identifier spelled with a leading `__` sets `importBuiltins`, `__func__`,
     * `__FUNCTION__` and `__PRETTY_FUNCTION__` set the flags that make the enclosing function declare them.
     */
    cparsePrimaryExp(): Expression {
        let e: Expression;
        const loc = this.token.loc;

        const tv = this.token.value;
        switch (tv) {
            case TOK.identifier: {
                const id = this.token.ident!.toString();
                // leading double underscore
                if (id.length > 2 && id[0] === 0x5f /* '_' */ && id[1] === 0x5f /* '_' */) {
                    if (this.token.ident === Id.FUNCTION)
                        this.refFuncName = true; // implicitly declare __FUNCTION__

                    if (this.token.ident === Id.PRETTY_FUNCTION)
                        this.pretFuncName = true; // implicitly declare __PRETTY_FUNCTION__

                    if (this.token.ident === Id.__func__) {
                        this.addFuncName = true;     // implicitly declare __func__
                    } else if (this.token.ident === Id.builtin_va_arg) {
                        e = this.cparseBuiltin_va_arg();
                        break;
                    } else
                        this.importBuiltins = true;  // probably one of those compiler extensions
                }
                e = new IdentifierExp(loc, this.token.ident);
                this.nextToken();
                break;
            }

            case TOK.charLiteral:
            case TOK.int32Literal:
                e = new IntegerExp(loc, this.token.intvalue, Type.tint32);
                this.nextToken();
                break;

            case TOK.wcharLiteral:
                e = new IntegerExp(loc, this.token.intvalue, Type.tuns16);
                this.nextToken();
                break;

            case TOK.dcharLiteral:
            case TOK.uns32Literal:
                e = new IntegerExp(loc, this.token.unsvalue, Type.tuns32);
                this.nextToken();
                break;

            case TOK.int64Literal:
                e = new IntegerExp(loc, this.token.intvalue, Type.tint64);
                this.nextToken();
                break;

            case TOK.uns64Literal:
                e = new IntegerExp(loc, this.token.unsvalue, Type.tuns64);
                this.nextToken();
                break;

            case TOK.float32Literal:
                e = new RealExp(loc, this.token.floatvalue, Type.tfloat32);
                this.nextToken();
                break;

            case TOK.float64Literal:
                e = new RealExp(loc, this.token.floatvalue, Type.tfloat64);
                this.nextToken();
                break;

            case TOK.float80Literal:
                e = new RealExp(loc, this.token.floatvalue, Type.tfloat80);
                this.nextToken();
                break;

            case TOK.imaginary32Literal:
                e = new RealExp(loc, this.token.floatvalue, Type.timaginary32);
                this.nextToken();
                break;

            case TOK.imaginary64Literal:
                e = new RealExp(loc, this.token.floatvalue, Type.timaginary64);
                this.nextToken();
                break;

            case TOK.imaginary80Literal:
                e = new RealExp(loc, this.token.floatvalue, Type.timaginary80);
                this.nextToken();
                break;

            case TOK.string_: {
                // cat adjacent strings
                let s = this.token.ustring!;
                let len = this.token.len;
                let postfix = this.token.postfix;
                while (true) {
                    this.nextToken();
                    if (this.token.value === TOK.string_) {
                        if (this.token.postfix) {
                            if (this.token.postfix !== postfix)
                                this.errorLoc(this.token.loc,
                                              ds("mismatched string literal postfixes `'%c'` and `'%c'`"),
                                              postfix, this.token.postfix);
                            postfix = this.token.postfix;
                        }

                        const len1 = len;
                        const len2 = this.token.len;
                        len = len1 + len2;
                        // mem.xmalloc_noscan(len * char.sizeof) -> a fresh byte buffer (03 §8)
                        const s2 = new Uint8Array(len);
                        s2.set(s.subarray(0, len1), 0);
                        s2.set(this.token.ustring!.subarray(0, len2), len1);
                        s = s2;
                    } else
                        break;
                }
                e = new StringExp(loc, Array.from(s.subarray(0, len)), len, 1, postfix);
                break;
            }

            case TOK.leftParenthesis:
                this.nextToken();
                if (this.token.value === TOK.leftCurly)
                    e = this.cparseStatementExpression();        // gcc extension
                else
                    e = this.cparseExpression();
                this.check(TOK.rightParenthesis);
                break;

            case TOK._Generic:
                e = this.cparseGenericSelection();
                break;

            case TOK._assert:  // __check(assign-exp) extension
                this.nextToken();
                this.checkFollowing(TOK.leftParenthesis, ds("`__check`"));
                e = this.cparseAssignExp();
                this.check(TOK.rightParenthesis);
                e = new AssertExp(loc, e, null);
                break;

            default:
                this.error(ds("expression expected, not `%s`"), this.token.toChars());
                // Anything for e, as long as it's not NULL
                e = new IntegerExp(loc, 0n, Type.tint32);
                this.nextToken();
                break;
        }
        return e;
    }

    /*********************************
     * C11 6.5.2
     * postfix-expression:
     *    primary-expression
     *    postfix-expression [ expression ]
     *    postfix-expression ( argument-expression-list (opt) )
     *    postfix-expression . identifier
     *    postfix-expression -> identifier
     *    postfix-expression ++
     *    postfix-expression --
     *    ( type-name ) { initializer-list }
     *    ( type-name ) { initializer-list , }
     *
     * argument-expression-list:
     *    assignment-expression
     *    argument-expression-list , assignment-expression
     *
     * D ignores the incoming `e` (it is overwritten by the primary-expression).
     */
    private cparsePostfixExp(e: Expression | null): Expression {
        e = this.cparsePrimaryExp();
        return this.cparsePostfixOperators(e);
    }

    /********************************
     * C11 6.5.2
     * Parse a series of operators for a postfix expression after already parsing
     * a primary-expression or compound literal expression.
     * Params:
     *      e = parsed primary or compound literal expression
     * Returns:
     *      parsed postfix expression
     */
    private cparsePostfixOperators(e: Expression): Expression {
        while (true) {
            const loc = this.token.loc;
            const tv = this.token.value;
            switch (tv) {
                case TOK.dot: {
                    this.nextToken();
                    if (this.token.value === TOK.identifier) {
                        const id = this.token.ident;
                        e = new DotIdExp(loc, e, id);
                        break;
                    }
                    this.error(ds("identifier expected following `.`, not `%s`"), this.token.toChars());
                    break;
                }

                case TOK.arrow: {
                    this.nextToken();
                    if (this.token.value === TOK.identifier) {
                        const id = this.token.ident;
                        const die = new DotIdExp(loc, e, id);
                        die.arrow = true;
                        e = die;
                        break;
                    }
                    this.error(ds("identifier expected following `->`, not `%s`"), this.token.toChars());
                    break;
                }

                case TOK.plusPlus:
                    e = new PostExp(EXP.plusPlus, loc, e);
                    break;

                case TOK.minusMinus:
                    e = new PostExp(EXP.minusMinus, loc, e);
                    break;

                case TOK.leftParenthesis:
                    e = new CallExp(loc, e, this.cparseArguments());
                    continue;

                case TOK.leftBracket: {
                    // array dereferences:
                    //      array[index]
                    let index: Expression;
                    const arguments_ = new DArray<Expression | null>();

                    this.inBrackets++;
                    this.nextToken();
                    index = this.cparseAssignExp();
                    arguments_.push(index);
                    this.check(TOK.rightBracket);
                    this.inBrackets--;
                    e = ArrayExp.fromArgs(loc, e, arguments_);
                    continue;
                }
                default:
                    return e;
            }
            this.nextToken();
        }
    }

    /************************
     * C11 6.5.3
     * unary-expression:
     *    postfix-expression
     *    ++ unary-expression
     *    -- unary-expression
     *    unary-operator cast-expression
     *    sizeof unary-expression
     *    sizeof ( type-name )
     *    _Alignof ( type-name )
     *    _Alignof unary-expression // gcc extension
     *
     * unary-operator:
     *    & * + - ~ !
     */
    private cparseUnaryExp(): Expression {
        let e: Expression | null = null;
        const loc = this.token.loc;

        const tv = this.token.value;
        switch (tv) {
            case TOK.plusPlus:
                this.nextToken();
                // Parse `++` as an unary operator so that cast expressions only give
                // an error for being non-lvalues.
                e = this.cparseCastExp();
                e = new PreExp(EXP.prePlusPlus, loc, e);
                break;

            case TOK.minusMinus:
                this.nextToken();
                // Parse `--` as an unary operator, same as prefix increment.
                e = this.cparseCastExp();
                e = new PreExp(EXP.preMinusMinus, loc, e);
                break;

            case TOK.and:
                this.nextToken();
                e = this.cparseCastExp();
                e = new AddrExp(loc, e);
                break;

            case TOK.mul:
                this.nextToken();
                e = this.cparseCastExp();
                e = new PtrExp(loc, e);
                break;

            case TOK.min:
                this.nextToken();
                e = this.cparseCastExp();
                e = new NegExp(loc, e);
                break;

            case TOK.add:
                this.nextToken();
                e = this.cparseCastExp();
                e = new UAddExp(loc, e);
                break;

            case TOK.not:
                this.nextToken();
                e = this.cparseCastExp();
                e = new NotExp(loc, e);
                break;

            case TOK.tilde:
                this.nextToken();
                e = this.cparseCastExp();
                e = new ComExp(loc, e);
                break;

            case TOK._Alignof:
            case TOK.sizeof_:
                e = this.cparseSizeofOrAlignofExp();
                break;

            case TOK.andAnd:
                /* https://gcc.gnu.org/onlinedocs/gcc/Labels-as-Values.html
                 */
                this.error(ds("unary `&&` computed goto extension is not supported"));
                this.nextToken();
                e = this.cparseCastExp();
                break;

            default:
                e = this.cparsePostfixExp(e);
                break;
        }
        assert(e !== null);
        return e;
    }

    /**************
     * C11 6.5.3.4
     *    sizeof unary-expression
     *    sizeof ( type-name )
     *    _Alignof ( type-name )
     *    _Alignof unary-expression // gcc extension
     *
     * D's bare `loc` here names no local: it is the lexer's `loc()` member (lexer.d), read at each use.
     */
    private cparseSizeofOrAlignofExp(): Expression {
        const id: Identifier = this.token.value === TOK.sizeof_ ? Id.__sizeof! : Id.__xalignof!;
        let e: Expression;
        this.nextToken();
        const tv0 = this.token.value;
        if (tv0 === TOK.leftParenthesis && this.startsTypeName(this.peek(this.token))) {
            /* Expression may be either be requesting the sizeof a type-name
             * or a compound literal, which requires checking whether
             * the next token is leftCurly
             */
            this.nextToken();
            const t = this.cparseTypeName();
            this.check(TOK.rightParenthesis);
            if (this.token.value === TOK.leftCurly) {
                // ( type-name ) { initializer-list }
                const ci = this.cparseInitializer();
                e = new CompoundLiteralExp(this.loc(), t, ci);
                e = this.cparsePostfixOperators(e);
            } else {
                // ( type-name )
                e = new TypeExp(this.loc(), t);
            }
        } else {
            // C11 6.5.3
            e = this.cparseUnaryExp();
        }
        return new DotIdExp(this.loc(), e, id);
    }

    /**************
     * C11 6.5.4
     * cast-expression
     *    unary-expression
     *    ( type-name ) cast-expression
     */
    private cparseCastExp(): Expression {

        // If ( type-name )
        const tv0 = this.token.value;
        if (tv0 === TOK.leftParenthesis && this.startsTypeName(this.peek(this.token))) {
            // Expression may be either a cast or a compound literal, which
            // requires checking whether the next token is leftCurly
            const loc = this.token.loc;
            this.nextToken();
            const t = this.cparseTypeName();
            this.check(TOK.rightParenthesis);

            if (this.token.value === TOK.leftCurly) {
                // C11 6.5.2.5 ( type-name ) { initializer-list }
                const ci = this.cparseInitializer();
                const ce = new CompoundLiteralExp(loc, t, ci);
                return this.cparsePostfixOperators(ce);
            }

            // ( type-name ) cast-expression
            const ce = this.cparseCastExp();
            return new CastExp(loc, ce, t);
        }

        return this.cparseUnaryExp();
    }

    /**************
     * C11 6.5.5
     * multiplicative-expression
     *    cast-expression
     *    multiplicative-expression * cast-expression
     *    multiplicative-expression / cast-expression
     *    multiplicative-expression % cast-expression
     */
    private cparseMulExp(): Expression {
        const loc = this.token.loc;
        let e = this.cparseCastExp();

        while (true) {
            const tv = this.token.value;
            switch (tv) {
                case TOK.mul: {
                    this.nextToken();
                    const e2 = this.cparseCastExp();
                    e = new MulExp(loc, e, e2);
                    continue;
                }

                case TOK.div: {
                    this.nextToken();
                    const e2 = this.cparseCastExp();
                    e = new DivExp(loc, e, e2);
                    continue;
                }

                case TOK.mod: {
                    this.nextToken();
                    const e2 = this.cparseCastExp();
                    e = new ModExp(loc, e, e2);
                    continue;
                }

                default:
                    break;
            }
            break;
        }
        return e;
    }

    /**************
     * C11 6.5.6
     * additive-expression
     *    multiplicative-expression
     *    additive-expression + multiplicative-expression
     *    additive-expression - multiplicative-expression
     */
    private cparseAddExp(): Expression {
        const loc = this.token.loc;
        let e = this.cparseMulExp();

        while (true) {
            const tv = this.token.value;
            switch (tv) {
                case TOK.add: {
                    this.nextToken();
                    const e2 = this.cparseMulExp();
                    e = new AddExp(loc, e, e2);
                    continue;
                }

                case TOK.min: {
                    this.nextToken();
                    const e2 = this.cparseMulExp();
                    e = new MinExp(loc, e, e2);
                    continue;
                }

                default:
                    break;
            }
            break;
        }
        return e;
    }

    /**************
     * C11 6.5.7
     * shift-expression
     *    additive-expression
     *    shift-expression << additive-expression
     *    shift-expression >> additive-expression
     */
    private cparseShiftExp(): Expression {
        const loc = this.token.loc;
        let e = this.cparseAddExp();

        while (true) {
            const tv = this.token.value;
            switch (tv) {
                case TOK.leftShift: {
                    this.nextToken();
                    const e2 = this.cparseAddExp();
                    e = new ShlExp(loc, e, e2);
                    continue;
                }

                case TOK.rightShift: {
                    this.nextToken();
                    const e2 = this.cparseAddExp();
                    e = new ShrExp(loc, e, e2);
                    continue;
                }

                default:
                    break;
            }
            break;
        }
        return e;
    }

    /**************
     * C11 6.5.8
     * relational-expression
     *    shift-expression
     *    relational-expression < shift-expression
     *    relational-expression > shift-expression
     *    relational-expression <= shift-expression
     *    relational-expression >= shift-expression
     *
     * `Lcmp:` is the shared tail of the four comparison arms (06 §3.6(b)): a local arrow each arm calls.
     */
    private cparseRelationalExp(): Expression {
        const loc = this.token.loc;

        let e = this.cparseShiftExp();

        let op: EXP = EXP.reserved;
        const Lcmp = (): void => {
            this.nextToken();
            const e2 = this.cparseShiftExp();
            e = new CmpExp(op, loc, e, e2);
        };
        const tv = this.token.value;
        switch (tv) {
            case TOK.lessThan:       op = EXP.lessThan; Lcmp(); break;        // goto Lcmp (dmd/cparse.d:1306)
            case TOK.lessOrEqual:    op = EXP.lessOrEqual; Lcmp(); break;     // goto Lcmp (dmd/cparse.d:1307)
            case TOK.greaterThan:    op = EXP.greaterThan; Lcmp(); break;     // goto Lcmp (dmd/cparse.d:1308)
            case TOK.greaterOrEqual: op = EXP.greaterOrEqual; Lcmp(); break;  // goto Lcmp (dmd/cparse.d:1309)

            default:
                break;
        }
        return e;
    }

    /**************
     * C11 6.5.9
     * equality-expression
     *    relational-expression
     *    equality-expression == relational-expression
     *    equality-expression != relational-expression
     *
     * `Lequal:` is the shared tail of the two arms (06 §3.6(b)), as in cparseRelationalExp.
     */
    private cparseEqualityExp(): Expression {
        const loc = this.token.loc;

        let e = this.cparseRelationalExp();

        let op: EXP = EXP.reserved;
        const Lequal = (): void => {
            this.nextToken();
            const e2 = this.cparseRelationalExp();
            e = new EqualExp(op, loc, e, e2);
        };
        const tv = this.token.value;
        switch (tv) {
            case TOK.equal:         op = EXP.equal;    Lequal(); break;  // goto Lequal (dmd/cparse.d:1338)
            case TOK.notEqual:      op = EXP.notEqual; Lequal(); break;  // goto Lequal (dmd/cparse.d:1339)

            default:
                break;
        }
        return e;
    }

    /**************
     * C11 6.5.10
     * AND-expression
     *    equality-expression
     *    AND-expression & equality-expression
     */
    private cparseAndExp(): Expression {
        let loc: Loc = this.token.loc;
        let e = this.cparseEqualityExp();
        while (this.token.value === TOK.and) {
            this.nextToken();
            const e2 = this.cparseEqualityExp();
            e = new AndExp(loc, e, e2);
            loc = this.token.loc;
        }
        return e;
    }

    /**************
     * C11 6.5.11
     * exclusive-OR-expression
     *    AND-expression
     *    exclusive-OR-expression ^ AND-expression
     */
    private cparseXorExp(): Expression {
        const loc = this.token.loc;

        let e = this.cparseAndExp();
        while (this.token.value === TOK.xor) {
            this.nextToken();
            const e2 = this.cparseAndExp();
            e = new XorExp(loc, e, e2);
        }
        return e;
    }

    /**************
     * C11 6.5.12
     * inclusive-OR-expression
     *    exclusive-OR-expression
     *    inclusive-OR-expression | exclusive-OR-expression
     */
    private cparseOrExp(): Expression {
        const loc = this.token.loc;

        let e = this.cparseXorExp();
        while (this.token.value === TOK.or) {
            this.nextToken();
            const e2 = this.cparseXorExp();
            e = new OrExp(loc, e, e2);
        }
        return e;
    }

    /**************
     * C11 6.5.13
     * logical-AND-expression
     *    inclusive-OR-expression
     *    logical-AND-expression && inclusive-OR-expression
     */
    private cparseAndAndExp(): Expression {
        const loc = this.token.loc;

        let e = this.cparseOrExp();
        while (this.token.value === TOK.andAnd) {
            e = new CastExp(loc, e, Type.tbool);
            this.nextToken();
            let e2 = this.cparseOrExp();
            e2 = new CastExp(loc, e2, Type.tbool);
            e = new LogicalExp(loc, EXP.andAnd, e, e2);
        }
        return e;
    }

    /**************
     * C11 6.5.14
     * logical-OR-expression
     *    logical-AND-expression
     *    logical-OR-expression || logical-AND-expression
     */
    private cparseOrOrExp(): Expression {
        const loc = this.token.loc;

        let e = this.cparseAndAndExp();
        while (this.token.value === TOK.orOr) {
            e = new CastExp(loc, e, Type.tbool);
            this.nextToken();
            let e2 = this.cparseAndAndExp();
            e2 = new CastExp(loc, e2, Type.tbool);
            e = new LogicalExp(loc, EXP.orOr, e, e2);
        }
        return e;
    }

    /**************
     * C11 6.5.15
     * conditional-expression:
     *    logical-OR-expression
     *    logical-OR-expression ? expression : conditional-expression
     *
     * Public: iasm/gcc.d:228 parses GCC asm operands with it.
     */
    cparseCondExp(): Expression {
        const loc = this.token.loc;

        let e = this.cparseOrOrExp();
        if (this.token.value === TOK.question) {
            this.nextToken();
            const e1 = this.cparseExpression();
            this.check(TOK.colon);
            const e2 = this.cparseCondExp();
            e = new CondExp(loc, e, e1, e2);
        }
        return e;
    }

    /**************
     * C11 6.5.16
     * assignment-expression:
     *    conditional-expression
     *    unary-expression assignment-operator assignment-expression
     *
     * assignment-operator:
     *    = *= /= %= += -= <<= >>= &= ^= |=
     *
     * Public: iasm/gcc.d:217 parses GCC asm operands with it. The left operand is not checked to be
     * a unary-expression here; semantic does that.
     */
    cparseAssignExp(): Expression {
        let e: Expression;
        e = this.cparseCondExp(); // constrain it to being unary-expression in semantic pass
        if (e === null)
            return e;

        const loc = this.token.loc;
        const tv = this.token.value;
        switch (tv) {
            case TOK.assign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new AssignExp(loc, e, e2);
                break;
            }

            case TOK.addAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new AddAssignExp(loc, e, e2);
                break;
            }

            case TOK.minAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new MinAssignExp(loc, e, e2);
                break;
            }

            case TOK.mulAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new MulAssignExp(loc, e, e2);
                break;
            }

            case TOK.divAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new DivAssignExp(loc, e, e2);
                break;
            }

            case TOK.modAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new ModAssignExp(loc, e, e2);
                break;
            }

            case TOK.andAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new AndAssignExp(loc, e, e2);
                break;
            }

            case TOK.orAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new OrAssignExp(loc, e, e2);
                break;
            }

            case TOK.xorAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new XorAssignExp(loc, e, e2);
                break;
            }

            case TOK.leftShiftAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new ShlAssignExp(loc, e, e2);
                break;
            }

            case TOK.rightShiftAssign: {
                this.nextToken();
                const e2 = this.cparseAssignExp();
                e = new ShrAssignExp(loc, e, e2);
                break;
            }

            default:
                break;
        }

        return e;
    }

    /***********************
     * C11 6.5.1.1
     * _Generic ( assignment-expression, generic-assoc-list )
     *
     * generic-assoc-list:
     *   generic-association
     *   generic-assoc-list generic-association
     *
     * generic-association:
     *   type-name : assignment-expression
     *   default : assignment-expression
     */
    private cparseGenericSelection(): Expression {
        const loc = this.token.loc;
        this.nextToken();
        this.check(TOK.leftParenthesis);
        const cntlExp = this.cparseAssignExp();
        this.check(TOK.comma);
        const types: Types = new DArray<Type | null>();
        const exps: Expressions = new DArray<Expression | null>();
        let sawDefault = false;
        while (true) {
            let t: Type | null;
            if (this.token.value === TOK.default_) {
                this.nextToken();
                if (sawDefault)
                    this.error(ds("only one `default` allowed in generic-assoc-list"));
                sawDefault = true;
                t = null;
            } else
                t = this.cparseTypeName();
            types.push(t);

            this.check(TOK.colon);
            const e = this.cparseAssignExp();
            exps.push(e);
            if (this.token.value === TOK.rightParenthesis || this.token.value === TOK.endOfFile)
                break;
            this.check(TOK.comma);
        }
        this.check(TOK.rightParenthesis);
        return new GenericExp(loc, cntlExp, types, exps);
    }

    /***********************
     * C11 6.6 Constant expressions
     * constant-expression:
     *   conditional-expression
     */
    private cparseConstantExp(): Expression {
        return this.cparseCondExp();
    }

    /*****************************
     * gcc extension:
     *    type __builtin_va_arg(assign-expression, type)
     * Rewrite as `va_arg` template from `core.stdc.stdarg`:
     *    va_arg!(type)(assign-expression);
     * Lexer is on `__builtin_va_arg`
     *
     * D's `const loc = loc;` reads the lexer's `loc()` member: the local is not yet in scope there.
     */
    private cparseBuiltin_va_arg(): Expression {
        this.importBuiltins = true;  // need core.stdc.stdarg

        this.nextToken();
        this.check(TOK.leftParenthesis);

        const arguments_ = new DArray<Expression | null>();
        const arg = this.cparseAssignExp();
        arguments_.push(arg);

        this.check(TOK.comma);

        const t = this.cparseTypeName();
        const tiargs: Objects = new DArray();
        tiargs.push(t);

        const loc = this.loc();
        const ti = new TemplateInstance(loc, Id.va_arg, tiargs);
        const tie = new ScopeExp(loc, ti);

        const e: Expression = new CallExp(loc, tie, arguments_);

        this.check(TOK.rightParenthesis);
        return e;
    }

    /*****************************
     * gcc extension: https://gcc.gnu.org/onlinedocs/gcc/Statement-Exprs.html
     * Represent as a function literal, then call the function literal.
     * Parser is on opening curly brace.
     */
    private cparseStatementExpression(): Expression {
        const parameterList = new ParameterList(null);
        const stc: STC = STC.none;
        const loc = this.token.loc;
        const symbolsSave = this.symbols;
        this.symbols = new DArray<Dsymbol | null>();
        this.typedefTab.push(null);
        const fbody = this.cparseStatement(ParseStatementFlags.scope_);
        this.typedefTab.pop();                                        // end of function scope
        this.symbols = symbolsSave;

        // Rewrite last ExpStatement (if there is one) as a ReturnStatement
        const ss = fbody!.isScopeStatement()!;
        const cs = ss.statement!.isCompoundStatement();
        assert(cs !== null);
        const len = cs.statements!.length;
        if (len !== 0) {
            const s = cs.statements!.opIndex(len - 1);
            if (s !== null) {  // error recovery should be with ErrorStatement, not null
                const es = s.isExpStatement();
                if (es !== null)
                    cs.statements!.opIndexAssign(new ReturnStatement(es.loc, es.exp), len - 1);
            }
        }

        const tf = new TypeFunction(parameterList, null, LINK.d, stc);
        const fd = new FuncLiteralDeclaration(loc, this.token.loc, tf, TOK.delegate_, null, null, STC.none);
        fd.fbody = fbody;

        const fe = new FuncExp(loc, fd);
        const args = new DArray<Expression | null>();
        const e = new CallExp(loc, fe, args);   // call the function literal
        return e;
    }

    /********************************************************************************/
    /********************************* Declaration Parser ***************************/

    /**
     * dmd/cparse.d:1708 — `void declareTag(AST.TypeTag tt` declares the tag of struct/union/enum type
     * `tt` in the current scope: pushes a StructDeclaration, UnionDeclaration or EnumDeclaration
     * (wrapped in an AlignDeclaration when `tt.alignExps` is set) onto `symbols`, creating `symbols`
     * if null, and moves `tt.members` into it (`tt.members` becomes null). An unnamed struct/union, or
     * an unnamed enum when `generate_enum_id` is set, gets a generated `__tag` name first.
     * `_specifier` is unused in D too; the `_` prefix is the tree's `noUnusedParameters` convention.
     */
    declareTag(tt: TypeTag, _specifier: Specifier, generate_enum_id = false): void {
        if (tt.id === null && (generate_enum_id || tt.tok !== TOK.enum_)) tt.id = Identifier.generateId(ds("__tag"));
        /* `struct tag;` and `struct tag { ... };`
         * always result in a declaration in the current scope
         */
        const stag: ScopeDsymbol = (tt.tok === TOK.struct_) ? new StructDeclaration(tt.loc, tt.id, false) :
                                   (tt.tok === TOK.union_)  ? new UnionDeclaration(tt.loc, tt.id) :
                                                              new EnumDeclaration(tt.loc, tt.id, tt.base);
        if (tt.alignExps === null && !tt.packalign.isUnknown()) {
            // saw `struct __declspec(align(N)) Tag ...`
            const st = stag.isStructDeclaration()!;
            st.alignment = tt.packalign.copy();
        }
        stag.members = tt.members;
        tt.members = null;
        if (this.symbols === null)
            this.symbols = new DArray<Dsymbol | null>();
        let stags: Dsymbol = stag;
        if (tt.alignExps !== null) {
            const decls = new DArray<Dsymbol | null>(1);
            decls.opIndexAssign(stags, 0);
            stags = AlignDeclaration.fromExps(stags.loc, tt.alignExps, decls);
        }
        this.symbols.push(stags);
    }
    /*************************************
     * C11 6.7
     * declaration:
     *    declaration-specifiers init-declarator-list (opt) ;
     *    static_assert-declaration
     *
     * init-declarator-list:
     *    init-declarator
     *    init-declarator-list , init-declarator
     *
     * init-declarator:
     *    declarator
     *    declarator = initializer
     *
     * Params:
     *    level = declaration context
     *
     * Appends what it declares to `symbols` (a function definition included); typedefs go to the
     * current `typedefTab` scope. On a syntax error it reports and skips past the next `;`.
     */
    cparseDeclaration(level: LVL): void {
        const tv0 = this.token.value;
        if (tv0 === TOK._Static_assert) {
            const s = this.cparseStaticAssert();
            this.symbols!.push(s);
            return;
        }

        if (tv0 === TOK.__pragma) {
            this.uupragmaDirective(this.scanloc);
            return;
        }

        if (tv0 === TOK._import) { // import declaration extension
            const a = this.parseImport();
            if (a !== null && a.length)
                this.symbols!.append(a);
            return;
        }

        const typedefTabLengthSave = this.typedefTab.length;
        let symbolsSave = this.symbols;
        const specifier = new Specifier();
        specifier.packalign = this.packalign.copy();
        let tspec = this.cparseDeclarationSpecifiers(level, specifier);

        // Defer declaring a tagged type (struct/union/enum) so
        // that anonymous types can use a typedef as their id.

        /* If a declarator does not follow, it is unnamed
         */
        const tv1 = this.token.value;
        if (tv1 === TOK.semicolon) {
            if (tspec === null) {
                this.nextToken();
                return;         // accept empty declaration as an extension
            }

            const ti = tspec.isTypeIdentifier();
            if (ti !== null) {
                // C11 6.7.2-2
                this.error(ds("type-specifier missing for declaration of `%s`"), ti.ident!.toChars());
                this.nextToken();
                return;
            }

            this.nextToken();
            const tt = tspec.isTypeTag();
            if (tt === null ||
                tt.id === null && (tt.tok === TOK.struct_ || tt.tok === TOK.union_))
                return; // legal but meaningless empty declaration, ignore it

            if (tt.members !== null || tt.tok !== TOK.enum_)
                this.declareTag(tt, specifier);

            // D `if (0 && tt.tok == TOK.enum_)` (dmd/cparse.d:1814): the `0 &&` short-circuits, so the
            // "`enum %s` has no members" error is never reached; C11's ban on empty enums is not enforced.
            return;
        }

        if (tspec === null) {
            this.error(ds("no type for declarator before `%s`"), this.token.toChars());
            this.panic();
            this.nextToken();
            return;
        }

        {
            const tt = tspec.isTypeTag();
            if (tt !== null) {
                if (tt.id !== null && tt.members !== null) {
                    // Valid tag decl with name and members, go ahead and declare it now.
                    this.declareTag(tt, specifier);
                }
            }
        }

        if (tspec !== null && (specifier.mod & MOD.xconst) !== 0) {
            tspec = this.toConst(tspec);
            specifier.mod &= ~MOD.xnone;          // 'used' it
        }

        const scanPastSemicolon = (): void => {
            while (this.token.value !== TOK.semicolon && this.token.value !== TOK.endOfFile)
                this.nextToken();
            this.nextToken();
        };

        if (this.token.value === TOK.assign && tspec !== null && tspec.isTypeIdentifier() !== null) {
            /* C11 6.7.2-2
             * Special check for `const b = 1;` because some compilers allow it
             */
            this.error(ds("type-specifier omitted for declaration of `%s`"),
                       tspec.isTypeIdentifier()!.ident!.toChars());
            return scanPastSemicolon();
        }

        // Lend: (dmd/cparse.d:2141) the terminal tail of the closing switch, reached by a jump and by
        // falling out of the default arm (06 §4 BAIL).
        const LendTail = (): void => {
            return scanPastSemicolon();
        };
        // default: (dmd/cparse.d:2139) also reached by a jump from the identifier arm (06 §3.6, terminal arm).
        const defaultArm = (): void => {
            this.error(ds("`=`, `;` or `,` expected to end declaration instead of `%s`"), this.token.toChars());
            return LendTail();
        };

        let first = true;
        while (true) {
            let asmName: StringExp | null = null;
            const pident: { value: ArgumentLabel } = { value: new ArgumentLabel(null, Loc.initial) };
            let dt = this.cparseDeclarator(DTR.xdirect_fd, tspec, pident, specifier);
            const id = pident.value;
            if (dt === null) {
                this.panic();
                this.nextToken();
                break;          // error recovery
            }

            /* GNU Extensions
             * init-declarator:
             *    declarator simple-asm-expr (opt) gnu-attributes (opt)
             *    declarator simple-asm-expr (opt) gnu-attributes (opt) = initializer
             *
             * Clang also allows simple-asm-expr after gnu-attributes.
             */
            while (true) {
                const tv = this.token.value;
                if (tv === TOK.asm_) {
                    asmName = this.cparseGnuAsmLabel();
                    /* This is a data definition, there cannot now be a
                     * function definition.
                     */
                    first = false;
                } else if (tv === TOK.__attribute__)
                    this.cparseGnuAttributes(specifier);
                else
                    break;
            }

            switch (this.token.value) {
                case TOK.assign:
                case TOK.comma:
                case TOK.semicolon:
                    /* This is a data definition, there cannot now be a
                     * function definition.
                     */
                    first = false;
                    break;

                default:
                    break;
            }

            // Check lastAlignas and not alignasExps so that gnu
            // __atribute__((aligned())) is silently allowed, matching the
            // behavior of other compilers.
            if (specifier.lastAlignas !== null && dt.isTypeFunction() !== null)
                // C11 6.7.5-2
                this.errorLoc(specifier.lastAlignas.loc, ds("no alignment-specifier for function declaration"));
            if (specifier.lastAlignas !== null && specifier.scw === SCW.xregister)
                // C11 6.7.5-2
                this.errorLoc(specifier.lastAlignas.loc, ds("no alignment-specifier for `register` storage class"));

            /* C11 6.9.1 Function Definitions
             * function-definition:
             *   declaration-specifiers declarator declaration-list (opt) compound-statement
             *
             * declaration-list:
             *    declaration
             *    declaration-list declaration
             */
            const t = this.token;          // D `auto t = &token;`: an alias of the token, not a copy
            if (first &&                   // first declarator
                id.name !== null &&
                dt.isTypeFunction() !== null &&     // function type not inherited from a typedef
                level === LVL.global &&    // function definitions only at global scope
                t.value !== TOK.endOfFile) {
                let s = this.cparseFunctionDefinition(id.copy(), dt.isTypeFunction()!, specifier);
                this.typedefTab.setDim(typedefTabLengthSave);
                this.symbols = symbolsSave;
                if ((specifier.mod & MOD.x__stdcall) !== 0) {
                    // If this function is __stdcall, wrap it in a LinkDeclaration so that
                    // it's extern(Windows) when imported in D.
                    const decls = new DArray<Dsymbol | null>(1);
                    decls.opIndexAssign(s, 0);
                    s = new LinkDeclaration(s.loc, LINK.windows, decls);
                }
                this.symbols!.push(s);
                return;
            }
            let s: Dsymbol | null = null;
            this.typedefTab.setDim(typedefTabLengthSave);
            this.symbols = symbolsSave;
            if (this.symbols === null)
                this.symbols = new DArray<Dsymbol | null>();     // lazily create it

            if (level !== LVL.global && tspec === null && specifier.scw === SCW.xnone && specifier.mod === MOD.xnone)
                this.error(ds("declaration-specifier-seq required"));
            else if (specifier.scw === SCW.xtypedef) {
                if (this.token.value === TOK.assign)
                    this.error(ds("no initializer for typedef declaration"));
                if (specifier.lastAlignas !== null)
                    // C11 6.7.5-2
                    this.errorLoc(specifier.lastAlignas.loc, ds("no alignment-specifier for typedef declaration"));

                if (specifier.vector_size) {
                    // `uint / ulong` divides in the 64-bit domain (09 §1)
                    const length = new IntegerExp(this.token.loc, BigInt(specifier.vector_size) / size(dt),
                                                  Type.tuns32);
                    const tsa = new TypeSArray(dt, length);
                    dt = new TypeVector(tsa);
                    specifier.vector_size = 0;          // used it up
                }

                const isalias = true;
                let idt: Identifier | null = null;
                const tt = dt.isTypeTag();
                if (tt !== null) {
                    if (tt.id === null && id.name !== null)
                        /* This applies for enums declared as
                         * typedef enum {A} E;
                         * Or for similar structs and unions.
                         */
                        tt.id = id.name;
                    if (tt.members !== null) {
                        const spec = new Specifier();
                        this.declareTag(tt, spec);
                    }
                    idt = tt.id;
                } else {
                    const tt = tspec!.isTypeTag();
                    if (tt !== null) {
                        // The unusual situation of an anonymous typedef struct where the
                        // first typedef can't be used as its name.
                        // Just declare it now so we can get a valid id.
                        if (tt.id === null && tt.members !== null) {
                            const spec = new Specifier();
                            this.declareTag(tt, spec, true);
                            idt = tt.id;
                        }
                    }
                }
                if (isalias) {
                    const ad = AliasDeclaration.fromType(id.loc, id.name!, dt);
                    if (id.name === idt)
                        ad.hidden = true; // do not print when generating .di files
                    s = ad;
                }

                this.insertTypedefToTypedefTab(id.name!, dt);       // remember typedefs
            } else if (id.name !== null) {
                {
                    const tt = dt.isTypeTag();
                    if (tt !== null) {
                        if (tt.members !== null && (tt.id !== null || tt.tok === TOK.enum_)) {
                            const spec = new Specifier();
                            this.declareTag(tt, spec);
                        }
                    }
                }

                if (level === LVL.prototype)
                    break;      // declared later as Parameter, not VarDeclaration

                if (dt.ty === Tvoid)
                    this.error(ds("`void` has no value"));

                {
                    const tt = tspec!.isTypeTag();
                    if (tt !== null) {
                        // Anonymous struct being used as a var decl type
                        if (tt.id === null && tt.members !== null && tt.tok !== TOK.enum_) {
                            const spec = new Specifier();
                            this.declareTag(tt, spec);
                        }
                    }
                }

                let initializer: Initializer | null = null;
                let hasInitializer = false;
                if (this.token.value === TOK.assign) {
                    this.nextToken();
                    hasInitializer = true;
                    initializer = this.cparseInitializer();
                }
                // declare the symbol
                assert(id.name !== null);

                if (this.isFunctionTypedef(dt)) {
                    if (hasInitializer)
                        this.error(ds("no initializer for function declaration"));
                    if ((specifier.scw & SCW.x_Thread_local) !== 0)
                        this.error(ds("functions cannot be `_Thread_local`")); // C11 6.7.1-4
                    let stc: STC = this.specifiersToSTC(level, specifier);
                    stc = (stc & ~STC.gshared) as STC;        // no gshared functions
                    const fd = new FuncDeclaration(id.loc, Loc.initial, id.name, stc, dt, specifier.noreturn);
                    this.specifiersToFuncDeclaration(fd, specifier);
                    s = fd;
                } else {
                    // Give non-extern variables an implicit void initializer
                    // if one has not been explicitly set.
                    if (!hasInitializer &&
                        !((specifier.scw & (SCW.xextern | SCW.xstatic | SCW.x_Thread_local)) !== 0 ||
                          level === LVL.global))
                        initializer = new VoidInitializer(this.token.loc);
                    const vd = new VarDeclaration(id.loc, dt, id.name, initializer,
                                                  this.specifiersToSTC(level, specifier));
                    this.specifiersToVarDeclaration(vd, specifier);
                    s = vd;
                }
                if (level !== LVL.global)
                    this.insertIdToTypedefTab(id.name); // non-typedef declarations can hide typedefs in outer scopes
            }
            if (s !== null) {
                // Saw `asm("name")` in the function, type, or variable definition.
                // This is equivalent to `pragma(mangle, "name")` in D
                if (asmName !== null) {
                    /*
                    https://issues.dlang.org/show_bug.cgi?id=23012
                    Ideally this would be translated to a pragma(mangle)
                    decl. This is not possible because ImportC symbols are
                    (currently) merged before semantic analysis is performed,
                    so the pragma(mangle) never effects any change on the declarations
                    it pertains too.

                    Writing to mangleOverride directly avoids this, and is possible
                    because C only a StringExp is allowed unlike a full fat pragma(mangle)
                    which is more liberal.
                    */
                    const p = s.isDeclaration();
                    if (p !== null) {
                        const str = asmName.peekString();
                        p.mangleOverride = str;
                        p.noUnderscore = true;
                    }
                }
                s = this.applySpecifier(s, specifier);
                if (level === LVL.local || (specifier.mod & MOD.x__stdcall) !== 0) {
                    // Wrap the declaration in `extern (C/Windows) { declaration }`
                    // Necessary for function pointers, but harmless to apply to all.
                    const decls = new DArray<Dsymbol | null>(1);
                    decls.opIndexAssign(s, 0);
                    const lkg = (specifier.mod & MOD.x__stdcall) !== 0 ? LINK.windows : this.linkage;
                    s = new LinkDeclaration(s.loc, lkg, decls);
                }
                this.symbols.push(s);
            }
            if (level === LVL.global && id.name === null)
                this.error(ds("expected identifier for declaration"));

            first = false;

            const tv = this.token.value;
            switch (tv) {
                case TOK.identifier:
                    if (s !== null) {
                        this.errorLoc(this.token.loc,
                                      ds("missing comma or semicolon after declaration of `%s`, found `%s` instead"),
                                      s.toChars(), this.token.toChars());
                        return LendTail();  // goto Lend (dmd/cparse.d:2125)
                    }
                    return defaultArm();  // goto default (dmd/cparse.d:2127)

                case TOK.semicolon:
                    this.nextToken();
                    return;

                case TOK.comma:
                    if (symbolsSave === null)
                        symbolsSave = this.symbols;
                    this.nextToken();
                    break;

                default:
                    return defaultArm();
            }
        }
    }

    /***************************************
     * C11 Function Definitions
     * function-definition
     *    declaration-specifiers declarator declaration-list (opt) compound-statement
     *
     * declaration-list:
     *    declaration
     *    declaration-list declaration
     *
     * It's already been parsed up to the declaration-list (opt).
     * Pick it up from there.
     * Params:
     *    id = function identifier
     *    ft = function type
     *    specifier = function specifiers
     * Returns:
     *  Dsymbol for the function
     *
     * A K&R declaration-list moves each declared type and storage class onto the matching parameter
     * of `ft` (which becomes `KRvariadic`); `__func__`/`__FUNCTION__`/`__PRETTY_FUNCTION__`
     * declarations are prepended to the body when the body references them.
     */
    cparseFunctionDefinition(id: ArgumentLabel, ft: TypeFunction, specifier: Specifier): Dsymbol {
        /* Start function scope
         */
        this.typedefTab.push(null);

        const tv0 = this.token.value;
        if (tv0 !== TOK.leftCurly) {      // if not start of a compound-statement
            // Do declaration-list
            do {
                this.cparseDeclaration(LVL.parameter);
            } while (this.token.value !== TOK.leftCurly && this.token.value !== TOK.endOfFile);

            /* Since there were declarations, the parameter-list must have been
             * an identifier-list.
             */
            ft.parameterList.hasIdentifierList = true;        // semantic needs to know to adjust parameter types
            const pl = ft.parameterList.copy();
            if (pl.varargs !== VarArg.none && pl.length())
                this.error(ds("function identifier-list cannot end with `...`"));
            ft.parameterList.varargs = VarArg.KRvariadic;   // but C11 allows extra arguments
            const plLength = pl.length();
            if (this.symbols !== null && this.symbols.length !== plLength)
                this.errorLoc(this.token.loc, ds("%d identifiers does not match %d declarations"), plLength,
                              this.symbols.length);

            /* Transfer the types and storage classes from symbols[] to pl[]
             */
            for (let i = 0; i < plLength; i++) {
                const p = pl.opIndex(i)!;  // yes, quadratic

                // Convert typedef-identifier to identifier
                if (p.type !== null) {
                    const t = p.type.isTypeIdentifier();
                    if (t !== null) {
                        p.ident = t.ident;
                        p.type = null;
                    }
                }

                if (p.type !== null || (p.storageClass & STC.parameter) === 0n)
                    this.error(ds("storage class and type are not allowed in identifier-list"));
                if (this.symbols === null) {
                    // Error already given in cparseDeclaration
                    p.type = Type.terror;
                    continue;
                }
                for (let s of this.symbols) { // yes, quadratic
                    const ad = s!.isAttribDeclaration();
                    if (ad !== null)
                        s = ad.decl!.opIndex(0);      // AlignDeclaration wrapping the declaration

                    const d = s!.isDeclaration();
                    if (d !== null && p.ident === d.ident && d.type !== null) {
                        p.type = d.type;
                        p.storageClass = d.storage_class;
                        d.type = null; // don't reuse
                        break;
                    }
                }
                if (p.type === null) {
                    this.error(ds("no declaration for identifier `%s`"), p.ident!.toChars());
                    p.type = Type.terror;
                }
            }
        }

        /* gets set to true if somebody references __func__ in this function, //ditto for __FUNCTION__ */
        this.addFuncName = false;
        this.refFuncName = false;
        this.pretFuncName = false;
        const locFunc = this.token.loc;

        // don't start a new scope; continue with parameter scope
        let body = this.cparseStatement(ParseStatementFlags.curly);
        this.typedefTab.pop();                                        // end of function scope

        let stc: STC = this.specifiersToSTC(LVL.global, specifier);
        stc = (stc & ~STC.gshared) as STC;    // no gshared functions
        const fd = new FuncDeclaration(id.loc, this.prevloc, id.name, stc, ft, specifier.noreturn);
        this.specifiersToFuncDeclaration(fd, specifier);

        const stmts: Statements = new DArray<Statement | null>();

        if (this.addFuncName)
            stmts.push(this.createFuncName(locFunc, id.name!, Id.__func__!));

        if (this.refFuncName)
            stmts.push(this.createFuncName(locFunc, id.name!, Id.FUNCTION!));

        if (this.pretFuncName)
            stmts.push(this.createPrettyFunc(locFunc, fd));

        stmts.push(body);

        body = new CompoundStatement(locFunc, stmts);
        fd.fbody = body;

        // TODO add `symbols` to the function's local symbol table `sc2` in FuncDeclaration::semantic3()

        return fd;
    }

    /***************************************
     * C11 Initialization
     * initializer:
     *    assignment-expression
     *    { }                       // C23 6.7.10 addition
     *    { initializer-list }
     *    { initializer-list , }
     *
     * initializer-list:
     *    designation (opt) initializer
     *    initializer-list , designation (opt) initializer
     *
     * designation:
     *    designator-list =
     *
     * designator-list:
     *    designator
     *    designator-list designator
     *
     * designator:
     *    [ constant-expression ]
     *    . identifier
     * Returns:
     *    initializer
     */
    cparseInitializer(): Initializer {
        const tv0 = this.token.value;
        if (tv0 !== TOK.leftCurly) {
            const ae = this.cparseAssignExp();        // assignment-expression
            return new ExpInitializer(this.token.loc, ae);
        }
        this.nextToken();
        const loc = this.token.loc;

        const tv1 = this.token.value;
        if (tv1 === TOK.rightCurly) {     // { }
            this.nextToken();
            return new DefaultInitializer(loc);
        }

        /* Collect one or more `designation (opt) initializer`
         * into ci.initializerList, but lazily create ci
         */
        let ci: CInitializer | null = null;
        while (true) {
            /* There can be 0 or more designators preceding an initializer.
             * Collect them in desigInit
             */
            const desigInit = new DesigInit();
            while (true) {
                const tv = this.token.value;
                if (tv === TOK.leftBracket) {    // [ constant-expression ]
                    this.nextToken();
                    const e = this.cparseConstantExp();
                    this.check(TOK.rightBracket);
                    if (desigInit.designatorList === null)
                        desigInit.designatorList = new DArray<Designator>();
                    desigInit.designatorList.push(Designator.fromExpression(e));
                } else if (tv === TOK.dot) {       // . identifier
                    this.nextToken();
                    if (this.token.value !== TOK.identifier) {
                        this.error(ds("identifier expected following `.` designator"));
                        break;
                    }
                    if (desigInit.designatorList === null)
                        desigInit.designatorList = new DArray<Designator>();
                    desigInit.designatorList.push(Designator.fromIdentifier(this.token.ident!));
                    this.nextToken();
                } else {
                    if (desigInit.designatorList !== null)
                        this.check(TOK.assign);
                    break;
                }
            }

            desigInit.initializer = this.cparseInitializer();
            if (ci === null)
                ci = new CInitializer(loc);
            ci.initializerList.push(desigInit.copy());
            const tv2 = this.token.value;
            if (tv2 === TOK.comma) {
                this.nextToken();
                if (this.token.value !== TOK.rightCurly)
                    continue;
            }
            break;
        }
        this.check(TOK.rightCurly);
        return ci;
    }

    /*************************************
     * C11 6.7
     * declaration-specifier:
     *    storage-class-specifier declaration-specifiers (opt)
     *    type-specifier declaration-specifiers (opt)
     *    type-qualifier declaration-specifiers (opt)
     *    function-specifier declaration-specifiers (opt)
     *    alignment-specifier declaration-specifiers (opt)
     * Params:
     *  level = declaration context
     *  specifier = specifiers in and out
     * Returns:
     *  resulting type, null if not specified
     *
     * The function-local `enum TKW` is hoisted to module scope above the class (02 §4).
     */
    private cparseDeclarationSpecifiers(level: LVL, specifier: Specifier): Type | null {
        let t: Type | null = null;

        let tkw: TKW = TKW.xnone;
        let scw: SCW = specifier.scw & SCW.xtypedef;
        let mod: MOD = MOD.xnone;
        let id = new ArgumentLabel(null, Loc.initial);
        let previd = new ArgumentLabel(null, Loc.initial);

        Lwhile:
        while (true) {
            let tkwx: TKW = TKW.xnone;
            let scwx: SCW = SCW.xnone;
            let modx: MOD = MOD.xnone;
            const tv = this.token.value;
            switch (tv) {
                // Storage class specifiers
                case TOK.static_:    scwx = SCW.xstatic;    break;
                case TOK.extern_:    scwx = SCW.xextern;    break;
                case TOK.auto_:      scwx = SCW.xauto;      break;
                case TOK.register:   scwx = SCW.xregister;  break;
                case TOK.typedef_:   scwx = SCW.xtypedef;   break;
                case TOK.inline:     scwx = SCW.xinline;    break;
                case TOK._Noreturn:  scwx = SCW.x_Noreturn; break;
                case TOK.__thread:
                case TOK._Thread_local: scwx = SCW.x_Thread_local; break;

                // Type qualifiers
                case TOK.const_:     modx = MOD.xconst;     break;
                case TOK.volatile:   modx = MOD.xvolatile;  break;
                case TOK.restrict:   modx = MOD.xrestrict;  break;
                case TOK.__stdcall:  modx = MOD.x__stdcall; break;

                // Type specifiers
                case TOK.char_:      tkwx = TKW.xchar;      break;
                case TOK.signed:     tkwx = TKW.xsigned;    break;
                case TOK.unsigned:   tkwx = TKW.xunsigned;  break;
                case TOK.int16:      tkwx = TKW.xshort;     break;
                case TOK.int32:      tkwx = TKW.xint;       break;
                case TOK.int64:      tkwx = TKW.xlong;      break;
                case TOK.__int128:   tkwx = TKW.xint128;    break;
                case TOK.float32:    tkwx = TKW.xfloat;     break;
                case TOK.float64:    tkwx = TKW.xdouble;    break;
                case TOK.void_:      tkwx = TKW.xvoid;      break;
                case TOK._Bool:      tkwx = TKW.xbool;      break;
                case TOK._Imaginary: tkwx = TKW.ximaginary; break;
                case TOK._Complex:   tkwx = TKW.xcomplex;   break;

                case TOK.identifier:
                    tkwx = TKW.xident;
                    id = new ArgumentLabel(this.token.ident, this.token.loc);
                    break;

                case TOK.struct_:
                case TOK.union_: {
                    const structOrUnion = this.token.value;
                    const sloc = this.token.loc;
                    this.nextToken();

                    // D passes `ref this.symbols`; cparseStruct never reads or writes that parameter
                    // (dmd/cparse.d:4019), so the value is passed.
                    t = this.cparseStruct(sloc, structOrUnion, this.symbols);
                    tkwx = TKW.xtag;
                    break;
                }

                case TOK.enum_: {
                    // D passes `ref this.symbols`; cparseEnum never reads or writes that parameter
                    // (dmd/cparse.d:3884), so the value is passed.
                    t = this.cparseEnum(this.symbols);
                    tkwx = TKW.xtag;
                    break;
                }

                case TOK._Atomic: {
                    // C11 6.7.2.4
                    // type-specifier if followed by `( type-name )`
                    if (this.peekNext() === TOK.leftParenthesis) {
                        this.nextToken();
                        this.nextToken();
                        t = this.cparseTypeName();
                        tkwx = TKW.x_Atomic;
                        break;
                    }
                    // C11 6.7.3 type-qualifier if not
                    modx = MOD.x_Atomic;
                    break;
                }

                case TOK._Alignas: {
                    const exp = this.cparseAlignasSpecifier(level);
                    if (specifier.alignasExps === null)
                        specifier.alignasExps = new DArray<Expression | null>();
                    specifier.alignasExps.push(exp);
                    specifier.lastAlignas = exp;
                    break;
                }

                case TOK.__attribute__: {
                    /* GNU Extensions
                     * declaration-specifiers:
                     *    gnu-attributes declaration-specifiers (opt)
                     */
                    this.cparseGnuAttributes(specifier);
                    break;
                }

                case TOK.__declspec: {
                    /* Microsoft extension
                     */
                    this.cparseDeclspec(specifier);
                    break;
                }

                case TOK.typeof_: {
                    /* GNU extension (added in C23)
                     */
                    t = this.cparseTypeofSpecifier();
                    tkwx = TKW.xtag;
                    break;
                }

                default:
                    break Lwhile;
            }

            if (tkwx !== TKW.xnone) {
                if ((tkw & TKW.xlong) !== 0 && (tkwx & TKW.xlong) !== 0) {
                    tkw &= ~TKW.xlong;
                    tkwx = TKW.xllong;
                }
                if (tkw !== TKW.xnone && (tkwx & TKW.xident) !== 0) {
                    // 2nd identifier can't be a typedef
                    break Lwhile; // leave parser on the identifier for the following declarator
                } else if ((tkwx & TKW.xident) !== 0) {
                    // 1st identifier, save it for TypeIdentifier
                    previd = id.copy();
                }
                // `tkwx` alone: tsc has narrowed it to non-zero inside `if (tkwx != 0)` and rejects an
                // explicit `!== TKW.xnone` (TS2367); a numeric enum's JS truthiness is D's `!= 0` (06 §2.5).
                if ((tkw & TKW.xident) !== 0 && tkwx ||  // typedef-name followed by type-specifier
                    (tkw & tkwx) !== 0) {                // duplicate type-specifiers
                    this.error(ds("illegal combination of type specifiers"));
                    tkwx = TKW.xnone;            // TKW.init
                }
                tkw |= tkwx;
                if ((tkwx & TKW.xtag) === 0) // if parser already advanced
                    this.nextToken();
                continue;
            }

            if (modx !== MOD.xnone) {
                mod |= modx;
                this.nextToken();
                continue;
            }

            if (scwx !== SCW.xnone) {
                if ((scw & scwx) !== 0)
                    this.error(ds("duplicate storage class"));
                scw |= scwx;
                // C11 6.7.1-2 At most one storage-class may be given, except that
                // _Thread_local may appear with static or extern.
                const scw2 = scw & (SCW.xstatic | SCW.xextern | SCW.xauto | SCW.xregister | SCW.xtypedef);
                if ((scw2 & (scw2 - 1)) !== 0 ||
                    (scw & SCW.x_Thread_local) !== 0 && (scw & (SCW.xauto | SCW.xregister | SCW.xtypedef)) !== 0) {
                    this.error(ds("multiple storage classes in declaration specifiers"));
                    scw &= ~scwx;
                }
                if (level === LVL.local &&
                    (scw & SCW.x_Thread_local) !== 0 && (scw & (SCW.xinline | SCW.x_Noreturn)) !== 0) {
                    this.error(ds("`inline` and `_Noreturn` function specifiers not allowed for `_Thread_local`"));
                    scw &= ~scwx;
                }
                if (level === LVL.local &&
                    (scw & SCW.x_Thread_local) !== 0 && (scw & (SCW.xstatic | SCW.xextern)) === 0) {
                    // C11 6.7.1-3
                    this.error(ds("`_Thread_local` in block scope must be accompanied with `static` or `extern`"));
                    scw &= ~scwx;
                }
                if ((level & (LVL.parameter | LVL.prototype)) !== 0 &&
                    (scw & ~SCW.xregister) !== 0) {
                    this.error(ds("only `register` storage class allowed for function parameters"));
                    scw &= ~scwx;
                }
                if (level === LVL.global &&
                    scw & (SCW.xauto | SCW.xregister)) {
                    this.error(ds("`auto` and `register` storage class not allowed for global"));
                    scw &= ~scwx;
                }
                this.nextToken();
                continue;
            }
        }

        specifier.scw = scw;
        specifier.mod = mod;

        // Convert TKW bits to type t
        switch (tkw) {
            case TKW.xnone:                     t = null; break;

            case TKW.xchar:                     t = Type.tchar; break;
            case TKW.xsigned | TKW.xchar:       t = Type.tint8; break;
            case TKW.xunsigned | TKW.xchar:     t = Type.tuns8; break;

            case TKW.xshort:
            case TKW.xsigned | TKW.xshort:
            case TKW.xsigned | TKW.xshort | TKW.xint:
            case TKW.xshort | TKW.xint:         t = this.integerTypeForSize(this.shortsize); break;

            case TKW.xunsigned | TKW.xshort | TKW.xint:
            case TKW.xunsigned | TKW.xshort:    t = this.unsignedTypeForSize(this.shortsize); break;

            case TKW.xint:
            case TKW.xsigned:
            case TKW.xsigned | TKW.xint:        t = this.integerTypeForSize(this.intsize); break;

            case TKW.xunsigned:
            case TKW.xunsigned | TKW.xint:      t = this.unsignedTypeForSize(this.intsize); break;

            case TKW.xlong:
            case TKW.xsigned | TKW.xlong:
            case TKW.xsigned | TKW.xlong | TKW.xint:
            case TKW.xlong | TKW.xint:          t = this.integerTypeForSize(this.longsize); break;

            case TKW.xunsigned | TKW.xlong | TKW.xint:
            case TKW.xunsigned | TKW.xlong:     t = this.unsignedTypeForSize(this.longsize); break;

            case TKW.xllong:
            case TKW.xsigned | TKW.xllong:
            case TKW.xsigned | TKW.xllong | TKW.xint:
            case TKW.xllong | TKW.xint:          t = this.integerTypeForSize(this.long_longsize); break;

            case TKW.xunsigned | TKW.xllong | TKW.xint:
            case TKW.xunsigned | TKW.xllong:     t = this.unsignedTypeForSize(this.long_longsize); break;

            case TKW.xint128:
            case TKW.xsigned | TKW.xint128:     t = this.integerTypeForSize(16); break;

            case TKW.xunsigned | TKW.xint128:   t = this.unsignedTypeForSize(16); break;

            case TKW.xvoid:                     t = Type.tvoid; break;
            case TKW.xbool:
                t = this.boolsize === 1 ? Type.tbool : this.integerTypeForSize(this.boolsize);
                break;

            case TKW.xfloat:                    t = Type.tfloat32; break;
            case TKW.xdouble:                   t = Type.tfloat64; break;
            case TKW.xlong | TKW.xdouble:       t = this.realType(RTFlags.realfloat); break;

            case TKW.ximaginary | TKW.xfloat:              t = Type.timaginary32; break;
            case TKW.ximaginary | TKW.xdouble:             t = Type.timaginary64; break;
            case TKW.ximaginary | TKW.xlong | TKW.xdouble: t = this.realType(RTFlags.imaginary); break;

            case TKW.xcomplex | TKW.xfloat:                t = Type.tcomplex32; break;
            case TKW.xcomplex | TKW.xdouble:               t = Type.tcomplex64; break;
            case TKW.xcomplex | TKW.xlong | TKW.xdouble:   t = this.realType(RTFlags.complex); break;

            case TKW.xident: {
                const idx = previd.name!.toString();
                // leading double underscore
                if (idx.length > 2 && idx[0] === 0x5f /* '_' */ && idx[1] === 0x5f /* '_' */)
                    this.importBuiltins = true;  // probably one of those compiler extensions
                t = null;

                /* Punch through to what the typedef is, to support things like:
                 *  typedef T* T;
                 */
                const pt = this.lookupTypedef(previd.name!);
                if (pt !== null && pt.value !== null)      // if previd is a known typedef
                    t = pt.value;

                if (t === null)
                    t = new TypeIdentifier(previd.loc, previd.name);
                break;
            }

            case TKW.xtag:
            case TKW.x_Atomic:  // no atomics for you
                break;          // t is already set

            default:
                this.error(ds("illegal type combination"));
                t = Type.terror;
                break;
        }

        return t;
    }

    /**************
     * C11 6.7.5
     * alignment-specifier:
     *    _Alignas ( type-name )
     *    _Alignas ( constant-expression )
     *
     * D's bare `loc` is the lexer's `loc()` member (no local of that name), read at each use.
     */
    private cparseAlignasSpecifier(level: LVL): Expression {
        if ((level & (LVL.parameter | LVL.prototype)) !== 0)
            this.error(ds("no alignment-specifier for parameters")); // C11 6.7.5-2

        let exp: Expression;
        this.nextToken();
        this.check(TOK.leftParenthesis);
        if (this.startsTypeName(this.token)) {
            // _Alignas ( type-name )
            const talign = this.cparseTypeName();
            // Convert type to expression: `talign.alignof`
            const e = new TypeExp(this.loc(), talign);
            exp = new DotIdExp(this.loc(), e, Id.__xalignof);
        } else {
            // _Alignas ( constant-expression )
            exp = this.cparseConstantExp();
        }
        this.check(TOK.rightParenthesis);
        return exp;
    }

    /**************
     * C23 6.7.2.5
     * typeof-specifier:
     *    typeof ( expression )
     *    typeof ( type-name )
     *    typeof_unqual ( expression )  // not implemented
     *    typeof_unqual ( type-name )   // not implemented
     *
     * D's bare `loc` is the lexer's `loc()` member (no local of that name), read at each use.
     */
    private cparseTypeofSpecifier(): Type {
        this.nextToken();
        this.check(TOK.leftParenthesis);

        let e: Expression;
        if (this.startsTypeName(this.token))
            e = new TypeExp(this.loc(), this.cparseTypeName());
        else
            e = this.cparseExpression();

        const tv0 = this.token.value;
        if (tv0 !== TOK.rightParenthesis) {
            // skipParens et. al expect to be on the opening parenthesis
            this.error(ds("`typeof` operator expects an expression or type name in parentheses"));
            let parens = 0;
            loop: while (true) {
                const tv = this.token.value;
                switch (tv) {
                    case TOK.leftParenthesis:
                        parens++;
                        break;
                    case TOK.rightParenthesis:
                        parens--;
                        if (!(parens < 0))
                            break;
                    // dmd/cparse.d:2780: the jump to the next case is a JS fall-through into the endOfFile arm
                    // eslint-disable-next-line no-fallthrough
                    case TOK.endOfFile:
                        break loop;
                    default:
                        break;
                }
                this.nextToken();
            }
            return Type.terror;
        }
        this.nextToken();
        return new TypeTypeof(this.loc(), e);
    }

    /********************************
     * C11 6.7.6
     * Parse a declarator (including function definitions).
     * declarator:
     *    pointer (opt) direct-declarator
     *
     * direct-declarator :
     *    identifier
     *    ( declarator )
     *    direct-declarator [ type-qualifier-list (opt) assignment-expression (opt) ]
     *    direct-declarator [ static type-qualifier-list (opt) assignment-expression ]
     *    direct-declarator [ type-qualifier-list static assignment-expression (opt) ]
     *    direct-declarator [ type-qualifier-list (opt) * ]
     *    direct-declarator ( parameter-type-list )
     *    direct-declarator ( identifier-list (opt) )
     *
     * pointer :
     *    * type-qualifier-list (opt)
     *    * type-qualifier-list (opt) pointer
     *
     * type-qualifier-list :
     *    type-qualifier
     *    type-qualifier-list type-qualifier
     *
     * parameter-type-list :
     *    parameter-list
     *    parameter-list , ...
     *
     * parameter-list :
     *    parameter-declaration
     *    parameter-list , parameter-declaration
     *
     * parameter-declaration :
     *    declaration-specifiers declarator
     *    declaration-specifiers abstract-declarator (opt)
     *
     * identifier-list :
     *    identifier
     *    identifier-list , identifier
     *
     * Params:
     *  declarator   = declarator kind
     *  tbase        = base type to start with
     *  pident       = set to Identifier if there is one, null if not
     *  specifier    = specifiers in and out
     * Returns:
     *  type declared. If a TypeFunction is returned, this.symbols is the
     *  symbol table for the parameter-type-list, which will contain any
     *  declared struct, union or enum tags.
     *
     * `pident` is D's `out AST.ArgumentLabel`: a box reset to `ArgumentLabel.init` on entry (03 §3.3).
     */
    private cparseDeclarator(declarator: DTR, tbase: Type, pident: { value: ArgumentLabel },
                             specifier: Specifier): Type {
        pident.value = new ArgumentLabel(null, Loc.initial);   // `out`: reset on entry
        const constTypes: Types = new DArray<Type | null>(); // all the Types that will need `const` applied to them

        // this.symbols can get changed to the symbol table for the
        // parameter-type-list if we parse a function type.
        // Callers are only ready to handle this if they pass DTR.xdirect_fd,
        // so remember to restore this.symbols.
        let restore_symbols = true;
        if (declarator === DTR.xdirect_fd) {
            declarator = DTR.xdirect;
            restore_symbols = false;
        }


        /* Insert tx -> t into
         *   ts -> ... -> t
         * so that
         *   ts -> ... -> tx -> t
         *
         * D walks a `Type*` over the `ts` slot, then over the `next` field of each TypeNext in the
         * chain (`pt = &(cast(AST.TypeNext)*pt).next`); here the first slot is the `ts` box and the
         * rest are `next` fields.
         */
        const insertTx = (ts: { value: Type }, tx: Type, t: Type): void => {
            if (ts.value === t) {
                ts.value = tx;
                return;
            }
            let cur: Type = ts.value;
            for (;;) {
                // `cast(AST.TypeNext)*pt`: every link between `ts` and `t` was built by parseDecl as a
                // TypePointer, TypeSArray or TypeFunction; the assert names that tag set (02 §11.5c #3).
                assert(cur.ty === Tpointer || cur.ty === Tsarray || cur.ty === Tfunction);
                const tn = cur as unknown as TypeNext;
                if (tn.next === t) {
                    tn.next = tx;
                    return;
                }
                cur = tn.next!;
            }
        };

        const parseDecl = (t: Type): Type => {
            let ts: Type;
            while (true) {
                const tv = this.token.value;
                switch (tv) {
                    case TOK.identifier:        // identifier
                        if (declarator === DTR.xabstract)
                            this.error(ds("identifier not allowed in abstract-declarator"));
                        pident.value = new ArgumentLabel(this.token.ident, this.token.loc);
                        ts = t;
                        this.nextToken();
                        break;

                    case TOK.leftParenthesis: {   // ( declarator )
                        /* like: T (*fp)();
                         *       T ((*fp))();
                         */
                        const tk: { value: Token } = { value: this.token };
                        if (!this.isCDeclarator(tk, declarator)) {
                            /* Not ( declarator ), might be parameter-list
                             */
                            ts = t;
                            break;
                        }
                        this.nextToken();

                        if (this.token.value === TOK.__stdcall) { // T (__stdcall*fp)();
                            specifier.mod |= MOD.x__stdcall;
                            this.nextToken();
                        }

                        ts = parseDecl(t);
                        this.check(TOK.rightParenthesis);
                        break;
                    }

                    case TOK.mul: {               // pointer
                        t = new TypePointer(t);
                        this.nextToken();
                        // add post fixes const/volatile/restrict/_Atomic
                        const mod = this.cparseTypeQualifierList();
                        if ((mod & MOD.xconst) !== 0)
                            constTypes.push(t);
                        if (this.token.value === TOK.__attribute__)
                            this.cparseGnuAttributes(specifier);
                        continue;
                    }

                    default:
                        if (declarator === DTR.xdirect) {
                            if (t === null || t.isTypeIdentifier() !== null) {
                                // const arr[1];
                                this.error(ds("no type-specifier for declarator"));
                                t = Type.tint32;
                            } else
                                this.error(ds("identifier or `(` expected")); // )
                            this.panic();
                        }
                        ts = t;
                        break;
                }
                break;
            }

            // parse DeclaratorSuffixes
            while (true) {
                const tv = this.token.value;
                switch (tv) {
                    case TOK.leftBracket: {
                        // post [] syntax, pick up any leading type qualifiers, `static` and `*`
                        let ta: Type;
                        this.nextToken();

                        let mod = this.cparseTypeQualifierList();   // const/volatile/restrict/_Atomic

                        let isStatic = false;
                        let isVLA = false;
                        const tv2 = this.token.value;
                        if (tv2 === TOK.static_) {
                            isStatic = true;    // `static`
                            this.nextToken();
                            if (mod === MOD.xnone)           // type qualifiers after `static`
                                mod = this.cparseTypeQualifierList();
                        } else if (tv2 === TOK.mul) {
                            if (this.peekNext() === TOK.rightBracket) {
                                isVLA = true;   // `*`
                                this.nextToken();
                            }
                        }

                        if (isStatic || this.token.value !== TOK.rightBracket) {
                            const e: Expression = this.cparseAssignExp(); // [ expression ]
                            ta = new TypeSArray(t, e);
                        } else {
                            /* C11 6.7.6.2-4 An [ ] array is an incomplete array type
                             */
                            ta = new TypeSArray(t);
                        }
                        this.check(TOK.rightBracket);

                        // Issue errors for unsupported types.
                        if (isVLA) { // C11 6.7.6.2
                            this.error(ds("variable length arrays are not supported"));
                        }
                        if (isStatic) { // C11 6.7.6.3
                            this.error(ds("static array parameters are not supported"));
                        }
                        if (declarator !== DTR.xparameter) {
                            /* C11 6.7.6.2-4: '*' can only be used with function prototype scope.
                             */
                            if (isVLA)
                                this.error(ds("variable length array used outside of function prototype"));
                            /* C11 6.7.6.2-1: type qualifiers and 'static' shall only appear
                             * in a declaration of a function parameter with an array type.
                             */
                            if (isStatic || mod !== MOD.xnone)
                                this.error(ds("static or type qualifier used outside of function prototype"));
                        }
                        if (ts.isStaticOrDynamicArray()) {
                            /* C11 6.7.6.2-1: type qualifiers and 'static' shall only appear
                             * in the outermost array type derivation.
                             */
                            if (isStatic || mod !== MOD.xnone)
                                this.error(ds("static or type qualifier used in non-outermost array type derivation"));
                            /* C11 6.7.6.2-1: the element type shall not be an incomplete or
                             * function type.
                             */
                            if (ta.isTypeSArray() !== null && ta.isTypeSArray()!.isIncomplete() && !isVLA)
                                this.error(ds("array type has incomplete element type `%s`"), ta.toChars());
                        }

                        // Apply type qualifiers to the constructed type.
                        if ((mod & MOD.xconst) !== 0) // ignore the other bits
                            ta = this.toConst(ta);
                        const pts: { value: Type } = { value: ts };
                        insertTx(pts, ta, t);  // ts -> ... -> ta -> t
                        ts = pts.value;
                        continue;
                    }

                    case TOK.leftParenthesis: {
                        // New symbol table for parameter-list
                        const symbolsSave = this.symbols;
                        this.symbols = null;

                        const parameterList = this.cparseParameterList();
                        const lkg = (specifier.mod & MOD.x__stdcall) !== 0 ? LINK.windows : this.linkage;
                        let stc: STC = specifier._nothrow ? STC.nothrow_ : STC.none;
                        if (specifier._pure)
                            stc = (stc | STC.pure_) as STC;
                        stc = (stc | this.defaultStorageClasses) as STC;
                        const tf: Type = new TypeFunction(parameterList, t, lkg, stc);
                        const pts: { value: Type } = { value: ts };
                        insertTx(pts, tf, t);  // ts -> ... -> tf -> t
                        ts = pts.value;

                        if (ts !== tf || restore_symbols)
                            this.symbols = symbolsSave;
                        break;
                    }

                    default:
                        break;
                }
                break;
            }
            if (declarator === DTR.xdirect && pident.value.name === null)
                this.error(ds("expected identifier for declarator"));
            return ts;
        };

        let t = parseDecl(tbase);

        if (specifier.vector_size) {
            const length = new IntegerExp(this.token.loc, BigInt(specifier.vector_size) / size(tbase), Type.tuns32);
            const tsa = new TypeSArray(tbase, length);
            const tv: Type = new TypeVector(tsa);
            specifier.vector_size = 0;          // used it up

            const pt: { value: Type } = { value: t };
            insertTx(pt, tv, tbase);     // replace tbase with tv
            t = pt.value;
        }

        /* Because const is transitive, cannot assemble types from
         * fragments. Instead, types to be annotated with const are put
         * in constTypes[], and a bottom up scan of t is done to apply
         * const
         */
        if (constTypes.length) {
            const constApply = (t: Type): Type => {
                if (nextOf(t) !== null) {
                    // `cast(AST.TypeNext)t`: the chain under `t` holds only the TypePointer, TypeSArray
                    // and TypeFunction links parseDecl built; the assert names that tag set (02 §11.5c #3).
                    assert(t.ty === Tpointer || t.ty === Tsarray || t.ty === Tfunction);
                    const tn = t as unknown as TypeNext; // t.nextOf() should return a ref instead of this
                    tn.next = constApply(tn.next!);
                }
                for (const tc of constTypes) {
                    if (tc === t) {
                        return this.toConst(t);
                    }
                }
                return t;
            };

            if (declarator === DTR.xparameter &&
                t.isTypePointer() !== null) {
                /* Because there are instances in .h files of "const pointer to mutable",
                 * skip applying transitive `const`
                 * https://issues.dlang.org/show_bug.cgi?id=22534
                 */
                // `cast(AST.TypeNext)t`: proved a TypePointer by the test just above.
                const tn: TypeNext = t.isTypePointer()!;
                tn.next = constApply(tn.next!);
            } else
                t = constApply(t);
        }

        return t;
    }

    /******************************
     * C11 6.7.3
     * type-qualifier:
     *    const
     *    restrict
     *    volatile
     *    _Atomic
     *    __stdcall
     *
     * Consumes the type-qualifier tokens at the current position and returns their union; an empty
     * list returns `MOD.xnone` and consumes nothing (dmd/cparse.d:3131).
     */
    cparseTypeQualifierList(): MOD {
        let mod: MOD = MOD.xnone;
        while (true) {
            switch (this.token.value) {
                case TOK.const_: mod |= MOD.xconst; break;
                case TOK.volatile: mod |= MOD.xvolatile; break;
                case TOK.restrict: mod |= MOD.xrestrict; break;
                case TOK._Atomic: mod |= MOD.x_Atomic; break;
                case TOK.__stdcall: mod |= MOD.x__stdcall; break;

                default:
                    return mod;
            }
            this.nextToken();
        }
    }

    /***********************************
     * C11 6.7.7
     * Parses a type-name (specifier-qualifier-list plus abstract declarator). A missing
     * type-specifier is diagnosed and replaced by `int` (dmd/cparse.d:3154).
     */
    cparseTypeName(): Type {
        const specifier = new Specifier();
        specifier.packalign.setDefault();
        let tspec = this.cparseSpecifierQualifierList(LVL.global, specifier);
        if (tspec === null) {
            this.error(ds("type-specifier is missing"));
            tspec = Type.tint32;
        }
        if (tspec !== null && (specifier.mod & MOD.xconst) !== 0) {
            tspec = this.toConst(tspec);
            specifier.mod = MOD.xnone; // 'used' it
        }
        // D `AST.ArgumentLabel id;` passed to cparseDeclarator's `out` parameter: a box (03 §3.3).
        const id: { value: ArgumentLabel } = { value: new ArgumentLabel(null, Loc.initial) };
        return this.cparseDeclarator(DTR.xabstract, tspec, id, specifier);
    }

    /***********************************
     * C11 6.7.2.1
     * specifier-qualifier-list:
     *    type-specifier specifier-qualifier-list (opt)
     *    type-qualifier specifier-qualifier-list (opt)
     * Params:
     *  level = declaration context
     *  specifier = specifiers in and out
     * Returns:
     *  resulting type, null if not specified
     */
    cparseSpecifierQualifierList(level: LVL, specifier: Specifier): Type | null {
        const t = this.cparseDeclarationSpecifiers(level, specifier);
        if (specifier.scw !== 0)
            this.error(ds("storage class not allowed in specifier-qualified-list"));
        return t;
    }

    /***********************************
     * C11 6.7.6.3
     * ( parameter-type-list )
     * ( identifier-list (opt) )
     *
     * Parser is on the `(`; consumes through the `)`. `(void)` is no parameters, `()` is a K&R
     * variadic list. Pushes a function-prototype scope on `typedefTab` for the parameters and pops
     * it before returning (dmd/cparse.d:3197).
     */
    cparseParameterList(): ParameterList {
        const parameters = new DArray<Parameter | null>();
        let varargs: VarArg = VarArg.none;
        const varargsStc: STC = STC.none;

        this.check(TOK.leftParenthesis);
        const tv0: TOK = this.token.value;
        if (tv0 === TOK.void_ && this.peekNext() === TOK.rightParenthesis) { // func(void)
            this.nextToken();
            this.nextToken();
            return new ParameterList(parameters, varargs, varargsStc);
        }

        const tv1: TOK = this.token.value;
        if (tv1 === TOK.rightParenthesis) { // func()
            this.nextToken();
            return new ParameterList(parameters, VarArg.KRvariadic, varargsStc);
        }

        /* Create function prototype scope
         */
        this.typedefTab.push(null);

        const finish = (): ParameterList => {
            this.typedefTab.pop();
            return new ParameterList(parameters, varargs, varargsStc);
        };

        /* The check for identifier-list comes later,
         * when doing the trailing declaration-list (opt)
         */
        while (true) {
            const tv: TOK = this.token.value;
            if (tv === TOK.rightParenthesis)
                break;
            if (tv === TOK.dotDotDot) {
                if (parameters.length === 0) // func(...)
                    this.error(ds("named parameter required before `...`"));
                this.importBuiltins = true; // will need __va_list_tag
                varargs = VarArg.variadic; // C-style variadics
                this.nextToken();
                this.check(TOK.rightParenthesis);
                return finish();
            }

            const specifier = new Specifier();
            specifier.packalign.setDefault();
            const typeLoc = this.token.loc;
            let tspec = this.cparseDeclarationSpecifiers(LVL.prototype, specifier);
            if (tspec === null) {
                this.error(ds("no type-specifier for parameter"));
                tspec = Type.tint32;
            }

            if ((specifier.mod & MOD.xconst) !== 0) {
                const tv2: TOK = this.token.value;
                if ((tv2 === TOK.rightParenthesis || tv2 === TOK.comma) && tspec.isTypeIdentifier() !== null)
                    this.error(ds("type-specifier omitted for parameter `%s`"),
                        tspec.isTypeIdentifier()!.ident!.toChars());

                tspec = this.toConst(tspec);
                specifier.mod = MOD.xnone; // 'used' it
            }

            const id: { value: ArgumentLabel } = { value: new ArgumentLabel(null, Loc.initial) };
            let t = this.cparseDeclarator(DTR.xparameter, tspec, id, specifier);
            if (this.token.value === TOK.__attribute__)
                this.cparseGnuAttributes(specifier);
            if ((specifier.mod & MOD.xconst) !== 0)
                t = this.toConst(t);
            const param = new Parameter(id.value.name !== null ? id.value.loc : typeLoc,
                                        this.specifiersToSTC(LVL.parameter, specifier),
                                        t, id.value.name, null, null);
            parameters.push(param);
            const tv3: TOK = this.token.value;
            if (tv3 === TOK.rightParenthesis || tv3 === TOK.endOfFile)
                break;
            this.check(TOK.comma);
        }
        this.check(TOK.rightParenthesis);
        return finish();
    }

    /***********************************
     * C11 6.7.10
     * _Static_assert ( constant-expression , string-literal ) ;
     * Parser is on the `_Static_assert` (dmd/cparse.d:3287).
     */
    private cparseStaticAssert(): StaticAssert {
        const loc = this.token.loc;

        this.nextToken();
        this.check(TOK.leftParenthesis);
        const exp = this.cparseConstantExp();
        this.check(TOK.comma);
        if (this.token.value !== TOK.string_)
            this.error(ds("string literal expected"));
        const msg = this.cparsePrimaryExp();
        this.check(TOK.rightParenthesis);
        this.check(TOK.semicolon);
        return StaticAssert.fromExpression(loc, exp, msg);
    }

    /*************************
     * Collect argument list.
     * Parser is on opening parenthesis.
     * Returns:
     *    the arguments
     */
    private cparseArguments(): Expressions {
        this.nextToken();
        const arguments_ = new DArray<Expression | null>();
        while (this.token.value !== TOK.rightParenthesis && this.token.value !== TOK.endOfFile) {
            const arg = this.cparseAssignExp();
            arguments_.push(arg);
            if (this.token.value !== TOK.comma)
                break;

            this.nextToken(); // consume comma
        }

        this.check(TOK.rightParenthesis);

        return arguments_;
    }

    /*************************
     * __declspec parser
     * https://docs.microsoft.com/en-us/cpp/cpp/declspec
     * decl-specifier:
     *    __declspec ( extended-decl-modifier-seq )
     *
     * extended-decl-modifier-seq:
     *    extended-decl-modifier (opt)
     *    extended-decl-modifier extended-decl-modifier-seq
     *
     * extended-decl-modifier:
     *    align(number)
     *    deprecated(depMsg)
     *    dllimport
     *    dllexport
     *    naked
     *    noinline
     *    noreturn
     *    nothrow
     *    thread
     * Params:
     *  specifier = filled in with the attribute(s)
     */
    private cparseDeclspec(specifier: Specifier): void {
        /* Check for dllexport, dllimport
         * Ignore the rest
         */
        this.nextToken(); // move past __declspec
        this.check(TOK.leftParenthesis);
        while (true) {
            const tv: TOK = this.token.value;
            if (tv === TOK.rightParenthesis) {
                this.nextToken();
                break;
            } else if (tv === TOK.endOfFile)
                break;
            else if (tv === TOK.identifier) {
                const ident = this.token.ident;
                if (ident === Id.dllimport) {
                    specifier.dllimport = true;
                    this.nextToken();
                } else if (ident === Id.dllexport) {
                    specifier.dllexport = true;
                    this.nextToken();
                } else if (ident === Id.naked) {
                    specifier.naked = true;
                    this.nextToken();
                } else if (ident === Id.noinline) {
                    specifier.scw |= SCW.xnoinline;
                    this.nextToken();
                } else if (ident === Id.noreturn) {
                    specifier.noreturn = true;
                    this.nextToken();
                } else if (ident === Id._nothrow) {
                    specifier._nothrow = true;
                    this.nextToken();
                } else if (ident === Id.thread) {
                    specifier.scw |= SCW.x_Thread_local;
                    this.nextToken();
                } else if (ident === Id._align) {
                    // Microsoft spec is very imprecise as to how this actually works
                    this.nextToken();
                    this.check(TOK.leftParenthesis);
                    if (this.token.value === TOK.int32Literal) {
                        const n = this.token.unsvalue;
                        if (n < 1n || (n & (n - 1n)) !== 0n || 8192n < n)
                            this.error(
                                ds("__decspec(align(%lld)) must be an integer positive power of 2 and be <= 8,192"), n);
                        specifier.packalign.set(Number(BigInt.asUintN(32, n))); // cast(uint)n
                        specifier.packalign.setPack();
                        this.nextToken();
                    } else {
                        this.error(ds("alignment value expected, not `%s`"), this.token.toChars());
                        this.nextToken();
                    }

                    this.check(TOK.rightParenthesis);
                } else if (ident === Id._deprecated) {
                    specifier._deprecated = true;
                    this.nextToken();
                    if (this.token.value === TOK.leftParenthesis) { // optional deprecation message
                        this.nextToken();
                        specifier.depMsg = this.cparseExpression();
                        this.check(TOK.rightParenthesis);
                    }
                } else {
                    this.nextToken();
                    if (this.token.value === TOK.leftParenthesis)
                        this.cparseParens();
                }
            } else if (tv === TOK._Noreturn) {
                specifier.noreturn = true;
                this.nextToken();
            } else if (tv === TOK.restrict) // ImportC assigns no semantics to `restrict`, so just ignore the keyword.
                this.nextToken();
            else {
                this.error(ds("extended-decl-modifier expected after `__declspec(`, saw `%s` instead"),
                    this.token.toChars());
                this.nextToken();
                if (this.token.value !== TOK.rightParenthesis)
                    break;
            }
        }
    }

    /*************************
     * Parser for asm label. It appears after the declarator, and has apparently
     * nothing to do with inline assembler.
     * https://gcc.gnu.org/onlinedocs/gcc/Asm-Labels.html
     * simple-asm-expr:
     *   asm ( asm-string-literal )
     *
     * asm-string-literal:
     *   string-literal
     *
     * Returns: the label, or null when the operand is not a string literal (an error was emitted).
     * D ends with dmd/cparse.d:3481 — `return cast(AST.StringExp) label;`, an unchecked reinterpretation
     * of an extern(C++) class: on the error path it hands back the non-string expression typed as a
     * StringExp. The port returns null there instead. Observable output is unchanged: the only
     * reader, cparseDeclaration's `asmName.peekString()` into `mangleOverride` (dmd/cparse.d:2081-2099),
     * runs after the error, and ldc2 stops at that error with exit status 1 and nothing else
     * printed (probe: `int x asm(123);`).
     */
    private cparseGnuAsmLabel(): StringExp | null {
        this.nextToken(); // move past asm
        this.check(TOK.leftParenthesis);
        if (this.token.value !== TOK.string_)
            this.error(ds("string literal expected for Asm Label, not `%s`"), this.token.toChars());
        const label = this.cparsePrimaryExp();
        this.check(TOK.rightParenthesis);
        return label.isStringExp();
    }

    /********************
     * Parse C inline assembler statement in Gnu format.
     * https://gcc.gnu.org/onlinedocs/gcc/Extended-Asm.html
     *   asm asm-qualifiers ( AssemblerTemplate : OutputOperands : InputOperands : Clobbers : GotoLabels )
     * Current token is on the `asm`.
     * Returns:
     *   inline assembler expression as a Statement
     */
    private cparseGnuAsm(): Statement {
        // Defer parsing of AsmStatements until semantic processing.
        const loc = this.token.loc;

        this.nextToken();

        // Consume all asm-qualifiers.
        let asmQualifiers: AsmQualifiers = AsmQualifiers.none;
        while (true) {
            let qual: AsmQualifiers = AsmQualifiers.none;
            // Lcontinue: SHARED-ARM (06 §4) reached only by the jumps of the three qualifier arms;
            // its tail ends in the loop's `continue`, which each jump site issues after the call.
            const LcontinueTail = (): void => {
                if ((asmQualifiers & qual) !== 0)
                    this.errorLoc(this.token.loc, ds("duplicate `asm` qualifier `%s`"), this.token.toChars());
                else
                    asmQualifiers |= qual;
                this.nextToken();
            };
            switch (this.token.value) {
                case TOK.goto_:
                    qual = AsmQualifiers.goto_;
                    LcontinueTail(); // goto Lcontinue (dmd/cparse.d:3509)
                    continue;

                case TOK.inline:
                    qual = AsmQualifiers.inline;
                    LcontinueTail(); // goto Lcontinue (dmd/cparse.d:3513)
                    continue;

                case TOK.volatile:
                    qual = AsmQualifiers.volatile;
                    LcontinueTail(); // goto Lcontinue (dmd/cparse.d:3517)
                    continue;

                case TOK.const_:
                case TOK.restrict:
                    this.errorLoc(this.token.loc, ds("`%s` is not a valid `asm` qualifier"), this.token.toChars());
                    this.nextToken();
                    continue;

                default:
                    break;
            }
            break;
        }

        this.check(TOK.leftParenthesis);
        if (this.token.value !== TOK.string_)
            this.error(ds("string literal expected for Assembler Template, not `%s`"), this.token.toChars());
        // D `Token* toklist = null; Token** ptoklist = &toklist;`: the list head is a one-slot box,
        // and the cursor over `Token*` slots an accessor pair re-pointed at each new node (03 §7.3).
        const toklist: { value: Token | null } = { value: null };
        let ptoklist = { set: (v: Token | null): void => { toklist.value = v; } };
        const statements = new DArray<Statement | null>();

        let parens = 0;
        while (true) {
            // `default:` body, shared with the arms below that jump to it (06 §3.6, non-adjacent
            // default); the arm ends in the loop's `continue`, issued by every site after the call.
            const defaultArm = (): void => {
                const nt = this.allocateToken(); // *ptoklist = allocateToken();
                ptoklist.set(nt);
                Object.assign(nt, this.token.copy()); // **ptoklist = this.token;
                ptoklist = { set: (v: Token | null): void => { nt.next = v; } }; // ptoklist = &(*ptoklist).next;
                ptoklist.set(null); // *ptoklist = null;
                this.nextToken();
            };
            switch (this.token.value) {
                case TOK.leftParenthesis:
                    ++parens;
                    defaultArm(); // goto default (dmd/cparse.d:3553)
                    continue;

                case TOK.rightParenthesis:
                    --parens;
                    if (parens >= 0) {
                        defaultArm(); // goto default (dmd/cparse.d:3558)
                        continue;
                    }
                    break;

                case TOK.semicolon:
                    this.error(ds("matching `)` expected, not `;`"));
                    break;

                case TOK.endOfFile:
                    /* ( */
                    this.error(ds("matching `)` expected, not end of file"));
                    break;

                default:
                    defaultArm();
                    continue;
            }
            if (toklist.value !== null) {
                // Create AsmStatement from list of tokens we've saved
                const s = new AsmStatement(this.token.loc, toklist.value);
                if ((asmQualifiers & AsmQualifiers.volatile) !== 0)
                    s.isVolatile = true;
                if ((asmQualifiers & AsmQualifiers.inline) !== 0)
                    s.isInline = true;
                statements.push(s);
            }
            break;
        }
        this.nextToken();
        const s = new CompoundAsmStatement(loc, statements, STC.none);
        return s;
    }

    /*************************
     * __attribute__ parser
     * https://gcc.gnu.org/onlinedocs/gcc/Attribute-Syntax.html
     * gnu-attributes:
     *   gnu-attributes gnu-attribute-specifier
     *
     * gnu-attribute-specifier:
     *    __attribute__ (( gnu-attribute-list ))
     *
     * gnu-attribute-list:
     *    gnu-attribute (opt)
     *    gnu-attribute-list , gnu-attribute
     *
     * Params:
     *  specifier = filled in with the attribute(s)
     */
    private cparseGnuAttributes(specifier: Specifier): void {
        while (true) {
            const tv: TOK = this.token.value;
            if (tv !== TOK.__attribute__)
                break;
            this.nextToken(); // move past __attribute__
            this.check(TOK.leftParenthesis);
            this.check(TOK.leftParenthesis);

            if (this.token.value !== TOK.rightParenthesis) {
                while (true) {
                    this.cparseGnuAttribute(specifier);
                    if (this.token.value !== TOK.comma)
                        break;
                    this.nextToken();
                }
            }

            this.check(TOK.rightParenthesis);
            this.check(TOK.rightParenthesis);
        }
    }

    /*************************
     * Parse a single GNU attribute
     * gnu-attribute:
     *    gnu-attribute-name
     *    gnu-attribute-name ( identifier )
     *    gnu-attribute-name ( identifier , expression-list )
     *    gnu-attribute-name ( expression-list (opt) )
     *
     * gnu-attribute-name:
     *    keyword
     *    identifier
     *
     * expression-list:
     *    constant-expression
     *    expression-list , constant-expression
     *
     * Params:
     *  specifier = filled in with the attribute(s)
     */
    private cparseGnuAttribute(specifier: Specifier): void {
        /* Check for dllimport, dllexport, naked, noreturn, vector_size(bytes)
         * Ignore the rest
         */
        if (!this.isGnuAttributeName())
            return;

        const tv: TOK = this.token.value;
        if (tv !== TOK.identifier) {
            this.nextToken();
            if (this.token.value === TOK.leftParenthesis)
                this.cparseParens();
            return;
        }

        const ident = this.token.ident;
        if (ident === Id.aligned) {
            this.nextToken();
            if (this.token.value === TOK.leftParenthesis) {
                this.nextToken();
                const exp: Expression = this.cparseConstantExp();
                if (specifier.alignAttrs === null)
                    specifier.alignAttrs = new DArray<Expression | null>();
                specifier.alignAttrs.push(exp);
                this.check(TOK.rightParenthesis);
            } else {
                /* ignore __attribute__((aligned)), which sets the alignment to the largest value for any data
                 * type on the target machine. It's the opposite of __attribute__((packed))
                 */
            }
        } else if (ident === Id.packed) {
            specifier.packalign.set(1);
            specifier.packalign.setPack();
            this.nextToken();
        } else if (ident === Id.always_inline) { // https://gcc.gnu.org/onlinedocs/gcc/Common-Function-Attributes.html
            specifier.scw |= SCW.xinline;
            this.nextToken();
        } else if (ident === Id._deprecated) {
            specifier._deprecated = true;
            this.nextToken();
            if (this.token.value === TOK.leftParenthesis) { // optional deprecation message
                this.nextToken();
                specifier.depMsg = this.cparseExpression();
                this.check(TOK.rightParenthesis);
            }
        } else if (ident === Id.dllimport) {
            specifier.dllimport = true;
            this.nextToken();
        } else if (ident === Id.dllexport) {
            specifier.dllexport = true;
            this.nextToken();
        } else if (ident === Id.naked) {
            specifier.naked = true;
            this.nextToken();
        } else if (ident === Id.noinline) {
            specifier.scw |= SCW.xnoinline;
            this.nextToken();
        } else if (ident === Id.noreturn) {
            specifier.noreturn = true;
            this.nextToken();
        } else if (ident === Id._nothrow) {
            specifier._nothrow = true;
            this.nextToken();
        } else if (ident === Id._pure) {
            specifier._pure = true;
            this.nextToken();
        } else if (ident === Id.vector_size) {
            this.nextToken();
            this.check(TOK.leftParenthesis);
            if (this.token.value === TOK.int32Literal) {
                const n = this.token.unsvalue;
                if (n < 1n || (n & (n - 1n)) !== 0n || 0xffffn < n) // ushort.max < n
                    this.error(ds("__attribute__((vector_size(%lld))) must be an integer positive power of 2 " +
                        "and be <= 32,768"), n);
                specifier.vector_size = Number(BigInt.asUintN(32, n)); // cast(uint) n
                this.nextToken();
            } else {
                this.error(ds("value for vector_size expected, not `%s`"), this.token.toChars());
                this.nextToken();
            }
            this.check(TOK.rightParenthesis);
        } else {
            this.nextToken();
            if (this.token.value === TOK.leftParenthesis)
                this.cparseParens();
        }
    }

    /*************************
     * See if match for GNU attribute name, which may be any identifier,
     * storage-class-specifier, type-specifier, or type-qualifier.
     * Returns:
     *  true if a valid GNU attribute name
     */
    private isGnuAttributeName(): boolean {
        switch (this.token.value) {
            case TOK.identifier:
            case TOK.static_:
            case TOK.unsigned:
            case TOK.int64:
            case TOK.const_:
            case TOK.extern_:
            case TOK.register:
            case TOK.typedef_:
            case TOK.int16:
            case TOK.inline:
            case TOK._Noreturn:
            case TOK.volatile:
            case TOK.signed:
            case TOK.auto_:
            case TOK.restrict:
            case TOK._Complex:
            case TOK._Thread_local:
            case TOK.int32:
            case TOK.__int128:
            case TOK.char_:
            case TOK.float32:
            case TOK.float64:
            case TOK.void_:
            case TOK._Bool:
            case TOK._Atomic:
                return true;

            default:
                return false;
        }
    }

    /***************************
     * Like skipParens(), but consume the tokens.
     * Parser is on the `(`; consumes through the matching `)` (dmd/cparse.d:3818).
     */
    private cparseParens(): void {
        this.check(TOK.leftParenthesis);
        let parens = 1;

        while (true) {
            switch (this.token.value) {
                case TOK.leftParenthesis:
                    ++parens;
                    break;

                case TOK.rightParenthesis:
                    --parens;
                    if (parens < 0) {
                        this.error(ds("extra right parenthesis"));
                        return;
                    }
                    if (parens === 0) {
                        this.nextToken();
                        return;
                    }
                    break;

                case TOK.endOfFile:
                    this.error(ds("end of file found before right parenthesis"));
                    return;

                default:
                    break;
            }
            this.nextToken();
        }
    }

    /******************************************************************************/
    /***************************** Struct & Enum Parser ***************************/

    /*************************************
     * C11 6.7.2.2
     * enum-specifier:
     *    enum identifier (opt) { enumerator-list }
     *    enum identifier (opt) { enumerator-list , }
     *    enum identifier
     *
     * enumerator-list:
     *    enumerator
     *    enumerator-list , enumerator
     *
     * enumerator:
     *    enumeration-constant
     *    enumeration-constant = constant-expression
     *
     * enumeration-constant:
     *    identifier
     *
     * Params:
     *  symbols = symbols to add enum declaration to. D takes it `ref AST.Dsymbols*` and never
     *            writes it, so it is passed by value (03 §3.2).
     * Returns:
     *  type of the enum
     */
    private cparseEnum(_symbols: Dsymbols | null): Type {
        const loc = this.token.loc;
        this.nextToken();

        /* GNU Extensions
         * enum-specifier:
         *    enum gnu-attributes (opt) identifier (opt) { enumerator-list } gnu-attributes (opt)
         *    enum gnu-attributes (opt) identifier (opt) { enumerator-list , } gnu-attributes (opt)
         *    enum gnu-attributes (opt) identifier
         */
        const specifier = new Specifier();
        specifier.packalign.setDefault();
        if (this.token.value === TOK.__attribute__)
            this.cparseGnuAttributes(specifier);

        let tag: Identifier | null = null;
        if (this.token.value === TOK.identifier) {
            tag = this.token.ident;
            this.nextToken();
        }

        /* clang extension: add optional base type after the identifier
         * https://en.cppreference.com/w/cpp/language/enum
         *   enum Identifier : Type
         */
        // C11 6.7.2.2-4 left the default base type implementation defined (D once used `int` here).
        let base: Type | null = null; // C23 says base type is determined by enum member values
        if (this.token.value === TOK.colon) {
            this.nextToken();
            base = this.cparseTypeName();
        }

        let members: Dsymbols | null = null;
        const tvc: TOK = this.token.value;
        if (tvc === TOK.leftCurly) {
            this.nextToken();
            members = new DArray<Dsymbol | null>();

            if (this.token.value === TOK.rightCurly) { // C11 6.7.2.2-1
                if (tag !== null)
                    this.error(ds("no members for `enum %s`"), tag.toChars());
                else
                    this.error(ds("no members for anonymous enum"));
            }

            while (true) {
                const tvw: TOK = this.token.value; // re-read per iteration (02 §11.4)
                if (tvw !== TOK.identifier)
                    break;
                const ident = this.token.ident; // enumeration-constant
                this.nextToken();
                const mloc = this.token.loc;

                if (this.token.value === TOK.__attribute__) {
                    /* gnu-attributes can appear here, but just scan and ignore them
                     * https://gcc.gnu.org/onlinedocs/gcc/Enumerator-Attributes.html
                     */
                    const specifierx = new Specifier();
                    specifierx.packalign.setDefault();
                    this.cparseGnuAttributes(specifierx);
                }

                let value: Expression | null = null;
                if (this.token.value === TOK.assign) {
                    this.nextToken();
                    value = this.cparseConstantExp();
                    // TODO C11 6.7.2.2-2 value must fit into an int
                }

                if (this.token.value === TOK.__attribute__) {
                    /* gnu-attributes can appear here, but just scan and ignore them
                     * https://gcc.gnu.org/onlinedocs/gcc/Enumerator-Attributes.html
                     */
                    const specifierx = new Specifier();
                    specifierx.packalign.setDefault();
                    this.cparseGnuAttributes(specifierx);
                }

                const em = new EnumMember(mloc, ident, value, null, STC.none, null, null);
                members.push(em);

                if (this.token.value === TOK.comma) {
                    this.nextToken();
                    continue;
                }
                break;
            }
            this.check(TOK.rightCurly);

            /* GNU Extensions
             * Parse the postfix gnu-attributes (opt)
             */
            if (this.token.value === TOK.__attribute__)
                this.cparseGnuAttributes(specifier);
        } else if (tag === null)
            this.error(ds("missing `identifier` after `enum`"));

        /* Need semantic information to determine if this is a declaration,
         * redeclaration, or reference to existing declaration.
         * Defer to the semantic() pass with a TypeTag.
         */
        return new TypeTag(loc, TOK.enum_, tag, new structalign_t(), null, base, members);
    }

    /*************************************
     * C11 6.7.2.1
     * Parse struct and union specifiers.
     * Parser is advanced to the tag identifier or brace.
     * struct-or-union-specifier:
     *    struct-or-union identifier (opt) { struct-declaration-list }
     *    struct-or-union identifier
     *
     * struct-or-union:
     *    struct
     *    union
     *
     * struct-declaration-list:
     *    struct-declaration
     *    struct-declaration-list struct-declaration
     *
     * Params:
     *  loc = location of `struct` or `union`
     *  structOrUnion = TOK.struct_ or TOK.union_
     *  packalign = alignment to use for struct members
     *  symbols = symbols to add struct-or-union declaration to. D takes it `ref AST.Dsymbols*`
     *            and never writes it, so it is passed by value (03 §3.2).
     * Returns:
     *  type of the struct
     */
    private cparseStruct(loc: Loc, structOrUnion: TOK, _symbols: Dsymbols | null): Type {
        /* GNU Extensions
         * struct-or-union-specifier:
         *    struct-or-union gnu-attributes (opt) identifier (opt) { struct-declaration-list } gnu-attributes (opt)
         *    struct-or-union gnu-attribute (opt) identifier
         */
        const tagSpecifier = new Specifier();
        while (true) {
            const tv: TOK = this.token.value;
            if (tv === TOK.__attribute__)
                this.cparseGnuAttributes(tagSpecifier);
            else if (tv === TOK.__declspec)
                this.cparseDeclspec(tagSpecifier);
            else if (tv === TOK.__pragma)
                this.uupragmaDirective(loc);
            else
                break;
        }
        let tag: Identifier | null = null;

        if (this.token.value === TOK.identifier) {
            tag = this.token.ident;
            this.nextToken();
        }

        let members: Dsymbols | null = null;
        const tvc: TOK = this.token.value;
        if (tvc === TOK.leftCurly) {
            this.nextToken();
            members = new DArray<Dsymbol | null>(); // so `members` will be non-null even with 0 members
            while (true) {
                const tvw: TOK = this.token.value; // re-read per iteration (02 §11.4)
                if (tvw === TOK.rightCurly)
                    break;
                this.cparseStructDeclaration(members, tagSpecifier.packalign.copy());

                const tve: TOK = this.token.value;
                if (tve === TOK.endOfFile)
                    break;
            }
            this.check(TOK.rightCurly);

            if (members.length === 0) { // C11 6.7.2.1-8
                /* allow empty structs as an extension
                 *  struct-declarator-list:
                 *    struct-declarator (opt)
                 */
            }

            /* GNU Extensions
             * Parse the postfix gnu-attributes (opt)
             */
            if (this.token.value === TOK.__attribute__)
                this.cparseGnuAttributes(tagSpecifier);
            if (!tagSpecifier.packalign.isUnknown()) {
                // D `foreach (ref d; (*members)[])`: the slot is rewritten in place.
                for (let i = 0; i < members.length; i++) {
                    const d = members.opIndex(i)!; // slot `Dsymbol | null` (08 §3); D reads it unchecked
                    // skip possible static assert declarations
                    if (d.isStaticAssert() !== null) continue;

                    const decls = new DArray<Dsymbol | null>(1);
                    decls.opIndexAssign(d, 0);
                    members.opIndexAssign(AlignDeclaration.fromSalign(d.loc, tagSpecifier.packalign, decls), i);
                }
            }
        } else if (tag === null)
            this.error(ds("missing tag `identifier` after `%s`"), Token.toCharsValue(structOrUnion));

        // many ways and places to declare alignment
        if (tagSpecifier.packalign.isUnknown() && !this.packalign.isUnknown())
            tagSpecifier.packalign.set(this.packalign.get());

        /* Need semantic information to determine if this is a declaration,
         * redeclaration, or reference to existing declaration.
         * Defer to the semantic() pass with a TypeTag.
         */
        return new TypeTag(loc, structOrUnion, tag, tagSpecifier.packalign.copy(), tagSpecifier.alignAttrs, null,
            members);
    }

    /*************************************
     * C11 6.7.2.1
     * Parse a struct declaration member.
     * struct-declaration:
     *    specifier-qualifier-list struct-declarator-list (opt) ;
     *    static_assert-declaration
     *
     * struct-declarator-list:
     *    struct-declarator
     *    struct-declarator-list , struct-declarator
     *
     * struct-declarator:
     *    declarator
     *    declarator (opt) : constant-expression
     * Params:
     *    members = where to put the fields (members)
     *    packalign = alignment to use for struct members (by value: the caller passes a copy)
     */
    cparseStructDeclaration(members: Dsymbols, packalign: structalign_t): void {
        if (this.token.value === TOK._Static_assert) {
            const s = this.cparseStaticAssert();
            members.push(s);
            return;
        }

        const specifier = new Specifier();
        specifier.packalign = packalign.isUnknown() ? this.packalign.copy() : packalign.copy();
        let tspec = this.cparseSpecifierQualifierList(LVL.member, specifier);
        if (tspec === null) {
            this.error(ds("no type-specifier for struct member"));
            tspec = Type.tint32;
        }
        if ((specifier.mod & MOD.xconst) !== 0) {
            tspec = this.toConst(tspec);
            specifier.mod = MOD.xnone; // 'used' it
        }

        /* If a declarator does not follow, it is unnamed
         */
        if (this.token.value === TOK.semicolon && tspec !== null) {
            this.nextToken();
            const tt = tspec.isTypeTag();
            if (tt === null) {
                const ti = tspec.isTypeIdentifier();
                if (ti !== null) {
                    this.error(ds("type-specifier omitted before declaration of `%s`"), ti.ident!.toChars());
                }
                return; // legal but meaningless empty declaration
            }

            /* If anonymous struct declaration
             *   struct { ... members ... };
             * C11 6.7.2.1-13
             */
            if (tt.id === null && tt.members !== null && tt.tok !== TOK.enum_) {
                /* members of anonymous struct are considered members of
                 * the containing struct
                 */
                const ad = new AnonDeclaration(tt.loc, tt.tok === TOK.union_, tt.members);
                const s = this.applySpecifier(ad, specifier);
                members.push(s);
                return;
            }
            if (tt.id === null && tt.members === null)
                return; // already gave error in cparseStruct()

            /* `struct tag;` and `struct tag { ... };`
             * always result in a declaration in the current scope
             */
            const spec = new Specifier();
            this.declareTag(tt, spec);
            return;
        }
        const tt = tspec.isTypeTag();
        if (tt !== null) {
            // Declare the tagged type at this point.
            if (tt.members !== null) {
                const spec = new Specifier();
                this.declareTag(tt, spec);
            }
        }

        // Shared `default:` arm of the declarator-list switch below, reached also by a jump from the
        // `identifier` arm (06 §3.6, non-adjacent default). Terminal: every site returns.
        const defaultArm = (): void => {
            this.error(ds("`;` or `,` expected"));
            while (this.token.value !== TOK.semicolon && this.token.value !== TOK.endOfFile)
                this.nextToken();
            this.nextToken();
        };

        while (true) {
            // D `AST.ArgumentLabel id;` passed to cparseDeclarator's `out` parameter: a box (03 §3.3).
            const id: { value: ArgumentLabel } = { value: new ArgumentLabel(null, Loc.initial) };
            let dt: Type;
            if (this.token.value === TOK.colon) {
                const ti = tspec.isTypeIdentifier();
                if (ti !== null) {
                    this.error(ds("type-specifier omitted before bit field declaration of `%s`"), ti.ident!.toChars());
                    tspec = Type.tint32;
                }

                // C11 6.7.2.1-12 unnamed bit-field
                id.value.name = Identifier.generateAnonymousId(ds("BitField"));
                dt = tspec;
            } else {
                // D tests the result for null (`if (!dt)`), so the declarator's result is read nullable.
                const dtx: Type | null = this.cparseDeclarator(DTR.xdirect, tspec, id, specifier);
                if (dtx === null) {
                    this.panic();
                    this.nextToken();
                    break; // error recovery
                }
                dt = dtx;
            }

            let width: Expression | null = null;
            if (this.token.value === TOK.colon) {
                // C11 6.7.2.1-10 bit-field
                this.nextToken();
                // DECLARED DIVERGENCE (11 §2.6): D reads `id.name` unchecked; a bit-field without a
                // declarator name (`struct S { int (1) : 3; };`) makes ldc2 segfault here.
                assert(id.value.name !== null,
                    "cparse.d:4223 reads id.name unchecked; ldc2 segfaults here (declared divergence, 11 §2.6)");
                if (id.value.name.isAnonymous())
                    id.value.loc = this.token.loc;
                width = this.cparseConstantExp();
            }

            /* GNU Extensions
             * struct-declarator:
             *    declarator gnu-attributes (opt)
             *    declarator (opt) : constant-expression gnu-attributes (opt)
             */
            if (this.token.value === TOK.__attribute__)
                this.cparseGnuAttributes(specifier);

            if (tspec === null && specifier.scw === 0 && specifier.mod === 0)
                this.error(ds("specifier-qualifier-list required"));
            else if (width !== null) {
                if (specifier.lastAlignas !== null)
                    this.errorLoc(specifier.lastAlignas.loc,
                        ds("no alignment-specifier for bit field declaration")); // C11 6.7.5-2
                // `id.value.name` is non-null here: `width` is set only after D dereferences it
                // unchecked (`id.name.isAnonymous`, above), where a null name crashes ldc2 (probe:
                // `struct S { int (1) : 3; };` segfaults in cparseStructDeclaration).
                const s = new BitFieldDeclaration(id.value.loc, dt, id.value.name!, width);
                members.push(s);
            } else if (id.value.name !== null) {
                if (dt.ty === Tvoid)
                    this.error(ds("`void` has no value"));

                // declare the symbol
                // Give member variables an implicit void initializer
                const initializer = new VoidInitializer(this.token.loc);
                let s: Dsymbol = new VarDeclaration(id.value.loc, dt, id.value.name, initializer,
                    this.specifiersToSTC(LVL.member, specifier));
                s = this.applySpecifier(s, specifier);
                members.push(s);
            }

            switch (this.token.value) {
                case TOK.identifier:
                    this.error(ds("missing comma"));
                    defaultArm(); // goto default (dmd/cparse.d:4262)
                    return;

                case TOK.semicolon:
                    this.nextToken();
                    return;

                case TOK.comma:
                    this.nextToken();
                    break;

                default:
                    defaultArm();
                    return;
            }
        }
    }

    /******************************************************************************/
    /********************************* Lookahead Parser ***************************/

    /************************************
     * Determine if the scanner is sitting on the start of a declaration.
     * Params:
     *  t = first token
     * Returns:
     *  true if at start of a declaration
     */
    private startsDeclaration(t: Token): boolean {
        // Labels aren't declarations.
        if (this.token.value === TOK.identifier && this.peek(t).value === TOK.colon)
            return false;

        if (this.token.value === TOK._Static_assert)
            return true;

        if (this.startsDeclarationSpecifiers(t))
            return true;

        if (this.startsTypeName(t))
            return true;

        return false;
    }

    /********************************
     * Is this the start of a declaration-specifiers?
     * Params:
     *  t = first token
     * Returns:
     *  true if declaration-specifiers
     */
    private startsDeclarationSpecifiers(t: Token): boolean {
        let seenType = false;
        while (true) {
            switch (t.value) {
                // typedef-name
                case TOK.identifier:
                    if (!seenType) {
                        if (this.isTypedef(t.ident!))
                            return true;
                        t = this.peek(t);
                        seenType = true;
                        continue;
                    }
                    return true;

                // type-specifiers
                case TOK.void_:
                case TOK.char_:
                case TOK.int16:
                case TOK.int32:
                case TOK.int64:
                case TOK.__int128:
                case TOK.float32:
                case TOK.float64:
                case TOK.signed:
                case TOK.unsigned:
                case TOK._Bool:
                // (TOK._Imaginary is not a type-specifier here.)
                case TOK._Complex:

                // struct-or-union-specifier
                // enum-specifier
                case TOK.struct_:
                case TOK.union_:
                case TOK.enum_:

                // storage-class-specifiers
                case TOK.typedef_:
                case TOK.extern_:
                case TOK.static_:
                case TOK.__thread:
                case TOK._Thread_local:
                case TOK.auto_:
                case TOK.register:

                // function-specifiers
                case TOK.inline:
                case TOK._Noreturn:

                // type-qualifiers
                case TOK.const_:
                case TOK.volatile:
                case TOK.restrict:
                case TOK.__stdcall:

                case TOK._Alignas: // alignment-specifier
                case TOK.__declspec: // decl-specifier
                case TOK.__attribute__: // attribute-specifier

                // atomic-type-specifier
                case TOK._Atomic:
                case TOK.typeof_:
                    return true;

                default:
                    return false;
            }
        }
    }

    /*******************************************
     * Skip brackets.
     * Params:
     *      pt = enters on left bracket, set to token past right bracket on true
     *           (D `ref Token*`: a box, written only on success)
     * Returns:
     *      true if successful
     */
    private skipBrackets(pt: { value: Token }): boolean {
        let t = pt.value;
        if (t.value !== TOK.leftBracket)
            return false;

        let brackets = 0;

        while (true) {
            switch (t.value) {
                case TOK.leftBracket:
                    ++brackets;
                    t = this.peek(t);
                    continue;

                case TOK.rightBracket:
                    --brackets;
                    if (brackets === 0) {
                        pt.value = this.peek(t);
                        return true;
                    }
                    if (brackets < 0)
                        return false;

                    t = this.peek(t);
                    continue;

                case TOK.endOfFile:
                    return false;

                default:
                    t = this.peek(t);
                    continue;
            }
        }
    }

    /*********************************
     * Check to see if tokens starting with *pt form a declarator.
     * Params:
     *  pt = pointer to starting token, updated to point past declarator if true is returned
     *       (D `ref Token*`: a box, written only on success)
     *  declarator = declarator kind
     * Returns:
     *  true if it does
     */
    private isCDeclarator(pt: { value: Token }, declarator: DTR): boolean {
        let t = pt.value;
        while (true) {
            if (t.value === TOK.mul) { // pointer
                t = this.peek(t);
                const t_box = { value: t };
                const ok = this.isTypeQualifierList(t_box);
                t = t_box.value;
                if (!ok)
                    return false;
            } else
                break;
        }

        if (t.value === TOK.identifier) {
            if (declarator === DTR.xabstract)
                return false;
            t = this.peek(t);
        } else if (t.value === TOK.leftParenthesis) {
            t = this.peek(t);
            if (t.value === TOK.__stdcall)
                t = this.peek(t);
            const t_box = { value: t };
            const ok = this.isCDeclarator(t_box, declarator);
            t = t_box.value;
            if (!ok)
                return false;
            if (t.value !== TOK.rightParenthesis)
                return false;
            t = this.peek(t);
        } else if (declarator === DTR.xdirect) {
            return false;
        }

        while (true) {
            if (t.value === TOK.leftBracket) {
                const t_box = { value: t };
                const ok = this.skipBrackets(t_box);
                t = t_box.value;
                if (!ok)
                    return false;
            } else if (t.value === TOK.leftParenthesis) {
                // D `skipParens(t, &t)`: by-value start token plus a write-back box for the end.
                const t_box = { value: t };
                const ok = this.skipParens(t, t_box);
                t = t_box.value;
                if (!ok)
                    return false;
            } else
                break;
        }
        pt.value = t;
        return true;
    }

    /***************************
     * Is this the start of a type-qualifier-list?
     * (Can be empty.)
     * Params:
     *  pt = first token; updated with past end of type-qualifier-list if true
     *       (D `ref Token*`: a box)
     * Returns:
     *  true if start of type-qualifier-list
     */
    private isTypeQualifierList(pt: { value: Token }): boolean {
        let t = pt.value;
        while (true) {
            switch (t.value) {
                case TOK.const_:
                case TOK.restrict:
                case TOK.volatile:
                case TOK._Atomic:
                case TOK.__stdcall:
                    t = this.peek(t);
                    continue;

                default:
                    break;
            }
            break;
        }
        pt.value = t;
        return true;
    }

    /*******************************************
     * Is this the start of a type-name?
     * Params:
     *  t = first token
     * Returns:
     *  true if start of type-name
     */
    private startsTypeName(t: Token): boolean {
        switch (t.value) {
            case TOK.identifier:
                // Use typedef table to disambiguate
                return this.isTypedef(t.ident!);

            // Type Qualifiers
            case TOK.const_:
            case TOK.restrict:
            case TOK.volatile:
            case TOK.__stdcall:

            // Type Specifiers
            case TOK.char_:
            case TOK.signed:
            case TOK.unsigned:
            case TOK.int16:
            case TOK.int32:
            case TOK.int64:
            case TOK.__int128:
            case TOK.float32:
            case TOK.float64:
            case TOK.void_:
            case TOK._Bool:

            // (TOK._Imaginary is not listed: "? missing in Spec".)
            case TOK._Complex:

            // struct-or-union-specifier
            // enum-specifier
            case TOK.struct_:
            case TOK.union_:
            case TOK.enum_:

            // atomic-type-specifier
            case TOK._Atomic:
            case TOK.typeof_:
            case TOK.__attribute__:
                return true;

            default:
                return false;
        }
    }

    /******************************************************************************/
    /********************************* More ***************************************/

    // LVL, DTR, SCW, MOD and Specifier (dmd/cparse.d:4599-4666) are hoisted to module scope.

    /***********************
     * Convert from C specifiers to D storage class
     * Params:
     *  level = declaration context
     *  specifier = specifiers, context, etc.
     * Returns:
     *  corresponding D storage class
     */
    specifiersToSTC(level: LVL, specifier: Specifier): STC {
        let stc: STC = STC.none;
        if ((specifier.scw & SCW.x_Thread_local) !== 0) {
            if (level === LVL.global) {
                if ((specifier.scw & SCW.xextern) !== 0)
                    stc = STC.extern_;
                else if ((specifier.scw & SCW.xstatic) !== 0)
                    stc = STC.static_;
            } else if (level === LVL.local) {
                if ((specifier.scw & SCW.xextern) !== 0)
                    stc = STC.extern_;
                else if ((specifier.scw & SCW.xstatic) !== 0)
                    stc = STC.static_;
            } else if (level === LVL.member) {
                if ((specifier.scw & SCW.xextern) !== 0)
                    stc = STC.extern_;
                else if ((specifier.scw & SCW.xstatic) !== 0)
                    stc = STC.static_;
            }
        } else {
            if (level === LVL.global) {
                if ((specifier.scw & SCW.xextern) !== 0)
                    stc = (STC.extern_ | STC.gshared) as STC;
                else if ((specifier.scw & SCW.xstatic) !== 0)
                    stc = (STC.gshared | STC.static_) as STC;
                else
                    stc = STC.gshared;
            } else if (level === LVL.local) {
                if ((specifier.scw & SCW.xextern) !== 0)
                    stc = (STC.extern_ | STC.gshared) as STC;
                else if ((specifier.scw & SCW.xstatic) !== 0)
                    stc = STC.gshared;
                else if ((specifier.scw & SCW.xregister) !== 0)
                    stc = STC.register;
            } else if (level === LVL.parameter) {
                if ((specifier.scw & SCW.xregister) !== 0)
                    stc = (STC.register | STC.parameter) as STC;
                else
                    stc = STC.parameter;
            } else if (level === LVL.member) {
                if ((specifier.scw & SCW.xextern) !== 0)
                    stc = (STC.extern_ | STC.gshared) as STC;
                else if ((specifier.scw & SCW.xstatic) !== 0)
                    stc = STC.gshared;
            }
        }
        if (specifier._deprecated && specifier.depMsg === null)
            stc = (stc | STC.deprecated_) as STC;
        return stc;
    }

    /***********************
     * Add attributes from Specifier to function
     * Params:
     *  fd = function to apply them to
     *  specifier = specifiers
     */
    specifiersToFuncDeclaration(fd: FuncDeclaration, specifier: Specifier): void {
        fd.isNaked = specifier.naked;
        fd.dllImport = specifier.dllimport;
        fd.dllExport = specifier.dllexport;

        if ((specifier.scw & SCW.xnoinline) !== 0)
            fd.inlining = PINLINE.never;
        else if ((specifier.scw & SCW.xinline) !== 0)
            fd.inlining = PINLINE.always;
    }

    /***********************
     * Add attributes from Specifier to variable
     * Params:
     *  vd = function to apply them to
     *  specifier = specifiers
     */
    specifiersToVarDeclaration(vd: VarDeclaration, specifier: Specifier): void {
        vd.dllImport = specifier.dllimport;
        vd.dllExport = specifier.dllexport;
    }

    /***********************
     * Return suitable signed integer type for the given size
     * Params:
     *  size = size of type
     * Returns:
     *  corresponding signed D integer type
     */
    private integerTypeForSize(size: number): Type {
        if (size <= 1)
            return Type.tint8;
        if (size <= 2)
            return Type.tint16;
        if (size <= 4)
            return Type.tint32;
        if (size <= 8)
            return Type.tint64;
        if (size === 16) {
            this.error(ds("__int128 not supported"));
            return Type.terror;
        }
        this.error(ds("unsupported integer type"));
        return Type.terror;
    }

    /***********************
     * Return suitable unsigned integer type for the given size
     * Params:
     *  size = size of type
     * Returns:
     *  corresponding unsigned D integer type
     */
    private unsignedTypeForSize(size: number): Type {
        if (size <= 1)
            return Type.tuns8;
        if (size <= 2)
            return Type.tuns16;
        if (size <= 4)
            return Type.tuns32;
        if (size <= 8)
            return Type.tuns64;
        if (size === 16) {
            this.error(ds("unsigned __int128 not supported"));
            return Type.terror;
        }
        this.error(ds("unsupported integer type"));
        return Type.terror;
    }

    /***********************
     * Return suitable D float type for C `long double`
     * Params:
     *  flags = kind of float to return (real, imaginary, complex).
     * Returns:
     *  corresponding D type
     */
    private realType(flags: RTFlags): Type {
        // D `AST.Type.tfloat80.size()` is typesem's `size` through UFCS, a `ulong`:
        // dmd/cparse.d:30 — `import dmd.typesem : size`
        if (BigInt(this.long_doublesize) === size(Type.tfloat80)) {
            // On GDC and LDC, D `real` types map to C `long double`, so never
            // return a double type when real.sizeof == double.sizeof.
            switch (flags) {
                case RTFlags.realfloat: return Type.tfloat80;
                case RTFlags.imaginary: return Type.timaginary80;
                case RTFlags.complex: return Type.tcomplex80;
                default: {
                    // final switch: D throws SwitchError on an unhandled value
                    const _exhaustive: never = flags;
                    void _exhaustive;
                    throw new SwitchError();
                }
            }
        } else {
            switch (flags) {
                case RTFlags.realfloat: return this.long_doublesize === 8 ? Type.tfloat64 : Type.tfloat80;
                case RTFlags.imaginary: return this.long_doublesize === 8 ? Type.timaginary64 : Type.timaginary80;
                case RTFlags.complex: return this.long_doublesize === 8 ? Type.tcomplex64 : Type.tcomplex80;
                default: {
                    // final switch: D throws SwitchError on an unhandled value
                    const _exhaustive: never = flags;
                    void _exhaustive;
                    throw new SwitchError();
                }
            }
        }
    }

    // RTFlags (dmd/cparse.d:4859) is hoisted to module scope.

    /********************
     * C11 6.4.2.2 Create declaration to predefine __func__
     *    `static const char __func__[] = " function-name ";`
     * Params:
     *    loc = location for this declaration
     *    id = identifier of function
     *    cident = identifier of the declared variable (`__func__`, `__FUNCTION__`, ...)
     * Returns:
     *    statement representing the declaration of __func__, __FUNCTION__, or __PRETTY-FUNCTION__
     */
    private createFuncName(loc: Loc, id: Identifier, cident: Identifier): Statement {
        const fn = id.toString(); // function-name
        const efn = new StringExp(loc, Array.from(fn), fn.length, 1, 0x63 /* 'c' */);
        const ifn = new ExpInitializer(loc, efn);
        // +1 for terminating 0, ditto for __pretty_chars__
        const lenfn = new IntegerExp(loc, BigInt(fn.length + 1), Type.tuns32);
        const tfn = new TypeSArray(Type.tchar, lenfn);
        efn.type = makeImmutable(tfn);
        efn.committed = true;
        const sfn = new VarDeclaration(loc, tfn, cident, ifn, (STC.gshared | STC.immutable_) as STC);
        const e = new DeclarationExp(loc, sfn);
        return new ExpStatement(loc, e);
    }

    /* function for C __PRETTY_FUNCTION__ for non-linux systems */
    private createPrettyFunc(loc: Loc, fd: FuncDeclaration): Statement {
        const tf = fd.type!.isTypeFunction()!;
        let funcSig: DString = tf.next!.toString();
        funcSig = dsConcat(funcSig, ds(" "));
        funcSig = dsConcat(funcSig, fd.ident!.toString());
        funcSig = dsConcat(funcSig, ds("("));

        tf.parameterList.opApply((i: number, _fparam: Parameter): number => {
            if (i > 0)
                funcSig = dsConcat(funcSig, ds(", "));

            const t: Type = tf.parameterList.opIndex(i)!.type!;
            funcSig = dsConcat(funcSig, t.toString());
            return 0;
        });
        funcSig = dsConcat(funcSig, ds(")"));

        const efn = new StringExp(loc, Array.from(funcSig));
        const ifn = new ExpInitializer(loc, efn);
        const lenfn = new IntegerExp(loc, BigInt(funcSig.length + 1), Type.tuns32); // +1 for terminating 0
        const tfn = new TypeSArray(Type.tchar, lenfn);
        efn.type = makeImmutable(tfn);
        efn.committed = true;
        const sfn = new VarDeclaration(loc, tfn, Id.PRETTY_FUNCTION!, ifn, (STC.gshared | STC.immutable_) as STC);
        const e = new DeclarationExp(loc, sfn);
        return new ExpStatement(loc, e);
    }

    /************************
     * After encountering an error, scan forward until a right brace or ; is found
     * or the end of the file.
     */
    panic(): void {
        while (this.token.value !== TOK.rightCurly && this.token.value !== TOK.semicolon &&
            this.token.value !== TOK.endOfFile)
            this.nextToken();
    }

    /**************************
     * Apply `const` to a type.
     * Params:
     *    t = type to add const to
     * Returns:
     *    resulting type
     */
    private toConst(t: Type): Type {
        // `const` is always applied to the return type, not the
        // type function itself.
        const tf = t.isTypeFunction();
        if (tf !== null)
            tf.next = addSTC(tf.next!, STC.const_);
        else {
            const tt = t.isTypeTag();
            // D writes TypeTag's own `mod` (dmd/mtype.d:2145), a slot distinct from Type.mod: the shadow-split
            // name `modTag` (02 §11.5b registry). Type.mod stays 0, as D's Type-level reads see it.
            if (tt !== null)
                tt.modTag |= MODFlags.const_;
            else {
                /* Ignore const if the result would be const pointer to mutable
                 */
                const tn = nextOf(t);
                if (tn === null || tn.isConst())
                    t = addSTC(t, STC.const_);
            }
        }
        return t;
    }

    /***************************
     * Apply specifier to a Dsymbol.
     * Params:
     *  s = Dsymbol
     *  specifier = specifiers to apply
     * Returns:
     *  Dsymbol with specifiers applied
     */
    private applySpecifier(s: Dsymbol, specifier: Specifier): Dsymbol {
        if (specifier._deprecated) {
            if (specifier.depMsg !== null) {
                // Wrap declaration in a DeprecatedDeclaration
                const decls = new DArray<Dsymbol | null>(1);
                decls.opIndexAssign(s, 0);
                s = new DeprecatedDeclaration(specifier.depMsg, decls);
            }
        }

        if (specifier.alignAttrs !== null) {
            // Wrap declaration in an AlignDeclaration
            const decls = new DArray<Dsymbol | null>(1);
            decls.opIndexAssign(s, 0);
            s = AlignDeclaration.fromExps(s.loc, specifier.alignAttrs, decls);
        }
        if (specifier.alignasExps !== null) {
            // Wrap declaration in an AlignDeclaration
            const decls = new DArray<Dsymbol | null>(1);
            decls.opIndexAssign(s, 0);
            const ad = AlignDeclaration.fromExps(s.loc, specifier.alignasExps, decls);
            ad.salign.setAlignas();
            s = ad;
        } else if (!specifier.packalign.isDefault() && !specifier.packalign.isUnknown()) {
            // Wrap #pragma pack in an AlignDeclaration
            const decls = new DArray<Dsymbol | null>(1);
            decls.opIndexAssign(s, 0);
            s = AlignDeclaration.fromSalign(s.loc, specifier.packalign, decls);
        }
        return s;
    }

    /******************************************************************************/
    /************************** typedefTab symbol table ***************************/

    // `typedefTab` (dmd/cparse.d:67, `Array!(void*)`) holds one D associative array
    // `void*[void*]` per scope, keyed by Identifier, as an opaque `void*`. This range reads each
    // entry as `Map<Identifier, Type | null> | null`: null is D's empty (unallocated) AA, a null
    // value marks an identifier that masks an outer typedef. `static if (LDC_pre_2084)`
    // (dmd/cparse.d:32, `__VERSION__ < 2084` under version(LDC)) is false for the host compiler, so only its
    // `else` reinterpretation applies.

    /********************************
     * Determines if type t is a function type.
     * Params:
     *  t = type to test
     * Returns:
     *  true if it represents a function
     */
    isFunctionTypedef(t: Type): boolean {
        if (t.isTypeFunction() !== null)
            return true;
        const tid = t.isTypeIdentifier();
        if (tid !== null) {
            const pt = this.lookupTypedef(tid.ident!);
            if (pt !== null && pt.value !== null) {
                return pt.value.isTypeFunction() !== null;
            }
        }
        return false;
    }

    /********************************
     * Determine if `id` is a symbol for a Typedef.
     * Params:
     *  id = possible typedef
     * Returns:
     *  true if id is a Type
     */
    isTypedef(id: Identifier): boolean {
        const pt = this.lookupTypedef(id);
        return pt !== null && pt.value !== null;
    }

    /*******************************
     * Add `id` to typedefTab[], but only if it will mask an existing typedef.
     * Params: id = identifier for non-typedef symbol
     */
    insertIdToTypedefTab(id: Identifier): void {
        if (this.isTypedef(id)) { // if existing typedef
            /* Add id as null, so we can later distinguish it from a non-null typedef
             */
            const tab = this.typedefTab.opIndex(this.typedefTab.length - 1);
            // D writes through a local copy of the AA handle and never stores it back
            // (dmd/cparse.d:5063 — `tab[cast(void*)id] = cast(void*)null;`): when the innermost scope
            // has no table yet, the insertion allocates one that is then dropped, so the mask is
            // lost. Only an already allocated table receives it.
            if (tab !== null)
                tab.set(id, null);
        }
    }

    /*******************************
     * Add `id` to typedefTab[]
     * Params:
     *  id = identifier for typedef symbol
     *  t = type of the typedef symbol
     */
    insertTypedefToTypedefTab(id: Identifier, t: Type): void {
        const tid = t.isTypeIdentifier();
        if (tid !== null) {
            // Try to resolve the TypeIdentifier to its type
            const pt = this.lookupTypedef(tid.ident!);
            if (pt !== null && pt.value !== null)
                t = pt.value;
        }
        if ((t.mcache !== null && t.mcache.typedefIdent !== null) || t.isTypeBasic() !== null) {
            t = t.copy();
            t.mcache = null;
        }
        t.getMcache().typedefIdent = id;
        let tab = this.typedefTab.opIndex(this.typedefTab.length - 1);
        if (tab === null)
            tab = new Map<Identifier, Type | null>(); // D's first insertion into a null AA allocates it
        tab.set(id, t);
        this.typedefTab.opIndexAssign(tab, this.typedefTab.length - 1);
    }

    /*********************************
     * Lookup id in typedefTab[].
     * Returns:
     *  if not found, then null.
     *  if found, then Type*. Deferencing it will yield null if it is not
     *  a typedef, and a type if it is a typedef.
     *
     * D returns a pointer into the AA slot. Every reader only dereferences it
     * (dmd/cparse.d:270, :2693, :5026, :5044, :5079) and none writes through it, so the port returns a
     * one-slot box holding the slot's value at lookup time: `pt.value` is D's `*pt`.
     */
    lookupTypedef(id: Identifier): { value: Type | null } | null {
        const tabs = this.typedefTab.opSlice();
        for (let i = tabs.length - 1; i >= 0; i--) { // foreach_reverse (tab; typedefTab[])
            const ctab = tabs[i];
            if (ctab === null)
                continue; // `in` on a null AA finds nothing
            const v = ctab.get(id);
            if (v !== undefined) {
                return { value: v };
            }
        }
        return null; // not found
    }

    /******************************************************************************/
    /********************************* Directive Parser ***************************/

    /**
     * Handles a `#` directive line in the C source: `# <linenum>` / `#line` markers, `#define` and
     * `#undef` (recorded into `defines` when collecting), `#pragma` (pack and attribute), and
     * `#ident`. Returns true when the directive was consumed, false (with an error, except for
     * `#undef`) when it is not supported (dmd/cparse.d:5125).
     */
    override parseSpecialTokenSequence(): boolean {
        const n = new Token();
        this.scan(n);
        const nv0: TOK = n.value;
        if (nv0 === TOK.int32Literal) {
            this.poundLine(n, true);
            return true;
        }
        if (nv0 === TOK.identifier) {
            if (n.ident === Id.line) {
                this.poundLine(n, false);
                return true;
            } else if (this.defines !== null && (n.ident === Id.define || n.ident === Id.undef)) {
                /* Append this line to `defines`.
                 * Not canonicalizing it - assume it already is
                 */
                this.defines.writeByte(0x23 /* '#' */);
                this.defines.writestring(n.ident!.toString());
                this.skipToNextLine(this.defines);
                this.defines.writeByte(0); // each #define line is 0 terminated
                return true;
            } else if (n.ident === Id.__pragma) {
                this.pragmaDirective(this.scanloc);
                return true;
            } else if (n.ident === Id.ident) { // #ident "string"
                this.scan(n);
                const nv1: TOK = n.value;
                if (nv1 === TOK.string_ && n.ptr![0] === 0x22 /* '"' */ && n.postfix === 0) {
                    /* gcc inserts string into the .comment section in the object file.
                     * Just ignore it for now, but can support it later by writing
                     * the string to obj_exestr()
                     */

                    this.scan(n);
                    const nv: TOK = n.value;
                    if (nv === TOK.endOfFile || nv === TOK.endOfLine)
                        return true;
                }
                this.error(ds("\"string\" expected after `#ident`"));
                return false;
            }
        }
        if (n.ident !== Id.undef)
            this.error(ds("C preprocessor directive `#%s` is not supported"), n.toChars());
        return false;
    }

    /*********************************************
     * VC __pragma
     * https://docs.microsoft.com/en-us/cpp/preprocessor/pragma-directives-and-the-pragma-keyword?view=msvc-170
     * Scanner is on the `__pragma`
     * Params:
     *  startloc = location to use for error messages
     */
    private uupragmaDirective(startloc: Loc): void {
        const loc = startloc;
        this.nextToken(); // move past __pragma
        const tv0: TOK = this.token.value;
        if (tv0 !== TOK.leftParenthesis) {
            this.errorLoc(loc, ds("left parenthesis expected to follow `__pragma` instead of `%s`"),
                this.token.toChars());
            this.nextToken();
            return;
        }
        this.nextToken();

        const tv: TOK = this.token.value;
        if (tv === TOK.identifier) {
            if (this.token.ident === Id.pack)
                this.pragmaPack(startloc, false);
            else {
                this.nextToken();
                if (this.token.value === TOK.leftParenthesis)
                    this.cparseParens();
            }

        } else if (tv === TOK.endOfFile) {
        } else if (tv === TOK.rightParenthesis) {
        } else
            this.errorLoc(loc, ds("unrecognized `__pragma(%s)`"), this.token.toChars());

        if (this.token.value !== TOK.rightParenthesis) {
            this.errorLoc(loc, ds("right parenthesis expected to close `__pragma(...)` instead of `%s`"),
                this.token.toChars());
            return;
        }
        this.nextToken();
    }

    /*********************************************
     * C11 6.10.6 Pragma directive
     * # pragma pp-tokens(opt) new-line
     * The C preprocessor sometimes leaves pragma directives in
     * the preprocessed output. Ignore them.
     * Upon return, p is at start of next line.
     */
    private pragmaDirective(loc: Loc): void {
        const n = new Token();
        this.scan(n);
        if (n.value === TOK.identifier && n.ident === Id.pack)
            return this.pragmaPack(loc, true);
        if (n.value === TOK.identifier && n.ident === Id.attribute)
            return this.pragmaAttribute(loc);
        if (n.value !== TOK.endOfLine)
            this.skipToNextLine();
    }

    /*********
     * # pragma pack
     * https://gcc.gnu.org/onlinedocs/gcc-4.4.4/gcc/Structure_002dPacking-Pragmas.html
     * https://docs.microsoft.com/en-us/cpp/preprocessor/pack
     * Scanner is on the `pack`
     * Params:
     *  startloc = location to use for error messages
     *  useScan = use scan() to retrieve next token, instead of nextToken()
     */
    private pragmaPack(startloc: Loc, useScan: boolean): void {
        const loc = startloc;

        /* Pull tokens from scan() or nextToken()
         */
        const scan = (t: Token): void => {
            if (useScan) {
                // D `Lexer.scan(t)`: the base-class scan; neither Parser nor CParser overrides it.
                this.scan(t);
            } else {
                this.nextToken();
                Object.assign(t, this.token.copy()); // *t = token;
            }
        };

        const n = new Token();
        scan(n);
        const nv0: TOK = n.value;
        if (nv0 !== TOK.leftParenthesis) {
            this.errorLoc(loc, ds("left parenthesis expected to follow `#pragma pack`"));
            if (n.value !== TOK.endOfLine)
                this.skipToNextLine();
            return;
        }

        const closingParen = (): void => {
            if (n.value !== TOK.rightParenthesis) {
                this.errorLoc(loc, ds("right parenthesis expected to close `#pragma pack(`"));
            }
            if (n.value !== TOK.endOfLine)
                this.skipToNextLine();
        };

        const setPackAlign = (t: Token): void => {
            const n = t.unsvalue;
            if (n < 1n || (n & (n - 1n)) !== 0n || 0xffffn < n) // ushort.max < n
                this.errorLoc(loc, ds("pack must be an integer positive power of 2, not 0x%llx"), n);
            this.packalign.set(Number(BigInt.asUintN(32, n))); // cast(uint)n
            this.packalign.setPack();
        };

        scan(n);

        if (this.records === null) {
            this.records = new DArray<Identifier | null>();
            this.packs = new DArray<structalign_t>();
        }
        const records = this.records;
        const packs = this.packs!; // allocated together with `records` just above

        /* # pragma pack ( show )
         */
        const nvs: TOK = n.value;
        if (nvs === TOK.identifier && n.ident === Id.show) {
            if (this.packalign.isDefault())
                this.eSink.warning(startloc, ds("current pack attribute is default"));
            else
                this.eSink.warning(startloc, ds("current pack attribute is %d"), this.packalign.get());
            scan(n);
            return closingParen();
        }
        /* # pragma pack ( push )
         * # pragma pack ( push , identifier )
         * # pragma pack ( push , integer )
         * # pragma pack ( push , identifier , integer )
         */
        const nvp: TOK = n.value;
        if (nvp === TOK.identifier && n.ident === Id.push) {
            scan(n);
            let record: Identifier | null = null;
            const nv1: TOK = n.value;
            if (nv1 === TOK.comma) {
                scan(n);
                const nv: TOK = n.value;
                if (nv === TOK.identifier) {
                    record = n.ident;
                    scan(n);
                    const nv2: TOK = n.value;
                    if (nv2 === TOK.comma) {
                        scan(n);
                        const nv3: TOK = n.value;
                        if (nv3 === TOK.int32Literal) {
                            setPackAlign(n);
                            scan(n);
                        } else
                            this.errorLoc(loc, ds("alignment value expected, not `%s`"), n.toChars());
                    }
                } else if (nv === TOK.int32Literal) {
                    setPackAlign(n);
                    scan(n);
                } else
                    this.errorLoc(loc, ds("alignment value expected, not `%s`"), n.toChars());
            }
            records.push(record);
            packs.push(this.packalign.copy());
            return closingParen();
        }
        /* # pragma pack ( pop )
         * # pragma pack ( pop PopList )
         * PopList :
         *    , IdentifierOrInteger
         *    , IdentifierOrInteger PopList
         * IdentifierOrInteger:
         *      identifier
         *      integer
         */
        const nvq: TOK = n.value;
        if (nvq === TOK.identifier && n.ident === Id.pop) {
            scan(n);
            let len = records.length;
            const nv1: TOK = n.value;
            if (nv1 === TOK.rightParenthesis) { // #pragma pack ( pop )
                if (len === 0) // nothing to pop
                    return closingParen();

                records.setDim(len - 1);
                packs.setDim(len - 1);
                if (len === 1) // stack is now empty
                    this.packalign.setDefault();
                else
                    this.packalign = packs.opIndex(len - 2).copy();
                return closingParen();
            }
            while (true) { // #pragma pack ( pop ,
                const nvw: TOK = n.value; // re-read per iteration (02 §11.4)
                if (nvw !== TOK.comma)
                    break;
                scan(n);
                const nv: TOK = n.value;
                if (nv === TOK.identifier) {
                    /* pragma pack(pop, identifier
                     * Pop until identifier is found, pop that one too, and set
                     * alignment to the new top of the stack.
                     * If identifier is not found, do nothing.
                     */
                    for (; len !== 0; --len) {
                        if (records.opIndex(len - 1) === n.ident) {
                            records.setDim(len - 1);
                            packs.setDim(len - 1);
                            if (len > 1)
                                this.packalign = packs.opIndex(len - 2).copy();
                            else
                                this.packalign.setDefault(); // stack empty, use default
                            break;
                        }
                    }
                    scan(n);
                } else if (nv === TOK.int32Literal) {
                    setPackAlign(n);
                    scan(n);
                } else {
                    this.errorLoc(loc,
                        ds("identifier or alignment value expected following `#pragma pack(pop,` not `%s`"),
                        n.toChars());
                    scan(n);
                }
            }
            return closingParen();
        }
        /* # pragma pack ( integer )
         * Sets alignment to integer
         */
        if (n.value === TOK.int32Literal) {
            setPackAlign(n);
            scan(n);
            return closingParen();
        }
        /* # pragma pack ( )
         * Sets alignment to default
         */
        if (n.value === TOK.rightParenthesis) {
            this.packalign.setDefault();
            return closingParen();
        }

        this.errorLoc(loc, ds("unrecognized `#pragma pack(%s)`"), n.toChars());
        if (n.value !== TOK.endOfLine)
            this.skipToNextLine();
    }

    /*********
     * # pragma attribute(...)
     * Sets default storage classes
     * Params:
     *  startloc = location to use for error messages
     */
    private pragmaAttribute(startloc: Loc): void {
        const loc = startloc;

        if (this.defaultStorageClassesStack === null) {
            this.defaultStorageClassesStack = new DArray<STC>();
        }
        const defaultStorageClassesStack = this.defaultStorageClassesStack;

        // D `Lexer.scan(&n)`: the base-class scan; neither Parser nor CParser overrides it.
        const n = new Token();
        this.scan(n);
        const nv0: TOK = n.value;
        if (nv0 !== TOK.leftParenthesis) {
            this.errorLoc(loc, ds("left parenthesis expected to follow `#pragma attribute`"));
            if (n.value !== TOK.endOfLine)
                this.skipToNextLine();
            return;
        }

        const closingParen = (): void => {
            if (n.value !== TOK.rightParenthesis) {
                this.errorLoc(loc, ds("right parenthesis expected to close `#pragma attribute(`"));
            }
            if (n.value !== TOK.endOfLine)
                this.skipToNextLine();
        };

        this.scan(n);

        /* # pragma attribute (push, ...)
         */
        const nvp: TOK = n.value;
        if (nvp === TOK.identifier && n.ident === Id.push) {
            this.scan(n);
            const nv1: TOK = n.value;
            if (nv1 !== TOK.comma) {
                this.errorLoc(loc, ds("comma expected to follow `#pragma attribute(push`"));
                if (n.value !== TOK.endOfLine)
                    this.skipToNextLine();
                return;
            }

            while (true) {
                this.scan(n);
                const nv: TOK = n.value;
                if (nv === TOK.endOfLine) {
                    this.errorLoc(loc, ds("right parenthesis expected to close `#pragma attribute(push, `"));
                    break;
                }

                if (nv === TOK.rightParenthesis)
                    break;

                if (nv === TOK.identifier) {
                    if (n.ident === Id._nothrow)
                        this.defaultStorageClasses = (this.defaultStorageClasses | STC.nothrow_) as STC;
                    else if (n.ident === Id.nogc)
                        this.defaultStorageClasses = (this.defaultStorageClasses | STC.nogc) as STC;
                    else if (n.ident === Id._pure)
                        this.defaultStorageClasses = (this.defaultStorageClasses | STC.pure_) as STC;
                    // Ignore unknown identifiers
                } else {
                    this.errorLoc(loc, ds("unrecognized `#pragma attribute(push, %s)`"), n.toChars());
                    break;
                }

                this.scan(n);
                const nv2: TOK = n.value;

                if (nv2 === TOK.rightParenthesis)
                    break;

                if (nv2 !== TOK.comma) {
                    this.errorLoc(loc, ds("unrecognized `#pragma attribute(push, %s)`"), n.toChars());
                    break;
                }
            }

            defaultStorageClassesStack.push(this.defaultStorageClasses);

            return closingParen();
        }

        /* # pragma attribute(pop)
         */
        const nvq: TOK = n.value;
        if (nvq === TOK.identifier && n.ident === Id.pop) {
            this.scan(n);
            const len = defaultStorageClassesStack.length;

            if (len !== 0) {
                defaultStorageClassesStack.setDim(len - 1);
                if (len === 1) // stack is now empty
                    this.defaultStorageClasses = STC.none; // STC.init
                else
                    this.defaultStorageClasses = defaultStorageClassesStack.opIndex(len - 2);
            }

            return closingParen();
        }

        this.errorLoc(loc, ds("unrecognized `#pragma attribute(%s)`"), n.toChars());
        if (n.value !== TOK.endOfLine)
            this.skipToNextLine();
    }

    /******************************************************************************/
    /********************************* #define Parser *****************************/

    /**
     * Go through the #define's in the defines buffer and see what we can convert
     * to Dsymbols, which are then appended to symbols[]
     *
     * Precondition: `symbols` is non-null whenever a #define converts (asserted).
     * Re-lexes the `defines` buffer in place: the lexer position, `scanloc` and `eSink` are saved and
     * restored around it, and `defines` is null while it runs (dmd/cparse.d:5580).
     */
    addDefines(): void {
        // The save/restore pairs below (`defines`, `scanloc`, `eSink`) are released only on D's normal
        // path. They are state of this parser instance, which does not outlive a throw: dmodule.d:802
        // builds one `scope` CParser per C module. So no try/finally is added (11 §2.5 rule (d)).
        if (this.defines === null || this.defines.length() < 10) // minimum length of a #define line
            return;
        const buf: OutBuffer = this.defines;
        this.defines = null; // prevent skipToNextLine() and parseSpecialTokenSequence()
                             // from appending to slice[]
        const length = buf.length();
        buf.writeByte(0);
        const slice = dsSubslice(buf.peekChars(), 0, length);
        const scanlocSave = this.scanloc;
        this.resetDefineLines(slice); // reset lexer
        const save = this.eSink;
        const eLatch = new ErrorSinkLatch();
        this.eSink = eLatch;

        // D reads the lexer's `const(char)* p` directly (`*p`, `p[0 .. 7]`). After resetDefineLines
        // the lexer's offset `p` indexes `slice`; the byte at `length` is the 0 written above.
        const ch = (i: number): number => (i < length ? slice[i] : 0);
        const endp = length - 7; // const(char)* endp = &slice[length - 7];

        const newSymbols = new DArray<Dsymbol | null>();

        // hash table of #define's turned into Symbol's
        // indexed by Identifier, returns index into newSymbols[]
        // The memory for this is leaked
        const defineTab = new Map<Identifier | null, number>();

        const addSym = (s: Dsymbol): void => {
            const v = s.isVarDeclaration();
            if (v !== null)
                v.isCmacro = true; // mark it as coming from a C #define
            const td = s.isTemplateDeclaration();
            if (td !== null)
                td.isCmacro = true; // mark as coming from a C #define
            /* If it's already defined, replace the earlier
             * definition
             */
            const pd = defineTab.get(s.ident);
            if (pd !== undefined) {
                newSymbols.opIndexAssign(s, pd);
                return;
            }
            defineTab.set(s.ident, newSymbols.length);
            newSymbols.push(s);
        };

        const removeSym = (ident: Identifier | null): void => {
            const pd = defineTab.get(ident);
            if (pd !== undefined) {
                newSymbols.opIndexAssign(null, pd);
            }
        };

        const nextLine = (): void => {
            // scan to end of line
            while (ch(this.p) !== 0)
                ++this.p;
            ++this.p; // advance to start of next line
        };

        /* Create a nullary template function from an expression:
         *   auto id()() { return exp; }
         */
        const addNullaryTemplate = (exp: Expression, id: Identifier): void => {
            const ret = new ReturnStatement(exp.loc, exp);
            const parameterList = new ParameterList(new DArray<Parameter | null>(), VarArg.none, STC.none);
            const stc: STC = STC.auto_;
            const tf = new TypeFunction(parameterList, null, LINK.d, stc);
            const fd = new FuncDeclaration(exp.loc, exp.loc, id, stc, tf, false);
            fd.fbody = ret;
            const decldefs: Dsymbols = new DArray<Dsymbol | null>();
            decldefs.push(fd);
            const tpl: TemplateParameters = new DArray<TemplateParameter | null>();
            const tempdecl = new TemplateDeclaration(exp.loc, id, tpl, null, decldefs, false);
            addSym(tempdecl);
        };

        while (this.p < endp) {
            if (dsEquals(slice.subarray(this.p, this.p + 7), ds("#define"))) { // p[0 .. 7] == "#define"
                this.p += 7;
                this.nextToken();
                const tvd: TOK = this.token.value;
                if (tvd === TOK.identifier) {
                    const id = this.token.ident!;
                    // https://github.com/dlang/dmd/issues/20423
                    // skip macros that could shadow special builtins
                    if (id === Id.va_arg) {
                        nextLine();
                        continue;
                    }
                    const params = ch(this.p) === 0x28 /* '(' */;
                    this.nextToken();

                    let t: Type | null = null;

                    let hasMinus = false;
                    const tvm: TOK = this.token.value;
                    if (tvm === TOK.min) {
                        this.nextToken();
                        // Only allow integer and float literals after minus.
                        const tvl: TOK = this.token.value;
                        switch (tvl) {
                            case TOK.int32Literal:
                            case TOK.uns32Literal:
                            case TOK.int64Literal:
                            case TOK.uns64Literal:
                            case TOK.float32Literal:
                            case TOK.float64Literal:
                            case TOK.float80Literal:
                            case TOK.imaginary32Literal:
                            case TOK.imaginary64Literal:
                            case TOK.imaginary80Literal:
                                hasMinus = true;
                                break;
                            default:
                                continue;
                        }
                    }

                    // Linteger: and Lfloat: SHARED-ARM tails (06 §4), reached by the jumps of the
                    // literal arms after each assigned `t`. Each returns true where D `continue`s the
                    // outer loop and false where D `break`s out of the switch; every site tests it.
                    const LintegerTail = (): boolean => {
                        const intvalue = this.token.intvalue;
                        this.nextToken();
                        if (this.token.value === TOK.endOfFile) {
                            /* Declare manifest constant:
                             *  enum id = intvalue;
                             */
                            let e: Expression = new IntegerExp(this.scanloc, intvalue, t!); // t set by every jump site
                            if (hasMinus)
                                e = new NegExp(this.scanloc, e);
                            const v = new VarDeclaration(this.scanloc, t, id, new ExpInitializer(this.scanloc, e),
                                STC.manifest);
                            addSym(v);
                            ++this.p;
                            return true;
                        }
                        return false;
                    };
                    const LfloatTail = (): boolean => {
                        const floatvalue = this.token.floatvalue;
                        this.nextToken();
                        if (this.token.value === TOK.endOfFile) {
                            /* Declare manifest constant:
                             *  enum id = floatvalue;
                             */
                            let e: Expression = new RealExp(this.scanloc, floatvalue, t);
                            if (hasMinus)
                                e = new NegExp(this.scanloc, e);
                            const v = new VarDeclaration(this.scanloc, t, id, new ExpInitializer(this.scanloc, e),
                                STC.manifest);
                            addSym(v);
                            ++this.p;
                            return true;
                        }
                        return false;
                    };

                    const tvs: TOK = this.token.value;
                    Lswitch:
                    switch (tvs) {
                        case TOK.endOfFile: // #define identifier
                            ++this.p;
                            continue;

                        case TOK.int32Literal:
                        case TOK.charLiteral:
                            t = Type.tint32;
                            if (LintegerTail()) continue; // goto Linteger (dmd/cparse.d:5715)
                            break;
                        case TOK.wcharLiteral:
                            t = Type.tuns16;
                            if (LintegerTail()) continue; // goto Linteger (dmd/cparse.d:5716)
                            break;
                        case TOK.dcharLiteral:
                        case TOK.uns32Literal:
                            t = Type.tuns32;
                            if (LintegerTail()) continue; // goto Linteger (dmd/cparse.d:5718)
                            break;
                        case TOK.int64Literal:
                            t = Type.tint64;
                            if (LintegerTail()) continue; // goto Linteger (dmd/cparse.d:5719)
                            break;
                        case TOK.uns64Literal:
                            t = Type.tuns64;
                            if (LintegerTail()) continue; // goto Linteger (dmd/cparse.d:5720)
                            break;

                        case TOK.float32Literal:
                            t = Type.tfloat32;
                            if (LfloatTail()) continue; // goto Lfloat (dmd/cparse.d:5740)
                            break;
                        case TOK.float64Literal:
                            t = Type.tfloat64;
                            if (LfloatTail()) continue; // goto Lfloat (dmd/cparse.d:5741)
                            break;
                        case TOK.float80Literal:
                            t = Type.tfloat80;
                            if (LfloatTail()) continue; // goto Lfloat (dmd/cparse.d:5742)
                            break;
                        case TOK.imaginary32Literal:
                            t = Type.timaginary32;
                            if (LfloatTail()) continue; // goto Lfloat (dmd/cparse.d:5743)
                            break;
                        case TOK.imaginary64Literal:
                            t = Type.timaginary64;
                            if (LfloatTail()) continue; // goto Lfloat (dmd/cparse.d:5744)
                            break;
                        case TOK.imaginary80Literal:
                            t = Type.timaginary80;
                            if (LfloatTail()) continue; // goto Lfloat (dmd/cparse.d:5745)
                            break;

                        case TOK.string_: {
                            const str = this.token.ustring!;
                            const len = this.token.len;
                            const postfix = this.token.postfix;
                            this.nextToken();
                            if (this.token.value === TOK.endOfFile) {
                                /* Declare manifest constant:
                                 *  enum id = "string";
                                 */
                                const e: Expression = new StringExp(this.scanloc, Array.from(str.subarray(0, len)),
                                    len, 1, postfix, true);
                                const v = new VarDeclaration(this.scanloc, null, id,
                                    new ExpInitializer(this.scanloc, e), STC.manifest);
                                addSym(v);
                                ++this.p;
                                continue;
                            }
                            break;
                        }

                        case TOK.identifier: {
                            /* Look for:
                             *  #define ID identifier ( args )
                             * where the macro body is exactly a function-like macro call
                             * (no additional operators that could cause precedence issues).
                             * Rewrite to a template function:
                             *  auto ID()() { return identifier(args); }
                             */
                            assert(!params); // would be TOK.leftParenthesis
                            eLatch.sawErrors = false;
                            const exp = this.cparseExpression();
                            if (eLatch.sawErrors) // parsing errors
                                break; // abandon this #define
                            if (this.token.value !== TOK.endOfFile) // did not consume the entire line
                                break;
                            // Only allow bare function calls to avoid precedence issues.
                            // E.g., `#define X FUNC(5)` is safe, but `#define X FUNC(5) + 1`
                            // would have different semantics in D vs C when used as `X * 2`.
                            if (exp.isCallExp() === null)
                                break;
                            addNullaryTemplate(exp, id);
                            ++this.p;
                            continue;
                        }

                        case TOK.leftParenthesis: {
                            /* Look for:
                             *  #define ID ( expression )
                             * and rewrite it to a template function:
                             *  auto ID()() { return expression; }
                             */
                            // goto caseFunctionLike (dmd/cparse.d:5817) when `params`: SKIP-FLAG, if/else
                            // sub-case (06 §4). Every path of the skipped tail leaves the switch arm
                            // (`break`/`continue`), so the label below is reached only on that jump.
                            if (!params) {
                                this.nextToken();
                                eLatch.sawErrors = false;
                                const exp = this.cparseExpression();
                                if (eLatch.sawErrors) // parsing errors
                                    break; // abandon this #define
                                const tvr: TOK = this.token.value;
                                if (tvr !== TOK.rightParenthesis)
                                    break;
                                this.nextToken();
                                const tve: TOK = this.token.value;
                                if (tve !== TOK.endOfFile)
                                    break;
                                addNullaryTemplate(exp, id);
                                ++this.p;
                                continue;
                            }

                            // caseFunctionLike:
                            /* Parse `( a, b ) expression`
                             * Create template function:
                             *    auto id(__MP1, __MP2)(__MP1 a, __MP1 b) { return expression; }
                             */

                            // Capture the parameter list
                            const varargs: VarArg = VarArg.none;
                            const parameters = new DArray<Parameter | null>();
                            this.nextToken(); // skip past `(`
                            while (true) { // Lwhile:
                                const tv: TOK = this.token.value;
                                if (tv === TOK.rightParenthesis)
                                    break;
                                if (tv === TOK.dotDotDot) {
                                    // dropped: `static if (0)` variadic-macro block (dmd/cparse.d:5852-5858),
                                    // compiled out in D.
                                    break Lswitch;
                                }

                                if (tv !== TOK.identifier)
                                    break Lswitch;
                                const param = new Parameter(this.token.loc, STC.none, null, this.token.ident, null,
                                    null);
                                parameters.push(param);
                                this.nextToken();
                                if (this.token.value === TOK.comma) {
                                    this.nextToken();
                                    continue;
                                }
                                break;
                            }
                            const tvr: TOK = this.token.value;
                            if (tvr !== TOK.rightParenthesis)
                                break;

                            this.nextToken();
                            const parameterList = new ParameterList(parameters, varargs, STC.none);
                            /* Create a type for each parameter. Add it to the template parameter list,
                             * and the parameter list.
                             */
                            const tpl: TemplateParameters = new DArray<TemplateParameter | null>();
                            for (const param of parameters.opSlice()) {
                                const idtype = Identifier.generateId(ds("__MP"));
                                const loc = param!.loc;
                                const tp = new TemplateTypeParameter(loc, idtype, null, null);
                                tpl.push(tp);

                                const at = new TypeIdentifier(loc, idtype);
                                param!.type = at;
                            }

                            eLatch.sawErrors = false;
                            const exp = this.cparseExpression();

                            assert(this.symbols !== null);

                            if (eLatch.sawErrors) // parsing errors
                                break; // abandon this #define

                            if (this.token.value !== TOK.endOfFile) // did not consume the entire line
                                break;

                            // Generate function
                            const ret = new ReturnStatement(exp.loc, exp);
                            const stc: STC = STC.auto_;
                            const tf = new TypeFunction(parameterList, null, LINK.d, stc);
                            const fd = new FuncDeclaration(exp.loc, exp.loc, id, stc, tf, false);
                            fd.fbody = ret;

                            // Wrap it in an eponymous template
                            const decldefs: Dsymbols = new DArray<Dsymbol | null>();
                            decldefs.push(fd);
                            const tempdecl = new TemplateDeclaration(exp.loc, id, tpl, null, decldefs, false);
                            addSym(tempdecl);

                            ++this.p;
                            continue;
                        }

                        default:
                            break;
                    }
                }
            } else if (dsEquals(slice.subarray(this.p, this.p + 6), ds("#undef"))) { // p[0 .. 6] == "#undef"
                this.p += 6;
                this.nextToken();
                if (this.token.value === TOK.identifier)
                    removeSym(this.token.ident);
            }
            nextLine();
        }

        if (newSymbols.length !== 0) {
            assert(this.symbols !== null, "symbols is null");
            const symbols = this.symbols!;
            symbols.reserve(newSymbols.length);

            for (const sym of newSymbols.opSlice())
                if (sym !== null) // undefined entries are null
                    symbols.push(sym);
        }

        this.scanloc = scanlocSave;
        this.eSink = save;
        this.defines = buf;
    }
}

// dmodule.ts and iasm/gcc.ts reach this class through registration slots (01 §4.4; the measurements and the order
// contracts are in dmodule.ts, at `registerCParser`, and in iasm/gcc.ts's LOAD ORDER note): dmodule.d:26 and
// iasm/gcc.d:27 `import dmd.cparse;` are inverted, so this module hands `CParser` over from its own body.
registerCParser(CParser);
registerGccAsmCParser(CParser);
