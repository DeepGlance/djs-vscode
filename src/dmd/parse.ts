// Ported from dmd/parse.d (module dmd.parse).
//
// Takes a token stream from the lexer, and parses it into an abstract syntax tree.
//
// MONOMORPHIZATION (13-visitor.md §3, translation-order.md §5 bucket 7b): the D source is
// `class Parser(AST, Lexer = dmd.lexer.Lexer) : Lexer`. We port exactly one AST
// (`astcodegen`), so the `(AST)` template parameter is dropped and every `AST.X` becomes the
// concrete ported class `X` imported from its module. The `Lexer` template parameter likewise
// collapses to the single concrete `Lexer` base class.
//
// EXCLUDED-MODULE STRIP (translation-order.md §4): parse.d does NOT import cparse directly; the
// C-file (ImportC) paths live in cparse.d and are reached only when the lexer is in C mode
// (`Cfile`). parse.d itself contains no `if (Cfile)`/cparse branch, so there is nothing to strip
// here — the whole file is the D-language parser. (cparse subclasses this Parser elsewhere; that
// subclass is excluded and not ported.)
//
// DIAGNOSTICS (10-tests-diagnostics.md): every `error(...)`/`deprecation(...)` format string is
// reproduced byte-for-byte via `ds("...")`. The lexer base provides `error(fmt, ...)` (uses
// `token.loc`) and `errorLoc(loc, fmt, ...)` (explicit loc); D's `error(loc, ...)` overload maps
// to `errorLoc`, and `deprecation(loc, ...)` maps to `deprecationLoc`.
//
// 1.43 DRIFT — `addSTC` (dependency signature, 11-escalate.md §1): upstream moved the method
// `Type.addSTC(stc)` (1.42 mtype.d:1120) to the free function `addSTC(Type, STC)` (1.43
// typesem.d:80), so every parse.d site now reads `AST.addSTC(t, stc)` (UFCS-free form, 04 §6). The
// typesem.ts exports the free form and every call site here uses it.

import { Lexer, CompileEnv } from "./lexer.js";
import { ErrorSink } from "./errorsink.js";
import { Loc } from "./location.js";
import { Identifier } from "./identifier.js";
import { Id } from "./id.js";
import { RootObject, DYNCAST } from "./rootobject.js";
import { Token, TOK, EXP } from "./tokens.js";
import { OutBuffer } from "./common/outbuffer.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import { assert, assertUnreachable } from "../assert.js";

import {
  STC,
  LINK,
  CPPMANGLE,
  VarArg,
  MODFlags,
  Edition,
  Tsarray,
  Taarray,
  Tident,
  Tfunction,
} from "./astenums.js";

import { stcToBuffer, linkageToChars, visibilityToChars, registerPrecedence } from "./hdrgen.js";
import { ModToStc } from "./mtype.js";
import { addSTC } from "./typesem.js";
// `typeToExpression` is homed in dmd/mtype.d:131 (2.113), not typesem.d.
import { typeToExpression } from "./mtype.js";

import {
  // mtype
  Type,
  TypeFunction,
  TypeQualified,
  TypeIdentifier,
  TypeInstance,
  TypeReturn,
  TypeTypeof,
  TypeVector,
  TypeTraits,
  TypeMixin,
  TypeError,
  TypePointer,
  TypeDArray,
  TypeAArray,
  TypeSArray,
  TypeSlice,
  TypeDelegate,
  TypeNext,
  Parameter,
  ParameterList,
} from "./mtype.js";

import type {
  Dsymbols,
  Expressions,
  Objects,
  Identifiers,
  TemplateParameters,
  BaseClasses,
  Catches,
  ArgumentLabels,
} from "./arraytypes.js";

// Runtime Array constructors for the arraytypes aliases (they are `Array<T>` value imports).
import { Array as DArray } from "./root/array.js";

import {
  // expression
  Expression,
  IntegerExp,
  RealExp,
  IdentifierExp,
  DollarExp,
  ThisExp,
  SuperExp,
  NullExp,
  StringExp,
  InterpExp,
  TypeExp,
  TypeidExp,
  TraitsExp,
  IsExp,
  AssertExp,
  MixinExp,
  ImportExp,
  DotIdExp,
  DotTemplateInstanceExp,
  CallExp,
  ArrayExp,
  ScopeExp,
  IntervalExp,
  AddrExp,
  PreExp,
  PostExp,
  PtrExp,
  NegExp,
  UAddExp,
  NotExp,
  ComExp,
  CastExp,
  PowExp,
  MulExp,
  DivExp,
  ModExp,
  AddExp,
  MinExp,
  CatExp,
  ShlExp,
  ShrExp,
  UshrExp,
  EqualExp,
  IdentityExp,
  CmpExp,
  InExp,
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
  PowAssignExp,
  AndAssignExp,
  OrAssignExp,
  XorAssignExp,
  ShlAssignExp,
  ShrAssignExp,
  UshrAssignExp,
  CatAssignExp,
  CommaExp,
  ThrowExp,
  ArrayLiteralExp,
  AssocArrayLiteralExp,
  FuncExp,
  NewExp,
  NewAnonClassExp,
  FileInitExp,
  LineInitExp,
  ModuleInitExp,
  FuncInitExp,
  PrettyFuncInitExp,
  ErrorExp,
  ArgumentLabel,
} from "./expression.js";

import {
  // declaration
  Declaration,
  AliasDeclaration,
  VarDeclaration,
  BitFieldDeclaration,
} from "./declaration.js";

import {
  // func
  FuncDeclaration,
  FuncLiteralDeclaration,
  CtorDeclaration,
  DtorDeclaration,
  PostBlitDeclaration,
  StaticCtorDeclaration,
  StaticDtorDeclaration,
  SharedStaticCtorDeclaration,
  SharedStaticDtorDeclaration,
  InvariantDeclaration,
  UnitTestDeclaration,
  NewDeclaration,
  Ensure,
} from "./func.js";

import { Dsymbol } from "./dsymbol.js";
import { Visibility, AliasAssign, ScopeDsymbol } from "./dsymbol.js";

import {
  // attrib
  StorageClassDeclaration,
  LinkDeclaration,
  CPPMangleDeclaration,
  CPPNamespaceDeclaration,
  AlignDeclaration,
  AnonDeclaration,
  PragmaDeclaration,
  DeprecatedDeclaration,
  UserAttributeDeclaration,
  ConditionalDeclaration,
  StaticIfDeclaration,
  StaticForeachDeclaration,
  MixinDeclaration,
  VisibilityDeclaration,
} from "./attrib.js";

import {
  // statement
  Statement,
  ErrorStatement,
  ExpStatement,
  CompoundStatement,
  CompoundDeclarationStatement,
  ScopeStatement,
  LabelStatement,
  WhileStatement,
  DoStatement,
  ForStatement,
  ForeachStatement,
  ForeachRangeStatement,
  IfStatement,
  ConditionalStatement,
  PragmaStatement,
  StaticAssertStatement,
  SwitchStatement,
  CaseStatement,
  CaseRangeStatement,
  DefaultStatement,
  GotoDefaultStatement,
  GotoCaseStatement,
  GotoStatement,
  ReturnStatement,
  BreakStatement,
  ContinueStatement,
  SynchronizedStatement,
  WithStatement,
  TryCatchStatement,
  TryFinallyStatement,
  ThrowStatement,
  ScopeGuardStatement,
  Catch,
  AsmStatement,
  CompoundAsmStatement,
  ImportStatement,
  MixinStatement,
  StaticForeachStatement,
} from "./statement.js";

import {
  // init
  Initializer,
  ExpInitializer,
  StructInitializer,
  ArrayInitializer,
  VoidInitializer,
} from "./init.js";

import {
  // cond
  Condition,
  StaticIfCondition,
  DebugCondition,
  VersionCondition,
  StaticForeach,
} from "./cond.js";

import {
  // dtemplate
  TemplateDeclaration,
  TemplateInstance,
  TemplateMixin,
  TemplateParameter,
  TemplateAliasParameter,
  TemplateTypeParameter,
  TemplateThisParameter,
  TemplateTupleParameter,
  TemplateValueParameter,
} from "./dtemplate.js";

import { StaticAssert } from "./staticassert.js";
import { Import } from "./dimport.js";
import { Nspace } from "./nspace.js";
import { AliasThis } from "./aliasthis.js";
import { DebugSymbol, VersionSymbol } from "./dversion.js";
import { EnumDeclaration, EnumMember } from "./denum.js";
import { StructDeclaration, UnionDeclaration } from "./dstruct.js";
import { ClassDeclaration, InterfaceDeclaration, BaseClass } from "./dclass.js";
import { AggregateDeclaration } from "./aggregate.js";
import { Module, ModuleDeclaration } from "./dmodule.js";

/***********************************************************
 */
export class Parser extends Lexer {
  md: ModuleDeclaration | null = null;

  // protected
  mod!: Module;
  linkage: LINK = LINK.default_;
  linkLoc: Loc = new Loc();
  cppmangle: CPPMANGLE = CPPMANGLE.def;
  endloc: Loc = new Loc(); // set to location of last right curly
  inBrackets = 0; // inside [] of array index or slice
  lookingForElse: Loc = new Loc(); // location of lonely if looking for an else
  doUnittests = false; // parse unittest blocks

  /*********************
   * Use this constructor for string mixins, OR the main parser constructor.
   * The D `Parser` has two `extern (D) this(...)` overloads (parse.d:58, :69); per 04 §1A they
   * differ only by the leading `Loc loc` prefix, so they collapse to one TS ctor with an optional
   * leading `loc`. When `loc` is supplied (string-mixin form) it overrides `scanloc` after super().
   */
  constructor(
    loc: Loc | null,
    module_: Module | null,
    input: DString,
    doDocComment: boolean,
    errorSink: ErrorSink,
    compileEnv: CompileEnv | null,
    doUnittests: boolean,
  ) {
    super(
      module_ ? module_.srcfile!.toChars() : null,
      input,
      0,
      input.length,
      doDocComment,
      false,
      errorSink,
      compileEnv,
    );

    this.mod = module_!;
    this.linkage = LINK.d;
    this.doUnittests = doUnittests;

    if (loc) {
      this.scanloc = loc; // string-mixin form: this(loc, ...) { this(...); scanloc = loc; }
    }
  }

  /** Instead of parsing text to get tokens, provide a list of tokens ending with null.
   * Note that the token list will be consumed (added to the tokenFreelist) by the lexer4.
   * Params:
   *    pToken = pointer to first token in list, take ownership of list
   *    linnum = line number to use for the tokens
   *
   * `ref Token* pToken` is a ref-to-pointer: the writeback (`pToken = null`) makes it an out-box
   * (03 §3.2/§7.2). No caller exists in the 1.43 frontend (the entry point is for library users).
   */
  setTokenList(pToken: { value: Token | null }, linnum: number): void {
    // `this.token = *pToken` — a whole-struct overwrite of the inline token slot. Copy the fields
    // INTO the existing object (03 in-place value-overwrite); never rebind the slot, since the
    // lexer's own `scan(this.token)`/`nextToken()` mutate that same object. `.copy()` first so the
    // nested value struct (`loc`) lands as a fresh value, exactly as D's struct assignment gives.
    Object.assign(this.token, pToken.value!.copy());
    pToken.value = null; // take ownership
    this.baseLoc!.startLine = linnum;
    this.linnum = linnum;
  }

  /*
   * Parse a module, i.e. the optional `module x.y.z` declaration and all declarations
   * found in the current file.
   */
  parseModule(): Dsymbols {
    if (!this.parseModuleDeclaration()) return this.errorReturn();

    return this.parseModuleContent();
  }

  /*
   * Parse the optional module declaration
   *
   * Returns: false if a malformed module declaration was found
   */
  parseModuleDeclaration(): boolean {
    const comment = this.token.blockComment;
    const isdeprecated_box = { value: false };
    const msg_box: { value: Expression | null } = { value: null };

    // Parse optional module attributes
    this.parseModuleAttributes(msg_box, isdeprecated_box);
    const isdeprecated = isdeprecated_box.value;
    const msg = msg_box.value;

    // ModuleDeclaration leads off
    if ((this.token.value as TOK) !== TOK.module_) return true;

    const loc = this.token.loc;
    this.nextToken();

    /* parse ModuleFullyQualifiedName
     * https://dlang.org/spec/module.html#ModuleFullyQualifiedName
     */

    if ((this.token.value as TOK) !== TOK.identifier) {
      this.error(ds("identifier expected following `module`"));
      return false;
    }

    const a: Identifier[] = [];
    let id: Identifier = this.token.ident!;

    while (this.nextToken() === TOK.dot) {
      a.push(id);
      this.nextToken();
      if ((this.token.value as TOK) !== TOK.identifier) {
        this.error(ds("identifier expected following `package`"));
        return false;
      }
      id = this.token.ident!;
    }

    this.md = new ModuleDeclaration(loc, a, id, msg, isdeprecated);

    if ((this.token.value as TOK) === TOK.int32Literal) {
      let edition = this.token.intvalue;
      if (edition < BigInt(Edition.v2023) || BigInt(Edition.v2025) < edition) {
        this.error(
          ds("module edition %lld must be in the range %d ... %d"),
          edition,
          Edition.v2023,
          Edition.v2025,
        );
        edition = BigInt(Edition.v2023);
      }
      this.mod.edition = Number(edition) as Edition;
      this.nextToken();
    }

    if ((this.token.value as TOK) !== TOK.semicolon)
      this.error(ds("`;` expected following module declaration instead of `%s`"), this.token.toChars());
    this.nextToken();
    // upcast cascade (02 §11.5): Module.errors (uint) shadows Dsymbol.errors (bool)
    this.addComment(this.mod as unknown as Dsymbol, comment);

    return true;
  }

  /*
   * Parse the content of a module, i.e. all declarations found until the end of file.
   */
  parseModuleContent(): Dsymbols {
    // upcast cascade (02 §11.5): Module.errors (uint) shadows Dsymbol.errors (bool)
    const lastDecl_box: { value: Dsymbol | null } = { value: this.mod as unknown as Dsymbol };
    const decldefs = this.parseDeclDefs(0, lastDecl_box);

    if ((this.token.value as TOK) === TOK.rightCurly) {
      this.error(ds("unmatched closing brace"));
      return this.errorReturn();
    }

    if ((this.token.value as TOK) !== TOK.endOfFile) {
      this.error(ds("unrecognized declaration"));
      return this.errorReturn();
    }
    return decldefs;
  }

  /*
   * Skips to the end of the current declaration - denoted by either `;` or EOF
   */
  private errorReturn(): Dsymbols {
    while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
    this.nextToken();
    return new DArray<Dsymbol | null>();
  }

  /**********************************
   * Parse the ModuleAttributes preceding a module declaration.
   * `out` params msg/isdeprecated modelled as boxes (03 §3.3 / 04 §7).
   */
  private parseModuleAttributes(msg: { value: Expression | null }, isdeprecated: { value: boolean }): void {
    // `out` semantics: reset on entry.
    msg.value = null;
    isdeprecated.value = false;

    const tk_box: { value: Token } = { value: this.token };
    if (!(this.skipAttributes(this.token, tk_box) && tk_box.value.value === TOK.module_)) return; // no module attributes

    let udas: Expressions | null = null;
    while ((this.token.value as TOK) !== TOK.module_) {
      switch ((this.token.value as TOK)) {
        case TOK.deprecated_: {
          // deprecated (...) module ...
          if (isdeprecated.value)
            this.error(ds("there is only one deprecation attribute allowed for module declaration"));
          isdeprecated.value = true;
          this.nextToken();
          if ((this.token.value as TOK) === TOK.leftParenthesis) {
            this.check(TOK.leftParenthesis);
            msg.value = this.parseAssignExp();
            this.check(TOK.rightParenthesis);
          }
          break;
        }
        case TOK.at: {
          const exps_box: { value: Expressions | null } = { value: null };
          const stc = this.parseAttribute(exps_box);
          const exps = exps_box.value;
          if (stc & this.atAttrGroup) {
            this.error(ds("`@%s` attribute for module declaration is not supported"), this.token.toChars());
          } else {
            // resolved: static if (is(typeof(mod.edition))) -> ON (Module has `edition` field).
            if (exps && exps.length > 0) {
              // slot `Expression | null` (08 §3); parse.d:265 calls through it with no null test.
              const id = exps.opIndex(0)!.isIdentifierExp();
              if (id && id.ident === Id.__edition_latest_do_not_use) {
                this.mod.edition = Edition.v2025; // latest edition
                continue;
              }
            }

            udas = UserAttributeDeclaration.concat(udas, exps);
          }
          if (stc) this.nextToken();
          break;
        }
        default: {
          this.error(ds("`module` expected instead of `%s`"), this.token.toChars());
          this.nextToken();
          break;
        }
      }
    }

    if (udas) {
      const a = new DArray<Dsymbol | null>();
      const udad = new UserAttributeDeclaration(udas, a);
      this.mod.userAttribDecl_set(udad);
    }
  }

  // final:

  /**
   * Parses a `deprecated` declaration. `msg` is a `ref` box (04 §7).
   * Returns: Whether the deprecated declaration has a message.
   */
  private parseDeprecatedAttribute(msg: { value: Expression | null }): boolean {
    if (this.peekNext() !== TOK.leftParenthesis) return false;

    this.nextToken();
    this.check(TOK.leftParenthesis);
    const e: Expression = this.parseAssignExp();
    this.check(TOK.rightParenthesis);
    if (msg.value) {
      this.errorLoc(
        this.token.loc,
        ds("conflicting storage class `deprecated(%s)` and `deprecated(%s)`"),
        msg.value.toChars(),
        e.toChars(),
      );
    }
    msg.value = e;
    return true;
  }

  /************************************
   * Parse declarations and definitions.
   * Params:
   *  once = !=0 means parse exactly one decl or def
   *  pLastDecl = box set to last decl or def parsed
   *  pAttrs = keep track of attributes
   */
  parseDeclDefs(
    once: number,
    pLastDecl: { value: Dsymbol | null } | null = null,
    pAttrs: PrefixAttributes | null = null,
  ): Dsymbols {
    const lastDecl_box: { value: Dsymbol | null } = { value: null }; // link unittest to previous declaration
    if (!pLastDecl) pLastDecl = lastDecl_box;

    const linksave = this.linkage; // save global state

    // D `AST.Dsymbols* decldefs = new AST.Dsymbols();` (parse.d) — the container IS a `Dsymbols`,
    // whose slots are `Dsymbol | null` (08 §3); spelling it narrower broke `append(a)` below.
    const decldefs = new DArray<Dsymbol | null>();
    do {
      // parse result
      let s: Dsymbol | null = null;
      let a: Dsymbols | null = null;

      let attrs = new PrefixAttributes();
      if (!once || !pAttrs) {
        pAttrs = attrs;
        pAttrs.comment = this.token.blockComment;
      }
      let prot: Visibility.Kind = Visibility.Kind.undefined;
      let stc: STC = STC.none;
      let condition: Condition | null = null;

      this.linkage = linksave;

      let startloc = new Loc();
      let scdLoc = new Loc();

      Lresult: {
        switch ((this.token.value as TOK)) {
          case TOK.enum_: {
            /* Determine if this is a manifest constant declaration, or a conventional enum. */
            const tv = this.peekNext();
            if (tv === TOK.leftCurly || tv === TOK.colon) s = this.parseEnum();
            else if (tv !== TOK.identifier) {
              a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
              break;
            } else {
              const nextv = this.peekNext2();
              if (nextv === TOK.leftCurly || nextv === TOK.colon || nextv === TOK.semicolon) s = this.parseEnum();
              else {
                a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
                break;
              }
            }
            break;
          }
          case TOK.import_:
            a = this.parseImport();
            // keep pLastDecl
            break;

          case TOK.template_:
            s = this.parseTemplateDeclaration() as Dsymbol | null;
            break;

          case TOK.mixin_: {
            const loc = this.token.loc;
            switch (this.peekNext()) {
              case TOK.leftParenthesis: {
                // MixinType
                if (this.isDeclaration(this.token, NeedDeclaratorId.mustIfDstyle, TOK.reserved, null)) {
                  a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
                  break;
                }
                // mixin(string)
                this.nextToken();
                const exps = this.parseArguments();
                this.check(TOK.semicolon);
                s = new MixinDeclaration(loc, exps);
                break;
              }
              case TOK.template_:
                // mixin template
                this.nextToken();
                s = this.parseTemplateDeclaration(true) as Dsymbol | null;
                break;

              default:
                s = this.parseMixin();
                break;
            }
            break;
          }
          case TOK.wchar_:
          case TOK.dchar_:
          case TOK.bool_:
          case TOK.char_:
          case TOK.int8:
          case TOK.uns8:
          case TOK.int16:
          case TOK.uns16:
          case TOK.int32:
          case TOK.uns32:
          case TOK.int64:
          case TOK.uns64:
          case TOK.int128:
          case TOK.uns128:
          case TOK.float32:
          case TOK.float64:
          case TOK.float80:
          case TOK.imaginary32:
          case TOK.imaginary64:
          case TOK.imaginary80:
          case TOK.complex32:
          case TOK.complex64:
          case TOK.complex80:
          case TOK.void_:
          case TOK.alias_:
          case TOK.identifier:
          case TOK.super_:
          case TOK.typeof_:
          case TOK.dot:
          case TOK.vector:
          case TOK.struct_:
          case TOK.union_:
          case TOK.class_:
          case TOK.interface_:
          case TOK.traits:
            a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
            break;

          case TOK.this_:
            if (this.peekNext() === TOK.dot) {
              a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
              break;
            }
            s = this.parseCtor(pAttrs);
            break;

          case TOK.tilde:
            s = this.parseDtor(pAttrs);
            break;

          case TOK.invariant_: {
            const tv = this.peekNext();
            if (tv === TOK.leftParenthesis || tv === TOK.leftCurly) {
              s = this.parseInvariant(pAttrs);
              break;
            }
            this.error(ds("invariant body expected, not `%s`"), this.token.toChars());
            // goto Lerror
            while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
            this.nextToken();
            s = null;
            continue;
          }

          case TOK.unittest_:
            // The isRoot check is here because it can change after parsing begins (see dmodule.d)
            if (this.doUnittests && this.mod.isRoot()) {
              this.linkage = LINK.d; // unittests have D linkage
              s = this.parseUnitTest(pAttrs);
              if (pLastDecl.value)
                pLastDecl.value.ddocUnittest_set(s as UnitTestDeclaration);
            } else {
              // Skip over unittest block by counting { }
              const loc = this.token.loc;
              let braces = 0;
              let eofLerror = false;
              skip: while (true) {
                this.nextToken();
                switch ((this.token.value as TOK)) {
                  case TOK.leftCurly:
                    ++braces;
                    continue;

                  case TOK.rightCurly:
                    if (--braces) continue;
                    this.nextToken();
                    break;

                  case TOK.endOfFile:
                    /* { */
                    this.errorLoc(loc, ds("closing `}` of unittest not found before end of file"));
                    eofLerror = true;
                    break skip; // goto Lerror

                  default:
                    continue;
                }
                break;
              }
              if (eofLerror) {
                // Lerror
                while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
                this.nextToken();
                s = null;
                continue;
              }
              // Workaround 14894. Add an empty unittest declaration to keep
              // the number of symbols in this scope independent of -unittest.
              s = new UnitTestDeclaration(loc, this.token.loc, STC.none, null);
            }
            break;

          case TOK.new_:
            s = this.parseNewDeclaration(pAttrs);
            break;

          case TOK.colon:
          case TOK.leftCurly:
            this.error(ds("declaration expected, not `%s`"), this.token.toChars());
            // goto Lerror
            while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
            this.nextToken();
            s = null;
            continue;

          case TOK.rightCurly:
          case TOK.endOfFile:
            if (once) this.error(ds("declaration expected, not `%s`"), this.token.toChars());
            this.linkage = linksave;
            return decldefs;

          case TOK.static_: {
            const next = this.peekNext();
            if (next === TOK.this_) s = this.parseStaticCtor(pAttrs);
            else if (next === TOK.tilde) s = this.parseStaticDtor(pAttrs);
            else if (next === TOK.assert_) s = this.parseStaticAssert();
            else if (next === TOK.if_) {
              const loc = this.token.loc;
              condition = this.parseStaticIfCondition();
              let athen: Dsymbols | null;
              if ((this.token.value as TOK) === TOK.colon) athen = this.parseBlock(pLastDecl);
              else {
                const lookingForElseSave = this.lookingForElse;
                this.lookingForElse = this.token.loc;
                athen = this.parseBlock(pLastDecl);
                this.lookingForElse = lookingForElseSave;
              }
              let aelse: Dsymbols | null = null;
              if ((this.token.value as TOK) === TOK.else_) {
                const elseloc = this.token.loc;
                this.nextToken();
                aelse = this.parseBlock(pLastDecl);
                this.checkDanglingElse(elseloc);
              }
              s = new StaticIfDeclaration(loc, condition, athen, aelse);
            } else if (next === TOK.import_) {
              a = this.parseImport();
              // keep pLastDecl
            } else if (next === TOK.foreach_ || next === TOK.foreach_reverse_) {
              s = this.parseForeachStaticDecl(this.token.loc, pLastDecl);
            } else {
              stc = STC.static_;
              const r = this.parseDeclDefs_Lstc(stc, pAttrs, pLastDecl);
              s = r.s;
              a = r.a;
              break;
            }
            break;
          }
          case TOK.const_:
            if (this.peekNext() === TOK.leftParenthesis) {
              a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
              break;
            }
            {
              const r = this.parseDeclDefs_Lstc(STC.const_, pAttrs, pLastDecl);
              s = r.s;
              a = r.a;
            }
            break;

          case TOK.immutable_:
            if (this.peekNext() === TOK.leftParenthesis) {
              a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
              break;
            }
            {
              const r = this.parseDeclDefs_Lstc(STC.immutable_, pAttrs, pLastDecl);
              s = r.s;
              a = r.a;
            }
            break;

          case TOK.shared_: {
            const next = this.peekNext();
            if (next === TOK.leftParenthesis) {
              a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
              break;
            }
            if (next === TOK.static_) {
              const next2 = this.peekNext2();
              if (next2 === TOK.this_) {
                s = this.parseSharedStaticCtor(pAttrs);
                break;
              }
              if (next2 === TOK.tilde) {
                s = this.parseSharedStaticDtor(pAttrs);
                break;
              }
            }
            {
              const r = this.parseDeclDefs_Lstc(STC.shared_, pAttrs, pLastDecl);
              s = r.s;
              a = r.a;
            }
            break;
          }
          case TOK.inout_:
            if (this.peekNext() === TOK.leftParenthesis) {
              a = this.parseDeclarations_Ldeclaration(pAttrs, pLastDecl);
              break;
            }
            {
              const r = this.parseDeclDefs_Lstc(STC.wild, pAttrs, pLastDecl);
              s = r.s;
              a = r.a;
            }
            break;

          case TOK.final_: {
            const r = this.parseDeclDefs_Lstc(STC.final_, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.auto_: {
            let stc2 = STC.auto_;
            if (this.peekNext() === TOK.ref_) stc2 = (stc2 | STC.autoref) as STC;
            const r = this.parseDeclDefs_Lstc(stc2, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.scope_: {
            const r = this.parseDeclDefs_Lstc(STC.scope_, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.override_: {
            const r = this.parseDeclDefs_Lstc(STC.override_, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.abstract_: {
            const r = this.parseDeclDefs_Lstc(STC.abstract_, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.synchronized_: {
            const r = this.parseDeclDefs_Lstc(STC.synchronized_, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.nothrow_: {
            const r = this.parseDeclDefs_Lstc(STC.nothrow_, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.pure_: {
            const r = this.parseDeclDefs_Lstc(STC.pure_, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.ref_: {
            const r = this.parseDeclDefs_Lstc(STC.ref_, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.gshared: {
            const r = this.parseDeclDefs_Lstc(STC.gshared, pAttrs, pLastDecl);
            s = r.s;
            a = r.a;
            break;
          }
          case TOK.at: {
            const exps_box: { value: Expressions | null } = { value: null };
            stc = this.parseAttribute(exps_box);
            if (stc) {
              const r = this.parseDeclDefs_Lstc(stc, pAttrs, pLastDecl);
              s = r.s;
              a = r.a;
              break;
            }
            // no redundant/conflicting check for UDAs
            pAttrs.udas = UserAttributeDeclaration.concat(pAttrs.udas, exps_box.value);
            {
              const r = this.parseDeclDefs_Lautodecl(scdLoc, pAttrs, pLastDecl, false);
              s = r.s;
              a = r.a;
            }
            break;
          }

          case TOK.deprecated_: {
            stc = (stc | STC.deprecated_) as STC;
            const depmsg_box = { value: pAttrs.depmsg };
            if (!this.parseDeprecatedAttribute(depmsg_box)) {
              pAttrs.depmsg = depmsg_box.value;
              const r = this.parseDeclDefs_Lstc(stc, pAttrs, pLastDecl);
              s = r.s;
              a = r.a;
              break;
            }
            pAttrs.depmsg = depmsg_box.value;
            a = this.parseBlock(pLastDecl, pAttrs);
            s = new DeprecatedDeclaration(pAttrs.depmsg, a);
            pAttrs.depmsg = null;
            break;
          }
          case TOK.leftBracket: {
            if (this.peekNext() === TOK.rightBracket) this.error(ds("empty attribute list is not allowed"));
            this.error(ds("use `@(attributes)` instead of `[attributes]`"));
            const exps = this.parseArguments();
            // no redundant/conflicting check for UDAs

            pAttrs.udas = UserAttributeDeclaration.concat(pAttrs.udas, exps);
            a = this.parseBlock(pLastDecl, pAttrs);
            if (pAttrs.udas) {
              s = new UserAttributeDeclaration(pAttrs.udas, a);
              pAttrs.udas = null;
            }
            break;
          }
          case TOK.extern_: {
            if (this.peekNext() !== TOK.leftParenthesis) {
              const r = this.parseDeclDefs_Lstc(STC.extern_, pAttrs, pLastDecl);
              s = r.s;
              a = r.a;
              break;
            }

            const linkLoc = this.token.loc;
            const res = this.parseLinkage();
            if (pAttrs.link !== LINK.default_) {
              if (pAttrs.link !== res.link) {
                this.errorLoc(
                  this.token.loc,
                  ds("conflicting linkage `extern (%s)` and `extern (%s)`"),
                  linkageToChars(pAttrs.link),
                  linkageToChars(res.link),
                );
              } else if (res.idents || res.identExps || res.cppmangle !== CPPMANGLE.def) {
                // Allow chained extern(C++, ...) namespace forms — see parse.d:820.
              } else this.error(ds("redundant linkage `extern (%s)`"), linkageToChars(pAttrs.link));
            }
            pAttrs.link = res.link;
            this.linkage = res.link;
            this.linkLoc = linkLoc;
            a = this.parseBlock(pLastDecl, pAttrs);
            if (res.idents) {
              assert(res.link === LINK.cpp);
              assert(res.idents.length);
              for (let i = res.idents.length; i; ) {
                const id = res.idents.opIndex(--i);
                if (s) {
                  a = new DArray<Dsymbol | null>();
                  a.push(s);
                }
                s = new Nspace(linkLoc, id, null, a);
              }
              pAttrs.link = LINK.default_;
            } else if (res.identExps) {
              assert(res.link === LINK.cpp);
              assert(res.identExps.length);
              for (let i = res.identExps.length; i; ) {
                const exp = res.identExps.opIndex(--i);
                if (s) {
                  a = new DArray<Dsymbol | null>();
                  a.push(s);
                }
                s = new CPPNamespaceDeclaration(linkLoc, exp, a);
              }
              pAttrs.link = LINK.default_;
            } else if (res.cppmangle !== CPPMANGLE.def) {
              assert(res.link === LINK.cpp);
              s = new CPPMangleDeclaration(linkLoc, res.cppmangle, a);
            } else if (pAttrs.link !== LINK.default_) {
              s = new LinkDeclaration(linkLoc, pAttrs.link, a);
              pAttrs.link = LINK.default_;
            }
            break;
          }

          case TOK.private_:
            prot = Visibility.Kind.private_;
            s = this.parseDeclDefs_Lprot(prot, pAttrs, pLastDecl).s;
            break;
          case TOK.package_:
            prot = Visibility.Kind.package_;
            s = this.parseDeclDefs_Lprot(prot, pAttrs, pLastDecl).s;
            break;
          case TOK.protected_:
            prot = Visibility.Kind.protected_;
            s = this.parseDeclDefs_Lprot(prot, pAttrs, pLastDecl).s;
            break;
          case TOK.public_:
            prot = Visibility.Kind.public_;
            s = this.parseDeclDefs_Lprot(prot, pAttrs, pLastDecl).s;
            break;
          case TOK.export_:
            prot = Visibility.Kind.export_;
            s = this.parseDeclDefs_Lprot(prot, pAttrs, pLastDecl).s;
            break;

          case TOK.align_: {
            const attrLoc = this.token.loc;

            const e = this.parseAlign();

            if (pAttrs.setAlignment) {
              if (e) this.error(ds("redundant alignment attribute `align(%s)`"), e.toChars());
              else this.error(ds("redundant alignment attribute `align(default)`"));
            }

            pAttrs.setAlignment = true;
            pAttrs.ealign = e;
            a = this.parseBlock(pLastDecl, pAttrs);
            if (pAttrs.setAlignment) {
              s = new AlignDeclaration(attrLoc, pAttrs.ealign, a);
              pAttrs.setAlignment = false;
              pAttrs.ealign = null;
            }
            break;
          }
          case TOK.pragma_: {
            let args: Expressions | null = null;
            const loc = this.token.loc;

            this.nextToken();
            this.check(TOK.leftParenthesis);
            if ((this.token.value as TOK) !== TOK.identifier) {
              this.error(ds("`pragma(identifier)` expected"));
              // goto Lerror
              while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
              this.nextToken();
              s = null;
              continue;
            }
            const ident = this.token.ident!;
            this.nextToken();
            if ((this.token.value as TOK) === TOK.comma && this.peekNext() !== TOK.rightParenthesis)
              args = this.parseArguments(); // pragma(identifier, args...)
            else this.check(TOK.rightParenthesis); // pragma(identifier)

            let a2: Dsymbols | null = null;
            if ((this.token.value as TOK) === TOK.semicolon) {
              // Accept single semicolon as an empty DeclarationBlock following attribute.
              this.nextToken();
            } else a2 = this.parseBlock(pLastDecl);
            s = new PragmaDeclaration(loc, ident, args, a2);
            break;
          }
          case TOK.debug_:
            startloc = this.token.loc;
            this.nextToken();
            if ((this.token.value as TOK) === TOK.assign) {
              s = this.parseDebugSpecification();
              break;
            }
            condition = this.parseDebugCondition();
            s = this.parseDeclDefs_Lcondition(startloc, condition, pLastDecl);
            break;

          case TOK.version_:
            startloc = this.token.loc;
            this.nextToken();
            if ((this.token.value as TOK) === TOK.assign) {
              s = this.parseVersionSpecification();
              break;
            }
            condition = this.parseVersionCondition();
            s = this.parseDeclDefs_Lcondition(startloc, condition, pLastDecl);
            break;

          case TOK.semicolon:
            // empty declaration
            this.nextToken();
            continue;

          // The following are all errors, the cases are just for better error messages than the default case
          case TOK.return_:
          case TOK.goto_:
          case TOK.break_:
          case TOK.continue_:
            this.error(ds("`%s` statement must be inside function scope"), this.token.toChars());
            // goto Lerror
            while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
            this.nextToken();
            s = null;
            continue;
          case TOK.asm_:
          case TOK.do_:
          case TOK.for_:
          case TOK.foreach_:
          case TOK.foreach_reverse_:
          case TOK.if_:
          case TOK.switch_:
          case TOK.try_:
          case TOK.while_:
            this.error(ds("`%s` statement must be inside function scope"), this.token.toChars());
            if (this.peekNext() === TOK.leftParenthesis || this.peekNext() === TOK.leftCurly) {
              this.parseStatement(0);
              s = null;
              continue;
            }
            // goto Lerror
            while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
            this.nextToken();
            s = null;
            continue;
          default:
            this.error(ds("declaration expected, not `%s`"), this.token.toChars());
            // Lerror
            while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
            this.nextToken();
            s = null;
            continue;
        }
      }

      if (s) {
        if (!s.isAttribDeclaration()) pLastDecl.value = s;
        decldefs.push(s);
        this.addComment(s, pAttrs.comment);
      } else if (a && a.length) {
        decldefs.append(a);
      }
    } while (!once);

    this.linkage = linksave;

    return decldefs;
  }

  /* parseDeclDefs `Ldeclaration:` target (parse.d:446) */
  private parseDeclarations_Ldeclaration(
    pAttrs: PrefixAttributes,
    pLastDecl: { value: Dsymbol | null },
  ): Dsymbols | null {
    const a = this.parseDeclarations(false, pAttrs, pAttrs.comment);
    if (a && a.length) pLastDecl.value = a.opIndex(a.length - 1);
    return a;
  }

  /* parseDeclDefs `Lprot:` target (parse.d:901) */
  private parseDeclDefs_Lprot(
    prot: Visibility.Kind,
    pAttrs: PrefixAttributes,
    pLastDecl: { value: Dsymbol | null },
  ): { s: Dsymbol | null } {
    let s: Dsymbol | null = null;
    if (pAttrs.visibility.kind !== Visibility.Kind.undefined) {
      if (pAttrs.visibility.kind !== prot)
        this.errorLoc(
          this.token.loc,
          ds("conflicting visibility attribute `%s` and `%s`"),
          visibilityToChars(pAttrs.visibility.kind),
          visibilityToChars(prot),
        );
      else this.error(ds("redundant visibility attribute `%s`"), visibilityToChars(prot));
    }
    pAttrs.visibility.kind = prot;
    const attrloc = this.token.loc;

    this.nextToken();

    // optional qualified package identifier to bind visibility to
    let pkg_prot_idents: Identifier[] = [];
    if (pAttrs.visibility.kind === Visibility.Kind.package_ && (this.token.value as TOK) === TOK.leftParenthesis) {
      pkg_prot_idents = this.parseQualifiedIdentifier(ds("protection package"));
      if (pkg_prot_idents.length) this.check(TOK.rightParenthesis);
      else {
        while ((this.token.value as TOK) !== TOK.semicolon && (this.token.value as TOK) !== TOK.endOfFile) this.nextToken();
        this.nextToken();
        return { s: null };
      }
    }

    const a = this.parseBlock(pLastDecl, pAttrs);
    if (pAttrs.visibility.kind !== Visibility.Kind.undefined) {
      if (pAttrs.visibility.kind === Visibility.Kind.package_ && pkg_prot_idents.length)
        // reconciled to faithful surface (W2); sweeps at this file's retranslation:
        // parse.d:951 picks the `Identifier[] pkg_identifiers` overload (attrib.d:340) of the
        // same-arity Form-B ctor pair; attrib.ts exposes that arm as a named factory (04 §1.1(c)).
        s = VisibilityDeclaration.fromPkgIdentifiers(attrloc, pkg_prot_idents, a);
      else s = new VisibilityDeclaration(attrloc, pAttrs.visibility, a);

      pAttrs.visibility = new Visibility(Visibility.Kind.undefined);
    }
    return { s };
  }

  /* parseDeclDefs `Lcondition:` target (parse.d:1028) */
  private parseDeclDefs_Lcondition(
    startloc: Loc,
    condition: Condition | null,
    pLastDecl: { value: Dsymbol | null },
  ): Dsymbol {
    let athen: Dsymbols | null;
    if ((this.token.value as TOK) === TOK.colon) athen = this.parseBlock(pLastDecl);
    else {
      const lookingForElseSave = this.lookingForElse;
      this.lookingForElse = this.token.loc;
      athen = this.parseBlock(pLastDecl);
      this.lookingForElse = lookingForElseSave;
    }
    let aelse: Dsymbols | null = null;
    if ((this.token.value as TOK) === TOK.else_) {
      const elseloc = this.token.loc;
      this.nextToken();
      aelse = this.parseBlock(pLastDecl);
      this.checkDanglingElse(elseloc);
    }
    return new ConditionalDeclaration(startloc, condition!, athen, aelse);
  }

  /* parseDeclDefs `Lstc:` + `Lautodecl:` targets (parse.d:712-774). Returns the storage-class
   * declaration block. */
  private parseDeclDefs_Lstc(
    stc: STC,
    pAttrs: PrefixAttributes,
    pLastDecl: { value: Dsymbol | null },
  ): { s: Dsymbol | null; a: Dsymbols | null } {
    pAttrs.storageClass = this.appendStorageClass(pAttrs.storageClass, stc);
    const scdLoc = this.token.loc;
    this.nextToken();
    return this.parseDeclDefs_Lautodecl(scdLoc, pAttrs, pLastDecl, true);
  }

  private parseDeclDefs_Lautodecl(
    scdLoc: Loc,
    pAttrs: PrefixAttributes,
    pLastDecl: { value: Dsymbol | null },
    _fromLstc: boolean,
  ): { s: Dsymbol | null; a: Dsymbols | null } {
    let s: Dsymbol | null = null;
    let a: Dsymbols | null = null;

    /* Look for auto initializers:
     *      storage_class identifier = initializer;
     *      storage_class identifier(...) = initializer;
     */
    if ((this.token.value as TOK) === TOK.identifier && this.hasOptionalParensThen(this.peek(this.token), TOK.assign)) {
      a = this.parseAutoDeclarations(this.getStorageClass(pAttrs), pAttrs.comment);
      if (a && a.length) pLastDecl.value = a.opIndex(a.length - 1);
      if (pAttrs.udas) {
        s = new UserAttributeDeclaration(pAttrs.udas, a);
        pAttrs.udas = null;
      }
      return { s, a };
    }

    /* Look for return type inference for template functions. */
    const tk_box: { value: Token } = { value: this.token };
    if (
      (this.token.value as TOK) === TOK.identifier &&
      this.skipParens(this.peek(this.token), tk_box) &&
      this.skipAttributes(tk_box.value, tk_box) &&
      (tk_box.value.value === TOK.leftParenthesis ||
        tk_box.value.value === TOK.leftCurly ||
        tk_box.value.value === TOK.in_ ||
        tk_box.value.value === TOK.out_ ||
        tk_box.value.value === TOK.do_ ||
        tk_box.value.value === TOK.goesTo ||
        (tk_box.value.value === TOK.identifier && tk_box.value.ident === Id._body))
    ) {
      if (tk_box.value.value === TOK.identifier && tk_box.value.ident === Id._body) this.usageOfBodyKeyword();

      a = this.parseDeclarations(true, pAttrs, pAttrs.comment);
      if (a && a.length) pLastDecl.value = a.opIndex(a.length - 1);
      if (pAttrs.udas) {
        s = new UserAttributeDeclaration(pAttrs.udas, a);
        pAttrs.udas = null;
      }
      return { s, a };
    }

    a = this.parseBlock(pLastDecl, pAttrs);
    const stc2 = this.getStorageClass(pAttrs);
    if (stc2 !== STC.none) {
      s = new StorageClassDeclaration(stc2, a, scdLoc); // ported: (loc, stc, decl) -> (stc, decl, loc?)
    }
    if (pAttrs.udas) {
      if (s) {
        a = new DArray<Dsymbol | null>();
        a.push(s);
      }
      s = new UserAttributeDeclaration(pAttrs.udas, a);
      pAttrs.udas = null;
    }
    return { s, a };
  }

  /*****************************************
   * Parse auto declarations of the form:
   *   storageClass ident = init, ident = init, ... ;
   */
  private parseAutoDeclarations(storageClass: STC, comment: DString | null): Dsymbols {
    const a = new DArray<Dsymbol | null>();

    while (true) {
      const loc = this.token.loc;
      const ident = this.token.ident!;
      this.nextToken(); // skip over ident

      let tpl: TemplateParameters | null = null;
      if ((this.token.value as TOK) === TOK.leftParenthesis) tpl = this.parseTemplateParameterList();

      this.check(TOK.assign); // skip over '='
      const _init = this.parseInitializer();
      const v = new VarDeclaration(loc, null, ident, _init, storageClass);

      let s: Dsymbol = v;
      if (tpl) {
        const a2 = new DArray<Dsymbol | null>();
        a2.push(v);
        const tempdecl = new TemplateDeclaration(loc, ident, tpl, null, a2, false);
        s = tempdecl;
      }
      a.push(s);
      let cont = false;
      switch ((this.token.value as TOK)) {
        case TOK.semicolon:
          this.nextToken();
          this.addComment(s, comment);
          break;

        case TOK.comma:
          this.nextToken();
          if (!((this.token.value as TOK) === TOK.identifier && this.hasOptionalParensThen(this.peek(this.token), TOK.assign))) {
            this.error(ds("identifier expected following comma"));
            break;
          }
          this.addComment(s, comment);
          cont = true;
          break;

        default:
          this.error(ds("semicolon expected following auto declaration, not `%s`"), this.token.toChars());
          break;
      }
      if (cont) continue;
      break;
    }
    return a;
  }

  /********************************************
   * Parse declarations after an align, visibility, or extern decl.
   */
  private parseBlock(
    pLastDecl: { value: Dsymbol | null },
    pAttrs: PrefixAttributes | null = null,
  ): Dsymbols | null {
    let a: Dsymbols | null = null;

    switch ((this.token.value as TOK)) {
      case TOK.semicolon:
        this.error(ds("declaration expected following attribute, not `;`"));
        this.nextToken();
        break;

      case TOK.endOfFile:
        this.error(ds("declaration expected following attribute, not end of file"));
        break;

      case TOK.leftCurly: {
        const lcLoc = this.token.loc;
        const lookingForElseSave = this.lookingForElse;
        this.lookingForElse = new Loc();

        this.nextToken();
        a = this.parseDeclDefs(0, pLastDecl);
        if ((this.token.value as TOK) !== TOK.rightCurly) {
          /* left curly brace */
          this.error(ds("matching `}` expected, not `%s`"), this.token.toChars());
          this.eSink.errorSupplemental(lcLoc, ds("unmatched `{`"));
        } else this.nextToken();
        this.lookingForElse = lookingForElseSave;
        break;
      }
      case TOK.colon:
        this.nextToken();
        a = this.parseDeclDefs(0, pLastDecl); // grab declarations up to closing curly bracket
        break;

      default:
        a = this.parseDeclDefs(1, pLastDecl, pAttrs);
        break;
    }
    return a;
  }

  /**
   * Provide an error message if `added` contains storage classes which are
   * redundant with those in `orig`; otherwise, return the combination.
   */
  private appendStorageClass(orig: STC, added: STC): STC {
    // checkConflictSTCGroup(at)(group): nested template (parse.d:1234). `at` is a compile-time
    // boolean specialized at the two call sites below.
    const checkConflictSTCGroup = (group: STC, at: boolean): void => {
      if (added & group && orig & group & ((orig & group) - 1n)) {
        this.error(at ? ds("conflicting attribute `@%s`") : ds("conflicting attribute `%s`"), this.token.toChars());
      }
    };

    if (orig & added) {
      const buf = new OutBuffer();
      stcToBuffer(buf, added);
      this.error(ds("redundant attribute `%s`"), buf.peekChars());
      return (orig | added) as STC;
    }

    const Redundant = (STC.const_ | STC.scope_ | STC.ref_) as STC;
    orig = (orig | added) as STC;

    if (orig & STC.in_ && added & Redundant) {
      if (added & STC.const_) this.error(ds("attribute `const` is redundant with previously-applied `in`"));
      else if (this.compileEnv.previewIn) {
        this.error(
          ds("attribute `%s` is redundant with previously-applied `in`"),
          orig & STC.scope_ ? ds("scope") : ds("ref"),
        );
      } else if (added & STC.ref_) {
        // accept using `in ref` for legacy compatibility
      } else {
        this.error(
          ds("attribute `scope` cannot be applied with `in`, use `-%spreview=in` instead"),
          this.compileEnv.switchPrefix,
        );
      }
      return orig;
    }

    if (added & STC.in_ && orig & Redundant) {
      if (orig & STC.const_) this.error(ds("attribute `in` cannot be added after `const`: remove `const`"));
      else if (this.compileEnv.previewIn) {
        // Windows `printf` does not support `%1$s`
        const stc_str = orig & STC.scope_ ? ds("scope") : ds("ref");
        this.errorLoc(this.token.loc, ds("attribute `in` cannot be added after `%s`: remove `%s`"), stc_str, stc_str);
      } else if (orig & STC.ref_) {
        // accept using `in ref` for legacy compatibility
      } else {
        this.error(
          ds("attribute `in` cannot be added after `scope`: remove `scope` and use `-%spreview=in`"),
          this.compileEnv.switchPrefix,
        );
      }
      return orig;
    }

    // resolved: `if (0)` block at parse.d:1296 dropped (dead code, never executed).

    checkConflictSTCGroup((STC.const_ | STC.immutable_ | STC.manifest) as STC, false);
    checkConflictSTCGroup((STC.gshared | STC.shared_) as STC, false);
    checkConflictSTCGroup(STC.safeGroup, true);

    return orig;
  }

  /***********************************************
   * Parse attribute(s), lexer is on '@'. `udas` is a `ref` box (04 §7).
   */
  private parseAttribute(udas: { value: Expressions | null }): STC {
    this.nextToken();
    if ((this.token.value as TOK) === TOK.identifier) {
      // If we find a builtin attribute, we're done, return immediately.
      const stc = Parser.isBuiltinAtAttribute(this.token.ident!);
      if (stc) return stc;

      // Allow identifier, template instantiation, or function call for `@Argument` (single UDA) form.
      let exp: Expression;

      {
        const loc = this.token.loc;
        const id = this.token.ident!;
        this.nextToken();
        if ((this.token.value as TOK) === TOK.not) {
          const tempinst = new TemplateInstance(loc, id, this.parseTemplateArguments());
          exp = new ScopeExp(loc, tempinst as unknown as ScopeDsymbol);
        } else exp = new IdentifierExp(loc, id);
      }

      if ((this.token.value as TOK) === TOK.leftParenthesis) {
        const loc = this.token.loc;
        const args = new DArray<Expression | null>();
        const names = new DArray<ArgumentLabel>();
        this.parseNamedArguments(args, names);
        exp = new CallExp(loc, exp, args, names);
      }

      if (udas.value === null) udas.value = new DArray<Expression | null>();
      udas.value.push(exp);
      return STC.none;
    }

    const templateArgToExp = (o: RootObject, loc: Loc): Expression => {
      switch (o.dyncast()) {
        case DYNCAST.expression:
          return o as unknown as Expression;
        case DYNCAST.type:
          return new TypeExp(loc, o as unknown as Type);
        default:
          return assertUnreachable();
      }
    };

    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      // Multi-UDAs ( `@( ArgumentList )`) form, concatenate with existing
      if (this.peekNext() === TOK.rightParenthesis) this.error(ds("empty attribute list is not allowed"));

      if (udas.value === null) udas.value = new DArray<Expression | null>();
      const args = this.parseTemplateArgumentList();
      // `args` slots are `RootObject | null` (08 §3); parse.d:1408 calls `o.dyncast` inside
      // `templateArgToExp` with no null test -> `!` at the call (02 §10.1 caller rule).
      for (const arg of args) udas.value.push(templateArgToExp(arg!, this.token.loc));
      return STC.none;
    }

    {
      const o = this.parseTemplateSingleArgument();
      if (o) {
        if (udas.value === null) udas.value = new DArray<Expression | null>();
        udas.value.push(templateArgToExp(o, this.token.loc));
        return STC.none;
      }
    }

    if (this.token.isKeyword()) this.error(ds("`%s` is a keyword, not an `@` attribute"), this.token.toChars());
    else this.error(ds("`@identifier` or `@(ArgumentList)` expected, not `@%s`"), this.token.toChars());

    return STC.none;
  }

  /***********************************************
   * Parse const/immutable/shared/inout/nothrow/pure postfix. `pudas` is a box-of-box (04 §7).
   */
  private parsePostfix(storageClass: STC, pudas: { value: Expressions | null } | null): STC {
    const prefix = storageClass;
    while (true) {
      let stc: STC = STC.none;
      switch ((this.token.value as TOK)) {
        case TOK.const_:
          stc = STC.const_;
          break;

        case TOK.immutable_:
          stc = STC.immutable_;
          break;

        case TOK.shared_:
          stc = STC.shared_;
          break;

        case TOK.inout_:
          stc = STC.wild;
          break;

        case TOK.nothrow_:
          stc = STC.nothrow_;
          break;

        case TOK.pure_:
          stc = STC.pure_;
          break;

        case TOK.return_: {
          stc = STC.return_;
          const next = this.peekNext();
          if (next === TOK.scope_) {
            // recognize the `return scope` pair
            stc = (stc | STC.scope_ | STC.returnScope) as STC;
            this.nextToken(); // consume it
          } else if (next === TOK.ref_) {
            // recognize the `return ref` pair
            stc = (stc | STC.ref_ | STC.returnRef) as STC;
            this.nextToken(); // consume it
          } else if (prefix & STC.ref_)
            // member function `ref int fp() return;` -> `int fp() return ref;`
            stc = (stc | STC.returnRef) as STC;
          break;
        }

        case TOK.scope_:
          stc = STC.scope_;
          break;

        case TOK.rvalue:
          stc = STC.rvalue;
          break;

        case TOK.at: {
          const udas_box: { value: Expressions | null } = { value: null };
          stc = this.parseAttribute(udas_box);
          if (udas_box.value) {
            if (pudas) pudas.value = UserAttributeDeclaration.concat(pudas.value, udas_box.value);
            else {
              // Disallow `void function() @uda fp;` / `() @uda { return 1; }`
              this.error(ds("user-defined attributes cannot appear as postfixes"));
            }
            continue;
          }
          break;
        }
        default: {
          const tk_box: { value: Token } = { value: this.token };
          if (
            (this.skipAttributes(this.token, tk_box) && tk_box.value.ptr !== this.token.ptr) ||
            (this.token.value as TOK) === TOK.static_ ||
            (this.token.value as TOK) === TOK.extern_
          ) {
            this.error(ds("`%s` token is not allowed in postfix position"), Token.toCharsValue((this.token.value as TOK)));
            this.nextToken();
            continue;
          }

          /* enforce `return ref`, but not foul things up with an extra `ref` (parse.d:1526). */
          if (!(prefix & STC.ref_) && storageClass & STC.ref_ && storageClass & STC.returnRef)
            storageClass = (storageClass & ~STC.ref_) as STC;

          return storageClass;
        }
      }
      storageClass = this.appendStorageClass(storageClass, stc);
      this.nextToken();
    }
  }

  private parseTypeCtor(): STC {
    let storageClass: STC = STC.none;

    while (true) {
      if (this.peekNext() === TOK.leftParenthesis) return storageClass;

      let stc: STC;
      switch ((this.token.value as TOK)) {
        case TOK.const_:
          stc = STC.const_;
          break;

        case TOK.immutable_:
          stc = STC.immutable_;
          break;

        case TOK.shared_:
          stc = STC.shared_;
          break;

        case TOK.inout_:
          stc = STC.wild;
          break;

        default:
          return storageClass;
      }
      storageClass = this.appendStorageClass(storageClass, stc);
      this.nextToken();
    }
  }

  /**************************************
   * Parse constraint. Constraint is of the form: `if ( ConstraintExpression )`
   */
  private parseConstraint(): Expression | null {
    let e: Expression | null = null;
    if ((this.token.value as TOK) === TOK.if_) {
      this.nextToken(); // skip over 'if'
      this.check(TOK.leftParenthesis);
      e = this.parseExpression();
      this.check(TOK.rightParenthesis);
    }
    return e;
  }

  /**************************************
   * Parse a TemplateDeclaration.
   */
  private parseTemplateDeclaration(ismixin = false): TemplateDeclaration | null {
    let tempdecl: TemplateDeclaration;
    let id: Identifier;
    let tpl: TemplateParameters | null;
    let decldefs: Dsymbols | null;
    let constraint: Expression | null = null;
    const loc = this.token.loc;

    this.nextToken();
    if ((this.token.value as TOK) !== TOK.identifier) {
      this.error(ds("identifier expected following `template`"));
      return null;
    }
    id = this.token.ident!;
    this.nextToken();
    tpl = this.parseTemplateParameterList();
    if (!tpl) return null;

    constraint = this.parseConstraint();

    if ((this.token.value as TOK) !== TOK.leftCurly) {
      this.error(ds("`{` expected after template parameter list, not `%s`"), this.token.toChars()); /* } */
      this.nextToken();
      return null;
    }
    decldefs = this.parseBlock(this.nullDeclBox());

    tempdecl = new TemplateDeclaration(loc, id, tpl, constraint, decldefs, ismixin);
    return tempdecl;
  }

  /* A fresh `AST.Dsymbol* pLastDecl = null` box for calls passing a bare `null` pointer. */
  private nullDeclBox(): { value: Dsymbol | null } {
    return { value: null };
  }

  /******************************************
   * Parse template parameter list.
   * Input: flag 0: parsing "( list )"; 1: parsing non-empty "list )"
   */
  private parseTemplateParameterList(flag = 0): TemplateParameters | null {
    const tpl: TemplateParameters | null = new DArray<TemplateParameter | null>();

    if (!flag && (this.token.value as TOK) !== TOK.leftParenthesis) {
      this.error(ds("parenthesized template parameter list expected following template identifier"));
      return tpl; // Lerr
    }
    this.nextToken();

    // Get array of TemplateParameters
    if (flag || (this.token.value as TOK) !== TOK.rightParenthesis) {
      while ((this.token.value as TOK) !== TOK.rightParenthesis) {
        let tp: TemplateParameter;
        let loc: Loc;
        let tp_ident: Identifier | null = null;
        let tp_spectype: Type | null = null;
        let tp_valtype: Type | null = null;
        let tp_defaulttype: Type | null = null;
        let tp_specvalue: Expression | null = null;
        let tp_defaultvalue: Expression | null = null;

        // First, look ahead to see if it is a TypeParameter or a ValueParameter
        const tv = this.peekNext();
        if ((this.token.value as TOK) === TOK.alias_) {
          // AliasParameter
          this.nextToken();
          loc = this.token.loc; // todo
          let spectype: Type | null = null;
          const ident_box: { value: Identifier | null } = { value: null };
          if (this.isDeclaration(this.token, NeedDeclaratorId.must, TOK.reserved, null)) {
            spectype = this.parseType(ident_box);
            tp_ident = ident_box.value;
          } else {
            if ((this.token.value as TOK) !== TOK.identifier) {
              this.error(ds("identifier expected for template `alias` parameter"));
              return tpl; // Lerr: skips the closing check(TOK.rightParenthesis)
            }
            tp_ident = this.token.ident!;
            this.nextToken();
          }
          let spec: RootObject | null = null;
          if ((this.token.value as TOK) === TOK.colon) {
            // : Type
            this.nextToken();
            if (this.isDeclaration(this.token, NeedDeclaratorId.no, TOK.reserved, null)) spec = this.parseType();
            else spec = this.parseCondExp();
          }
          let def: RootObject | null = null;
          if ((this.token.value as TOK) === TOK.assign) {
            // = Type
            this.nextToken();
            if (this.isDeclaration(this.token, NeedDeclaratorId.no, TOK.reserved, null)) def = this.parseType();
            else def = this.parseCondExp();
          }
          tp = new TemplateAliasParameter(loc, tp_ident, spectype, spec, def);
        } else if (tv === TOK.colon || tv === TOK.assign || tv === TOK.comma || tv === TOK.rightParenthesis) {
          // TypeParameter
          if ((this.token.value as TOK) !== TOK.identifier) {
            this.error(ds("identifier expected for template type parameter"));
            return tpl; // Lerr: skips the closing check(TOK.rightParenthesis)
          }
          loc = this.token.loc;
          tp_ident = this.token.ident!;
          this.nextToken();
          if ((this.token.value as TOK) === TOK.colon) {
            // : Type
            this.nextToken();
            tp_spectype = this.parseType();
          }
          if ((this.token.value as TOK) === TOK.assign) {
            // = Type
            this.nextToken();
            tp_defaulttype = this.parseType();
          }
          tp = new TemplateTypeParameter(loc, tp_ident, tp_spectype, tp_defaulttype);
        } else if ((this.token.value as TOK) === TOK.identifier && tv === TOK.dotDotDot) {
          // ident...
          loc = this.token.loc;
          tp_ident = this.token.ident!;
          this.nextToken();
          this.nextToken();
          tp = new TemplateTupleParameter(loc, tp_ident);
        } else if ((this.token.value as TOK) === TOK.this_) {
          // ThisParameter
          this.nextToken();
          if ((this.token.value as TOK) !== TOK.identifier) {
            this.error(ds("identifier expected for template `this` parameter"));
            return tpl; // Lerr: skips the closing check(TOK.rightParenthesis)
          }
          loc = this.token.loc;
          tp_ident = this.token.ident!;
          this.nextToken();
          if ((this.token.value as TOK) === TOK.colon) {
            // : Type
            this.nextToken();
            tp_spectype = this.parseType();
          }
          if ((this.token.value as TOK) === TOK.assign) {
            // = Type
            this.nextToken();
            tp_defaulttype = this.parseType();
          }
          tp = new TemplateThisParameter(loc, tp_ident, tp_spectype, tp_defaulttype);
        } else {
          // ValueParameter
          loc = this.token.loc; // todo
          const tp_ident_box: { value: Identifier | null } = { value: null };
          tp_valtype = this.parseType(tp_ident_box);
          tp_ident = tp_ident_box.value;
          if (!tp_ident) {
            this.error(ds("identifier expected for template value parameter"));
            tp_ident = Identifier.idPool(ds("error"));
          }
          if ((this.token.value as TOK) === TOK.colon) {
            // : CondExpression
            this.nextToken();
            tp_specvalue = this.parseCondExp();
          }
          if ((this.token.value as TOK) === TOK.assign) {
            // = CondExpression
            this.nextToken();
            tp_defaultvalue = this.parseAssignExp();
          }
          tp = new TemplateValueParameter(loc, tp_ident, tp_valtype, tp_specvalue, tp_defaultvalue);
        }
        tpl.push(tp);
        if ((this.token.value as TOK) !== TOK.comma) break;
        this.nextToken();
      }
    }
    this.check(TOK.rightParenthesis);

    // Lerr:
    return tpl;
  }

  /******************************************
   * Parse template mixin.
   */
  private parseMixin(): Dsymbol {
    let tm: TemplateMixin;
    let id: Identifier = Id.empty!;
    let name: Identifier | null = null;
    let tiargs: Objects | null;

    const locMixin = this.token.loc;
    this.nextToken(); // skip 'mixin'

    // mixin Identifier = MixinTemplateName TemplateArguments;
    if ((this.token.value as TOK) === TOK.identifier && this.peekNext() === TOK.assign) {
      name = this.token.ident!;
      this.nextToken();
      this.nextToken();
    }

    let loc = this.token.loc;
    let tqual: TypeQualified | null = null;
    if ((this.token.value as TOK) === TOK.dot) {
      id = Id.empty!;
    } else {
      if ((this.token.value as TOK) === TOK.typeof_) {
        tqual = this.parseTypeof();
        this.check(TOK.dot);
      }
      if ((this.token.value as TOK) !== TOK.identifier) {
        this.error(ds("identifier expected, not `%s`"), this.token.toChars());
        id = Id.empty!;
      } else id = this.token.ident!;
      this.nextToken();
    }

    while (true) {
      tiargs = null;
      if ((this.token.value as TOK) === TOK.not) {
        tiargs = this.parseTemplateArguments();
      }

      if (tiargs && (this.token.value as TOK) === TOK.dot) {
        const tempinst = new TemplateInstance(loc, id, tiargs);
        if (!tqual) tqual = new TypeInstance(loc, tempinst);
        else tqual.addInst(tempinst);
        tiargs = null;
      } else {
        if (!tqual) tqual = new TypeIdentifier(loc, id);
        else tqual.addIdent(id);
      }

      if ((this.token.value as TOK) !== TOK.dot) break;

      this.nextToken();
      if ((this.token.value as TOK) !== TOK.identifier) {
        this.error(ds("identifier expected following `.` instead of `%s`"), this.token.toChars());
        break;
      }
      loc = this.token.loc;
      id = this.token.ident!;
      this.nextToken();
    }

    // mixin MixinTemplateName TemplateArguments Identifier;
    if (!name && (this.token.value as TOK) === TOK.identifier) {
      name = this.token.ident!;
      this.nextToken();
    }

    tm = new TemplateMixin(locMixin, name, tqual, tiargs);
    if ((this.token.value as TOK) !== TOK.semicolon) this.error(ds("`;` expected after `mixin`"));
    this.nextToken();

    return tm;
  }

  /******************************************
   * Parse template arguments. Input: current token is opening '!'.
   */
  private parseTemplateArguments(): Objects | null {
    let tiargs: Objects | null = null;

    this.nextToken();
    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      // ident!(template_arguments)
      tiargs = this.parseTemplateArgumentList();
    } else {
      // ident!template_argument
      const o = this.parseTemplateSingleArgument();
      if (!o) {
        this.error(ds("template argument expected following `!`"));
      } else {
        tiargs = new DArray<RootObject | null>();
        tiargs.push(o);
      }
    }
    if ((this.token.value as TOK) === TOK.not) {
      let tok = this.peekNext();
      if (tok !== TOK.is_ && tok !== TOK.in_) {
        this.error(ds("multiple ! arguments are not allowed"));
        // Lagain
        do {
          this.nextToken();
          if ((this.token.value as TOK) === TOK.leftParenthesis) this.parseTemplateArgumentList();
          else this.parseTemplateSingleArgument();
        } while ((this.token.value as TOK) === TOK.not && (tok = this.peekNext()) !== TOK.is_ && tok !== TOK.in_);
      }
    }
    return tiargs;
  }

  /******************************************
   * Parse template argument list. Input: current token is opening '(', or ',' for __traits.
   */
  private parseTemplateArgumentList(): Objects {
    const tiargs = new DArray<RootObject | null>();
    const endtok = TOK.rightParenthesis;
    assert((this.token.value as TOK) === TOK.leftParenthesis || (this.token.value as TOK) === TOK.comma);
    this.nextToken();

    // Get TemplateArgumentList
    while ((this.token.value as TOK) !== endtok) {
      tiargs.push(this.parseTypeOrAssignExp());
      if ((this.token.value as TOK) !== TOK.comma) break;
      this.nextToken();
    }
    this.checkFollowing(endtok, ds("template argument list"));
    return tiargs;
  }

  /***************************************
   * Parse a Type or an Expression.
   */
  parseTypeOrAssignExp(endtoken: TOK = TOK.reserved): RootObject {
    return this.isDeclaration(this.token, NeedDeclaratorId.no, endtoken, null)
      ? (this.parseType() as RootObject) // argument is a type
      : (this.parseAssignExp() as RootObject); // argument is an expression
  }

  /*****************************
   * Parse single template argument, to support the syntax: foo!arg
   * Returns: An AST.Type, AST.Expression, or `null` on error
   */
  private parseTemplateSingleArgument(): RootObject | null {
    let ta: Type;
    switch ((this.token.value as TOK)) {
      case TOK.identifier:
        ta = new TypeIdentifier(this.token.loc, this.token.ident!);
        this.nextToken();
        return ta;

      case TOK.vector:
        ta = this.parseVector();
        this.nextToken();
        return ta;

      case TOK.void_:
        ta = Type.tvoid;
        this.nextToken();
        return ta;
      case TOK.int8:
        ta = Type.tint8;
        this.nextToken();
        return ta;
      case TOK.uns8:
        ta = Type.tuns8;
        this.nextToken();
        return ta;
      case TOK.int16:
        ta = Type.tint16;
        this.nextToken();
        return ta;
      case TOK.uns16:
        ta = Type.tuns16;
        this.nextToken();
        return ta;
      case TOK.int32:
        ta = Type.tint32;
        this.nextToken();
        return ta;
      case TOK.uns32:
        ta = Type.tuns32;
        this.nextToken();
        return ta;
      case TOK.int64:
        ta = Type.tint64;
        this.nextToken();
        return ta;
      case TOK.uns64:
        ta = Type.tuns64;
        this.nextToken();
        return ta;
      case TOK.int128:
        ta = Type.tint128;
        this.nextToken();
        return ta;
      case TOK.uns128:
        ta = Type.tuns128;
        this.nextToken();
        return ta;
      case TOK.float32:
        ta = Type.tfloat32;
        this.nextToken();
        return ta;
      case TOK.float64:
        ta = Type.tfloat64;
        this.nextToken();
        return ta;
      case TOK.float80:
        ta = Type.tfloat80;
        this.nextToken();
        return ta;
      case TOK.imaginary32:
        ta = Type.timaginary32;
        this.nextToken();
        return ta;
      case TOK.imaginary64:
        ta = Type.timaginary64;
        this.nextToken();
        return ta;
      case TOK.imaginary80:
        ta = Type.timaginary80;
        this.nextToken();
        return ta;
      case TOK.complex32:
        ta = Type.tcomplex32;
        this.nextToken();
        return ta;
      case TOK.complex64:
        ta = Type.tcomplex64;
        this.nextToken();
        return ta;
      case TOK.complex80:
        ta = Type.tcomplex80;
        this.nextToken();
        return ta;
      case TOK.bool_:
        ta = Type.tbool;
        this.nextToken();
        return ta;
      case TOK.char_:
        ta = Type.tchar;
        this.nextToken();
        return ta;
      case TOK.wchar_:
        ta = Type.twchar;
        this.nextToken();
        return ta;
      case TOK.dchar_:
        ta = Type.tdchar;
        this.nextToken();
        return ta;

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
      case TOK.null_:
      case TOK.true_:
      case TOK.false_:
      case TOK.charLiteral:
      case TOK.wcharLiteral:
      case TOK.dcharLiteral:
      case TOK.string_:
      case TOK.interpolated:
      case TOK.hexadecimalString:
      case TOK.file:
      case TOK.fileFullPath:
      case TOK.line:
      case TOK.moduleString:
      case TOK.functionString:
      case TOK.prettyFunction:
      case TOK.this_: {
        // Template argument is an expression
        return this.parsePrimaryExp();
      }
      default:
        return null;
    }
  }

  /**********************************
   * Parse a static assertion. Current token is 'static'.
   */
  private parseStaticAssert(): StaticAssert {
    const loc = this.token.loc;
    let exp: Expression;
    let msg: Expressions | null = null;

    this.nextToken();
    this.nextToken();
    this.check(TOK.leftParenthesis);
    exp = this.parseAssignExp();
    if ((this.token.value as TOK) === TOK.comma) {
      if (this.peekNext() === TOK.rightParenthesis) {
        this.nextToken(); // consume `,`
        this.nextToken(); // consume `)`
      } else msg = this.parseArguments();
    } else this.check(TOK.rightParenthesis);
    this.checkFollowing(TOK.semicolon, ds("static assert"));
    return new StaticAssert(loc, exp, msg);
  }

  /***********************************
   * Parse typeof(expression). Current token is on the 'typeof'.
   */
  private parseTypeof(): TypeQualified {
    let t: TypeQualified;
    const loc = this.token.loc;

    this.nextToken();
    this.check(TOK.leftParenthesis);
    if ((this.token.value as TOK) === TOK.return_) {
      // typeof(return)
      this.nextToken();
      t = new TypeReturn(loc);
    } else {
      const exp = this.parseExpression(); // typeof(expression)
      t = new TypeTypeof(loc, exp);
    }
    this.check(TOK.rightParenthesis);
    return t;
  }

  /***********************************
   * Parse __vector(type). Current token is on the '__vector'.
   */
  private parseVector(): Type {
    this.nextToken();
    this.check(TOK.leftParenthesis);
    const tb = this.parseType();
    this.check(TOK.rightParenthesis);
    return new TypeVector(tb);
  }

  /***********************************
   * Parse extern (linkage), extern (C++, namespaces), etc. The parser is on the 'extern' token.
   */
  private parseLinkage(): ParsedLinkage {
    const result = new ParsedLinkage();
    this.nextToken();
    assert((this.token.value as TOK) === TOK.leftParenthesis);
    this.nextToken();
    const returnLinkage = (link: LINK): ParsedLinkage => {
      this.check(TOK.rightParenthesis);
      result.link = link;
      return result;
    };
    const invalidLinkage = (): ParsedLinkage => {
      this.error(ds("valid linkage identifiers are `D`, `C`, `C++`, `Objective-C`, `Windows`, `System`"));
      return returnLinkage(LINK.d);
    };

    if ((this.token.value as TOK) !== TOK.identifier) return returnLinkage(LINK.d);

    const id = this.token.ident!;
    this.nextToken();
    if (id === Id.Windows) return returnLinkage(LINK.windows);
    if (id === Id.D) return returnLinkage(LINK.d);
    if (id === Id.System) return returnLinkage(LINK.system);
    if (id === Id.Objective) {
      // Looking for tokens "Objective-C"
      if ((this.token.value as TOK) !== TOK.min) return invalidLinkage();

      this.nextToken();
      if (this.token.ident !== Id.C) return invalidLinkage();

      this.nextToken();
      return returnLinkage(LINK.objc);
    } else if (id !== Id.C) return invalidLinkage();

    if ((this.token.value as TOK) !== TOK.plusPlus) return returnLinkage(LINK.c);

    this.nextToken();
    if ((this.token.value as TOK) !== TOK.comma)
      // , namespaces or class or struct
      return returnLinkage(LINK.cpp);

    this.nextToken();

    if ((this.token.value as TOK) === TOK.rightParenthesis) return returnLinkage(LINK.cpp); // extern(C++,)

    if ((this.token.value as TOK) === TOK.class_ || (this.token.value as TOK) === TOK.struct_) {
      result.cppmangle = (this.token.value as TOK) === TOK.class_ ? CPPMANGLE.asClass : CPPMANGLE.asStruct;
      this.nextToken();
    } else if ((this.token.value as TOK) === TOK.identifier) {
      // named scope namespace
      result.idents = new DArray<Identifier | null>();
      while (true) {
        const idn = this.token.ident!;
        result.idents.push(idn);
        this.nextToken();
        if ((this.token.value as TOK) === TOK.dot) {
          this.nextToken();
          if ((this.token.value as TOK) === TOK.identifier) continue;
          this.error(ds("identifier expected for C++ namespace"));
          result.idents = null; // error occurred, invalidate list of elements.
        }
        break;
      }
    } else {
      // non-scoped StringExp namespace
      result.identExps = new DArray<Expression | null>();
      while (true) {
        result.identExps.push(this.parseCondExp());
        if ((this.token.value as TOK) !== TOK.comma) break;
        this.nextToken();
        // Allow trailing commas as done for argument lists, arrays, ...
        if ((this.token.value as TOK) === TOK.rightParenthesis) break;
      }
    }
    return returnLinkage(LINK.cpp);
  }

  /***********************************
   * Parse ident1.ident2.ident3
   */
  private parseQualifiedIdentifier(entity: DString): Identifier[] {
    const qualified: Identifier[] = [];

    do {
      this.nextToken();
      if ((this.token.value as TOK) !== TOK.identifier) {
        this.errorLoc(
          this.token.loc,
          ds("`%s` expected as dot-separated identifiers, got `%s`"),
          entity,
          this.token.toChars(),
        );
        return qualified;
      }

      const id = this.token.ident!;
      qualified.push(id);

      this.nextToken();
    } while ((this.token.value as TOK) === TOK.dot);

    return qualified;
  }

  private parseDebugSpecification(): DebugSymbol | null {
    let s: DebugSymbol | null;
    this.nextToken();
    if ((this.token.value as TOK) === TOK.identifier) s = new DebugSymbol(this.token.loc, this.token.ident!);
    else {
      this.error(ds("identifier expected, not `%s`"), this.token.toChars());
      s = null;
    }
    this.nextToken();
    if ((this.token.value as TOK) !== TOK.semicolon) this.error(ds("semicolon expected"));
    this.nextToken();
    return s;
  }

  /**************************************
   * Parse a debug conditional
   */
  private parseDebugCondition(): Condition {
    let id: Identifier | null = null;
    let loc = this.token.loc;

    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      this.nextToken();

      if ((this.token.value as TOK) === TOK.identifier) id = this.token.ident!;
      else this.error(ds("identifier expected inside `debug(...)`, not `%s`"), this.token.toChars());
      loc = this.token.loc;
      this.nextToken();
      this.check(TOK.rightParenthesis);
    }
    return new DebugCondition(loc, this.mod, id);
  }

  /**************************************
   * Parse a version specification
   */
  private parseVersionSpecification(): VersionSymbol | null {
    let s: VersionSymbol | null;
    this.nextToken();
    if ((this.token.value as TOK) === TOK.identifier) s = new VersionSymbol(this.token.loc, this.token.ident!);
    else {
      this.error(ds("identifier expected, not `%s`"), this.token.toChars());
      s = null;
    }
    this.nextToken();
    if ((this.token.value as TOK) !== TOK.semicolon) this.error(ds("semicolon expected"));
    this.nextToken();
    return s;
  }

  /**************************************
   * Parse a version conditional
   */
  private parseVersionCondition(): Condition {
    let id: Identifier | null = null;
    let loc = new Loc();

    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      this.nextToken();
      // Allow version (unittest) / version (assert) even though they are keywords
      loc = this.token.loc;
      if ((this.token.value as TOK) === TOK.identifier) id = this.token.ident!;
      else if ((this.token.value as TOK) === TOK.unittest_) id = Identifier.idPool(Token.toStringValue(TOK.unittest_));
      else if ((this.token.value as TOK) === TOK.assert_) id = Identifier.idPool(Token.toStringValue(TOK.assert_));
      else this.error(ds("identifier expected inside `version(...)`, not `%s`"), this.token.toChars());
      this.nextToken();
      this.check(TOK.rightParenthesis);
    } else this.error(ds("(condition) expected following `version`"));
    return new VersionCondition(loc, this.mod, id);
  }

  /***********************************************
   *      static if (expression) body else body
   * Current token is 'static'.
   */
  private parseStaticIfCondition(): Condition {
    let exp: Expression | null;
    let condition: Condition;
    const loc = this.token.loc;

    this.nextToken();
    this.nextToken();
    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      this.nextToken();
      exp = this.parseAssignExp();
      this.check(TOK.rightParenthesis);
    } else {
      this.error(ds("(expression) expected following `static if`"));
      exp = null;
    }
    condition = new StaticIfCondition(loc, exp);
    return condition;
  }

  /*****************************************
   * Parse a constructor definition. Current token is 'this'.
   */
  private parseCtor(pAttrs: PrefixAttributes): Dsymbol {
    const udas_box: { value: Expressions | null } = { value: null };
    const loc = this.token.loc;
    let stc = this.getStorageClass(pAttrs);

    this.nextToken();
    if (
      (this.token.value as TOK) === TOK.leftParenthesis &&
      this.peekNext() === TOK.this_ &&
      this.peekNext2() === TOK.rightParenthesis
    ) {
      // this(this) { ... }
      this.nextToken();
      this.nextToken();
      this.check(TOK.rightParenthesis);

      stc = this.parsePostfix(stc, udas_box);
      if (stc & STC.immutable_)
        this.deprecation(ds("`immutable` postblit is deprecated. Please use an unqualified postblit."));
      if (stc & STC.shared_)
        this.deprecation(ds("`shared` postblit is deprecated. Please use an unqualified postblit."));
      if (stc & STC.const_)
        this.deprecation(ds("`const` postblit is deprecated. Please use an unqualified postblit."));
      if (stc & STC.static_) this.errorLoc(loc, ds("postblit cannot be `static`"));

      const f = new PostBlitDeclaration(loc, Loc.initial, stc, Id.postblit!);
      let s: Dsymbol = this.parseContracts(f);
      if (udas_box.value) {
        const a = new DArray<Dsymbol | null>();
        a.push(f);
        s = new UserAttributeDeclaration(udas_box.value, a);
      }
      return s;
    }

    /* Look ahead to see if `this(...)(...)` which is a constructor template */
    let tpl: TemplateParameters | null = null;
    if ((this.token.value as TOK) === TOK.leftParenthesis && this.peekPastParen(this.token).value === TOK.leftParenthesis) {
      tpl = this.parseTemplateParameterList();
    }

    /* Just a regular constructor */
    const parameterList = this.parseParameterList(null);
    stc = this.parsePostfix(stc, udas_box);

    if (parameterList.varargs !== VarArg.none || Parameter.dim(parameterList.parameters) !== 0) {
      if (stc & STC.static_) this.errorLoc(loc, ds("constructor cannot be static"));
    } else {
      const ss = (stc & (STC.shared_ | STC.static_)) as STC; // this()
      if (ss) {
        if (ss === STC.static_) this.errorLoc(loc, ds("use `static this()` to declare a static constructor"));
        else if (ss === ((STC.shared_ | STC.static_) as STC))
          this.errorLoc(loc, ds("use `shared static this()` to declare a shared static constructor"));
      }
    }

    const constraint = tpl ? this.parseConstraint() : null;

    let tf: Type = new TypeFunction(parameterList, null, this.linkage, stc); // ReturnType -> auto
    tf = addSTC(tf, stc);
    const f = new CtorDeclaration(loc, Loc.initial, stc, tf);
    let s: Dsymbol = this.parseContracts(f, !!tpl);
    if (udas_box.value) {
      const a = new DArray<Dsymbol | null>();
      a.push(f);
      s = new UserAttributeDeclaration(udas_box.value, a);
    }

    if (tpl) {
      // Wrap a template around it
      const decldefs = new DArray<Dsymbol | null>();
      decldefs.push(s);
      s = new TemplateDeclaration(loc, f.ident, tpl, constraint, decldefs);
    }

    return s;
  }

  /*****************************************
   * Parse a destructor definition. Current token is '~'.
   */
  private parseDtor(pAttrs: PrefixAttributes): Dsymbol {
    const udas_box: { value: Expressions | null } = { value: null };
    const loc = this.token.loc;
    let stc = this.getStorageClass(pAttrs);

    this.nextToken();
    this.check(TOK.this_);
    this.check(TOK.leftParenthesis);
    this.check(TOK.rightParenthesis);

    stc = this.parsePostfix(stc, udas_box);
    const ss = (stc & (STC.shared_ | STC.static_)) as STC;
    if (ss) {
      if (ss === STC.static_) this.errorLoc(loc, ds("use `static ~this()` to declare a static destructor"));
      else if (ss === ((STC.shared_ | STC.static_) as STC))
        this.errorLoc(loc, ds("use `shared static ~this()` to declare a shared static destructor"));
    }

    const f = new DtorDeclaration(loc, Loc.initial, stc, Id.dtor!);
    let s: Dsymbol = this.parseContracts(f);
    if (udas_box.value) {
      const a = new DArray<Dsymbol | null>();
      a.push(f);
      s = new UserAttributeDeclaration(udas_box.value, a);
    }
    return s;
  }

  /*****************************************
   * Parse a static constructor definition. Current token is 'static'.
   */
  private parseStaticCtor(pAttrs: PrefixAttributes): Dsymbol {
    const loc = this.token.loc;
    let stc = this.getStorageClass(pAttrs);

    this.nextToken();
    this.nextToken();
    this.check(TOK.leftParenthesis);
    this.check(TOK.rightParenthesis);

    stc = (this.parsePostfix((stc & ~STC.TYPECTOR) as STC, null) | stc) as STC;
    if (stc & STC.shared_) this.errorLoc(loc, ds("use `shared static this()` to declare a shared static constructor"));
    else if (stc & STC.static_) this.appendStorageClass(stc, STC.static_); // complaint for the redundancy
    else {
      const modStc = (stc & STC.TYPECTOR) as STC;
      if (modStc) {
        const buf = new OutBuffer();
        stcToBuffer(buf, modStc);
        this.errorLoc(loc, ds("static constructor cannot be `%s`"), buf.peekChars());
      }
    }
    stc = (stc & ~(STC.static_ | STC.TYPECTOR)) as STC;

    const f = new StaticCtorDeclaration(loc, Loc.initial, stc);
    const s: Dsymbol = this.parseContracts(f);
    return s;
  }

  /*****************************************
   * Parse a static destructor definition. Current token is 'static'.
   */
  private parseStaticDtor(pAttrs: PrefixAttributes): Dsymbol {
    const udas_box: { value: Expressions | null } = { value: null };
    const loc = this.token.loc;
    let stc = this.getStorageClass(pAttrs);

    this.nextToken();
    this.nextToken();
    this.check(TOK.this_);
    this.check(TOK.leftParenthesis);
    this.check(TOK.rightParenthesis);

    stc = (this.parsePostfix((stc & ~STC.TYPECTOR) as STC, udas_box) | stc) as STC;
    if (stc & STC.shared_)
      this.errorLoc(loc, ds("use `shared static ~this()` to declare a shared static destructor"));
    else if (stc & STC.static_) this.appendStorageClass(stc, STC.static_); // complaint for the redundancy
    else {
      const modStc = (stc & STC.TYPECTOR) as STC;
      if (modStc) {
        const buf = new OutBuffer();
        stcToBuffer(buf, modStc);
        this.errorLoc(loc, ds("static destructor cannot be `%s`"), buf.peekChars());
      }
    }
    stc = (stc & ~(STC.static_ | STC.TYPECTOR)) as STC;

    const f = new StaticDtorDeclaration(loc, Loc.initial, stc);
    let s: Dsymbol = this.parseContracts(f);
    if (udas_box.value) {
      const a = new DArray<Dsymbol | null>();
      a.push(f);
      s = new UserAttributeDeclaration(udas_box.value, a);
    }
    return s;
  }

  /*****************************************
   * Parse a shared static constructor definition. Current token is 'shared'.
   */
  private parseSharedStaticCtor(pAttrs: PrefixAttributes): Dsymbol {
    const loc = this.token.loc;
    let stc = this.getStorageClass(pAttrs);

    this.nextToken();
    this.nextToken();
    this.nextToken();
    this.check(TOK.leftParenthesis);
    this.check(TOK.rightParenthesis);

    stc = (this.parsePostfix((stc & ~STC.TYPECTOR) as STC, null) | stc) as STC;
    const ss = (stc & (STC.shared_ | STC.static_)) as STC;
    if (ss) this.appendStorageClass(stc, ss); // complaint for the redundancy
    else {
      const modStc = (stc & STC.TYPECTOR) as STC;
      if (modStc) {
        const buf = new OutBuffer();
        stcToBuffer(buf, modStc);
        this.errorLoc(loc, ds("shared static constructor cannot be `%s`"), buf.peekChars());
      }
    }
    stc = (stc & ~(STC.static_ | STC.TYPECTOR)) as STC;

    const f = new SharedStaticCtorDeclaration(loc, Loc.initial, stc);
    const s: Dsymbol = this.parseContracts(f);
    return s;
  }

  /*****************************************
   * Parse a shared static destructor definition. Current token is 'shared'.
   */
  private parseSharedStaticDtor(pAttrs: PrefixAttributes): Dsymbol {
    const udas_box: { value: Expressions | null } = { value: null };
    const loc = this.token.loc;
    let stc = this.getStorageClass(pAttrs);

    this.nextToken();
    this.nextToken();
    this.nextToken();
    this.check(TOK.this_);
    this.check(TOK.leftParenthesis);
    this.check(TOK.rightParenthesis);

    stc = (this.parsePostfix((stc & ~STC.TYPECTOR) as STC, udas_box) | stc) as STC;
    const ss = (stc & (STC.shared_ | STC.static_)) as STC;
    if (ss) this.appendStorageClass(stc, ss); // complaint for the redundancy
    else {
      const modStc = (stc & STC.TYPECTOR) as STC;
      if (modStc) {
        const buf = new OutBuffer();
        stcToBuffer(buf, modStc);
        this.errorLoc(loc, ds("shared static destructor cannot be `%s`"), buf.peekChars());
      }
    }
    stc = (stc & ~(STC.static_ | STC.TYPECTOR)) as STC;

    const f = new SharedStaticDtorDeclaration(loc, Loc.initial, stc);
    let s: Dsymbol = this.parseContracts(f);
    if (udas_box.value) {
      const a = new DArray<Dsymbol | null>();
      a.push(f);
      s = new UserAttributeDeclaration(udas_box.value, a);
    }
    return s;
  }

  /*****************************************
   * Parse an invariant definition. Current token is 'invariant'.
   */
  private parseInvariant(pAttrs: PrefixAttributes): Dsymbol {
    const loc = this.token.loc;
    const stc = this.getStorageClass(pAttrs);

    this.nextToken();
    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      // optional () or invariant (expression);
      this.nextToken();
      if ((this.token.value as TOK) !== TOK.rightParenthesis) {
        // invariant (expression);
        let e = this.parseAssignExp();
        let msg: Expression | null = null;
        if ((this.token.value as TOK) === TOK.comma) {
          this.nextToken();
          if ((this.token.value as TOK) !== TOK.rightParenthesis) {
            msg = this.parseAssignExp();
            if ((this.token.value as TOK) === TOK.comma) this.nextToken();
          }
        }
        this.check(TOK.rightParenthesis);
        this.checkFollowing(TOK.semicolon, ds("invariant"));
        e = new AssertExp(loc, e, msg);
        const fbody = new ExpStatement(loc, e);
        const f = new InvariantDeclaration(loc, this.token.loc, stc, null, fbody);
        return f;
      }
      this.nextToken();
    }

    const fbody = this.parseStatement(ParseStatementFlags.curly);
    const f = new InvariantDeclaration(loc, this.token.loc, stc, null, fbody);
    return f;
  }

  /*****************************************
   * Parse a unittest definition. Current token is 'unittest'.
   */
  private parseUnitTest(pAttrs: PrefixAttributes): Dsymbol {
    const loc = this.token.loc;
    const stc = this.getStorageClass(pAttrs);

    this.nextToken();

    // `const(char)* begPtr = token.ptr + 1;` (parse.d:2832): a byte offset into the lexer's store, the
    // one `token.ptr` and `endPtr` are views of. `endPtr` is the box parseStatement writes (parse.d:2834).
    const begPtr = this.token.ptr!.byteOffset + 1; // skip left curly brace
    const endPtr: { value: DString | null } = { value: null };
    const sbody = this.parseStatement(ParseStatementFlags.curly, endPtr);

    /** Extract unittest body as a string. Must be done eagerly since memory
     will be released by the lexer before doc gen. */
    let docline: DString | null = null;
    if (this.compileEnv.ddocOutput && endPtr.value !== null && endPtr.value.byteOffset > begPtr) {
      const store = new Uint8Array(endPtr.value.buffer); // the lexer's store, indexed by byte offset
      let end = endPtr.value.byteOffset;
      /* Remove trailing whitespaces */
      for (let p = end - 1; begPtr <= p &&
        (store[p] === 0x20 || store[p] === 0x0d || store[p] === 0x0a || store[p] === 0x09); --p) {
        end = p;
      }

      const len = end - begPtr;
      if (len > 0) {
        const line = new Uint8Array(len + 2); // mem.xmalloc_noscan(len + 2)
        line.set(store.subarray(begPtr, begPtr + len), 0);
        line[len] = 0x0a; // Terminate all lines by LF
        line[len + 1] = 0;
        docline = line.subarray(0, len + 1); // the C string; its NUL stays in the store
      }
    }

    const f = new UnitTestDeclaration(loc, this.token.loc, stc, docline);
    f.fbody = sbody;
    return f;
  }

  /*****************************************
   * Parse a new definition. Current token is 'new'.
   */
  private parseNewDeclaration(pAttrs: PrefixAttributes): Dsymbol {
    const loc = this.token.loc;
    const stc = this.getStorageClass(pAttrs);
    if (!(stc & STC.disable)) {
      this.error(ds("`new` allocator must be annotated with `@disabled`"));
    }
    this.nextToken();
    this.check(TOK.leftParenthesis);
    this.check(TOK.rightParenthesis);
    this.check(TOK.semicolon);
    return new NewDeclaration(loc, stc);
  }

  /**********************************************
   * Parse parameter list. `tpl` is a box-of-box (ptr to TemplateParameters*) or null (04 §7).
   *
   * The D body is a deeply-nested labeled loop (parse.d:2870): an outer `while(1)` per parameter,
   * an inner `for(;1;nextToken())`, an `L3:` re-entry (for `goto L3` after `@uda`), with `goto L1`
   * (next parameter), `break` (done), `goto default`, and `L2:`/`goto L2` (append storage class).
   * Faithfully reproduced with labeled `while`/`for`/`continue`/`break`.
   */
  private parseParameterList(tpl: { value: TemplateParameters | null } | null): ParameterList {
    const parameters = new DArray<Parameter | null>();
    let varargs = VarArg.none;
    let varargsStc: STC = STC.none;
    let hasAutoRefParam = false;

    // Attributes allowed for ...
    const VarArgsStc = (STC.const_ |
      STC.immutable_ |
      STC.shared_ |
      STC.scope_ |
      STC.return_ |
      STC.returnScope |
      STC.returnRef) as STC;

    this.check(TOK.leftParenthesis);
    Outer: while (true) {
      let ai: Identifier | null = null;
      let at: Type | null = null;
      let storageClass: STC = STC.none;
      let stc: STC;
      let ae: Expression | null;
      let udas: Expressions | null = null;
      // for (; 1; nextToken()) — the post-iteration nextToken() runs on `continue InnerFor`.
      let first = true;
      InnerFor: while (true) {
        if (!first) this.nextToken();
        first = false;
        // L3: label — `goto L3` re-runs the switch WITHOUT the trailing nextToken().
        L3: while (true) {
          switch ((this.token.value as TOK)) {
            case TOK.rightParenthesis:
              if (storageClass !== STC.none || udas !== null) this.error(ds("basic type expected, not `)`"));
              break InnerFor;

            case TOK.dotDotDot:
              varargs = VarArg.variadic;
              varargsStc = storageClass;
              if (varargsStc & ~VarArgsStc) {
                const buf = new OutBuffer();
                stcToBuffer(buf, (varargsStc & ~VarArgsStc) as STC);
                this.error(ds("variadic parameter cannot have attributes `%s`"), buf.peekChars());
                varargsStc = (varargsStc & VarArgsStc) as STC;
              }
              this.nextToken();
              break InnerFor;

            case TOK.const_:
              if (this.peekNext() === TOK.leftParenthesis) break; // goto default
              stc = STC.const_;
              storageClass = this.appendStorageClass(storageClass, stc); // L2
              // D `hasAutoRefParam |= <bool>`: the RHS is pure, so the short-circuiting `||=` is
              // equivalent. Repeated at every inlined `goto L2` target below (D has one L2 label).
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.immutable_:
              if (this.peekNext() === TOK.leftParenthesis) break;
              stc = STC.immutable_;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.shared_:
              if (this.peekNext() === TOK.leftParenthesis) break;
              stc = STC.shared_;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.inout_:
              if (this.peekNext() === TOK.leftParenthesis) break;
              stc = STC.wild;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;
            case TOK.at: {
              const exps_box: { value: Expressions | null } = { value: null };
              const stc2 = this.parseAttribute(exps_box);
              if (stc2 & this.atAttrGroup) {
                this.error(ds("`@%s` attribute for function parameter is not supported"), this.token.toChars());
              } else {
                udas = UserAttributeDeclaration.concat(udas, exps_box.value);
              }
              if ((this.token.value as TOK) === TOK.dotDotDot)
                this.error(ds("variadic parameter cannot have user-defined attributes"));
              if (stc2) this.nextToken();
              continue L3; // goto L3 — Don't call nextToken again.
            }
            case TOK.in_:
              if (this.compileEnv.transitionIn) this.eSink.message(this.scanloc, ds("Usage of 'in' on parameter"));
              stc = STC.in_;
              if (this.compileEnv.previewIn) stc = (stc | STC.constscoperef) as STC;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.out_:
              stc = STC.out_;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.ref_:
              stc = STC.ref_;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.lazy_:
              stc = STC.lazy_;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.scope_:
              stc = STC.scope_;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.final_:
              stc = STC.final_;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.auto_:
              stc = STC.auto_;
              if (this.peekNext() === TOK.ref_) stc = (stc | STC.autoref) as STC;
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;

            case TOK.return_: {
              stc = STC.return_;
              const next = this.peekNext();
              if (next === TOK.scope_) {
                // recognize the `return scope` pair
                stc = (stc | STC.scope_ | STC.returnScope) as STC;
                this.nextToken();
              } else if (next === TOK.ref_) {
                // recognize the `return ref` pair
                stc = (stc | STC.ref_ | STC.returnRef) as STC;
                this.nextToken();
              } else if (next === TOK.out_) {
                // recognize the `return out` pair
                stc = (stc | STC.out_ | STC.returnRef) as STC;
                this.nextToken();
              }
              storageClass = this.appendStorageClass(storageClass, stc);
              hasAutoRefParam ||= (storageClass & (STC.auto_ | STC.ref_)) === (STC.auto_ | STC.ref_);
              continue InnerFor;
            }
            default:
              break; // fall through to the `default:` body below (out of the switch + L3 loop)
          }
          // default: body (parse.d:3012-3090)
          {
            const stcx = (storageClass & (STC.in_ | STC.ref_ | STC.out_ | STC.lazy_)) as STC;
            // if stcx is not a power of 2
            if (stcx & (stcx - 1n) && !(stcx === ((STC.in_ | STC.ref_) as STC)))
              this.error(ds("incompatible parameter storage classes"));

            // Deprecated in 2.111
            if (storageClass & STC.auto_ && storageClass & STC.ref_ && !(storageClass & STC.autoref))
              this.deprecation(ds("`auto` and `ref` storage classes should be adjacent"));

            const tv = this.peekNext();
            let loc = new Loc();
            if (
              tpl &&
              (this.token.value as TOK) === TOK.identifier &&
              (tv === TOK.comma || tv === TOK.rightParenthesis || tv === TOK.dotDotDot)
            ) {
              const id = Identifier.generateId(ds("__T"));
              loc = this.token.loc;
              at = new TypeIdentifier(loc, id);
              if (!tpl.value) tpl.value = new DArray<TemplateParameter | null>();
              const tp: TemplateParameter = new TemplateTypeParameter(loc, id, null, null);
              tpl.value.push(tp);

              ai = this.token.ident!;
              this.nextToken();
            } else {
              if (tpl && !tpl.value && hasAutoRefParam) tpl.value = new DArray<TemplateParameter | null>();
              const ai_box: { value: Identifier | null } = { value: null };
              const loc_box: { value: Loc } = { value: loc };
              at = this.parseType(ai_box, loc_box);
              ai = ai_box.value;
              loc = loc_box.value;
            }
            ae = null;
            if ((this.token.value as TOK) === TOK.assign) {
              // = defaultArg
              this.nextToken();
              ae = this.parseAssignExp();
            }
            const param = new Parameter(loc, (storageClass | STC.parameter) as STC, at, ai, ae, null);
            if (udas) {
              const a = new DArray<Dsymbol | null>();
              const udad = new UserAttributeDeclaration(udas, a);
              param.userAttribDecl = udad;
            }
            if ((this.token.value as TOK) === TOK.at) {
              const exps_box: { value: Expressions | null } = { value: null };
              const stc2 = this.parseAttribute(exps_box);
              if (stc2 & this.atAttrGroup) {
                this.error(ds("`@%s` attribute for function parameter is not supported"), this.token.toChars());
              } else {
                this.error(ds("user-defined attributes cannot appear as postfixes"));
              }
              if (stc2) this.nextToken();
            }
            if ((this.token.value as TOK) === TOK.dotDotDot) {
              /* This is: at ai ... */
              if (storageClass & (STC.out_ | STC.ref_)) this.error(ds("variadic argument cannot be `out` or `ref`"));
              varargs = VarArg.typesafe;
              parameters.push(param);
              this.nextToken();
              break InnerFor;
            }
            parameters.push(param);
            if ((this.token.value as TOK) === TOK.comma) {
              this.nextToken();
              continue Outer; // goto L1
            }
            break InnerFor;
          }
        }
      }
      break;
    }
    this.check(TOK.rightParenthesis);
    return new ParameterList(parameters, varargs, varargsStc);
  }

  /*************************************
   */
  private parseEnum(): EnumDeclaration {
    let e: EnumDeclaration;
    let id: Identifier | null;
    let memtype: Type | null;
    let loc = this.token.loc;

    this.nextToken();
    id = null;
    if ((this.token.value as TOK) === TOK.identifier) {
      id = this.token.ident!;
      this.nextToken();
    }

    memtype = null;
    if ((this.token.value as TOK) === TOK.colon) {
      this.nextToken();
      const alt_box = { value: 0 };
      const typeLoc = this.token.loc;
      memtype = this.parseBasicType();
      memtype = this.parseDeclarator(memtype, alt_box, null);
      this.checkCstyleTypeSyntax(typeLoc, memtype, alt_box.value, null);
    }

    e = new EnumDeclaration(loc, id, memtype);
    // opaque type
    if ((this.token.value as TOK) === TOK.semicolon && id) this.nextToken();
    else if ((this.token.value as TOK) === TOK.leftCurly) {
      const isAnonymousEnum = !id;

      e.members = new DArray<Dsymbol | null>();
      this.nextToken();
      let comment = this.token.blockComment;
      while ((this.token.value as TOK) !== TOK.rightCurly) {
        /* Can take: 1. ident   2. ident = value   3. type ident = value, prefixed by attributes */
        loc = this.token.loc;

        let type: Type | null = null;
        let ident: Identifier | null = null;

        const udas_box: { value: Expressions | null } = { value: null };
        let stc: STC = STC.none;
        const deprecationMessage_box: { value: Expression | null } = { value: null };
        const attributeErrorMessage = ds("`%s` is not a valid attribute for enum members");
        // Lattrs:
        Lattrs: while (true) {
          switch ((this.token.value as TOK)) {
            case TOK.at: {
              const _stc = this.parseAttribute(udas_box);
              if (_stc) {
                if (_stc === STC.disable) stc = (stc | _stc) as STC;
                else {
                  const buf = new OutBuffer();
                  stcToBuffer(buf, _stc);
                  this.error(attributeErrorMessage, buf.peekChars());
                }
                this.nextToken();
              }
              break;
            }
            case TOK.deprecated_:
              stc = (stc | STC.deprecated_) as STC;
              if (!this.parseDeprecatedAttribute(deprecationMessage_box)) {
                this.nextToken();
              }
              break;
            default:
              break Lattrs;
          }
        }
        let Ltype = false;
        if ((this.token.value as TOK) === TOK.identifier) {
          const tv = this.peekNext();
          if (tv === TOK.assign || tv === TOK.comma || tv === TOK.rightCurly) {
            ident = this.token.ident!;
            type = null;
            this.nextToken();
          } else {
            if (isAnonymousEnum) Ltype = true;
            else {
              this.nextToken();
              this.error(ds("expected `,` or `=` after identifier, not `%s`"), this.token.toChars());
            }
          }
        } else {
          if (isAnonymousEnum) {
            Ltype = true;
          } else {
            const t_box: { value: Token } = { value: this.token };
            if (this.isBasicType(t_box)) {
              this.error(ds("named enum cannot declare member with type"), t_box.value.toChars());
              this.nextToken();
            } else this.check(TOK.identifier);

            // avoid extra error messages
            const tv = (this.token.value as TOK);
            if (tv !== TOK.assign && tv !== TOK.comma && tv !== TOK.rightCurly && tv !== TOK.endOfFile) continue;
          }
        }
        if (Ltype) {
          // Type identifier
          const ident_box: { value: Identifier | null } = { value: null };
          type = this.parseType(ident_box);
          ident = ident_box.value;
          if (type === Type.terror) {
            type = null;
            this.nextToken();
          } else if (!ident) {
            this.error(ds("no identifier for declarator `%s`"), type.toChars());
            type = null;
          } else {
            const tv = (this.token.value as TOK);
            if (tv !== TOK.assign && tv !== TOK.comma && tv !== TOK.rightCurly) {
              this.error(ds("expected `,` or `=` after identifier, not `%s`"), this.token.toChars());
              this.nextToken();
            }
          }
        }

        let value: Expression | null;
        if ((this.token.value as TOK) === TOK.assign) {
          this.nextToken();
          value = this.parseAssignExp();
        } else {
          value = null;
          if (type && isAnonymousEnum)
            this.error(ds("initializer required after `%s` when type is specified"), ident!.toChars());
        }

        let dd: DeprecatedDeclaration | null = null;
        if (deprecationMessage_box.value) {
          dd = new DeprecatedDeclaration(deprecationMessage_box.value, null);
          stc = (stc | STC.deprecated_) as STC;
        }

        const em = new EnumMember(loc, ident, value, type, stc, null, dd);
        e.members.push(em);

        if (udas_box.value) {
          const uad = new UserAttributeDeclaration(udas_box.value, new DArray<Dsymbol | null>());
          em.userAttribDecl_set(uad);
        }

        if ((this.token.value as TOK) !== TOK.rightCurly) {
          this.addComment(em, comment);
          comment = null;
          this.check(TOK.comma);
        }
        this.addComment(em, comment);
        comment = this.token.blockComment;

        if ((this.token.value as TOK) === TOK.endOfFile) {
          this.error(ds("premature end of file"));
          break;
        }
      }
      this.nextToken();
    } else {
      this.nextToken();
      this.error(ds("expected `{`, not `%s` for enum declaration"), this.token.toChars());
    }
    return e;
  }

  /********************************
   * Parse struct, union, interface, class.
   */
  private parseAggregate(): Dsymbol {
    let tpl: TemplateParameters | null = null;
    let constraint: Expression | null = null;
    const loc = this.token.loc;
    const tok = (this.token.value as TOK);

    this.nextToken();
    let id: Identifier | null;
    if ((this.token.value as TOK) !== TOK.identifier) {
      id = null;
    } else {
      id = this.token.ident!;
      this.nextToken();

      if ((this.token.value as TOK) === TOK.leftParenthesis) {
        // struct/class template declaration.
        tpl = this.parseTemplateParameterList();
        constraint = this.parseConstraint();
      }
    }

    // Collect base class(es)
    let baseclasses: BaseClasses | null = null;
    if ((this.token.value as TOK) === TOK.colon) {
      if (tok !== TOK.interface_ && tok !== TOK.class_)
        this.error(ds("base classes are not allowed for `%s`, did you mean `;`?"), Token.toCharsValue(tok));
      this.nextToken();
      baseclasses = this.parseBaseClasses();
    }

    if ((this.token.value as TOK) === TOK.if_) {
      if (constraint)
        this.error(ds("template constraints appear both before and after BaseClassList, put them before"));
      constraint = this.parseConstraint();
    }
    if (constraint) {
      if (!id) this.error(ds("template constraints not allowed for anonymous `%s`"), Token.toCharsValue(tok));
      if (!tpl) this.error(ds("template constraints only allowed for templates"));
    }

    let members: Dsymbols | null = null;
    if ((this.token.value as TOK) === TOK.leftCurly) {
      const lookingForElseSave = this.lookingForElse;
      this.lookingForElse = new Loc();
      this.nextToken();
      members = this.parseDeclDefs(0);
      this.lookingForElse = lookingForElseSave;
      if ((this.token.value as TOK) !== TOK.rightCurly) {
        /* { */
        this.errorLoc(
          this.token.loc,
          ds("`}` expected following members in `%s` declaration"),
          Token.toCharsValue(tok),
        );
        if (id) this.eSink.errorSupplemental(loc, ds("%s `%s` starts here"), Token.toCharsValue(tok), id.toChars());
        else this.eSink.errorSupplemental(loc, ds("%s starts here"), Token.toCharsValue(tok));
      }
      this.nextToken();
    } else if ((this.token.value as TOK) === TOK.semicolon && id) {
      if (baseclasses || constraint) this.error(ds("members expected"));
      this.nextToken();
    } else {
      this.errorLoc(this.token.loc, ds("{ } expected following `%s` declaration"), Token.toCharsValue(tok));
    }

    let a: AggregateDeclaration;
    switch (tok) {
      case TOK.interface_:
        if (!id) this.errorLoc(loc, ds("anonymous interfaces not allowed"));
        a = new InterfaceDeclaration(loc, id, baseclasses) as unknown as AggregateDeclaration;
        a.members = members;
        break;

      case TOK.class_: {
        if (!id) this.errorLoc(loc, ds("anonymous classes not allowed"));
        const inObject = !!this.md && !this.md.packages.length && this.md.id === Id.object;
        a = new ClassDeclaration(loc, id, baseclasses, members, inObject) as unknown as AggregateDeclaration;
        break;
      }

      case TOK.struct_:
        if (id) {
          const inObject = !!this.md && !this.md.packages.length && this.md.id === Id.object;
          a = new StructDeclaration(loc, id, inObject) as unknown as AggregateDeclaration;
          a.members = members;
        } else {
          /* Anonymous structs/unions are more like attributes. */
          assert(!tpl);
          return new AnonDeclaration(loc, false, members);
        }
        break;

      case TOK.union_:
        if (id) {
          a = new UnionDeclaration(loc, id) as unknown as AggregateDeclaration;
          a.members = members;
        } else {
          /* Anonymous structs/unions are more like attributes. */
          assert(!tpl);
          return new AnonDeclaration(loc, true, members);
        }
        break;

      default:
        return assertUnreachable();
    }

    if (tpl) {
      // Wrap a template around the aggregate declaration
      const decldefs = new DArray<Dsymbol | null>();
      decldefs.push(a as unknown as Dsymbol);
      const tempdecl = new TemplateDeclaration(loc, id, tpl, constraint, decldefs);
      return tempdecl;
    }
    return a as unknown as Dsymbol;
  }

  /*******************************************
   */
  private parseBaseClasses(): BaseClasses {
    const baseclasses = new DArray<BaseClass | null>();

    for (;; this.nextToken()) {
      const b = new BaseClass(this.parseBasicType());
      baseclasses.push(b);
      if ((this.token.value as TOK) !== TOK.comma) break;
    }
    return baseclasses;
  }

  parseImport(): Dsymbols {
    const decldefs = new DArray<Dsymbol | null>();
    let aliasid: Identifier | null = null;

    const isstatic = (this.token.value as TOK) === TOK.static_;
    if (isstatic) this.nextToken();

    do {
      // L1:
      L1: while (true) {
        this.nextToken();
        if ((this.token.value as TOK) !== TOK.identifier) {
          this.error(ds("identifier expected following `import`"));
          return decldefs;
        }

        const loc = this.token.loc;
        let id = this.token.ident!;
        const a: Identifier[] = [];
        this.nextToken();
        if (!aliasid && (this.token.value as TOK) === TOK.assign) {
          aliasid = id;
          continue L1; // goto L1
        }
        while ((this.token.value as TOK) === TOK.dot) {
          a.push(id);
          this.nextToken();
          if ((this.token.value as TOK) !== TOK.identifier) {
            this.error(ds("identifier expected following `package`"));
            break;
          }
          id = this.token.ident!;
          this.nextToken();
        }

        const s = new Import(loc, a, id, aliasid, isstatic ? 1 : 0);
        decldefs.push(s);

        /* Look for : alias=name, alias=name; syntax. */
        if ((this.token.value as TOK) === TOK.colon) {
          do {
            this.nextToken();
            if ((this.token.value as TOK) !== TOK.identifier) {
              this.error(ds("identifier expected following `:`"));
              break;
            }
            let _alias: Identifier | null = this.token.ident!;
            let name: Identifier;
            this.nextToken();
            if ((this.token.value as TOK) === TOK.assign) {
              this.nextToken();
              if ((this.token.value as TOK) !== TOK.identifier) {
                this.error(ds("identifier expected following `%s=`"), _alias.toChars());
                break;
              }
              name = this.token.ident!;
              this.nextToken();
            } else {
              name = _alias;
              _alias = null;
            }
            if (s.isstatic)
              this.errorLoc(loc, ds("static import `%s` cannot have an import bind list"), s.toPrettyChars());
            if (!s.aliasId) s.ident = null; // make it an anonymous import
            s.names.push(name);
            s.aliases.push(_alias as unknown as Identifier); // D import alias may be null
          } while ((this.token.value as TOK) === TOK.comma);
          break; // no comma-separated imports of this form
        }
        aliasid = null;
        break; // exit L1 while, continue outer do-while
      }
    } while ((this.token.value as TOK) === TOK.comma);

    if ((this.token.value as TOK) === TOK.semicolon) this.nextToken();
    else {
      this.error(ds("`;` expected"));
      this.nextToken();
    }

    return decldefs;
  }

  /* Parse a type, seeded with a storage class.
   * `AST.Type parseType(STC stc)` (parse.d:3603) — the D overload set is same-arity/different-type
   * (`parseType(STC)` vs `parseType(Identifier*)`), so it is a Form-B rename (04 §1B); the body is
   * the forward D writes. The bare name stays with the pident form (the most-called one).
   */
  parseTypeFromSTC(stc: STC): Type {
    return this.parseType(null, null, stc);
  }

  /* Parse a type and optional identifier
   * Params:
   *  pident   = set to Identifier if there is one, null if not
   *  pdeclLoc = if !null, then set to location of the declarator
   *  stc      = Storage Class
   *
   * pident/pdeclLoc are out-boxes (04 §7).
   */
  parseType(
    pident: { value: Identifier | null } | null = null,
    pdeclLoc: { value: Loc } | null = null,
    stc: STC = STC.none,
  ): Type {
    /* Take care of the storage class prefixes that serve as type attributes. */
    StcLoop: while (true) {
      switch ((this.token.value as TOK)) {
        case TOK.const_:
          if (this.peekNext() === TOK.leftParenthesis) break StcLoop; // const as type constructor
          stc = (stc | STC.const_) as STC; // const as storage class
          this.nextToken();
          continue;

        case TOK.immutable_:
          if (this.peekNext() === TOK.leftParenthesis) break StcLoop;
          stc = (stc | STC.immutable_) as STC;
          this.nextToken();
          continue;

        case TOK.shared_:
          if (this.peekNext() === TOK.leftParenthesis) break StcLoop;
          stc = (stc | STC.shared_) as STC;
          this.nextToken();
          continue;

        case TOK.inout_:
          if (this.peekNext() === TOK.leftParenthesis) break StcLoop;
          stc = (stc | STC.wild) as STC;
          this.nextToken();
          continue;

        default:
          break StcLoop;
      }
    }

    const typeLoc = this.token.loc;

    let t: Type;
    t = this.parseBasicType();

    if (pdeclLoc) pdeclLoc.value = this.token.loc;
    const alt_box = { value: 0 };
    t = this.parseDeclarator(t, alt_box, pident, null);
    this.checkCstyleTypeSyntax(typeLoc, t, alt_box.value, pident ? pident.value : null);

    t = addSTC(t, stc);    return t;
  }

  private parseBasicType(dontLookDotIdents = false): Type {
    let t: Type;
    let loc: Loc;
    let id: Identifier;
    switch ((this.token.value as TOK)) {
      case TOK.void_:
        t = Type.tvoid;
        this.nextToken();
        break;
      case TOK.int8:
        t = Type.tint8;
        this.nextToken();
        break;
      case TOK.uns8:
        t = Type.tuns8;
        this.nextToken();
        break;
      case TOK.int16:
        t = Type.tint16;
        this.nextToken();
        break;
      case TOK.uns16:
        t = Type.tuns16;
        this.nextToken();
        break;
      case TOK.int32:
        t = Type.tint32;
        this.nextToken();
        break;
      case TOK.uns32:
        t = Type.tuns32;
        this.nextToken();
        break;

      case TOK.int64:
        t = Type.tint64;
        this.nextToken();
        if ((this.token.value as TOK) === TOK.int64) {
          // if `long long`
          this.error(ds("use `long` for a 64 bit integer instead of `long long`"));
          this.nextToken();
        } else if ((this.token.value as TOK) === TOK.float64) {
          // if `long double`
          this.error(ds("use `real` instead of `long double`"));
          t = Type.tfloat80;
          this.nextToken();
        }
        break;

      case TOK.uns64:
        t = Type.tuns64;
        this.nextToken();
        break;
      case TOK.int128:
        t = Type.tint128;
        this.nextToken();
        break;
      case TOK.uns128:
        t = Type.tuns128;
        this.nextToken();
        break;
      case TOK.float32:
        t = Type.tfloat32;
        this.nextToken();
        break;
      case TOK.float64:
        t = Type.tfloat64;
        this.nextToken();
        break;
      case TOK.float80:
        t = Type.tfloat80;
        this.nextToken();
        break;
      case TOK.imaginary32:
        t = Type.timaginary32;
        this.nextToken();
        break;
      case TOK.imaginary64:
        t = Type.timaginary64;
        this.nextToken();
        break;
      case TOK.imaginary80:
        t = Type.timaginary80;
        this.nextToken();
        break;
      case TOK.complex32:
        t = Type.tcomplex32;
        this.nextToken();
        break;
      case TOK.complex64:
        t = Type.tcomplex64;
        this.nextToken();
        break;
      case TOK.complex80:
        t = Type.tcomplex80;
        this.nextToken();
        break;
      case TOK.bool_:
        t = Type.tbool;
        this.nextToken();
        break;
      case TOK.char_:
        t = Type.tchar;
        this.nextToken();
        break;
      case TOK.wchar_:
        t = Type.twchar;
        this.nextToken();
        break;
      case TOK.dchar_:
        t = Type.tdchar;
        this.nextToken();
        break;

      case TOK.this_:
      case TOK.super_:
      case TOK.identifier:
        loc = this.token.loc;
        id = this.token.ident!;
        this.nextToken();
        if ((this.token.value as TOK) === TOK.not) {
          // ident!(template_arguments)
          const tempinst = new TemplateInstance(loc, id, this.parseTemplateArguments());
          t = this.parseBasicTypeStartingAt(new TypeInstance(loc, tempinst), dontLookDotIdents);
        } else {
          t = this.parseBasicTypeStartingAt(new TypeIdentifier(loc, id), dontLookDotIdents);
        }
        break;

      case TOK.mixin_: {
        // https://dlang.org/spec/expression.html#mixin_types
        loc = this.token.loc;
        this.nextToken();
        if ((this.token.value as TOK) !== TOK.leftParenthesis)
          this.errorLoc(
            this.token.loc,
            ds("found `%s` when expecting `%s` following `mixin`"),
            this.token.toChars(),
            Token.toCharsValue(TOK.leftParenthesis),
          );
        const exps = this.parseArguments();
        t = new TypeMixin(loc, exps);
        break;
      }
      case TOK.dot:
        // Leading . as in .foo
        t = this.parseBasicTypeStartingAt(new TypeIdentifier(this.token.loc, Id.empty), dontLookDotIdents);
        break;

      case TOK.typeof_:
        // typeof(expression)
        t = this.parseBasicTypeStartingAt(this.parseTypeof(), dontLookDotIdents);
        break;

      case TOK.vector:
        t = this.parseVector();
        break;

      case TOK.traits: {
        const te = this.parsePrimaryExp() as TraitsExp | null;
        if (te && (te as TraitsExp).ident) {
          t = new TypeTraits(this.token.loc, te as TraitsExp);
          break;
        }
        t = new TypeError();
        break;
      }

      case TOK.const_:
        // const(type)
        this.nextToken();
        this.check(TOK.leftParenthesis);
        t = this.parseTypeFromSTC(STC.const_);
        this.check(TOK.rightParenthesis);
        break;

      case TOK.immutable_:
        // immutable(type)
        this.nextToken();
        this.check(TOK.leftParenthesis);
        t = this.parseTypeFromSTC(STC.immutable_);
        this.check(TOK.rightParenthesis);
        break;

      case TOK.shared_:
        // shared(type)
        this.nextToken();
        this.check(TOK.leftParenthesis);
        t = this.parseTypeFromSTC(STC.shared_);
        this.check(TOK.rightParenthesis);
        break;

      case TOK.inout_:
        // wild(type)
        this.nextToken();
        this.check(TOK.leftParenthesis);
        t = this.parseTypeFromSTC(STC.wild);
        this.check(TOK.rightParenthesis);
        break;

      default:
        this.error(ds("basic type expected, not `%s`"), this.token.toChars());
        if ((this.token.value as TOK) === TOK.else_)
          this.eSink.errorSupplemental(this.token.loc, ds("There's no `static else`, use `else` instead."));
        t = Type.terror;
        break;
    }
    return t;
  }

  private parseBasicTypeStartingAt(tid: TypeQualified, dontLookDotIdents: boolean): Type {
    let maybeArray: Type | null = null;
    while (true) {
      let Lend = false;
      switch ((this.token.value as TOK)) {
        case TOK.dot: {
          this.nextToken();
          if ((this.token.value as TOK) !== TOK.identifier) {
            this.error(ds("identifier expected following `.` instead of `%s`"), this.token.toChars());
            break;
          }
          if (maybeArray) {
            // This is actually a TypeTuple index, not an {a/s}array.
            const dimStack = new DArray<RootObject | null>();
            let t: Type = maybeArray;
            while (true) {
              if (t.ty === Tsarray) {
                const aa = t as TypeSArray;
                dimStack.push(aa.dim!.syntaxCopy());
                t = aa.next!.syntaxCopy();
              } else if (t.ty === Taarray) {
                const aa = t as TypeAArray;
                dimStack.push(aa.index!.syntaxCopy());
                t = aa.next!.syntaxCopy();
              } else {
                break;
              }
            }
            assert(dimStack.length > 0);
            // We're good. Replay indices in the reverse order.
            tid = t as TypeQualified;
            while (dimStack.length) {
              tid.addIndex(dimStack.pop());
            }
            maybeArray = null;
          }
          const loc = this.token.loc;
          const id = this.token.ident!;
          this.nextToken();
          if ((this.token.value as TOK) === TOK.not) {
            const tempinst = new TemplateInstance(loc, id, this.parseTemplateArguments());
            tid.addInst(tempinst);
          } else tid.addIdent(id);
          continue;
        }
        case TOK.leftBracket: {
          if (dontLookDotIdents) {
            // workaround for https://issues.dlang.org/show_bug.cgi?id=14911
            Lend = true;
            break;
          }

          this.nextToken();
          let t: Type = maybeArray ? maybeArray : (tid as Type);
          if ((this.token.value as TOK) === TOK.rightBracket) {
            // It's a dynamic array, and we're done: T[].U does not make sense.
            t = new TypeDArray(t);
            this.nextToken();
            return t;
          } else if (this.isDeclaration(this.token, NeedDeclaratorId.no, TOK.rightBracket, null)) {
            // associative array declaration, T[type] or T[expr] — disambiguated later.
            const index = this.parseType(); // [ type ]
            maybeArray = new TypeAArray(t, index);
            this.check(TOK.rightBracket);
          } else {
            // static array T[expr], slice T[expr..expr], or template-param-pack index T[expr].U
            this.inBrackets++;
            const e = this.parseAssignExp(); // [ expression ]
            if ((this.token.value as TOK) === TOK.slice) {
              // It's a slice, and we're done.
              this.nextToken();
              const e2 = this.parseAssignExp(); // [ exp .. exp ]
              t = new TypeSlice(t, e, e2);
              this.inBrackets--;
              this.check(TOK.rightBracket);
              return t;
            } else {
              maybeArray = new TypeSArray(t, e);
              this.inBrackets--;
              this.check(TOK.rightBracket);
              continue;
            }
          }
          break;
        }
        default:
          Lend = true;
          break;
      }
      if (Lend) break;
    }
    // Lend:
    return maybeArray ? maybeArray : (tid as Type);
  }

  /******************************************
   * Parse suffixes to type t: *, [], [AssignExpression], [Type], delegate/function ...
   */
  private parseTypeSuffixes(t: Type): Type {
    while (true) {
      switch ((this.token.value as TOK)) {
        case TOK.mul:
          t = new TypePointer(t);
          this.nextToken();
          continue;

        case TOK.leftBracket:
          // Handle []. int[3][1] a; is (array[1] of array[3] of int)
          this.nextToken();
          if ((this.token.value as TOK) === TOK.rightBracket) {
            t = new TypeDArray(t); // []
            this.nextToken();
          } else if (this.isDeclaration(this.token, NeedDeclaratorId.no, TOK.rightBracket, null)) {
            // It's an associative array declaration
            const index = this.parseType(); // [ type ]
            t = new TypeAArray(t, index);
            this.check(TOK.rightBracket);
          } else {
            this.inBrackets++;
            const e = this.parseAssignExp(); // [ expression ]
            if (!e) {
              this.inBrackets--;
              this.check(TOK.rightBracket);
              continue;
            }
            if ((this.token.value as TOK) === TOK.slice) {
              this.nextToken();
              const e2 = this.parseAssignExp(); // [ exp .. exp ]
              t = new TypeSlice(t, e, e2);
            } else {
              t = new TypeSArray(t, e);
            }
            this.inBrackets--;
            this.check(TOK.rightBracket);
          }
          continue;

        case TOK.delegate_:
        case TOK.function_: {
          // t delegate(parameter list) nothrow pure / t function(parameter list) nothrow pure
          const save = (this.token.value as TOK);
          this.nextToken();

          const parameterList = this.parseParameterList(null);

          const stc = this.parsePostfix(STC.none, null);
          let tf = new TypeFunction(parameterList, t, this.linkage, stc) as Type;
          if (stc & (STC.const_ | STC.immutable_ | STC.shared_ | STC.wild | STC.return_)) {
            if ((save as TOK) === TOK.function_)
              this.error(
                ds(
                  "`const`/`immutable`/`shared`/`inout`/`return` attributes are only valid for non-static member functions",
                ),
              );
            else tf = addSTC(tf, stc) as TypeFunction;
          }
          t = (save as TOK) === TOK.delegate_ ? new TypeDelegate(tf as TypeFunction) : new TypePointer(tf); // pointer to function
          continue;
        }
        default:
          return t;
      }
    }
  }

  /**********************
   * Parse Declarator. palt is a ref box (int*); pident/tpl/pudas/pdisable are out boxes.
   */
  private parseDeclarator(
    t: Type,
    palt: { value: number },
    pident: { value: Identifier | null } | null,
    tpl: { value: TemplateParameters | null } | null = null,
    storageClass: STC = STC.none,
    pdisable: { value: boolean } | null = null,
    pudas: { value: Expressions | null } | null = null,
  ): Type {
    t = this.parseTypeSuffixes(t);
    let ts: Type;
    switch ((this.token.value as TOK)) {
      case TOK.identifier:
        if (pident) pident.value = this.token.ident!;
        else this.error(ds("unexpected identifier `%s` in declarator"), this.token.ident!.toChars());
        ts = t;
        this.nextToken();
        break;

      case TOK.leftParenthesis: {
        // like: T (*fp)();  /  T ((*fp))();
        if (this.peekNext() === TOK.mul || this.peekNext() === TOK.leftParenthesis) {
          /* Parse things with parentheses around the identifier, like: int (*ident[3])[] */
          palt.value |= 1;
          this.nextToken();
          ts = this.parseDeclarator(t, palt, pident);
          this.check(TOK.rightParenthesis);
          break;
        }
        ts = t;

        const peekt_box: { value: Token } = { value: this.token };
        /* Disallow C-style T (a); Improve error for missing return type. */
        if (this.isParameters(peekt_box)) {
          this.error(ds("function declaration without return type"));
          this.errorSupplemental(ds("Note that constructors are always named `this`"));
        } else this.error(ds("unexpected `(` in declarator"));
        break;
      }
      default:
        ts = t;
        break;
    }

    // parse DeclaratorSuffixes
    DeclLoop: while (true) {
      switch ((this.token.value as TOK)) {
        // resolved: static if (CARRAYDECL) -> ON (CARRAYDECL = 1). C-style array post-[] syntax.
        case TOK.leftBracket: {
          // This is the old C-style post [] syntax.
          let ta: TypeNext;
          this.nextToken();
          if ((this.token.value as TOK) === TOK.rightBracket) {
            // It's a dynamic array
            ta = new TypeDArray(t); // []
            this.nextToken();
            palt.value |= 2;
          } else if (this.isDeclaration(this.token, NeedDeclaratorId.no, TOK.rightBracket, null)) {
            // It's an associative array
            const index = this.parseType(); // [ type ]
            this.check(TOK.rightBracket);
            ta = new TypeAArray(t, index);
            palt.value |= 2;
          } else {
            // It's a static array
            const e = this.parseAssignExp(); // [ expression ]
            ta = new TypeSArray(t, e);
            this.check(TOK.rightBracket);
            palt.value |= 2;
          }

          /* Insert ta into ts -> ... -> t so that ts -> ... -> ta -> t */
          const pt_box = this.insertTypeNext(ts, t, ta);
          ts = pt_box;
          continue;
        }
        case TOK.leftParenthesis: {
          if (tpl) {
            const tk = this.peekPastParen(this.token);
            if (tk.value === TOK.leftParenthesis) {
              /* Look ahead to see if this is (...)(...), i.e. a function template declaration */
              tpl.value = this.parseTemplateParameterList();
            } else if (tk.value === TOK.assign) {
              /* or (...) =, i.e. a variable template declaration */
              tpl.value = this.parseTemplateParameterList();
              break DeclLoop;
            }
          }

          const parameterList = this.parseParameterList(null);

          /* Parse const/immutable/shared/inout/nothrow/pure/return postfix; merge prefix stc. */
          const stc = this.parsePostfix(storageClass, pudas);

          let tf = new TypeFunction(parameterList, t, this.linkage, stc) as Type;
          tf = addSTC(tf, stc);          if (pdisable) pdisable.value = stc & STC.disable ? true : false;

          /* Insert tf into ts -> ... -> t so that ts -> ... -> tf -> t */
          ts = this.insertTypeNext(ts, t, tf);
          break DeclLoop;
        }
        default:
          break DeclLoop;
      }
    }
    return ts;
  }

  /* The `for (pt = &ts; *pt != t; pt = &(cast(TypeNext)*pt).next) {} *pt = ta;` linked-list
   * splice (parse.d:4220-4224, :4271-4275). Walks the `next` chain from `ts` down to `t`, and
   * replaces the slot holding `t` with `repl`. Returns the (possibly new) head `ts`. */
  private insertTypeNext(ts: Type, t: Type, repl: Type): Type {
    if (ts === t) return repl;
    let cur: Type = ts;
    while ((cur as TypeNext).next !== t) {
      cur = (cur as TypeNext).next!;
    }
    (cur as TypeNext).next = repl;
    return ts;
  }

  private parseStorageClasses(
    storage_class: { value: STC },
    link: { value: LINK },
    setAlignment: { value: boolean },
    ealign: { value: Expression | null },
    udas: { value: Expressions | null },
    linkloc: { value: Loc },
  ): void {
    let stc: STC;
    let sawLinkage = false; // seen a linkage declaration

    linkloc.value = Loc.initial; // out param

    Outer: while (true) {
      switch ((this.token.value as TOK)) {
        case TOK.const_:
          if (this.peekNext() === TOK.leftParenthesis) break Outer; // const as type constructor
          stc = STC.const_; // const as storage class
          storage_class.value = this.appendStorageClass(storage_class.value, stc); // L1
          this.nextToken();
          continue;

        case TOK.immutable_:
          if (this.peekNext() === TOK.leftParenthesis) break Outer;
          stc = STC.immutable_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.shared_:
          if (this.peekNext() === TOK.leftParenthesis) break Outer;
          stc = STC.shared_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.inout_:
          if (this.peekNext() === TOK.leftParenthesis) break Outer;
          stc = STC.wild;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.static_:
          stc = STC.static_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.final_:
          stc = STC.final_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.auto_:
          stc = STC.auto_;
          if (this.peekNext() === TOK.ref_) stc = (stc | STC.autoref) as STC;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.scope_:
          stc = STC.scope_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.override_:
          stc = STC.override_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.abstract_:
          stc = STC.abstract_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.synchronized_:
          stc = STC.synchronized_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.deprecated_:
          stc = STC.deprecated_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.nothrow_:
          stc = STC.nothrow_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.pure_:
          stc = STC.pure_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.ref_:
          stc = STC.ref_;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.gshared:
          stc = STC.gshared;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;

        case TOK.enum_: {
          const tv = this.peekNext();
          if (tv === TOK.leftCurly || tv === TOK.colon) break Outer;
          if (tv === TOK.identifier) {
            const nextv = this.peekNext2();
            if (nextv === TOK.leftCurly || nextv === TOK.colon || nextv === TOK.semicolon) break Outer;
          }
          stc = STC.manifest;
          storage_class.value = this.appendStorageClass(storage_class.value, stc);
          this.nextToken();
          continue;
        }

        case TOK.at: {
          stc = this.parseAttribute(udas);
          if (stc) {
            storage_class.value = this.appendStorageClass(storage_class.value, stc);
            this.nextToken();
            continue;
          }
          continue;
        }

        case TOK.extern_: {
          if (this.peekNext() !== TOK.leftParenthesis) {
            stc = STC.extern_;
            storage_class.value = this.appendStorageClass(storage_class.value, stc);
            this.nextToken();
            continue;
          }

          if (sawLinkage) this.error(ds("redundant linkage declaration"));
          sawLinkage = true;
          linkloc.value = this.token.loc;
          const res = this.parseLinkage();
          link.value = res.link;
          if (res.idents || res.identExps) {
            this.error(ds("C++ name spaces not allowed here"));
          }
          if (res.cppmangle !== CPPMANGLE.def) {
            this.error(ds("C++ mangle declaration not allowed here"));
          }
          continue;
        }
        case TOK.align_: {
          setAlignment.value = true;
          ealign.value = this.parseAlign();
          continue;
        }
        default:
          break Outer;
      }
    }
  }

  /**
   * Parse `align` or `align(n)`. Returns expression `n` if present, else `null`.
   */
  private parseAlign(): Expression | null {
    assert((this.token.value as TOK) === TOK.align_);
    let e: Expression | null = null;
    this.nextToken();
    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      this.nextToken();
      if ((this.token.value as TOK) === TOK.default_) this.nextToken();
      else e = this.parseAssignExp();
      this.check(TOK.rightParenthesis);
    }
    return e;
  }

  /**********************************
   * Parse Declarations. These can be: 1. global/class level; 2. statement level.
   */
  private parseDeclarations(autodecl: boolean, pAttrs: PrefixAttributes | null, comment: DString | null): Dsymbols {
    let storage_class: STC = STC.none;
    let link: LINK = this.linkage;
    let linkloc: Loc = this.linkLoc;
    let setAlignment = false;
    let ealign: Expression | null = null;
    let udas: Expressions | null = null;

    if (!comment) comment = this.token.blockComment;

    /* Look for AliasReassignment */
    if ((this.token.value as TOK) === TOK.identifier && this.peekNext() === TOK.assign)
      return this.parseAliasReassignment(comment);

    /* Declarations that start with `alias` */
    let isAliasDeclaration = false;
    const aliasLoc = this.token.loc;
    if ((this.token.value as TOK) === TOK.alias_) {
      const a = this.parseAliasDeclarations(comment);
      if (a) return a;
      /* Handle these later: alias StorageClasses type ident; */
      isAliasDeclaration = true;
    }

    const typeLoc = this.token.loc;
    let ts: Type | null = null;

    if (!autodecl) {
      const sc_box = { value: storage_class };
      const link_box = { value: link };
      const setAlign_box: { value: boolean } = { value: setAlignment };
      const ealign_box: { value: Expression | null } = { value: ealign };
      const udas_box: { value: Expressions | null } = { value: udas };
      const linkloc_box = { value: linkloc };
      this.parseStorageClasses(sc_box, link_box, setAlign_box, ealign_box, udas_box, linkloc_box);
      storage_class = sc_box.value;
      link = link_box.value;
      setAlignment = setAlign_box.value;
      ealign = ealign_box.value;
      udas = udas_box.value;
      linkloc = linkloc_box.value;

      if ((this.token.value as TOK) === TOK.enum_) {
        let d: Dsymbol = this.parseEnum();
        let a = new DArray<Dsymbol | null>();
        a.push(d);

        if (udas) {
          d = new UserAttributeDeclaration(udas, a);
          a = new DArray<Dsymbol | null>();
          a.push(d);
        }

        this.addComment(d, comment);
        return a;
      }
      if (
        (this.token.value as TOK) === TOK.struct_ ||
        (this.token.value as TOK) === TOK.union_ ||
        (this.token.value as TOK) === TOK.class_ ||
        (this.token.value as TOK) === TOK.interface_
      ) {
        let s: Dsymbol = this.parseAggregate();
        let a = new DArray<Dsymbol | null>();
        a.push(s);

        if (storage_class) {
          s = new StorageClassDeclaration(storage_class, a);
          a = new DArray<Dsymbol | null>();
          a.push(s);
        }
        if (setAlignment) {
          s = new AlignDeclaration(s.loc, ealign, a);
          a = new DArray<Dsymbol | null>();
          a.push(s);
        }
        if (link !== this.linkage) {
          s = new LinkDeclaration(linkloc, link, a);
          a = new DArray<Dsymbol | null>();
          a.push(s);
        }
        if (udas) {
          s = new UserAttributeDeclaration(udas, a);
          a = new DArray<Dsymbol | null>();
          a.push(s);
        }

        this.addComment(s, comment);
        return a;
      }

      /* Look for auto initializers */
      if (
        (storage_class || udas) &&
        (this.token.value as TOK) === TOK.identifier &&
        this.hasOptionalParensThen(this.peek(this.token), TOK.assign)
      ) {
        let a: Dsymbols | null = this.parseAutoDeclarations(storage_class, comment);
        if (udas) {
          const s = new UserAttributeDeclaration(udas, a);
          a = new DArray<Dsymbol | null>();
          a.push(s);
        }
        return a;
      }

      /* Look for return type inference for template functions. */
      {
        const tk_box: { value: Token } = { value: this.token };
        if (
          (storage_class || udas) &&
          (this.token.value as TOK) === TOK.identifier &&
          this.skipParens(this.peek(this.token), tk_box) &&
          this.skipAttributes(tk_box.value, tk_box) &&
          (tk_box.value.value === TOK.leftParenthesis ||
            tk_box.value.value === TOK.leftCurly ||
            tk_box.value.value === TOK.in_ ||
            tk_box.value.value === TOK.out_ ||
            tk_box.value.value === TOK.goesTo ||
            tk_box.value.value === TOK.do_ ||
            (tk_box.value.value === TOK.identifier && tk_box.value.ident === Id._body))
        ) {
          if (tk_box.value.value === TOK.identifier && tk_box.value.ident === Id._body) this.usageOfBodyKeyword();

          ts = null;
        } else {
          ts = this.parseBasicType();
          ts = this.parseTypeSuffixes(ts);
        }
      }
    }

    if (pAttrs) {
      storage_class = (storage_class | pAttrs.storageClass) as STC;
    }

    let tfirst: Type | null = null;
    const a = new DArray<Dsymbol | null>();

    Outer: while (true) {
      const tpl_box: { value: TemplateParameters | null } = { value: null };
      const disable_box = { value: false };
      const alt_box = { value: 0 };

      const loc = this.token.loc;
      const ident_box: { value: Identifier | null } = { value: null };
      const udas_box2: { value: Expressions | null } = { value: udas };
      const t = this.parseDeclarator(ts!, alt_box, ident_box, tpl_box, storage_class, disable_box, udas_box2);
      udas = udas_box2.value;
      let ident = ident_box.value;
      const tpl = tpl_box.value;
      const disable = disable_box.value;
      assert(t);
      if (!tfirst) tfirst = t;
      else if (t !== tfirst)
        this.errorLoc(
          this.token.loc,
          ds("multiple declarations must have the same type, not `%s` and `%s`"),
          tfirst.toChars(),
          t.toChars(),
        );

      if ((this.token.value as TOK) === TOK.colon && !ident && t.ty !== Tfunction) {
        // Unnamed bit field
        ident = Identifier.generateAnonymousId(ds("BitField"));
      }

      const isThis =
        t.ty === Tident && (t as TypeIdentifier).ident === Id.This && (this.token.value as TOK) === TOK.assign;
      if (ident) this.checkCstyleTypeSyntax(loc, t, alt_box.value, ident);
      else if (!isThis && t !== Type.terror) this.noIdentifierForDeclarator(t, this.token);

      if (isAliasDeclaration) {
        if (ident && this.mod.edition >= Edition.v2024) {
          this.eSink.error(
            this.token.loc,
            ds("use `alias %s = ...;` syntax instead of `alias ... %s;`"),
            ident.toChars(),
            ident.toChars(),
          );
        }
        /* Aliases can no longer have multiple declarators, storage classes, linkages, or auto
         * declarations. These never made any sense, anyway. But allow enums, since they allow
         * multiple declarators.
         */
        if (udas) this.error(ds("user-defined attributes not allowed for `alias` declarations"));

        let _init: Initializer | null = null;
        if ((this.token.value as TOK) === TOK.assign) {
          this.nextToken();
          _init = this.parseInitializer();
        }
        if (_init) {
          this.error(ds("alias cannot have initializer"));
        }
        // reconciled to faithful surface (W2); sweeps at this file's retranslation:
        // D overload set AliasDeclaration(Loc,Identifier,Type) -> Form-B factory (04 §1.1(c)).
        const v: Declaration = AliasDeclaration.fromType(aliasLoc, ident!, t);

        v.storage_class = storage_class;
        if (pAttrs) {
          /* AliasDeclaration distinguishes @safe/@system/@trusted on prefix and postfix. */
          pAttrs.storageClass = (pAttrs.storageClass & STC.safeGroup) as STC;
        }
        let s: Dsymbol = v;

        if (link !== this.linkage) {
          const ax = new DArray<Dsymbol | null>();
          ax.push(v);
          s = new LinkDeclaration(linkloc, link, ax);
        }
        a.push(s);
        switch ((this.token.value as TOK)) {
          case TOK.semicolon:
            this.nextToken();
            this.addComment(s, comment);
            break;

          case TOK.comma:
            this.nextToken();
            this.addComment(s, comment);
            continue Outer;

          default:
            this.error(ds("semicolon expected to close `alias` declaration, not `%s`"), this.token.toChars());
            this.nextToken();
            break;
        }
      } else if (t.ty === Tfunction) {
        /* @@@DEPRECATED_2.115@@@ change to error, deprecated in 2.105.1 */
        if (storage_class & STC.manifest) this.deprecation(ds("function cannot have enum storage class"));

        let constraint: Expression | null = null;
        const f = new FuncDeclaration(
          loc,
          Loc.initial,
          ident,
          (storage_class | (disable ? STC.disable : STC.none)) as STC,
          t,
        );
        if (pAttrs) pAttrs.storageClass = STC.none;
        if (tpl) constraint = this.parseConstraint();
        let s: Dsymbol = this.parseContracts(f, !!tpl);
        const tplIdent = s.ident;

        if (link !== this.linkage) {
          const ax = new DArray<Dsymbol | null>();
          ax.push(s);
          s = new LinkDeclaration(linkloc, link, ax);
        }
        if (udas) {
          const ax = new DArray<Dsymbol | null>();
          ax.push(s);
          s = new UserAttributeDeclaration(udas, ax);
        }

        /* A template parameter list means it's a function template */
        if (tpl) {
          // @@@DEPRECATED_2.114@@@ Both deprecated in 2.104, change to error
          if (storage_class & STC.override_)
            this.deprecationLoc(loc, ds("a function template is not virtual so cannot be marked `override`"));
          else if (storage_class & STC.abstract_)
            this.deprecationLoc(loc, ds("a function template is not virtual so cannot be marked `abstract`"));

          // Wrap a template around the function declaration
          const decldefs = new DArray<Dsymbol | null>();
          decldefs.push(s);
          const tempdecl = new TemplateDeclaration(loc, tplIdent, tpl, constraint, decldefs);
          s = tempdecl;

          let stc2: STC = STC.none;
          if (storage_class & STC.static_) {
            assert(f.storage_class & STC.static_);
            f.storage_class = (f.storage_class & ~STC.static_) as STC;
            stc2 = (stc2 | STC.static_) as STC;
          }
          if (storage_class & STC.deprecated_) {
            assert(f.storage_class & STC.deprecated_);
            f.storage_class = (f.storage_class & ~STC.deprecated_) as STC;
            stc2 = (stc2 | STC.deprecated_) as STC;
          }
          if (stc2 !== STC.none) {
            const ax = new DArray<Dsymbol | null>();
            ax.push(s);
            s = new StorageClassDeclaration(stc2, ax);
          }
        }
        a.push(s);
        this.addComment(s, comment);
      } else if (ident) {
        let width: Expression | null = null;
        if ((this.token.value as TOK) === TOK.colon) {
          this.nextToken();
          width = this.parseCondExp();
        }

        let _init: Initializer | null = null;
        if ((this.token.value as TOK) === TOK.assign) {
          this.nextToken();
          _init = this.parseInitializer();
        }

        let s: Dsymbol;
        if (width) {
          if (storage_class) this.error(ds("storage class not allowed for bitfield declaration"));
          const bf = new BitFieldDeclaration(ident.isAnonymous() ? typeLoc : loc, t, ident, width);
          // dependency signature (11 §1): 1.43 passes `_init` as the ctor's 5th argument
          // (declaration.d:678 `this(loc, type, ident, width, Initializer _init = null)`), which
          // forwards it to `super(loc, type, ident, _init)`; declaration.ts still carries the 1.42
          // 4-param ctor (which forwards `null`) and is not this agent's file (14 §3). Closest
          // expressible form: construct, then store. NOT fully equivalent — the VarDeclaration ctor
          // also runs `assert(type || _init)` (declaration.d:508, ported at declaration.ts:396), so
          // if `t` can ever be null on this path, 1.43 accepts `int : 3 = 5`-shaped input while this
          // form asserts. Whether parseDeclarations can deliver a null `t` here is NOT verified.
          // Delete both lines and pass `_init` when the ported ctor gains the parameter.
          bf._init = _init;
          s = bf;
        } else {
          const v = new VarDeclaration(loc, t, ident, _init);
          v.storage_class = storage_class;
          if (pAttrs) pAttrs.storageClass = STC.none;
          s = v;
        }

        if (tpl && _init) {
          const a2 = new DArray<Dsymbol | null>();
          a2.push(s);
          const tempdecl = new TemplateDeclaration(loc, ident, tpl, null, a2, false);
          s = tempdecl;
        }
        if (setAlignment) {
          const ax = new DArray<Dsymbol | null>();
          ax.push(s);
          s = new AlignDeclaration(s.loc, ealign, ax);
        }
        if (link !== this.linkage) {
          const ax = new DArray<Dsymbol | null>();
          ax.push(s);
          s = new LinkDeclaration(linkloc, link, ax);
        }
        if (udas) {
          const ax = new DArray<Dsymbol | null>();
          ax.push(s);
          s = new UserAttributeDeclaration(udas, ax);
        }
        a.push(s);
        switch ((this.token.value as TOK)) {
          case TOK.semicolon:
            this.nextToken();
            this.addComment(s, comment);
            break;

          case TOK.comma:
            this.nextToken();
            this.addComment(s, comment);
            continue Outer;

          default:
            if (loc.linnum() !== this.token.loc.linnum()) {   // Loc.linnum is a method, not a field
              this.errorLoc(
                this.token.loc,
                ds("semicolon needed to end declaration of `%s`, instead of `%s`"),
                s.toChars(),
                this.token.toChars(),
              );
              this.eSink.errorSupplemental(loc, ds("`%s` declared here"), s.toChars());
            } else {
              this.errorLoc(
                this.token.loc,
                ds("semicolon needed to end declaration of `%s` instead of `%s`"),
                s.toChars(),
                this.token.toChars(),
              );
            }
            break;
        }
      }
      break;
    }
    return a;
  }

  /// Report an error that a declaration of type `t` is missing an identifier and got `tok` instead.
  private noIdentifierForDeclarator(t: Type, tok: Token): void {
    this.error(ds("variable name expected after type `%s`, not `%s`"), t.toChars(), tok.toChars());

    // A common mistake is to use a reserved keyword as an identifier, e.g. `in` or `out`
    if (this.token.isKeyword()) {
      this.eSink.errorSupplemental(
        this.token.loc,
        ds("`%s` is a keyword, perhaps append `_` to make it an identifier"),
        this.token.toChars(),
      );
      this.nextToken();
    }
  }

  /********************************
   * Parse AliasReassignment: identifier = type;
   */
  private parseAliasReassignment(comment: DString | null): Dsymbols {
    const loc = this.token.loc;
    const ident = this.token.ident!;
    this.nextToken();
    this.nextToken(); // advance past =
    const t = this.parseType();
    const s: Dsymbol = new AliasAssign(loc, ident, t, null);
    this.checkFollowing(TOK.semicolon, ds("alias reassignment"));
    this.addComment(s, comment);
    const a = new DArray<Dsymbol | null>();
    a.push(s);
    return a;
  }

  /********************************
   * Parse declarations that start with `alias`. Parser is sitting on the `alias`.
   */
  private parseAliasDeclarations(comment: DString | null): Dsymbols | null {
    const loc = this.token.loc;
    this.nextToken();
    let linkloc: Loc = this.linkLoc;
    let udas: Expressions | null = null;
    let link: LINK = this.linkage;
    let storage_class: STC = STC.none;
    let ealign: Expression | null = null;
    let setAlignment = false;

    /* Look for: alias Identifier this; */
    if ((this.token.value as TOK) === TOK.identifier && this.peekNext() === TOK.this_) {
      const s = new AliasThis(loc, this.token.ident!);
      this.nextToken();
      this.check(TOK.this_);
      this.checkFollowing(TOK.semicolon, ds("`alias Identifier this`"));
      const a = new DArray<Dsymbol | null>();
      a.push(s);
      this.addComment(s, comment);
      return a;
    }
    /* Look for: alias this = identifier; */
    if ((this.token.value as TOK) === TOK.this_ && this.peekNext() === TOK.assign && this.peekNext2() === TOK.identifier) {
      this.check(TOK.this_);
      this.check(TOK.assign);
      const s = new AliasThis(loc, this.token.ident!);
      this.nextToken();
      this.checkFollowing(TOK.semicolon, ds("`alias this = Identifier`"));
      const a = new DArray<Dsymbol | null>();
      a.push(s);
      this.addComment(s, comment);
      return a;
    }
    /* Look for: alias identifier = type; / alias identifier(...) = type; */
    if ((this.token.value as TOK) === TOK.identifier && this.hasOptionalParensThen(this.peek(this.token), TOK.assign)) {
      const a = new DArray<Dsymbol | null>();
      Outer: while (true) {
        const ident = this.token.ident!;
        this.nextToken();
        let tpl: TemplateParameters | null = null;
        if ((this.token.value as TOK) === TOK.leftParenthesis) tpl = this.parseTemplateParameterList();
        this.check(TOK.assign);

        let hasParsedAttributes = false;
        const parseAttributes = (): void => {
          if (hasParsedAttributes) return; // only parse once
          hasParsedAttributes = true;
          udas = null;
          storage_class = STC.none;
          link = this.linkage;
          linkloc = this.linkLoc;
          setAlignment = false;
          ealign = null;
          const sc_box = { value: storage_class };
          const link_box = { value: link };
          const setAlign_box: { value: boolean } = { value: setAlignment };
          const ealign_box: { value: Expression | null } = { value: ealign };
          const udas_box: { value: Expressions | null } = { value: udas };
          const linkloc_box = { value: linkloc };
          this.parseStorageClasses(sc_box, link_box, setAlign_box, ealign_box, udas_box, linkloc_box);
          storage_class = sc_box.value;
          link = link_box.value;
          setAlignment = setAlign_box.value;
          ealign = ealign_box.value;
          udas = udas_box.value;
          linkloc = linkloc_box.value;
        };

        if ((this.token.value as TOK) === TOK.at) parseAttributes();

        let v: Declaration;
        let s: Dsymbol;

        let attributesAppended = false;
        const funcStc = this.parseTypeCtor();
        const tk_box: { value: Token } = { value: this.token };
        // function literal?
        if (
          (this.token.value as TOK) === TOK.function_ ||
          (this.token.value as TOK) === TOK.delegate_ ||
          ((this.token.value as TOK) === TOK.leftParenthesis &&
            this.skipAttributes(this.peekPastParen(this.token), tk_box) &&
            (tk_box.value.value === TOK.goesTo || tk_box.value.value === TOK.leftCurly)) ||
          (this.token.value as TOK) === TOK.leftCurly ||
          ((this.token.value as TOK) === TOK.identifier && this.peekNext() === TOK.goesTo) ||
          ((this.token.value as TOK) === TOK.ref_ &&
            this.peekNext() === TOK.leftParenthesis &&
            this.skipAttributes(this.peekPastParen(this.peek(this.token)), tk_box) &&
            (tk_box.value.value === TOK.goesTo || tk_box.value.value === TOK.leftCurly)) ||
          ((this.token.value as TOK) === TOK.auto_ &&
            (this.peekNext() === TOK.leftParenthesis ||
              (this.peekNext() === TOK.ref_ && this.peekNext2() === TOK.leftParenthesis)))
        ) {
          // various function-literal forms (parse.d:5003-5012)
          s = this.parseFunctionLiteral();

          if (udas !== null) {
            if (storage_class !== STC.none) this.error(ds("cannot put a storage-class in an `alias` declaration."));
            // parseAttributes shouldn't have set these variables
            assert(link === this.linkage && !setAlignment && ealign === null);
            // D `cast(AST.TemplateDeclaration) s` (parse.d:5049) is a static cast (Dsymbol is extern(C++)).
            // parseFunctionLiteral returns the TemplateDeclaration only for a literal with untyped parameters
            // (parse.d:5326), else the bare FuncLiteralDeclaration (:5328). On the latter D reads
            // ScopeDsymbol.members at the offset of Declaration.type, so `members.length` is the TypeFunction's
            // vtable pointer, never 1: the error branch is taken. isTemplateDeclaration() takes it through the
            // null test; reading `.members` off a FuncLiteralDeclaration crashed.
            const tpl_ = s.isTemplateDeclaration();
            if (tpl_ === null || tpl_.members!.length !== 1) {
              this.error(ds("user-defined attributes are not allowed on `alias` declarations"));
            } else {
              const fd = tpl_.members!.opIndex(0)!.isFuncLiteralDeclaration()!;
              const tf = fd.type!.isTypeFunction()!;
              assert(tf.parameterList.parameters!.length > 0);
              const as = new DArray<Dsymbol | null>();
              // slot `Parameter | null` (08 §3); D writes through it with no null test -> `!`.
              tf.parameterList.parameters!.opIndex(0)!.userAttribDecl = new UserAttributeDeclaration(udas, as);
            }
          }

          // reconciled to faithful surface (W2); sweeps at this file's retranslation (04 §1.1(c))
          v = AliasDeclaration.fromDsymbol(loc, ident, s);
        } else {
          // type
          parseAttributes();
          if (udas) this.error(ds("user-defined attributes not allowed for `alias` declarations"));

          let t = this.parseBasicType();
          t = this.parseTypeSuffixes(t);
          if ((this.token.value as TOK) === TOK.identifier) {
            this.error(ds("unexpected identifier `%s` after `%s`"), this.token.ident!.toChars(), t.toChars());
            this.nextToken();
          } else if ((this.token.value as TOK) === TOK.leftParenthesis) {
            // function type: StorageClasses Type ( Parameters ) MemberFunctionAttributes
            const parameterList = this.parseParameterList(null);
            udas = null;
            const sc_box = { value: storage_class };
            const link_box = { value: link };
            const setAlign_box: { value: boolean } = { value: setAlignment };
            const ealign_box: { value: Expression | null } = { value: ealign };
            const udas_box: { value: Expressions | null } = { value: udas };
            const linkloc_box = { value: linkloc };
            this.parseStorageClasses(sc_box, link_box, setAlign_box, ealign_box, udas_box, linkloc_box);
            storage_class = sc_box.value;
            link = link_box.value;
            setAlignment = setAlign_box.value;
            ealign = ealign_box.value;
            udas = udas_box.value;
            linkloc = linkloc_box.value;
            if (udas) this.error(ds("user-defined attributes not allowed for `alias` declarations"));

            attributesAppended = true;
            // Note: method types can have a TypeCtor attribute
            storage_class = this.appendStorageClass(storage_class, funcStc);
            t = new TypeFunction(parameterList, t, link, storage_class);
          }

          // Disallow meaningless storage classes on type aliases
          if (storage_class) {
            // Don't raise errors for STC that are part of a function/delegate type.
            let remStc: STC;
            if (t.isTypeFunction()) remStc = (storage_class & ~(STC.FUNCATTR | STC.TYPECTOR)) as STC;
            else {
              const tp = t.isTypePointer();
              const isFuncType = (tp && tp.next!.isTypeFunction()) || t.isTypeDelegate();
              remStc = isFuncType ? ((storage_class & ~STC.FUNCATTR) as STC) : storage_class;
            }

            if (remStc) {
              const buf = new OutBuffer();
              stcToBuffer(buf, remStc);
              // @@@DEPRECATED_2.103@@@ Deprecated in 2020-07
              this.eSink.deprecation(
                this.token.loc,
                ds("storage class `%s` has no effect in type aliases"),
                buf.peekChars(),
              );
            }
          }

          // reconciled to faithful surface (W2); sweeps at this file's retranslation (04 §1.1(c))
          v = AliasDeclaration.fromType(loc, ident, t);
        }
        if (!attributesAppended) storage_class = this.appendStorageClass(storage_class, funcStc);
        v.storage_class = storage_class;

        s = v;
        if (tpl) {
          const a2 = new DArray<Dsymbol | null>();
          a2.push(s);
          const tempdecl = new TemplateDeclaration(loc, ident, tpl, null, a2);
          s = tempdecl;
        }
        if (link !== this.linkage) {
          const a2 = new DArray<Dsymbol | null>();
          a2.push(s);
          s = new LinkDeclaration(linkloc, link, a2);
        }
        a.push(s);

        switch ((this.token.value as TOK)) {
          case TOK.semicolon:
            this.nextToken();
            this.addComment(s, comment);
            break;

          case TOK.comma:
            this.nextToken();
            this.addComment(s, comment);
            if ((this.token.value as TOK) !== TOK.identifier) {
              this.error(ds("identifier expected following comma, not `%s`"), this.token.toChars());
              break;
            }
            if (this.peekNext() !== TOK.assign && this.peekNext() !== TOK.leftParenthesis) {
              this.error(ds("`=` expected following identifier"));
              this.nextToken();
              break;
            }
            continue Outer;

          default:
            this.error(ds("semicolon expected to close `alias` declaration, not `%s`"), this.token.toChars());
            this.nextToken();
            break;
        }
        break;
      }
      return a;
    }

    // alias StorageClasses type ident;
    return null;
  }

  private parseFunctionLiteral(): Dsymbol {
    const loc = this.token.loc;
    let tpl: TemplateParameters | null = null;
    let parameterList: ParameterList = new ParameterList(null);
    let tret: Type | null = null;
    let stc: STC = STC.none;
    let save: TOK = TOK.reserved;

    LfunctionLiteral: {
      switch ((this.token.value as TOK)) {
        case TOK.function_:
        case TOK.delegate_:
          save = (this.token.value as TOK);
          this.nextToken();
          if ((this.token.value as TOK) === TOK.auto_) {
            this.nextToken();
            if ((this.token.value as TOK) === TOK.ref_) {
              // function/delegate auto ref (parameters) { statements... }
              stc = (STC.auto_ | STC.ref_ | STC.autoref) as STC;
              this.nextToken();
            } else
              this.error(ds("`auto` can only be used as part of `auto ref` for function literal return values"));
          } else if ((this.token.value as TOK) === TOK.ref_) {
            // function/delegate ref (parameters) { statements... }
            stc = STC.ref_;
            this.nextToken();
          }
          if (
            (this.token.value as TOK) !== TOK.leftParenthesis &&
            (this.token.value as TOK) !== TOK.leftCurly &&
            (this.token.value as TOK) !== TOK.goesTo
          ) {
            // function/delegate type (parameters) { statements... }
            tret = this.parseBasicType();
            tret = this.parseTypeSuffixes(tret); // function return type
          }

          if ((this.token.value as TOK) === TOK.leftParenthesis) {
            // function/delegate (parameters) { statements... } — fall to leftParenthesis case
          } else {
            // function/delegate { statements... }
            break LfunctionLiteral;
          }
          // goto case TOK.leftParenthesis: the arm's body, run here. `tpl` goes by box and is read back, as
          // D passes `&tpl`: an untyped parameter (`function(x) {...}`) makes parseParameterList create the
          // template parameter list, and dropping it leaves `__T<n>` unbound (dmd/parse.d:5261).
          const tpl_box: { value: TemplateParameters | null } = { value: tpl };
          parameterList = this.parseParameterList(tpl_box);
          tpl = tpl_box.value;
          stc = this.parsePostfix(stc, null);
          {
            const modStc = (stc & STC.TYPECTOR) as STC;
            if (modStc) {
              if ((save as TOK) === TOK.function_) {
                const buf = new OutBuffer();
                stcToBuffer(buf, modStc);
                this.error(ds("function literal cannot be `%s`"), buf.peekChars());
              } else save = TOK.delegate_;
            }
          }
          break LfunctionLiteral;

        case TOK.auto_: {
          this.nextToken();
          if ((this.token.value as TOK) === TOK.ref_) {
            // auto ref (parameters) => expression / { statements... }
            stc = (STC.auto_ | STC.ref_ | STC.autoref) as STC;
            this.nextToken();
          } else
            this.error(ds("`auto` can only be used as part of `auto ref` for function literal return values"));
          // goto case TOK.leftParenthesis
          const tpl_box: { value: TemplateParameters | null } = { value: tpl };
          parameterList = this.parseParameterList(tpl_box);
          tpl = tpl_box.value;
          stc = this.parsePostfix(stc, null);
          {
            const modStc = (stc & STC.TYPECTOR) as STC;
            if (modStc) {
              if ((save as TOK) === TOK.function_) {
                const buf = new OutBuffer();
                stcToBuffer(buf, modStc);
                this.error(ds("function literal cannot be `%s`"), buf.peekChars());
              } else save = TOK.delegate_;
            }
          }
          break LfunctionLiteral;
        }
        case TOK.ref_: {
          // ref (parameters) => expression / { statements... }
          stc = STC.ref_;
          this.nextToken();
          // goto case TOK.leftParenthesis -> fall through to the next arm (JS no-break fallthrough)
        }
        case TOK.leftParenthesis: {
          // (parameters) => expression / { statements... }
          const tpl_box: { value: TemplateParameters | null } = { value: tpl };
          parameterList = this.parseParameterList(tpl_box);
          tpl = tpl_box.value;
          stc = this.parsePostfix(stc, null);
          const modStc = (stc & STC.TYPECTOR) as STC;
          if (modStc) {
            if ((save as TOK) === TOK.function_) {
              const buf = new OutBuffer();
              stcToBuffer(buf, modStc);
              this.error(ds("function literal cannot be `%s`"), buf.peekChars());
            } else save = TOK.delegate_;
          }
          break LfunctionLiteral;
        }
        case TOK.leftCurly:
          // { statements... }
          break LfunctionLiteral;

        case TOK.identifier: {
          // identifier => expression
          parameterList.parameters = new DArray<Parameter | null>();
          const id = Identifier.generateId(ds("__T"));
          const t: Type = new TypeIdentifier(loc, id);
          parameterList.parameters.push(new Parameter(loc, STC.parameter, t, this.token.ident!, null, null));

          tpl = new DArray<TemplateParameter | null>();
          const tp: TemplateParameter = new TemplateTypeParameter(loc, id, null, null);
          tpl.push(tp);

          this.nextToken();
          break LfunctionLiteral;
        }
        default:
          assertUnreachable();
      }
    }

    let tf = new TypeFunction(parameterList, tret, this.linkage, stc) as Type;
    tf = addSTC(tf, stc) as TypeFunction;
    const fd = new FuncLiteralDeclaration(
      loc,
      Loc.initial,
      tf,
      save,
      null,
      null,
      (stc & STC.auto_) as STC,
    );

    if ((this.token.value as TOK) === TOK.goesTo) {
      this.check(TOK.goesTo);
      if ((this.token.value as TOK) === TOK.leftCurly) {
        this.deprecation(
          ds("using `(args) => { ... }` to create a delegate that returns a delegate is error-prone."),
        );
        this.deprecationSupplemental(
          ds(
            "Use `(args) { ... }` for a multi-statement function literal or use `(args) => () { }` if you intended for the lambda to return a delegate.",
          ),
        );
      }
      const returnloc = this.token.loc;
      const ae = this.parseAssignExp();
      fd.fbody = new ReturnStatement(returnloc, ae);
      fd.endloc = this.token.loc;
    } else {
      this.parseContracts(fd);
    }

    if (tpl) {
      // Wrap a template around function fd
      const decldefs = new DArray<Dsymbol | null>();
      decldefs.push(fd);
      return new TemplateDeclaration(fd.loc, fd.ident, tpl, null, decldefs, false, true);
    }
    return fd;
  }

  /*****************************************
   * Parse contracts following function declaration.
   */
  private parseContracts(f: FuncDeclaration, isTemplateFunction = false): FuncDeclaration {
    const linksave = this.linkage;

    const literal = f.isFuncLiteralDeclaration() !== null;

    // overridden by sc.linkage in TypeFunction::semantic
    this.linkage = LINK.d; // nested functions have D linkage
    let requireDo = false;
    L1: while (true) {
      switch ((this.token.value as TOK)) {
        case TOK.goesTo: {
          if (requireDo) this.error(ds("missing `do { ... }` after `in` or `out`"));
          const returnloc = this.token.loc;
          this.nextToken();
          f.fbody = new ReturnStatement(returnloc, this.parseExpression());
          f.endloc = this.token.loc;
          this.check(TOK.semicolon);
          break L1;
        }

        case TOK.leftCurly:
          if (requireDo) this.error(ds("missing `do { ... }` after `in` or `out`"));
          f.fbody = this.parseStatement(0);
          f.endloc = this.endloc;
          break L1;

        case TOK.identifier:
          if (this.token.ident === Id._body) {
            this.usageOfBodyKeyword();
            // goto case TOK.do_
            this.nextToken();
            f.fbody = this.parseStatement(ParseStatementFlags.curly);
            f.endloc = this.endloc;
            break L1;
          }
          // goto default
          this.parseContracts_default(f, literal, requireDo, isTemplateFunction);
          break L1;

        case TOK.do_:
          this.nextToken();
          f.fbody = this.parseStatement(ParseStatementFlags.curly);
          f.endloc = this.endloc;
          break L1;

        // resolved: version(none) `case TOK.comma:` block dropped (disabled in upstream).

        case TOK.in_: {
          // in { statements... } / in (expression)
          const loc = this.token.loc;
          this.nextToken();
          // f.frequires field-write -> setter (func.d generateContractSetter); read -> getter.
          if (!f.frequires()) {
            f.setFrequires(new DArray<Statement | null>());
          }
          if ((this.token.value as TOK) === TOK.leftParenthesis) {
            this.nextToken();
            let e = this.parseAssignExp();
            let msg: Expression | null = null;
            if ((this.token.value as TOK) === TOK.comma) {
              this.nextToken();
              if ((this.token.value as TOK) !== TOK.rightParenthesis) {
                msg = this.parseAssignExp();
                if ((this.token.value as TOK) === TOK.comma) this.nextToken();
              }
            }
            this.check(TOK.rightParenthesis);
            e = new AssertExp(loc, e, msg);
            f.frequires()!.push(new ExpStatement(loc, e));
            requireDo = false;
          } else {
            const ret = this.parseStatement(ParseStatementFlags.curly | ParseStatementFlags.scope_);
            assert(ret);
            f.frequires()!.push(ret);
            requireDo = true;
          }
          continue L1; // goto L1
        }

        case TOK.out_: {
          // out { statements... } / out (; expression) / out (identifier) ...
          const loc = this.token.loc;
          this.nextToken();
          if (!f.fensures()) {
            f.setFensures(new DArray<Ensure>());
          }
          let id: Identifier | null = null;
          if ((this.token.value as TOK) !== TOK.leftCurly) {
            this.check(TOK.leftParenthesis);
            if ((this.token.value as TOK) !== TOK.identifier && (this.token.value as TOK) !== TOK.semicolon)
              this.error(
                ds("`(identifier) { ... }` or `(identifier; expression)` following `out` expected, not `%s`"),
                this.token.toChars(),
              );
            if ((this.token.value as TOK) !== TOK.semicolon) {
              id = this.token.ident!;
              this.nextToken();
            }
            if ((this.token.value as TOK) === TOK.semicolon) {
              this.nextToken();
              let e = this.parseAssignExp();
              let msg: Expression | null = null;
              if ((this.token.value as TOK) === TOK.comma) {
                this.nextToken();
                if ((this.token.value as TOK) !== TOK.rightParenthesis) {
                  msg = this.parseAssignExp();
                  if ((this.token.value as TOK) === TOK.comma) this.nextToken();
                }
              }
              this.check(TOK.rightParenthesis);
              e = new AssertExp(loc, e, msg);
              f.fensures()!.push(new Ensure(id, new ExpStatement(loc, e)));
              requireDo = false;
              continue L1; // goto L1
            }
            this.check(TOK.rightParenthesis);
          }
          f.fensures()!.push(
            new Ensure(id, this.parseStatement(ParseStatementFlags.curly | ParseStatementFlags.scope_)),
          );
          requireDo = true;
          continue L1; // goto L1
        }

        case TOK.semicolon:
          if (!literal) {
            // Semicolon part of function declaration only when 'do' is not required
            if (!requireDo) this.nextToken();
            break L1;
          }
          // goto default
          this.parseContracts_default(f, literal, requireDo, isTemplateFunction);
          break L1;

        default:
          this.parseContracts_default(f, literal, requireDo, isTemplateFunction);
          break L1;
      }
    }
    if (literal && !f.fbody) {
      // Set empty function body for error recovery
      // reconciled to faithful surface (W2); sweeps at this file's retranslation:
      // parse.d:5518 spells `cast(AST.Statement)null`, i.e. D picks the TYPESAFE VARIADIC ctor
      // (statement.d:507), which builds a one-element Statements holding null — not the container
      // ctor (statement.d:493). statement.ts splits the pair per 04 §1.1(c); this is the factory arm.
      f.fbody = CompoundStatement.fromStatementList(Loc.initial, null);
    }

    this.linkage = linksave;

    return f;
  }

  /* The `default:` body of parseContracts (parse.d:5457-5486). */
  private parseContracts_default(
    f: FuncDeclaration,
    literal: boolean,
    requireDo: boolean,
    isTemplateFunction: boolean,
  ): void {
    void f;
    if (literal) {
      const sbody = requireDo ? ds("do ") : ds("");
      this.error(ds("missing `%s{ ... }` for function literal"), sbody);
    } else if (!requireDo) {
      // allow contracts even with no body
      const t = (this.token.value as TOK);
      if (
        t === TOK.const_ ||
        t === TOK.immutable_ ||
        t === TOK.inout_ ||
        t === TOK.return_ ||
        t === TOK.shared_ ||
        t === TOK.nothrow_ ||
        t === TOK.pure_
      )
        this.error(ds("'%s' cannot be placed after a template constraint"), this.token.toChars());
      else if (t === TOK.at) this.error(ds("attributes cannot be placed after a template constraint"));
      else if (t === TOK.if_) {
        if (isTemplateFunction) this.error(ds("template constraint must follow parameter lists and attributes"));
        else this.error(ds("cannot use function constraints for non-template functions. Use `static if` instead"));

        this.parseConstraint();
      } else {
        this.error(ds("semicolon expected following function declaration, not `%s`"), this.token.toChars());
        this.nextToken();
      }
    }
  }

  /*****************************************
   */
  private checkDanglingElse(elseloc: Loc): void {
    if (
      (this.token.value as TOK) !== TOK.else_ &&
      (this.token.value as TOK) !== TOK.catch_ &&
      (this.token.value as TOK) !== TOK.finally_ &&
      this.lookingForElse.isValid()
    ) {
      this.eSink.error(elseloc, ds("else is dangling, add { } after condition at %s"), this.lookingForElse.toChars());
    }
  }

  /* *************************
   * Issue errors if C-style syntax. `alt != 0` for C-style syntax.
   */
  private checkCstyleTypeSyntax(loc: Loc, t: Type, alt: number, ident: Identifier | null): void {
    if (!alt) return;

    const sp = !ident ? ds("") : ds(" ");
    const s = !ident ? ds("") : ident.toChars();
    this.errorLoc(loc, ds("instead of C-style syntax, use D-style `%s%s%s`"), t.toChars(), sp, s);
  }

  /*****************************
   * Ad-hoc error message for missing or extra parens that close a condition.
   */
  private closeCondition(start: DString, param: Parameter | null, condition: Expression | null): void {
    let format: DString | null = null;
    if ((this.token.value as TOK) !== TOK.rightParenthesis && condition) {
      format = ds("missing closing `)` after `%s (%s`");
    } else this.check(TOK.rightParenthesis);
    if ((this.token.value as TOK) === TOK.rightParenthesis) {
      if (condition)
        // if not an error in condition
        format = ds("extra `)` after `%s (%s)`");
      this.nextToken();
    }
    if (format) this.errorLoc(this.token.loc, format, start, param ? ds("declaration") : condition!.toChars());
  }

  /*****************************************
   * Parses `foreach` statements (Statement form). `parseForeach!(AST.Statement)`.
   * The D template is monomorphized into three concrete methods (parseForeachStmt /
   * parseForeachStaticStmt / parseForeachStaticDecl) — the `static if (is(Foreach == ...))`
   * branches resolved per the instantiation.
   */
  private parseForeachStmt(loc: Loc): Statement | null {
    return this.parseForeachImpl(loc, null, "stmt") as Statement | null;
  }

  private parseForeachStaticStmt(loc: Loc): Statement | null {
    return this.parseForeachImpl(loc, null, "staticStmt") as Statement | null;
  }

  private parseForeachStaticDecl(loc: Loc, pLastDecl: { value: Dsymbol | null }): Dsymbol | null {
    return this.parseForeachImpl(loc, pLastDecl, "staticDecl") as Dsymbol | null;
  }

  /* Shared body of the three `parseForeach!(Foreach)` instantiations (parse.d:5561). `kind`
   * selects which `static if` branch is live. */
  private parseForeachImpl(
    loc: Loc,
    pLastDecl: { value: Dsymbol | null } | null,
    kind: "stmt" | "staticStmt" | "staticDecl",
  ): Statement | Dsymbol | null {
    // static if (is(Foreach == StaticForeachStatement) || is(Foreach == StaticForeachDeclaration)) nextToken();
    if (kind === "staticStmt" || kind === "staticDecl") {
      this.nextToken();
    }

    const op = (this.token.value as TOK);

    this.nextToken();
    this.check(TOK.leftParenthesis);

    const parameters = new DArray<Parameter | null>();
    let lastai: Identifier | null = null;
    OuterParam: while (true) {
      let ai: Identifier | null = null;
      let at: Type | null = null;
      let aloc = new Loc();

      let storageClass: STC = STC.none;
      let stc: STC = STC.none;
      Lagain: while (true) {
        if (stc) {
          storageClass = this.appendStorageClass(storageClass, stc);
          this.nextToken();
        }
        let larg = false;
        switch ((this.token.value as TOK)) {
          case TOK.ref_:
            stc = STC.ref_;
            continue Lagain;

          case TOK.scope_:
            stc = STC.scope_;
            continue Lagain;

          case TOK.out_:
            this.error(ds("cannot declare `out` loop variable, use `ref` instead"));
            stc = STC.out_;
            continue Lagain;

          case TOK.auto_:
            this.error(ds("cannot declare `auto` loop variable, omit `auto` to still get type inference"));
            stc = STC.auto_;
            continue Lagain;

          case TOK.enum_:
            stc = STC.manifest;
            continue Lagain;

          case TOK.alias_:
            storageClass = this.appendStorageClass(storageClass, STC.alias_);
            this.nextToken();
            break;

          case TOK.const_:
            if (this.peekNext() !== TOK.leftParenthesis) {
              stc = STC.const_;
              continue Lagain;
            }
            break;

          case TOK.immutable_:
            if (this.peekNext() !== TOK.leftParenthesis) {
              stc = STC.immutable_;
              continue Lagain;
            }
            break;

          case TOK.shared_:
            if (this.peekNext() !== TOK.leftParenthesis) {
              stc = STC.shared_;
              continue Lagain;
            }
            break;

          case TOK.inout_:
            if (this.peekNext() !== TOK.leftParenthesis) {
              stc = STC.wild;
              continue Lagain;
            }
            break;

          default:
            break;
        }
        if ((this.token.value as TOK) === TOK.identifier) {
          const tv = this.peekNext();
          if (tv === TOK.comma || tv === TOK.semicolon || tv === TOK.rightParenthesis) {
            lastai = this.token.ident!;
            ai = this.token.ident!;
            at = null; // infer argument type
            aloc = this.token.loc;
            this.nextToken();
            larg = true;
          }
        }
        if (!larg) {
          const ai_box: { value: Identifier | null } = { value: null };
          at = this.parseType(ai_box);
          ai = ai_box.value;
          if (!ai) this.noIdentifierForDeclarator(at, this.token);
        }
        // Larg:
        const p = new Parameter(aloc, storageClass, at, ai, null, null);
        parameters.push(p);
        if ((this.token.value as TOK) === TOK.comma) {
          this.nextToken();
          continue OuterParam;
        }
        break OuterParam;
      }
    }
    if ((this.token.value as TOK) !== TOK.semicolon) {
      this.error(ds("missing `; expression` before `)` of `foreach`"));
      this.nextToken();
      if (lastai && parameters.length >= 2) {
        this.eSink.errorSupplemental(loc, ds("perhaps the `;` goes before `%s`"), lastai.toChars());
      }
      return null;
    }
    this.nextToken();

    const aggr = this.parseExpression();
    if ((this.token.value as TOK) === TOK.slice && parameters.length === 1) {
      const p = parameters.opIndex(0);
      this.nextToken();
      const upr = this.parseExpression();
      this.check(TOK.rightParenthesis);
      const endloc_box: { value: Loc } = { value: new Loc() };
      let _body: Statement | null;
      if (kind === "stmt" || kind === "staticStmt") {
        _body = this.parseStatement(0, null, endloc_box);
      } else {
        _body = null;
      }
      const rangefe = new ForeachRangeStatement(loc, op, p, aggr, upr, _body, endloc_box.value);
      if (kind === "stmt") {
        return rangefe;
      } else if (kind === "staticDecl") {
        return new StaticForeachDeclaration(
          new StaticForeach(loc, null, rangefe),
          this.parseBlock(pLastDecl!),
        );
      } else {
        return new StaticForeachStatement(loc, new StaticForeach(loc, null, rangefe));
      }
    } else {
      this.check(TOK.rightParenthesis);
      const endloc_box: { value: Loc } = { value: new Loc() };
      let _body: Statement | null;
      if (kind === "stmt" || kind === "staticStmt") {
        _body = this.parseStatement(0, null, endloc_box);
      } else {
        _body = null;
      }
      const aggrfe = new ForeachStatement(loc, op, parameters, aggr, _body, endloc_box.value);
      if (kind === "stmt") {
        return aggrfe;
      } else if (kind === "staticDecl") {
        return new StaticForeachDeclaration(
          new StaticForeach(loc, aggrfe, null),
          this.parseBlock(pLastDecl!),
        );
      } else {
        return new StaticForeachStatement(loc, new StaticForeach(loc, aggrfe, null));
      }
    }
  }

  /***
   * Parse an assignment condition for `if`, `switch`, `while` or `with` statements.
   *
   * Returns:
   *      The variable that is declared inside the condition
   */
  parseAssignCondition(_with = false): Parameter | null {
    let storageClass: STC = STC.none;
    let stc: STC = STC.none;
    Lwhile: while (true) {
      switch ((this.token.value as TOK)) {
        // parse ref for better error
        case TOK.ref_:
          stc = STC.ref_;
          break;

        case TOK.scope_:
          stc = STC.scope_;
          break;

        case TOK.auto_:
          stc = STC.auto_;
          if (this.peekNext() === TOK.ref_) stc = (stc | STC.autoref) as STC;
          break;

        case TOK.const_:
          if (this.peekNext() !== TOK.leftParenthesis) {
            stc = STC.const_;
            break;
          }
          break Lwhile; // goto default

        case TOK.immutable_:
          if (this.peekNext() !== TOK.leftParenthesis) {
            stc = STC.immutable_;
            break;
          }
          break Lwhile;

        case TOK.shared_:
          if (this.peekNext() !== TOK.leftParenthesis) {
            stc = STC.shared_;
            break;
          }
          break Lwhile;

        case TOK.inout_:
          if (this.peekNext() !== TOK.leftParenthesis) {
            stc = STC.wild;
            break;
          }
          break Lwhile;

        default:
          break Lwhile;
      }
      storageClass = this.appendStorageClass(storageClass, stc);
      this.nextToken();
    }
    const n = this.peek(this.token);
    if (storageClass !== STC.none && (this.token.value as TOK) === TOK.identifier && n.value === TOK.assign) {
      const ai = this.token.ident!;
      const at: Type | null = null; // infer parameter type
      const aloc = this.token.loc;
      this.nextToken();
      this.check(TOK.assign);
      return new Parameter(aloc, storageClass, at, ai, null, null);
    } else if (this.isDeclaration(this.token, NeedDeclaratorId.must, TOK.assign, null)) {
      const ai_box: { value: Identifier | null } = { value: null };
      const aloc = this.token.loc;
      const at = this.parseType(ai_box);
      this.check(TOK.assign);
      return new Parameter(aloc, storageClass, at, ai_box.value, null, null);
    } else if (storageClass !== STC.none && !_with) {
      this.error(ds("found `%s` while expecting `=` or identifier"), n.toChars());
    }
    return null;
  }

  /*****************************************
   * Parse a statement. `endPtr`/`pEndloc` are out-boxes (04 §7). The D body is a giant switch
   * with `goto Ldeclaration/Lexp/Lswitch/Lcondition/Lerror/case`; the shared targets are
   * extracted into helper methods, and `goto` becomes a `kind`-dispatched call or a labeled jump.
   */
  parseStatement(
    flags: number,
    endPtr: { value: DString | null } | null = null,
    pEndloc: { value: Loc } | null = null,
  ): Statement {
    let s: Statement | null = null;
    let cond: Condition | null = null;
    let ifbody: Statement | null = null;
    let elsebody: Statement | null = null;
    let isfinal = false;
    const loc = this.token.loc;

    if (flags & ParseStatementFlags.curly && (this.token.value as TOK) !== TOK.leftCurly)
      this.error(ds("statement expected to be `{ }`, not `%s`"), this.token.toChars());

    // The `goto` targets are reached via this dispatch loop; `jump` selects the next labeled body.
    let jump: "" | "Ldeclaration" | "Lexp" | "Lswitch" | "Lcondition" | "Lerror" = "";

    Body: {
      switch ((this.token.value as TOK)) {
        case TOK.identifier: {
          /* A leading identifier can be a declaration, label, or expression. */
          if (this.peekNext() === TOK.colonColon) {
            // skip ident::
            this.nextToken();
            this.nextToken();
            this.error(ds("use `.` for member lookup, not `::`"));
            break Body;
          }

          if (this.peekNext() === TOK.colon) {
            // It's a label
            const ident = this.token.ident!;
            this.nextToken();
            this.nextToken();
            if ((this.token.value as TOK) === TOK.rightCurly) s = null;
            else if ((this.token.value as TOK) === TOK.leftCurly)
              s = this.parseStatement(ParseStatementFlags.curly | ParseStatementFlags.scope_);
            else if (flags & ParseStatementFlags.curlyScope)
              s = this.parseStatement(ParseStatementFlags.semiOk | ParseStatementFlags.curlyScope);
            else s = this.parseStatement(ParseStatementFlags.semiOk);
            s = new LabelStatement(loc, ident, s);
            break Body;
          }
          // goto case TOK.dot
          if (this.isDeclaration(this.token, NeedDeclaratorId.mustIfDstyle, TOK.reserved, null)) {
            jump = "Ldeclaration";
            break Body;
          }
          jump = "Lexp";
          break Body;
        }
        case TOK.dot:
        case TOK.typeof_:
        case TOK.vector:
        case TOK.traits:
          /* prefer D expression over old C-style declaration */
          if (this.isDeclaration(this.token, NeedDeclaratorId.mustIfDstyle, TOK.reserved, null)) {
            jump = "Ldeclaration";
            break Body;
          }
          jump = "Lexp";
          break Body;

        case TOK.assert_:
        case TOK.this_:
        case TOK.super_:
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
        case TOK.charLiteral:
        case TOK.wcharLiteral:
        case TOK.dcharLiteral:
        case TOK.null_:
        case TOK.true_:
        case TOK.false_:
        case TOK.string_:
        case TOK.interpolated:
        case TOK.hexadecimalString:
        case TOK.leftParenthesis:
        case TOK.cast_:
        case TOK.mul:
        case TOK.min:
        case TOK.add:
        case TOK.tilde:
        case TOK.not:
        case TOK.plusPlus:
        case TOK.minusMinus:
        case TOK.new_:
        case TOK.delegate_:
        case TOK.function_:
        case TOK.typeid_:
        case TOK.is_:
        case TOK.leftBracket:
        case TOK.file:
        case TOK.fileFullPath:
        case TOK.line:
        case TOK.moduleString:
        case TOK.functionString:
        case TOK.prettyFunction:
        case TOK.rvalue:
          jump = "Lexp";
          break Body;

        case TOK.static_: {
          // Look ahead to see if it's static assert() or static if()
          const tv = this.peekNext();
          if (tv === TOK.assert_) {
            s = new StaticAssertStatement(this.parseStaticAssert());
            break Body;
          }
          if (tv === TOK.if_) {
            cond = this.parseStaticIfCondition();
            jump = "Lcondition";
            break Body;
          }
          if (tv === TOK.foreach_ || tv === TOK.foreach_reverse_) {
            s = this.parseForeachStaticStmt(loc);
            if (flags & ParseStatementFlags.scope_) s = new ScopeStatement(loc, s, this.token.loc);
            break Body;
          }
          if (tv === TOK.import_) {
            const imports = this.parseImport();
            s = new ImportStatement(loc, imports);
            if (flags & ParseStatementFlags.scope_) s = new ScopeStatement(loc, s, this.token.loc);
            break Body;
          }
          jump = "Ldeclaration";
          break Body;
        }
        case TOK.final_:
          if (this.peekNext() === TOK.switch_) {
            this.nextToken();
            isfinal = true;
            jump = "Lswitch";
            break Body;
          }
          jump = "Ldeclaration";
          break Body;

        case TOK.wchar_:
        case TOK.dchar_:
        case TOK.bool_:
        case TOK.char_:
        case TOK.int8:
        case TOK.uns8:
        case TOK.int16:
        case TOK.uns16:
        case TOK.int32:
        case TOK.uns32:
        case TOK.int64:
        case TOK.uns64:
        case TOK.int128:
        case TOK.uns128:
        case TOK.float32:
        case TOK.float64:
        case TOK.float80:
        case TOK.imaginary32:
        case TOK.imaginary64:
        case TOK.imaginary80:
        case TOK.complex32:
        case TOK.complex64:
        case TOK.complex80:
        case TOK.void_:
          // bug 7773: int.max is always a part of expression
          if (this.peekNext() === TOK.dot) {
            jump = "Lexp";
            break Body;
          }
          if (this.peekNext() === TOK.leftParenthesis) {
            jump = "Lexp";
            break Body;
          }
          jump = "Ldeclaration"; // goto case (the next case, Ldeclaration group)
          break Body;

        // FunctionLiteral `auto ref (`
        case TOK.auto_:
          if (this.peekNext() === TOK.ref_ && this.peekNext2() === TOK.leftParenthesis) {
            jump = "Lexp";
            break Body;
          }
          jump = "Ldeclaration";
          break Body;
        case TOK.ref_:
          if (this.peekNext() === TOK.leftParenthesis) {
            jump = "Lexp";
            break Body;
          }
          jump = "Ldeclaration";
          break Body;

        case TOK.alias_:
        case TOK.const_:
        case TOK.abstract_:
        case TOK.extern_:
        case TOK.align_:
        case TOK.immutable_:
        case TOK.shared_:
        case TOK.inout_:
        case TOK.deprecated_:
        case TOK.nothrow_:
        case TOK.pure_:
        case TOK.gshared:
        case TOK.at:
        case TOK.struct_:
        case TOK.union_:
        case TOK.class_:
        case TOK.interface_:
          jump = "Ldeclaration";
          break Body;

        case TOK.enum_: {
          /* manifest constant declaration or conventional enum. */
          let d: Dsymbol;
          const tv = this.peekNext();
          if (tv === TOK.leftCurly || tv === TOK.colon) d = this.parseEnum();
          else if (tv !== TOK.identifier) {
            jump = "Ldeclaration";
            break Body;
          } else {
            const nextv = this.peekNext2();
            if (nextv === TOK.leftCurly || nextv === TOK.colon || nextv === TOK.semicolon) d = this.parseEnum();
            else {
              jump = "Ldeclaration";
              break Body;
            }
          }
          s = ExpStatement.fromDsymbol(loc, d);            // parse.d:6169 — this(Loc, Dsymbol)
          if (flags & ParseStatementFlags.scope_) s = new ScopeStatement(loc, s, this.token.loc);
          break Body;
        }
        case TOK.mixin_: {
          if (this.isDeclaration(this.token, NeedDeclaratorId.mustIfDstyle, TOK.reserved, null)) {
            jump = "Ldeclaration";
            break Body;
          }
          const tv = this.peekNext();
          if (tv === TOK.leftParenthesis) {
            // mixin(string)
            const e = this.parseAssignExp();
            this.checkFollowing(TOK.semicolon, ds("mixin"));
            if (e.op === EXP.mixin_) {
              const cpe = e as MixinExp;
              s = new MixinStatement(loc, cpe.exps);
            } else {
              s = new ExpStatement(loc, e);
            }
            break Body;
          } else if (tv === TOK.template_) {
            // mixin template
            this.nextToken();
            const d = this.parseTemplateDeclaration(true)!;
            s = ExpStatement.fromDsymbol(loc, d);          // parse.d:6200 — this(Loc, Dsymbol)
            break Body;
          }
          const d = this.parseMixin();
          s = ExpStatement.fromDsymbol(loc, d);            // parse.d:6204 — this(Loc, Dsymbol)
          if (flags & ParseStatementFlags.scope_) s = new ScopeStatement(loc, s, this.token.loc);
          break Body;
        }
        case TOK.leftCurly: {
          const lcLoc = this.token.loc;
          const lookingForElseSave = this.lookingForElse;
          this.lookingForElse = Loc.initial;

          this.nextToken();
          const statements = new DArray<Statement | null>();
          while ((this.token.value as TOK) !== TOK.rightCurly && (this.token.value as TOK) !== TOK.endOfFile) {
            statements.push(
              this.parseStatement(ParseStatementFlags.curlyScope | ParseStatementFlags.semiOk),
            );
          }
          if (endPtr) endPtr.value = this.token.ptr;
          this.endloc = this.token.loc;
          if (pEndloc) {
            pEndloc.value = this.token.loc;
            pEndloc = null; // don't set it again
          }
          s = new CompoundStatement(loc, statements);
          if (flags & (ParseStatementFlags.scope_ | ParseStatementFlags.curlyScope))
            s = new ScopeStatement(loc, s, this.token.loc);
          if ((this.token.value as TOK) !== TOK.rightCurly) {
            this.errorLoc(
              this.token.loc,
              ds("matching `}` expected following compound statement, not `%s`"),
              this.token.toChars(),
            );
            this.eSink.errorSupplemental(lcLoc, ds("unmatched `{`"));
          } else this.nextToken();
          this.lookingForElse = lookingForElseSave;
          break Body;
        }
        case TOK.while_: {
          this.nextToken();
          this.check(TOK.leftParenthesis);
          const param = this.parseAssignCondition();
          const condition = this.parseExpression();
          this.closeCondition(ds("while"), param, condition);

          const endloc_box: { value: Loc } = { value: new Loc() };
          const _body = this.parseStatement(ParseStatementFlags.scope_, null, endloc_box);
          s = new WhileStatement(loc, condition, _body, endloc_box.value, param);
          break Body;
        }
        case TOK.semicolon:
          if (!(flags & ParseStatementFlags.semiOk)) {
            this.error(ds("use `{ }` for an empty statement, not `;`"));
          }
          this.nextToken();
          s = new ExpStatement(loc, null);               // parse.d:6264 `cast(AST.Expression)null`
          break Body;

        case TOK.do_: {
          let _body: Statement;

          this.nextToken();
          const lookingForElseSave = this.lookingForElse;
          this.lookingForElse = Loc.initial;
          _body = this.parseStatement(ParseStatementFlags.scope_);
          this.lookingForElse = lookingForElseSave;
          this.check(TOK.while_);
          this.check(TOK.leftParenthesis);
          const condition = this.parseExpression();
          this.closeCondition(ds("do .. while"), null, condition);
          if ((this.token.value as TOK) === TOK.semicolon) this.nextToken();
          else this.error(ds("terminating `;` required after do-while statement"));
          s = new DoStatement(loc, _body, condition, this.token.loc);
          break Body;
        }
        case TOK.for_: {
          let _init: Statement | null;
          let condition: Expression | null;
          let increment: Expression | null;

          this.nextToken();
          this.check(TOK.leftParenthesis);
          if ((this.token.value as TOK) === TOK.semicolon) {
            _init = null;
            this.nextToken();
          } else {
            const lookingForElseSave = this.lookingForElse;
            this.lookingForElse = Loc.initial;
            _init = this.parseStatement(0);
            this.lookingForElse = lookingForElseSave;
          }
          if ((this.token.value as TOK) === TOK.semicolon) {
            condition = null;
            this.nextToken();
          } else {
            condition = this.parseExpression();
            this.checkFollowing(TOK.semicolon, ds("`for` condition"));
          }
          if ((this.token.value as TOK) === TOK.rightParenthesis) {
            increment = null;
            this.nextToken();
          } else {
            increment = this.parseExpression();
            this.check(TOK.rightParenthesis);
          }
          const endloc_box: { value: Loc } = { value: new Loc() };
          const _body = this.parseStatement(ParseStatementFlags.scope_, null, endloc_box);
          s = new ForStatement(loc, _init, condition, increment, _body, endloc_box.value);
          break Body;
        }
        case TOK.foreach_:
        case TOK.foreach_reverse_: {
          s = this.parseForeachStmt(loc);
          break Body;
        }
        case TOK.if_: {
          this.nextToken();
          this.check(TOK.leftParenthesis);
          const param = this.parseAssignCondition();
          const condition = this.parseExpression();
          this.closeCondition(ds("if"), param, condition);

          {
            const lookingForElseSave = this.lookingForElse;
            this.lookingForElse = loc;
            ifbody = this.parseStatement(ParseStatementFlags.scope_);
            this.lookingForElse = lookingForElseSave;
          }
          if ((this.token.value as TOK) === TOK.else_) {
            const elseloc = this.token.loc;
            this.nextToken();
            elsebody = this.parseStatement(ParseStatementFlags.scope_);
            this.checkDanglingElse(elseloc);
          } else elsebody = null;
          if (condition && ifbody) s = new IfStatement(loc, param, condition, ifbody, elsebody, this.token.loc);
          else s = null; // don't propagate parsing errors
          break Body;
        }

        case TOK.else_:
          this.error(ds("found `else` without a corresponding `if`, `version` or `debug` statement"));
          jump = "Lerror";
          break Body;

        case TOK.scope_:
          if (this.peekNext() !== TOK.leftParenthesis) {
            jump = "Ldeclaration"; // scope used as storage class
            break Body;
          }
          this.nextToken();
          this.check(TOK.leftParenthesis);
          if ((this.token.value as TOK) !== TOK.identifier) {
            this.error(ds("scope identifier expected"));
            jump = "Lerror";
            break Body;
          } else {
            let t = TOK.onScopeExit;
            const id = this.token.ident!;
            if (id === Id.exit) t = TOK.onScopeExit;
            else if (id === Id.failure) t = TOK.onScopeFailure;
            else if (id === Id.success) t = TOK.onScopeSuccess;
            else this.error(ds("valid scope identifiers are `exit`, `failure`, or `success`, not `%s`"), id.toChars());
            this.nextToken();
            this.check(TOK.rightParenthesis);
            const st = this.parseStatement(ParseStatementFlags.scope_);
            s = new ScopeGuardStatement(loc, t, st);
            break Body;
          }

        case TOK.debug_:
          this.nextToken();
          if ((this.token.value as TOK) === TOK.assign) {
            const dsx = this.parseDebugSpecification();
            if (dsx)
              this.eSink.error(
                dsx.loc,
                ds("%s `%s` declaration must be at module level"),
                dsx.kind(),
                dsx.toPrettyChars(),
              );
            break Body;
          }
          cond = this.parseDebugCondition();
          jump = "Lcondition";
          break Body;

        case TOK.version_:
          this.nextToken();
          if ((this.token.value as TOK) === TOK.assign) {
            const vs = this.parseVersionSpecification();
            if (vs)
              this.eSink.error(
                vs.loc,
                ds("%s `%s` declaration must be at module level"),
                vs.kind(),
                vs.toPrettyChars(),
              );
            break Body;
          }
          cond = this.parseVersionCondition();
          jump = "Lcondition";
          break Body;

        case TOK.pragma_: {
          let ident: Identifier;
          let args: Expressions | null = null;
          let _body: Statement | null;

          this.nextToken();
          this.check(TOK.leftParenthesis);
          if ((this.token.value as TOK) !== TOK.identifier) {
            this.error(ds("`pragma(identifier)` expected"));
            jump = "Lerror";
            break Body;
          }
          ident = this.token.ident!;
          this.nextToken();
          if ((this.token.value as TOK) === TOK.comma && this.peekNext() !== TOK.rightParenthesis)
            args = this.parseArguments(); // pragma(identifier, args...);
          else this.check(TOK.rightParenthesis); // pragma(identifier);
          if ((this.token.value as TOK) === TOK.semicolon) {
            this.nextToken();
            _body = null;
          } else _body = this.parseStatement(0);
          s = new PragmaStatement(loc, ident, args, _body);
          break Body;
        }
        case TOK.switch_:
          isfinal = false;
          jump = "Lswitch";
          break Body;

        case TOK.case_: {
          // D `AST.Expression exp;` — a nullable class ref; parse.d:6552 reassigns it from a raw
          // `cases` slot (`exp = cases[i - 1];`), so the TS local carries the same nullability.
          let exp: Expression | null;
          const cases = new DArray<Expression | null>(); // array of Expression's
          let last: Expression | null = null;

          this.nextToken();
          do {
            exp = this.parseAssignExp();
            cases.push(exp);
            if ((this.token.value as TOK) !== TOK.comma) break;
            this.nextToken(); //comma
          } while ((this.token.value as TOK) !== TOK.colon && (this.token.value as TOK) !== TOK.endOfFile);
          this.check(TOK.colon);

          /* case exp: .. case last: */
          if ((this.token.value as TOK) === TOK.slice) {
            if (cases.length > 1) this.error(ds("only one `case` allowed for start of case range"));
            this.nextToken();
            this.check(TOK.case_);
            last = this.parseAssignExp();
            this.check(TOK.colon);
          }

          if (flags & ParseStatementFlags.curlyScope) {
            const statements = new DArray<Statement | null>();
            while (
              (this.token.value as TOK) !== TOK.case_ &&
              (this.token.value as TOK) !== TOK.default_ &&
              (this.token.value as TOK) !== TOK.endOfFile &&
              (this.token.value as TOK) !== TOK.rightCurly
            ) {
              const cur = this.parseStatement(ParseStatementFlags.curlyScope);
              statements.push(cur);

              // https://issues.dlang.org/show_bug.cgi?id=21739 stop at the last break
              if (cur && cur.isBreakStatement()) break;
            }
            s = new CompoundStatement(loc, statements);
          } else {
            s = this.parseStatement(0);
          }
          s = new ScopeStatement(loc, s, this.token.loc);

          if (last) {
            s = new CaseRangeStatement(loc, exp, last, s);
          } else {
            // Keep cases in order by building the case statements backwards
            for (let i = cases.length; i; i--) {
              exp = cases.opIndex(i - 1);
              s = new CaseStatement(loc, exp, s);
            }
          }
          break Body;
        }
        case TOK.default_: {
          this.nextToken();
          this.check(TOK.colon);

          if (flags & ParseStatementFlags.curlyScope) {
            const statements = new DArray<Statement | null>();
            while (
              (this.token.value as TOK) !== TOK.case_ &&
              (this.token.value as TOK) !== TOK.default_ &&
              (this.token.value as TOK) !== TOK.endOfFile &&
              (this.token.value as TOK) !== TOK.rightCurly
            ) {
              statements.push(this.parseStatement(ParseStatementFlags.curlyScope));
            }
            s = new CompoundStatement(loc, statements);
          } else s = this.parseStatement(0);
          s = new ScopeStatement(loc, s, this.token.loc);
          s = new DefaultStatement(loc, s);
          break Body;
        }
        case TOK.return_: {
          let exp: Expression | null;
          this.nextToken();
          exp = (this.token.value as TOK) === TOK.semicolon ? null : this.parseExpression();
          this.checkFollowing(TOK.semicolon, ds("`return` statement"));
          s = new ReturnStatement(loc, exp);
          break Body;
        }
        case TOK.break_: {
          let ident: Identifier | null;
          this.nextToken();
          ident = null;
          if ((this.token.value as TOK) === TOK.identifier) {
            ident = this.token.ident!;
            this.nextToken();
          }
          this.checkFollowing(TOK.semicolon, ds("`break` statement"));
          s = new BreakStatement(loc, ident);
          break Body;
        }
        case TOK.continue_: {
          let ident: Identifier | null;
          this.nextToken();
          ident = null;
          if ((this.token.value as TOK) === TOK.identifier) {
            ident = this.token.ident!;
            this.nextToken();
          }
          this.checkFollowing(TOK.semicolon, ds("`continue` statement"));
          s = new ContinueStatement(loc, ident);
          break Body;
        }
        case TOK.goto_: {
          let ident: Identifier | null;
          this.nextToken();
          if ((this.token.value as TOK) === TOK.default_) {
            this.nextToken();
            s = new GotoDefaultStatement(loc);
          } else if ((this.token.value as TOK) === TOK.case_) {
            let exp: Expression | null = null;
            this.nextToken();
            if ((this.token.value as TOK) !== TOK.semicolon) exp = this.parseExpression();
            s = new GotoCaseStatement(loc, exp);
          } else {
            if ((this.token.value as TOK) !== TOK.identifier) {
              this.error(ds("identifier expected following `goto`"));
              ident = null;
            } else {
              ident = this.token.ident!;
              this.nextToken();
            }
            s = new GotoStatement(loc, ident);
          }
          this.checkFollowing(TOK.semicolon, ds("`goto` statement"));
          break Body;
        }
        case TOK.synchronized_: {
          let exp: Expression | null;
          let _body: Statement;

          const t_box: { value: Token } = { value: this.peek(this.token) };
          if (this.skipAttributes(t_box.value, t_box) && t_box.value.value === TOK.class_) {
            jump = "Ldeclaration";
            break Body;
          }

          this.nextToken();
          if ((this.token.value as TOK) === TOK.leftParenthesis) {
            this.nextToken();
            exp = this.parseExpression();
            this.closeCondition(ds("synchronized"), null, exp);
          } else exp = null;
          _body = this.parseStatement(ParseStatementFlags.scope_);
          s = new SynchronizedStatement(loc, exp, _body);
          break Body;
        }
        case TOK.with_: {
          let exp: Expression;
          let _body: Statement;
          const endloc_box: { value: Loc } = { value: loc };

          this.nextToken();
          this.check(TOK.leftParenthesis);
          const param = this.parseAssignCondition(true);
          exp = this.parseExpression();
          this.closeCondition(ds("with"), param, exp);
          _body = this.parseStatement(ParseStatementFlags.scope_, null, endloc_box);
          // reconciled to faithful surface (W2); sweeps at this file's retranslation:
          // statement.ts now carries the 1.43 `Parameter prm` slot and the 5-param ctor
          // (statement.d:1476/:1482), so the former wall on the `param != null` path is gone and
          // parse.d:6683 is reproduced verbatim, binding included.
          s = new WithStatement(loc, param, exp, _body, endloc_box.value);
          break Body;
        }
        case TOK.try_: {
          let _body: Statement;
          let catches: Catches | null = null;
          let finalbody: Statement | null = null;

          this.nextToken();
          const lookingForElseSave = this.lookingForElse;
          this.lookingForElse = Loc.initial;
          _body = this.parseStatement(ParseStatementFlags.scope_);
          this.lookingForElse = lookingForElseSave;
          while ((this.token.value as TOK) === TOK.catch_) {
            let handler: Statement;
            let c: Catch;
            let t: Type | null;
            let id: Identifier | null;
            const catchloc = this.token.loc;

            this.nextToken();
            if ((this.token.value as TOK) !== TOK.leftParenthesis) {
              this.deprecation(ds("`catch` statement without an exception specification is deprecated"));
              this.deprecationSupplemental(ds("use `catch(Throwable)` for old behavior"));
              t = null;
              id = null;
            } else {
              this.check(TOK.leftParenthesis);
              id = null;
              const id_box: { value: Identifier | null } = { value: null };
              t = this.parseType(id_box);
              id = id_box.value;
              this.check(TOK.rightParenthesis);
            }
            handler = this.parseStatement(0);
            c = new Catch(catchloc, t, id, handler);
            if (!catches) catches = new DArray<Catch | null>();
            catches.push(c);
          }

          if ((this.token.value as TOK) === TOK.finally_) {
            this.nextToken();
            finalbody = this.parseStatement(ParseStatementFlags.scope_);
          }

          s = _body;
          if (!catches && !finalbody) this.error(ds("`catch` or `finally` expected following `try`"));
          else {
            if (catches) s = new TryCatchStatement(loc, _body, catches);
            if (finalbody) s = new TryFinallyStatement(loc, s, finalbody);
          }
          break Body;
        }
        case TOK.throw_: {
          let exp: Expression;
          this.nextToken();
          exp = this.parseExpression();
          this.checkFollowing(TOK.semicolon, ds("`throw` statement"));
          s = new ThrowStatement(loc, exp);
          break Body;
        }

        case TOK.asm_:
          s = this.parseAsm(false);
          break Body;

        case TOK.import_: {
          /* https://issues.dlang.org/show_bug.cgi?id=16088 — ImportExpression vs ImportDeclaration */
          if (this.peekNext() === TOK.leftParenthesis) {
            const e = this.parseExpression();
            this.checkFollowing(TOK.semicolon, ds("`import` Expression"));
            s = new ExpStatement(loc, e);
          } else {
            const imports = this.parseImport();
            s = new ImportStatement(loc, imports);
            if (flags & ParseStatementFlags.scope_) s = new ScopeStatement(loc, s, this.token.loc);
          }
          break Body;
        }
        case TOK.template_: {
          const d = this.parseTemplateDeclaration()!;
          s = ExpStatement.fromDsymbol(loc, d);            // parse.d:6788 — this(Loc, Dsymbol)
          break Body;
        }
        default:
          this.error(ds("found `%s` instead of statement"), this.token.toChars());
          jump = "Lerror";
          break Body;
      }
    }

    // ── goto targets ──────────────────────────────────────────────────────────────────────────
    if (jump === "Ldeclaration") {
      const a = this.parseDeclarations(false, null, null);
      if (a.length > 1) {
        const as = new DArray<Statement | null>();
        as.reserve(a.length);
        // `a` slots are `Dsymbol | null` (08 §3); parse.d:6133-6134 hands the raw slot to the
        // `this(Loc, Dsymbol)` ctor, whose body neither dereferences nor null-tests it — no `!`
        // (D would build `DeclarationExp(loc, null)`, not fault).
        for (let i = 0; i < a.length; i++) {
          const d = a.opIndex(i);
          s = ExpStatement.fromDsymbol(loc, d);
          as.push(s);
        }
        s = new CompoundDeclarationStatement(loc, as);
      } else if (a.length === 1) {
        const d = a.opIndex(0);
        s = ExpStatement.fromDsymbol(loc, d);          // parse.d:6142
      } else s = new ExpStatement(loc, null);          // parse.d:6145 `cast(AST.Expression)null`
      if (flags & ParseStatementFlags.scope_) s = new ScopeStatement(loc, s, this.token.loc);
    } else if (jump === "Lexp") {
      const exp = this.parseExpression();
      /* https://issues.dlang.org/show_bug.cgi?id=15103 */
      if ((this.token.value as TOK) === TOK.identifier && exp.op === EXP.identifier) {
        this.errorLoc(
          this.token.loc,
          ds("found `%s` when expecting `;` or `=`, did you mean `%s %s = %s`?"),
          this.peek(this.token).toChars(),
          exp.toChars(),
          this.token.toChars(),
          this.peek(this.peek(this.token)).toChars(),
        );
        this.nextToken();
      } else {
        /* https://issues.dlang.org/show_bug.cgi?id=22529 */
        if ((this.token.value as TOK) !== TOK.semicolon && this.peek(this.token).value === TOK.semicolon)
          this.error(ds("found `%s` when expecting `;` following expression"), this.token.toChars());
        else {
          if ((this.token.value as TOK) !== TOK.semicolon) {
            this.error(ds("found `%s` when expecting `;` following expression"), this.token.toChars());
            this.eSink.errorSupplemental(exp.loc, ds("expression: `%s`"), exp.toChars());
          }
          this.nextToken();
        }
      }
      s = new ExpStatement(loc, exp);
    } else if (jump === "Lswitch") {
      this.nextToken();
      this.check(TOK.leftParenthesis);
      const param = this.parseAssignCondition();
      const condition = this.parseExpression();
      this.closeCondition(ds("switch"), null, condition);
      const _body = this.parseStatement(ParseStatementFlags.scope_);
      s = new SwitchStatement(loc, param, condition, _body, isfinal, this.token.loc);
    } else if (jump === "Lcondition") {
      {
        const lookingForElseSave = this.lookingForElse;
        this.lookingForElse = loc;
        ifbody = this.parseStatement(0);
        this.lookingForElse = lookingForElseSave;
      }
      elsebody = null;
      if ((this.token.value as TOK) === TOK.else_) {
        const elseloc = this.token.loc;
        this.nextToken();
        elsebody = this.parseStatement(0);
        this.checkDanglingElse(elseloc);
      }
      s = new ConditionalStatement(loc, cond, ifbody, elsebody);
      if (flags & ParseStatementFlags.scope_) s = new ScopeStatement(loc, s, this.token.loc);
    } else if (jump === "Lerror") {
      while (
        (this.token.value as TOK) !== TOK.rightCurly &&
        (this.token.value as TOK) !== TOK.semicolon &&
        (this.token.value as TOK) !== TOK.endOfFile
      )
        this.nextToken();
      if ((this.token.value as TOK) === TOK.semicolon) this.nextToken();
      s = new ErrorStatement();
    }

    if (pEndloc) pEndloc.value = this.prevloc;
    return s as Statement;
  }

  private parseExpInitializer(loc: Loc): ExpInitializer {
    const ae = this.parseAssignExp();
    return new ExpInitializer(loc, ae);
  }

  private parseStructInitializer(loc: Loc): Initializer {
    /* Scan ahead to discern between a struct initializer and parameterless function literal. */
    let braces = 1;
    let parens = 0;
    StructScan: for (let t = this.peek(this.token); true; t = this.peek(t)) {
      ScanSwitch: {
        switch (t.value) {
          case TOK.leftParenthesis:
            parens++;
            continue StructScan;
          case TOK.rightParenthesis:
            parens--;
            continue StructScan;
          // https://issues.dlang.org/show_bug.cgi?id=21163 lambda `scope` storage class
          case TOK.scope_:
            if (!parens) break ScanSwitch; // goto case (semicolon/keyword group)
            continue StructScan;
          /* Look for a semicolon or keyword of statements not requiring a semicolon. */
          case TOK.asm_:
          case TOK.class_:
          case TOK.debug_:
          case TOK.enum_:
          case TOK.if_:
          case TOK.interface_:
          case TOK.pragma_:
          case TOK.semicolon:
          case TOK.struct_:
          case TOK.switch_:
          case TOK.synchronized_:
          case TOK.try_:
          case TOK.union_:
          case TOK.version_:
          case TOK.while_:
          case TOK.with_:
            if (braces === 1) return this.parseExpInitializer(loc);
            continue StructScan;

          case TOK.leftCurly:
            braces++;
            continue StructScan;

          case TOK.rightCurly:
            if (--braces === 0) break StructScan; // break out of the for loop
            continue StructScan;

          case TOK.endOfFile:
            break StructScan;

          default:
            continue StructScan;
        }
      }
      // ScanSwitch fell through via `goto case` from `scope_`: re-handle as semicolon/keyword group.
      if (braces === 1) return this.parseExpInitializer(loc);
      continue StructScan;
    }

    const _is = new StructInitializer(loc);
    let commaExpected = false;
    this.nextToken();
    FillLoop: while (true) {
      switch ((this.token.value as TOK)) {
        case TOK.identifier: {
          if (commaExpected) this.error(ds("comma expected separating field initializers"));
          const t = this.peek(this.token);
          let id: Identifier | null = null;
          if (t.value === TOK.colon) {
            id = this.token.ident!;
            this.nextToken();
            this.nextToken(); // skip over ':'
          }
          const value = this.parseInitializer();
          _is.addInit(id as unknown as Identifier, value);
          commaExpected = true;
          continue;
        }
        case TOK.comma:
          if (!commaExpected) this.error(ds("expression expected, not `,`"));
          this.nextToken();
          commaExpected = false;
          continue;

        case TOK.rightCurly: // allow trailing comma's
          this.nextToken();
          break FillLoop;

        case TOK.endOfFile:
          this.error(ds("found end of file instead of initializer"));
          break FillLoop;

        default: {
          if (commaExpected) this.error(ds("comma expected separating field initializers"));
          const t = this.peek(this.token);
          if (t.value === TOK.colon) {
            this.error(ds("incorrect syntax for associative array, expected `[]`, found `{}`"));
            while ((this.token.value as TOK) !== TOK.rightCurly && (this.token.value as TOK) !== TOK.endOfFile) {
              this.nextToken();
            }
            if ((this.token.value as TOK) === TOK.rightCurly) {
              this.nextToken();
            }
            break FillLoop;
          }
          const value = this.parseInitializer();
          _is.addInit(null as unknown as Identifier, value);
          commaExpected = true;
          continue;
        }
      }
    }
    return _is;
  }

  /*****************************************
   * Parse initializer for variable declaration.
   */
  private parseInitializer(): Initializer {
    const loc = this.token.loc;

    switch ((this.token.value as TOK)) {
      case TOK.leftCurly:
        return this.parseStructInitializer(loc);

      case TOK.leftBracket: {
        /* Scan ahead to see if array initializer or expression. */
        let brackets = 1;
        ArrScan: for (let t = this.peek(this.token); true; t = this.peek(t)) {
          switch (t.value) {
            case TOK.leftBracket:
              brackets++;
              continue;

            case TOK.rightBracket:
              if (--brackets === 0) {
                t = this.peek(t);
                if (
                  t.value !== TOK.semicolon &&
                  t.value !== TOK.comma &&
                  t.value !== TOK.rightBracket &&
                  t.value !== TOK.rightCurly
                )
                  return this.parseExpInitializer(loc);
                break ArrScan;
              }
              continue;

            case TOK.endOfFile:
              break ArrScan;

            default:
              continue;
          }
        }

        const ia = new ArrayInitializer(loc);
        let commaExpected = false;

        this.nextToken();
        ArrFill: while (true) {
          switch ((this.token.value as TOK)) {
            default: {
              if (commaExpected) {
                this.error(ds("comma expected separating array initializers, not `%s`"), this.token.toChars());
                this.nextToken();
                break ArrFill;
              }
              let e: Expression | null = this.parseAssignExp();
              if (!e) break ArrFill;

              let value: Initializer;
              if ((this.token.value as TOK) === TOK.colon) {
                this.nextToken();
                value = this.parseInitializer();
              } else {
                value = new ExpInitializer(e.loc, e);
                e = null;
              }
              ia.addInit(e as unknown as Expression, value);
              commaExpected = true;
              continue;
            }

            case TOK.leftCurly:
            case TOK.leftBracket: {
              if (commaExpected)
                this.error(ds("comma expected separating array initializers, not `%s`"), this.token.toChars());
              let value = this.parseInitializer();
              let e: Expression | null = null;

              if ((this.token.value as TOK) === TOK.colon) {
                this.nextToken();
                const ei = value.isExpInitializer();
                if (ei) {
                  e = ei.exp;
                  value = this.parseInitializer();
                } else this.error(ds("initializer expression expected following colon, not `%s`"), this.token.toChars());
              }
              ia.addInit(e as unknown as Expression, value);
              commaExpected = true;
              continue;
            }

            case TOK.comma:
              if (!commaExpected) this.error(ds("expression expected, not `,`"));
              this.nextToken();
              commaExpected = false;
              continue;

            case TOK.rightBracket: // allow trailing comma's
              this.nextToken();
              break ArrFill;

            case TOK.endOfFile:
              this.error(ds("found `%s` instead of array initializer"), this.token.toChars());
              break ArrFill;
          }
        }
        return ia;
      }

      case TOK.void_: {
        const tv = this.peekNext();
        if (tv === TOK.semicolon || tv === TOK.comma) {
          this.nextToken();
          return new VoidInitializer(loc);
        }
        return this.parseExpInitializer(loc);
      }

      default:
        return this.parseExpInitializer(loc);
    }
  }

  /********************
   * Parse inline assembler block. Enters with token on the `asm`.
   */
  parseAsm(endOfLine: boolean): Statement {
    const loc = this.token.loc;
    let labelloc = new Loc();

    this.nextToken();
    const stc = this.parsePostfix(STC.none, null); // optional FunctionAttributes
    if (stc & (STC.const_ | STC.immutable_ | STC.shared_ | STC.wild))
      this.error(ds("`const`/`immutable`/`shared`/`inout` attributes are not allowed on `asm` blocks"));

    this.check(TOK.leftCurly);
    // toklist is a singly-linked Token list built via `*ptoklist = allocateToken(); ... ptoklist = &(*ptoklist).next`.
    let toklist: Token | null = null;
    let ptoklistOwner: { setNext: (t: Token | null) => void } = { setNext: (t) => (toklist = t) };
    let label: Identifier | null = null;
    const statements = new DArray<Statement | null>();
    let nestlevel = 0;
    AsmLoop: while (true) {
      if (endOfLine) this.nextDefineLine();
      switch ((this.token.value as TOK)) {
        case TOK.identifier:
          if (!toklist) {
            // Look ahead to see if it is a label
            if (this.peekNext() === TOK.colon) {
              // It's a label
              label = this.token.ident!;
              labelloc = this.token.loc;
              this.nextToken();
              this.nextToken();
              continue;
            }
          }
          // goto default
          ptoklistOwner = this.asmAppendToken(ptoklistOwner);
          this.nextToken();
          continue;

        case TOK.leftCurly:
          ++nestlevel;
          // goto default
          ptoklistOwner = this.asmAppendToken(ptoklistOwner);
          this.nextToken();
          continue;

        case TOK.rightCurly:
          if (nestlevel > 0) {
            --nestlevel;
            // goto default
            ptoklistOwner = this.asmAppendToken(ptoklistOwner);
            this.nextToken();
            continue;
          }
          if (toklist || label) {
            this.error(ds("`asm` statements must end in `;`"));
          }
          break AsmLoop;

        case TOK.endOfLine:
          this.nextDefineLine();
        // goto case TOK.semicolon (fallthrough)
        // eslint-disable-next-line no-fallthrough
        case TOK.semicolon: {
          if (nestlevel !== 0) this.error(ds("mismatched number of curly brackets"));

          if (toklist || label) {
            // Create AsmStatement from list of tokens we've saved
            const asx = new AsmStatement(this.token.loc, toklist);
            asx.caseSensitive = !endOfLine;
            let s: Statement = asx;
            toklist = null;
            ptoklistOwner = { setNext: (t) => (toklist = t) };
            if (label) {
              s = new LabelStatement(labelloc, label, s);
              label = null;
            }
            statements.push(s);
          }
          this.nextToken();
          continue;
        }

        case TOK.endOfFile:
          /* { */
          this.error(ds("matching `}` expected, not end of file"));
          break AsmLoop;

        default:
          ptoklistOwner = this.asmAppendToken(ptoklistOwner);
          this.nextToken();
          continue;
      }
    }
    this.nextToken();
    if ((this.token.value as TOK) === TOK.endOfLine) this.nextToken();
    const s = new CompoundAsmStatement(loc, statements, stc);
    return s;
  }

  /* The `*ptoklist = allocateToken(); **ptoklist = this.token; ptoklist = &(*ptoklist).next;
   * *ptoklist = null;` asm-token-append (parse.d:7181-7184). The D code allocates a fresh node and
   * value-copies the current token into it, appending to the singly-linked `toklist`. We use the
   * token's own `.copy()` as the node (the node identity in the list is all `AsmStatement` reads).
   * Returns the new tail owner so the next append links onto this node's `.next`. */
  private asmAppendToken(owner: { setNext: (t: Token | null) => void }): { setNext: (t: Token | null) => void } {
    const nt = this.token.copy(); // **ptoklist = this.token (value copy)
    nt.next = null;
    owner.setNext(nt);
    return { setNext: (t) => (nt.next = t) };
  }

  /**********************************
   * Issue error if the current token is not `value`, advance to next token.
   * D `check(value)` (parse.d:7217).
   */
  check(value: TOK): void {
    this.checkLoc(this.token.loc, value);
  }

  /* D `check(Loc loc, TOK value)` (parse.d:7204) — Form-B rename, distinct from `check(TOK)`. */
  checkLoc(loc: Loc, value: TOK): void {
    if ((this.token.value as TOK) !== value)
      this.errorLoc(loc, ds("found `%s` when expecting `%s`"), this.token.toChars(), Token.toCharsValue(value));
    this.nextToken();
  }

  /* D `check(TOK value, const(char)* string)` (parse.d:7229) — Form-B rename. */
  checkFollowing(value: TOK, string_: DString): void {
    if ((this.token.value as TOK) !== value)
      this.errorLoc(
        this.token.loc,
        ds("found `%s` when expecting `%s` following %s"),
        this.token.toChars(),
        Token.toCharsValue(value),
        string_,
      );
    this.nextToken();
  }

  private checkParens(value: TOK, e: Expression): void {
    if (precedence[e.op] === PREC.rel && !e.parens)
      this.errorLoc(
        e.loc,
        ds("`%s` must be surrounded by parentheses when next to operator `%s`"),
        e.toChars(),
        Token.toCharsValue(value),
      );
  }

  /************************************
   * Determine if the scanner is sitting on the start of a declaration. `t` is a Token (the D
   * `Token* t`); `pt` is an out-box `{value: Token}` or null.
   */
  private isDeclaration(t: Token, needId: NeedDeclaratorId, endtok: TOK, pt: { value: Token } | null): boolean {
    const haveId_box = { value: 0 };
    const haveTpl_box = { value: 0 };

    while (true) {
      if (
        (t.value === TOK.const_ || t.value === TOK.immutable_ || t.value === TOK.inout_ || t.value === TOK.shared_) &&
        this.peek(t).value !== TOK.leftParenthesis
      ) {
        /* const/immutable/shared/wild type */
        t = this.peek(t);
        continue;
      }
      break;
    }

    const t_box: { value: Token } = { value: t };
    if (!this.isBasicType(t_box)) {
      return false; // Lisnot
    }
    t = t_box.value;
    const t_box2: { value: Token } = { value: t };
    if (!this.isDeclarator(t_box2, haveId_box, haveTpl_box, endtok, needId !== NeedDeclaratorId.mustIfDstyle))
      return false; // Lisnot
    t = t_box2.value;
    const haveId = haveId_box.value;
    // needed for `__traits(compiles, arr[0] = 0)`
    if (!haveId && t.value === TOK.assign) return false; // Lisnot
    if (
      (needId === NeedDeclaratorId.no && !haveId) ||
      needId === NeedDeclaratorId.opt ||
      (needId === NeedDeclaratorId.must && haveId) ||
      (needId === NeedDeclaratorId.mustIfDstyle && haveId)
    ) {
      if (pt) pt.value = t;
      return true; // Lis
    }
    return false; // Lisnot
  }

  // pt = test token. If found, pt is set to the token after BasicType.
  private isBasicType(pt: { value: Token }): boolean {
    // This code parallels parseBasicType()
    let t = pt.value;
    switch (t.value) {
      case TOK.wchar_:
      case TOK.dchar_:
      case TOK.bool_:
      case TOK.char_:
      case TOK.int8:
      case TOK.uns8:
      case TOK.int16:
      case TOK.uns16:
      case TOK.int32:
      case TOK.uns32:
      case TOK.int64:
      case TOK.uns64:
      case TOK.int128:
      case TOK.uns128:
      case TOK.float32:
      case TOK.float64:
      case TOK.float80:
      case TOK.imaginary32:
      case TOK.imaginary64:
      case TOK.imaginary80:
      case TOK.complex32:
      case TOK.complex64:
      case TOK.complex80:
      case TOK.void_:
        t = this.peek(t);
        break;

      case TOK.identifier:
        // The D code is a tangle of L2/L3/L4/L5/Ldot/Lfalse gotos; reproduced via a labeled state machine.
        {
          const r = this.isBasicType_identifier(t);
          if (r === null) return false; // Lfalse
          t = r;
        }
        break;

      case TOK.dot:
        {
          const r = this.isBasicType_Ldot(t);
          if (r === null) return false;
          t = r;
        }
        break;

      case TOK.typeof_:
      case TOK.vector:
      case TOK.mixin_: {
        /* typeof(exp).identifier... */
        t = this.peek(t);
        const t_box: { value: Token } = { value: t };
        if (!this.skipParens(t, t_box)) return false; // Lfalse
        t = t_box.value;
        const r = this.isBasicType_L3(t);
        if (r === null) return false;
        t = r;
        break;
      }

      case TOK.traits: {
        // __traits(getMember
        t = this.peek(t);
        if (t.value !== TOK.leftParenthesis) return false; // Lfalse
        const lp = t;
        t = this.peek(t);
        if (t.value !== TOK.identifier || t.ident !== Id.getMember) return false; // Lfalse
        const lp_box: { value: Token } = { value: lp };
        if (!this.skipParens(lp, lp_box)) return false; // Lfalse
        const lp2 = lp_box.value;
        // we expect a declarator following __trait if it's a type.
        if (lp2.value !== TOK.identifier) return false; // Lfalse
        break;
      }

      case TOK.const_:
      case TOK.immutable_:
      case TOK.shared_:
      case TOK.inout_: {
        // const(type) / immutable(type) / shared(type) / wild(type)
        t = this.peek(t);
        if (t.value !== TOK.leftParenthesis) return false; // Lfalse
        t = this.peek(t);
        const t_box: { value: Token } = { value: t };
        if (!this.isDeclaration(t, NeedDeclaratorId.no, TOK.rightParenthesis, t_box)) {
          return false; // Lfalse
        }
        t = t_box.value;
        t = this.peek(t);
        break;
      }

      default:
        return false; // Lfalse
    }
    pt.value = t;
    return true;
  }

  /* The `case TOK.identifier: L5:` ... `goto L3`/`Ldot`/`L4`/`L2` web of isBasicType
   * (parse.d:7345-7442). Walks the dotted/template-instance type name. Returns the token after the
   * basic type, or null on failure. */
  private isBasicType_identifier(t: Token): Token | null {
    // L5: t = peek(t); if (!) goto L4; goto L3;
    // We model L2/L3/L4/L5/Ldot as a small dispatch.
    let state: "L5" | "L2" | "L3" | "L4" | "Ldot" = "L5";
    for (;;) {
      switch (state) {
        case "L5":
          t = this.peek(t);
          if (t.value === TOK.not) {
            state = "L4";
            continue;
          }
          state = "L3";
          continue;
        case "L2":
          t = this.peek(t);
          state = "L3";
          continue;
        case "L3":
          if (t.value === TOK.dot) {
            state = "Ldot";
            continue;
          }
          // break out of the `while(1)` -> return t (the outer `break; break;`)
          return t;
        case "Ldot":
          t = this.peek(t);
          if (t.value !== TOK.identifier) return null; // Lfalse
          t = this.peek(t);
          if (t.value !== TOK.not) {
            state = "L3";
            continue;
          }
          state = "L4";
          continue;
        case "L4": {
          /* Seen a ! — look for !( args ), !identifier, etc. */
          t = this.peek(t);
          switch (t.value) {
            case TOK.identifier:
              state = "L5";
              continue;

            case TOK.leftParenthesis: {
              const t_box: { value: Token } = { value: t };
              if (!this.skipParens(t, t_box)) return null; // Lfalse
              t = t_box.value;
              state = "L3";
              continue;
            }

            case TOK.wchar_:
            case TOK.dchar_:
            case TOK.bool_:
            case TOK.char_:
            case TOK.int8:
            case TOK.uns8:
            case TOK.int16:
            case TOK.uns16:
            case TOK.int32:
            case TOK.uns32:
            case TOK.int64:
            case TOK.uns64:
            case TOK.int128:
            case TOK.uns128:
            case TOK.float32:
            case TOK.float64:
            case TOK.float80:
            case TOK.imaginary32:
            case TOK.imaginary64:
            case TOK.imaginary80:
            case TOK.complex32:
            case TOK.complex64:
            case TOK.complex80:
            case TOK.void_:
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
            case TOK.null_:
            case TOK.true_:
            case TOK.false_:
            case TOK.charLiteral:
            case TOK.wcharLiteral:
            case TOK.dcharLiteral:
            case TOK.string_:
            case TOK.interpolated:
            case TOK.hexadecimalString:
            case TOK.file:
            case TOK.fileFullPath:
            case TOK.line:
            case TOK.moduleString:
            case TOK.functionString:
            case TOK.prettyFunction:
              state = "L2";
              continue;

            default:
              return null; // Lfalse
          }
        }
      }
    }
  }

  /* The `case TOK.dot: goto Ldot;` entry — runs the L3/Ldot state machine starting at Ldot. */
  private isBasicType_Ldot(t: Token): Token | null {
    // goto Ldot inside the identifier state-machine: re-enter at Ldot.
    let state: "L2" | "L3" | "L4" | "L5" | "Ldot" = "Ldot";
    return this.isBasicType_run(t, state);
  }

  private isBasicType_L3(t: Token): Token | null {
    return this.isBasicType_run(t, "L3");
  }

  /* Shared driver for the L2/L3/L4/L5/Ldot state machine (so the `dot`/`typeof` entries can start
   * at a different label than the `identifier` entry). */
  private isBasicType_run(t: Token, state: "L2" | "L3" | "L4" | "L5" | "Ldot"): Token | null {
    for (;;) {
      switch (state) {
        case "L5":
          t = this.peek(t);
          if (t.value === TOK.not) {
            state = "L4";
            continue;
          }
          state = "L3";
          continue;
        case "L2":
          t = this.peek(t);
          state = "L3";
          continue;
        case "L3":
          if (t.value === TOK.dot) {
            state = "Ldot";
            continue;
          }
          return t;
        case "Ldot":
          t = this.peek(t);
          if (t.value !== TOK.identifier) return null;
          t = this.peek(t);
          if (t.value !== TOK.not) {
            state = "L3";
            continue;
          }
          state = "L4";
          continue;
        case "L4": {
          t = this.peek(t);
          switch (t.value) {
            case TOK.identifier:
              state = "L5";
              continue;
            case TOK.leftParenthesis: {
              const t_box: { value: Token } = { value: t };
              if (!this.skipParens(t, t_box)) return null;
              t = t_box.value;
              state = "L3";
              continue;
            }
            case TOK.wchar_:
            case TOK.dchar_:
            case TOK.bool_:
            case TOK.char_:
            case TOK.int8:
            case TOK.uns8:
            case TOK.int16:
            case TOK.uns16:
            case TOK.int32:
            case TOK.uns32:
            case TOK.int64:
            case TOK.uns64:
            case TOK.int128:
            case TOK.uns128:
            case TOK.float32:
            case TOK.float64:
            case TOK.float80:
            case TOK.imaginary32:
            case TOK.imaginary64:
            case TOK.imaginary80:
            case TOK.complex32:
            case TOK.complex64:
            case TOK.complex80:
            case TOK.void_:
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
            case TOK.null_:
            case TOK.true_:
            case TOK.false_:
            case TOK.charLiteral:
            case TOK.wcharLiteral:
            case TOK.dcharLiteral:
            case TOK.string_:
            case TOK.interpolated:
            case TOK.hexadecimalString:
            case TOK.file:
            case TOK.fileFullPath:
            case TOK.line:
            case TOK.moduleString:
            case TOK.functionString:
            case TOK.prettyFunction:
              state = "L2";
              continue;
            default:
              return null;
          }
        }
      }
    }
  }

  private isDeclarator(
    pt: { value: Token },
    haveId: { value: number },
    haveTpl: { value: number } | null,
    endtok: TOK,
    allowAltSyntax = true,
  ): boolean {
    // This code parallels parseDeclarator()
    let t = pt.value;
    let parens: boolean;

    if (t.value === TOK.assign) return false;

    First: while (true) {
      parens = false;
      switch (t.value) {
        case TOK.mul:
          t = this.peek(t);
          continue;

        case TOK.leftBracket:
          t = this.peek(t);
          if (t.value === TOK.rightBracket) {
            t = this.peek(t);
          } else {
            const t_box: { value: Token } = { value: t };
            if (this.isDeclaration(t, NeedDeclaratorId.no, TOK.rightBracket, t_box)) {
              // It's an associative array declaration
              t = t_box.value;
              t = this.peek(t);

              // ...[type].ident
              if (t.value === TOK.dot && this.peek(t).value === TOK.identifier) {
                t = this.peek(t);
                t = this.peek(t);
              }
            } else {
              // [ expression ] / [ expression .. expression ]
              const t_box2: { value: Token } = { value: t };
              if (!this.isExpression(t_box2)) return false;
              t = t_box2.value;
              if (t.value === TOK.slice) {
                t = this.peek(t);
                const t_box3: { value: Token } = { value: t };
                if (!this.isExpression(t_box3)) return false;
                t = t_box3.value;
                if (t.value !== TOK.rightBracket) return false;
                t = this.peek(t);
              } else {
                if (t.value !== TOK.rightBracket) return false;
                t = this.peek(t);
                // ...[index].ident
                if (t.value === TOK.dot && this.peek(t).value === TOK.identifier) {
                  t = this.peek(t);
                  t = this.peek(t);
                }
              }
            }
          }
          continue;

        case TOK.identifier:
          if (haveId.value) return false;
          haveId.value = 1;
          t = this.peek(t);
          break First;

        case TOK.leftParenthesis: {
          if (!allowAltSyntax) return false; // Do not recognize C-style declarations.

          t = this.peek(t);
          if (t.value === TOK.rightParenthesis) return false; // () is not a declarator

          /* Regard ( identifier ) as not a declarator */
          if (t.value === TOK.identifier) {
            const t2 = this.peek(t);
            if (t2.value === TOK.rightParenthesis) return false;
          }

          const t_box: { value: Token } = { value: t };
          if (!this.isDeclarator(t_box, haveId, null, TOK.rightParenthesis)) return false;
          t = t_box.value;
          t = this.peek(t);
          parens = true;
          break First;
        }

        case TOK.delegate_:
        case TOK.function_: {
          t = this.peek(t);
          const t_box: { value: Token } = { value: t };
          if (!this.isParameters(t_box)) return false;
          t = t_box.value;
          const t_box2: { value: Token } = { value: t };
          this.skipAttributes(t, t_box2);
          t = t_box2.value;
          continue;
        }

        default:
          break First;
      }
    }

    Second: while (true) {
      switch (t.value) {
        // resolved: static if (CARRAYDECL) -> ON.
        case TOK.leftBracket: {
          parens = false;
          t = this.peek(t);
          if (t.value === TOK.rightBracket) {
            t = this.peek(t);
          } else {
            const t_box: { value: Token } = { value: t };
            if (this.isDeclaration(t, NeedDeclaratorId.no, TOK.rightBracket, t_box)) {
              // It's an associative array declaration
              t = t_box.value;
              t = this.peek(t);
            } else {
              // [ expression ]
              const t_box2: { value: Token } = { value: t };
              if (!this.isExpression(t_box2)) return false;
              t = t_box2.value;
              if (t.value !== TOK.rightBracket) return false;
              t = this.peek(t);
            }
          }
          continue;
        }

        case TOK.leftParenthesis: {
          parens = false;
          const tk = this.peekPastParen(t);
          if (tk) {
            if (tk.value === TOK.leftParenthesis) {
              if (!haveTpl) return false;
              haveTpl.value = 1;
              t = tk;
            } else if (tk.value === TOK.assign) {
              if (!haveTpl) return false;
              haveTpl.value = 1;
              pt.value = tk;
              return true;
            }
          }
          {
            const t_box: { value: Token } = { value: t };
            if (!this.isParameters(t_box)) return false;
            t = t_box.value;
          }
          while (true) {
            switch (t.value) {
              case TOK.const_:
              case TOK.immutable_:
              case TOK.shared_:
              case TOK.inout_:
              case TOK.pure_:
              case TOK.nothrow_:
              case TOK.return_:
              case TOK.scope_:
                t = this.peek(t);
                continue;

              case TOK.at:
                t = this.peek(t); // skip '@'
                t = this.peek(t); // skip identifier
                continue;

              default:
                break;
            }
            break;
          }
          continue;
        }

        // Valid tokens that follow the start of a declaration
        case TOK.rightParenthesis:
        case TOK.rightBracket:
        case TOK.assign:
        case TOK.comma:
        case TOK.dotDotDot:
        case TOK.semicolon:
        case TOK.leftCurly:
        case TOK.in_:
        case TOK.out_:
        case TOK.do_:
          // The !parens is to disallow unnecessary parentheses
          if (!parens && ((endtok as TOK) === TOK.reserved || endtok === t.value)) {
            pt.value = t;
            return true;
          }
          return false;

        // To recognize the shortened function declaration syntax
        case TOK.goesTo:
          if (haveId.value) {
            // goto case TOK.do_: the case body re-tests `endtok == t.value` against the CURRENT token
            if (!parens && ((endtok as TOK) === TOK.reserved || endtok === t.value)) {
              pt.value = t;
              return true;
            }
            return false;
          }
          return false; // goto default

        case TOK.identifier:
          if (t.ident === Id._body) {
            this.usageOfBodyKeyword();
            // goto case TOK.do_: the case body re-tests `endtok == t.value` against the CURRENT token
            if (!parens && ((endtok as TOK) === TOK.reserved || endtok === t.value)) {
              pt.value = t;
              return true;
            }
            return false;
          }
          return false; // goto default

        case TOK.if_:
          return haveTpl ? true : false;

        // Used for mixin type parsing
        case TOK.endOfFile:
          if (endtok === TOK.endOfFile) {
            // goto case TOK.do_: the case body re-tests `endtok == t.value` against the CURRENT token
            if (!parens && ((endtok as TOK) === TOK.reserved || endtok === t.value)) {
              pt.value = t;
              return true;
            }
            return false;
          }
          return false;

        default:
          return false;
      }
    }
  }

  private isParameters(pt: { value: Token }): boolean {
    // This code parallels parseParameterList(). The D body is `for (; 1; t = peek(t))` with an
    // `L1:` re-entry (re-run the switch WITHOUT advancing) and an `L2:` label inside `default:`
    // reached by `goto L2` from the `const(...)` case and by `goto default` from the `@` case.
    // Reproduced via an explicit `action` state: "loop" advances then re-runs the switch; "same"
    // re-runs without advancing (goto L1); "default"/"L2" jump into the default body.
    let t = pt.value;

    if (t.value !== TOK.leftParenthesis) return false;

    t = this.peek(t);
    let action: "switch" | "L2" | "default" = "switch";
    for (;;) {
      if (action === "switch") {
        let advance = true; // whether the trailing `t = peek(t)` of the for-loop runs
        let fallToDefault = false;
        switch (t.value) {
          case TOK.rightParenthesis:
            // break -> exit the for loop
            if (t.value !== TOK.rightParenthesis) return false;
            t = this.peek(t);
            pt.value = t;
            return true;

          case TOK.at: {
            const pastAttr_box: { value: Token } = { value: t };
            if (this.skipAttributes(t, pastAttr_box)) {
              t = pastAttr_box.value;
              action = "default"; // goto default
              continue;
            }
            // break -> exit for loop -> rightParenthesis check
            if ((t.value as TOK) !== TOK.rightParenthesis) return false;
            t = this.peek(t);
            pt.value = t;
            return true;
          }

          case TOK.dotDotDot:
            t = this.peek(t);
            // break -> exit for loop -> rightParenthesis check
            if (t.value !== TOK.rightParenthesis) return false;
            t = this.peek(t);
            pt.value = t;
            return true;

          case TOK.in_:
          case TOK.out_:
          case TOK.ref_:
          case TOK.lazy_:
          case TOK.scope_:
          case TOK.final_:
          case TOK.auto_:
          case TOK.return_:
            // continue -> the for-loop advances t
            break;

          case TOK.const_:
          case TOK.immutable_:
          case TOK.shared_:
          case TOK.inout_:
            t = this.peek(t);
            if (t.value === TOK.leftParenthesis) {
              t = this.peek(t);
              {
                const t_box: { value: Token } = { value: t };
                if (!this.isDeclaration(t, NeedDeclaratorId.no, TOK.rightParenthesis, t_box)) return false;
                t = t_box.value;
              }
              t = this.peek(t); // skip past closing ')'
              action = "L2"; // goto L2
              continue;
            }
            action = "switch"; // goto L1 (re-run switch without advancing)
            advance = false;
            break;

          default:
            fallToDefault = true;
            break;
        }
        if (fallToDefault) {
          action = "default";
          continue;
        }
        if (advance) t = this.peek(t);
        continue;
      }

      // default: body — runs isBasicType, then the L2 label.
      if (action === "default") {
        const t_box: { value: Token } = { value: t };
        if (!this.isBasicType(t_box)) return false;
        t = t_box.value;
        action = "L2";
      }

      // L2: label
      if (action === "L2") {
        const tmp_box = { value: 0 };
        if (t.value !== TOK.dotDotDot) {
          const t_box: { value: Token } = { value: t };
          if (!this.isDeclarator(t_box, tmp_box, null, TOK.reserved)) return false;
          t = t_box.value;
        }
        if (t.value === TOK.assign) {
          t = this.peek(t);
          const t_box: { value: Token } = { value: t };
          if (!this.isExpression(t_box)) return false;
          t = t_box.value;
        }
        if (t.value === TOK.dotDotDot) {
          t = this.peek(t);
          // break -> exit for loop -> rightParenthesis check
          if (t.value !== TOK.rightParenthesis) return false;
          t = this.peek(t);
          pt.value = t;
          return true;
        }
        if (t.value === TOK.comma) {
          // continue -> the for-loop advances t and re-runs the switch
          t = this.peek(t);
          action = "switch";
          continue;
        }
        // break -> exit for loop -> rightParenthesis check
        if (t.value !== TOK.rightParenthesis) return false;
        t = this.peek(t);
        pt.value = t;
        return true;
      }
    }
  }

  private isExpression(pt: { value: Token }): boolean {
    // Scan until a closing right bracket is found.
    let t = pt.value;
    let brnest = 0;
    let panest = 0;
    let curlynest = 0;

    ExprLoop: for (;; t = this.peek(t)) {
      switch (t.value) {
        case TOK.leftBracket:
          brnest++;
          continue;

        case TOK.rightBracket:
          if (--brnest >= 0) continue;
          break ExprLoop;

        case TOK.leftParenthesis:
          panest++;
          continue;

        case TOK.comma:
          if (brnest || panest) continue;
          break ExprLoop;

        case TOK.rightParenthesis:
          if (--panest >= 0) continue;
          break ExprLoop;

        case TOK.leftCurly:
          curlynest++;
          continue;

        case TOK.rightCurly:
          if (--curlynest >= 0) continue;
          return false;

        case TOK.slice:
          if (brnest) continue;
          break ExprLoop;

        case TOK.semicolon:
          if (curlynest) continue;
          return false;

        case TOK.endOfFile:
          return false;

        default:
          continue;
      }
    }

    pt.value = t;
    return true;
  }

  /*******************************************
   * Skip parentheses. `t` on opening '('; `pt` set to token past ')'.
   */
  skipParens(t: Token, pt: { value: Token } | null): boolean {
    if (t.value !== TOK.leftParenthesis) return false;

    let parens = 0;

    while (true) {
      let done = false;
      switch (t.value) {
        case TOK.leftParenthesis:
          parens++;
          break;

        case TOK.rightParenthesis:
          parens--;
          if (parens < 0) return false; // Lfalse
          if (parens === 0) {
            done = true;
            break;
          }
          break;

        case TOK.endOfFile:
          return false; // Lfalse

        default:
          break;
      }
      if (done) break; // Ldone
      t = this.peek(t);
    }
    // Ldone:
    if (pt) pt.value = this.peek(t); // skip found rparen
    return true;
  }

  private skipParensIf(t: Token, pt: { value: Token } | null): boolean {
    if (t.value !== TOK.leftParenthesis) {
      if (pt) pt.value = t;
      return true;
    }
    return this.skipParens(t, pt);
  }

  //returns true if the next value (after optional matching parens) is expected
  private hasOptionalParensThen(t: Token, expected: TOK): boolean {
    const tk_box: { value: Token } = { value: t };
    if (!this.skipParensIf(t, tk_box)) return false;
    return tk_box.value.value === expected;
  }

  /*******************************************
   * Skip attributes. Input: `t` on a candidate attribute. Output: `*pt` first non-attribute token.
   */
  private skipAttributes(t: Token, pt: { value: Token } | null): boolean {
    while (true) {
      switch (t.value) {
        case TOK.const_:
        case TOK.immutable_:
        case TOK.shared_:
        case TOK.inout_:
        case TOK.final_:
        case TOK.auto_:
        case TOK.scope_:
        case TOK.override_:
        case TOK.abstract_:
        case TOK.synchronized_:
          break;

        case TOK.deprecated_:
          if (this.peek(t).value === TOK.leftParenthesis) {
            t = this.peek(t);
            const t_box: { value: Token } = { value: t };
            if (!this.skipParens(t, t_box)) return false; // Lerror
            t = t_box.value;
            // t is on the next of closing parenthesis
            continue;
          }
          break;

        case TOK.nothrow_:
        case TOK.pure_:
        case TOK.ref_:
        case TOK.gshared:
        case TOK.return_:
          break;

        case TOK.at:
          t = this.peek(t);
          if (t.value === TOK.identifier) {
            /* @identifier / @identifier!arg / @identifier!(arglist) / @predefined_attribute */
            if (Parser.isBuiltinAtAttribute(t.ident!)) break;
            t = this.peek(t);
            if (t.value === TOK.not) {
              t = this.peek(t);
              if (t.value === TOK.leftParenthesis) {
                // @identifier!(arglist)
                const t_box: { value: Token } = { value: t };
                if (!this.skipParens(t, t_box)) return false; // Lerror
                t = t_box.value;
              } else {
                // @identifier!arg — low rent skipTemplateArgument
                if (t.value === TOK.vector) {
                  // identifier!__vector(type)
                  t = this.peek(t);
                  const t_box: { value: Token } = { value: t };
                  if (!this.skipParens(t, t_box)) return false; // Lerror
                  t = t_box.value;
                } else t = this.peek(t);
              }
            }
            if (t.value === TOK.leftParenthesis) {
              const t_box: { value: Token } = { value: t };
              if (!this.skipParens(t, t_box)) return false; // Lerror
              t = t_box.value;
              // t is on the next of closing parenthesis
              continue;
            }
            continue;
          }
          if (t.value === TOK.leftParenthesis) {
            // @( ArgumentList )
            const t_box: { value: Token } = { value: t };
            if (!this.skipParens(t, t_box)) return false; // Lerror
            t = t_box.value;
            // t is on the next of closing parenthesis
            continue;
          }
          return false; // Lerror

        default:
          // Ldone
          if (pt) pt.value = t;
          return true;
      }
      t = this.peek(t);
    }
  }

  parseExpression(): Expression {
    let loc = this.token.loc;

    let e = this.parseAssignExp();
    while ((this.token.value as TOK) === TOK.comma) {
      this.nextToken();
      const e2 = this.parseAssignExp();
      e = new CommaExp(loc, e, e2, false);
      loc = this.token.loc;
    }
    return e;
  }

  /********************************* Expression Parser ***************************/

  parsePrimaryExp(): Expression {
    let e: Expression;
    let t: Type;
    let id: Identifier;
    const loc = this.token.loc;

    let jumpDelegate = false; // `goto case_delegate`
    let jumpLerr = false; // `goto Lerr`

    Body: {
      switch ((this.token.value as TOK)) {
        case TOK.identifier: {
          if (this.peekNext() === TOK.arrow) {
            // skip `identifier ->`
            this.nextToken();
            this.nextToken();
            this.error(ds("use `.` for member lookup, not `->`"));
            jumpLerr = true;
            break Body;
          }

          if (this.peekNext() === TOK.goesTo) {
            jumpDelegate = true;
            break Body;
          }

          id = this.token.ident!;
          this.nextToken();
          let save: TOK;
          if ((this.token.value as TOK) === TOK.not && (save = this.peekNext()) !== TOK.is_ && save !== TOK.in_) {
            // identifier!(template-argument-list)
            const tempinst = new TemplateInstance(loc, id, this.parseTemplateArguments());
            e = new ScopeExp(loc, tempinst as unknown as ScopeDsymbol);
          } else e = new IdentifierExp(loc, id);
          break Body;
        }
        case TOK.dollar:
          if (!this.inBrackets) this.error(ds("`$` is valid only inside [] of index or slice"));
          e = new DollarExp(loc);
          this.nextToken();
          break Body;

        case TOK.dot:
          // Signal global scope '.' operator with "" identifier
          e = new IdentifierExp(loc, Id.empty);
          break Body;

        case TOK.this_:
          e = new ThisExp(loc);
          this.nextToken();
          break Body;

        case TOK.super_:
          e = new SuperExp(loc);
          this.nextToken();
          break Body;

        case TOK.int32Literal:
          e = new IntegerExp(loc, this.token.intvalue, Type.tint32);
          this.nextToken();
          break Body;

        case TOK.uns32Literal:
          e = new IntegerExp(loc, this.token.unsvalue, Type.tuns32);
          this.nextToken();
          break Body;

        case TOK.int64Literal:
          e = new IntegerExp(loc, this.token.intvalue, Type.tint64);
          this.nextToken();
          break Body;

        case TOK.uns64Literal:
          e = new IntegerExp(loc, this.token.unsvalue, Type.tuns64);
          this.nextToken();
          break Body;

        case TOK.float32Literal:
          e = new RealExp(loc, this.token.floatvalue, Type.tfloat32);
          this.nextToken();
          break Body;

        case TOK.float64Literal:
          e = new RealExp(loc, this.token.floatvalue, Type.tfloat64);
          this.nextToken();
          break Body;

        case TOK.float80Literal:
          e = new RealExp(loc, this.token.floatvalue, Type.tfloat80);
          this.nextToken();
          break Body;

        case TOK.imaginary32Literal:
          e = new RealExp(loc, this.token.floatvalue, Type.timaginary32);
          this.nextToken();
          break Body;

        case TOK.imaginary64Literal:
          e = new RealExp(loc, this.token.floatvalue, Type.timaginary64);
          this.nextToken();
          break Body;

        case TOK.imaginary80Literal:
          e = new RealExp(loc, this.token.floatvalue, Type.timaginary80);
          this.nextToken();
          break Body;

        case TOK.null_:
          e = new NullExp(loc);
          this.nextToken();
          break Body;

        case TOK.file:
          e = new FileInitExp(loc, EXP.file);
          this.nextToken();
          break Body;
        case TOK.fileFullPath:
          e = new FileInitExp(loc, EXP.fileFullPath);
          this.nextToken();
          break Body;

        case TOK.line:
          e = new LineInitExp(loc);
          this.nextToken();
          break Body;

        case TOK.moduleString:
          e = new ModuleInitExp(loc);
          this.nextToken();
          break Body;
        case TOK.functionString:
          e = new FuncInitExp(loc);
          this.nextToken();
          break Body;

        case TOK.prettyFunction:
          e = new PrettyFuncInitExp(loc);
          this.nextToken();
          break Body;

        case TOK.true_:
          e = new IntegerExp(loc, 1n, Type.tbool);
          this.nextToken();
          break Body;

        case TOK.false_:
          e = new IntegerExp(loc, 0n, Type.tbool);
          this.nextToken();
          break Body;

        case TOK.charLiteral:
          e = new IntegerExp(loc, this.token.unsvalue, Type.tchar);
          this.nextToken();
          break Body;

        case TOK.wcharLiteral:
          e = new IntegerExp(loc, this.token.unsvalue, Type.twchar);
          this.nextToken();
          break Body;

        case TOK.dcharLiteral:
          e = new IntegerExp(loc, this.token.unsvalue, Type.tdchar);
          this.nextToken();
          break Body;

        case TOK.interpolated:
          e = new InterpExp(loc, this.token.interpolatedSet, this.token.postfix);
          this.nextToken();
          break Body;

        case TOK.string_:
        case TOK.hexadecimalString: {
          const hexString = (this.token.value as TOK) === TOK.hexadecimalString;
          {
            // cat adjacent strings
            let s = this.token.ustring;
            let len = this.token.len;
            let postfix = this.token.postfix;
            while (true) {
              // D `const prev = token;` copies the Token struct; an alias would be overwritten by nextToken()
              const prev = this.token.copy();
              this.nextToken();
              if ((this.token.value as TOK) === TOK.string_ || (this.token.value as TOK) === TOK.hexadecimalString) {
                if (this.token.postfix) {
                  if (this.token.postfix !== postfix)
                    this.errorLoc(
                      this.token.loc,
                      ds("mismatched string literal postfixes `'%c'` and `'%c'`"),
                      postfix,
                      this.token.postfix,
                    );
                  postfix = this.token.postfix;
                }

                this.error(ds("implicit string concatenation is error-prone and disallowed in D"));
                this.eSink.errorSupplemental(
                  this.token.loc,
                  ds("Use the explicit syntax instead (concatenating literals is `@nogc`): %s ~ %s"),
                  prev.toChars(),
                  this.token.toChars(),
                );

                const len1 = len;
                const len2 = this.token.len;
                len = len1 + len2;
                const s2 = new Uint8Array(len);
                if (s) s2.set(s.subarray(0, len1), 0);
                if (this.token.ustring) s2.set(this.token.ustring.subarray(0, len2), len1);
                s = s2;
              } else break;
            }
            const arr: number[] = s ? Array.from(s.subarray(0, len)) : [];
            e = new StringExp(loc, arr, len, 1, postfix);
            e.isStringExp()!.hexString = hexString;
            break Body;
          }
        }
        case TOK.void_:
          t = Type.tvoid;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.int8:
          t = Type.tint8;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.uns8:
          t = Type.tuns8;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.int16:
          t = Type.tint16;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.uns16:
          t = Type.tuns16;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.int32:
          t = Type.tint32;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.uns32:
          t = Type.tuns32;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.int64:
          t = Type.tint64;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.uns64:
          t = Type.tuns64;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.int128:
          t = Type.tint128;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.uns128:
          t = Type.tuns128;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.float32:
          t = Type.tfloat32;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.float64:
          t = Type.tfloat64;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.float80:
          t = Type.tfloat80;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.imaginary32:
          t = Type.timaginary32;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.imaginary64:
          t = Type.timaginary64;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.imaginary80:
          t = Type.timaginary80;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.complex32:
          t = Type.tcomplex32;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.complex64:
          t = Type.tcomplex64;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.complex80:
          t = Type.tcomplex80;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.bool_:
          t = Type.tbool;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.char_:
          t = Type.tchar;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.wchar_:
          t = Type.twchar;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;
        case TOK.dchar_:
          t = Type.tdchar;
          {
            const ex = this.parsePrimaryExp_LabelX(loc, t);
            if (ex === null) {
              jumpLerr = true;
              break Body;
            }
            e = ex;
          }
          break Body;

        case TOK.typeof_: {
          t = this.parseTypeof();
          e = new TypeExp(loc, t);
          break Body;
        }
        case TOK.vector: {
          t = this.parseVector();
          e = new TypeExp(loc, t);
          break Body;
        }
        case TOK.typeid_: {
          this.nextToken();
          this.checkFollowing(TOK.leftParenthesis, ds("`typeid`"));
          const o = this.parseTypeOrAssignExp();
          this.check(TOK.rightParenthesis);
          e = new TypeidExp(loc, o);
          break Body;
        }
        case TOK.rvalue: {
          this.nextToken();
          this.checkFollowing(TOK.leftParenthesis, ds("`__rvalue`"));
          e = this.parseAssignExp();
          e.rvalue = true;
          this.check(TOK.rightParenthesis);
          break Body;
        }
        case TOK.traits: {
          /* __traits(identifier, args...) */
          let ident: Identifier;
          let args: Objects | null = null;

          this.nextToken();
          this.check(TOK.leftParenthesis);
          if ((this.token.value as TOK) !== TOK.identifier) {
            this.error(ds("`__traits(identifier, args...)` expected"));
            jumpLerr = true;
            break Body;
          }
          ident = this.token.ident!;
          this.nextToken();
          if ((this.token.value as TOK) === TOK.comma)
            args = this.parseTemplateArgumentList(); // __traits(identifier, args...)
          else this.check(TOK.rightParenthesis); // __traits(identifier)

          e = new TraitsExp(loc, ident, args);
          break Body;
        }
        case TOK.is_: {
          let targ: Type | null;
          let ident: Identifier | null = null;
          let tspec: Type | null = null;
          let tok = TOK.reserved;
          let tok2 = TOK.reserved;
          let tpl: TemplateParameters | null = null;

          this.nextToken();
          if ((this.token.value as TOK) !== TOK.leftParenthesis) {
            this.error(ds("expected `(` following `is`, not `%s`"), this.token.toChars());
            jumpLerr = true;
            break Body;
          } else {
            this.nextToken();
            if ((this.token.value as TOK) === TOK.identifier && this.peekNext() === TOK.leftParenthesis) {
              this.errorLoc(loc, ds("unexpected `(` after `%s`, inside `is` expression"), this.token.toChars());
              this.errorSupplemental(ds("try enclosing the contents of `is` with a `typeof` expression"));
              this.nextToken();
              const tempTok = this.peekPastParen(this.token);
              this.token = tempTok;
              jumpLerr = true;
              break Body;
            }
            const ident_box: { value: Identifier | null } = { value: null };
            targ = this.parseType(ident_box);
            ident = ident_box.value;
            if ((this.token.value as TOK) === TOK.colon || (this.token.value as TOK) === TOK.equal) {
              tok = (this.token.value as TOK);
              this.nextToken();
              if (
                tok === TOK.equal &&
                ((this.token.value as TOK) === TOK.struct_ ||
                  (this.token.value as TOK) === TOK.union_ ||
                  (this.token.value as TOK) === TOK.class_ ||
                  (this.token.value as TOK) === TOK.super_ ||
                  (this.token.value as TOK) === TOK.enum_ ||
                  (this.token.value as TOK) === TOK.interface_ ||
                  (this.token.value as TOK) === TOK.package_ ||
                  (this.token.value as TOK) === TOK.module_ ||
                  (this.token.value as TOK) === TOK.argumentTypes ||
                  (this.token.value as TOK) === TOK.parameters ||
                  ((this.token.value as TOK) === TOK.const_ && this.peekNext() === TOK.rightParenthesis) ||
                  ((this.token.value as TOK) === TOK.immutable_ && this.peekNext() === TOK.rightParenthesis) ||
                  ((this.token.value as TOK) === TOK.shared_ && this.peekNext() === TOK.rightParenthesis) ||
                  ((this.token.value as TOK) === TOK.inout_ && this.peekNext() === TOK.rightParenthesis) ||
                  (this.token.value as TOK) === TOK.function_ ||
                  (this.token.value as TOK) === TOK.delegate_ ||
                  (this.token.value as TOK) === TOK.return_ ||
                  ((this.token.value as TOK) === TOK.vector && this.peekNext() === TOK.rightParenthesis))
              ) {
                tok2 = (this.token.value as TOK);
                this.nextToken();
              } else {
                tspec = this.parseType();
              }
            }
            if (tspec) {
              if ((this.token.value as TOK) === TOK.comma) tpl = this.parseTemplateParameterList(1);
              else {
                tpl = new DArray<TemplateParameter | null>();
                this.check(TOK.rightParenthesis);
              }
            } else this.check(TOK.rightParenthesis);
          }
          e = new IsExp(loc, targ, ident, tok, tspec, tok2, tpl);
          break Body;
        }
        case TOK.assert_: {
          // https://dlang.org/spec/expression.html#assert_expressions
          let msg: Expression | null = null;

          this.nextToken();
          this.checkFollowing(TOK.leftParenthesis, ds("`assert`"));
          e = this.parseAssignExp();
          if ((this.token.value as TOK) === TOK.comma) {
            this.nextToken();
            if ((this.token.value as TOK) !== TOK.rightParenthesis) {
              msg = this.parseAssignExp();
              if ((this.token.value as TOK) === TOK.comma) this.nextToken();
            }
          }
          this.check(TOK.rightParenthesis);
          e = new AssertExp(loc, e, msg);
          break Body;
        }
        case TOK.mixin_: {
          // https://dlang.org/spec/expression.html#mixin_expressions
          this.nextToken();
          if ((this.token.value as TOK) !== TOK.leftParenthesis)
            this.errorLoc(
              this.token.loc,
              ds("found `%s` when expecting `%s` following `mixin`"),
              this.token.toChars(),
              Token.toCharsValue(TOK.leftParenthesis),
            );
          const exps = this.parseArguments();
          e = new MixinExp(loc, exps);
          break Body;
        }
        case TOK.import_: {
          this.nextToken();
          this.checkFollowing(TOK.leftParenthesis, ds("`import`"));
          e = this.parseAssignExp();
          this.check(TOK.rightParenthesis);
          e = new ImportExp(loc, e);
          break Body;
        }
        case TOK.new_:
          e = this.parseNewExp(null);
          break Body;

        case TOK.auto_: {
          if (this.peekNext() === TOK.ref_ && this.peekNext2() === TOK.leftParenthesis) {
            const tk_box: { value: Token } = { value: this.peekPastParen(this.peek(this.peek(this.token))) };
            if (this.skipAttributes(tk_box.value, tk_box) && (tk_box.value.value === TOK.goesTo || tk_box.value.value === TOK.leftCurly)) {
              // auto ref (arguments) => expression / { statements... }
              jumpDelegate = true;
              break Body;
            }
          }
          this.nextToken();
          this.error(ds("found `%s` when expecting `ref` and function literal following `auto`"), this.token.toChars());
          jumpLerr = true;
          break Body;
        }
        case TOK.ref_: {
          if (this.peekNext() === TOK.leftParenthesis) {
            const tk_box: { value: Token } = { value: this.peekPastParen(this.peek(this.token)) };
            if (this.skipAttributes(tk_box.value, tk_box) && (tk_box.value.value === TOK.goesTo || tk_box.value.value === TOK.leftCurly)) {
              // ref (arguments) => expression / { statements... }
              jumpDelegate = true;
              break Body;
            }
          }
          this.nextToken();
          this.error(ds("found `%s` when expecting function literal following `ref`"), this.token.toChars());
          jumpLerr = true;
          break Body;
        }
        case TOK.leftParenthesis: {
          const tk_box: { value: Token } = { value: this.peekPastParen(this.token) };
          if (this.skipAttributes(tk_box.value, tk_box) && (tk_box.value.value === TOK.goesTo || tk_box.value.value === TOK.leftCurly)) {
            // (arguments) => expression / { statements... }
            jumpDelegate = true;
            break Body;
          }

          // ( expression )
          this.nextToken();
          e = this.parseExpression();
          e.parens = true;
          this.checkLoc(loc, TOK.rightParenthesis);
          break Body;
        }
        case TOK.leftBracket: {
          /* array literals and associative array literals */
          const values = new DArray<Expression | null>();
          let keys: Expressions | null = null;

          this.nextToken();
          while ((this.token.value as TOK) !== TOK.rightBracket && (this.token.value as TOK) !== TOK.endOfFile) {
            e = this.parseAssignExp();
            if ((this.token.value as TOK) === TOK.colon && (keys || values.length === 0)) {
              this.nextToken();
              if (!keys) keys = new DArray<Expression | null>();
              keys.push(e);
              e = this.parseAssignExp();
            } else if (keys) {
              this.error(ds("`key:value` expected for associative array literal"));
              keys = null;
            }
            values.push(e);
            if ((this.token.value as TOK) === TOK.rightBracket) break;
            this.check(TOK.comma);
          }
          this.checkLoc(loc, TOK.rightBracket);

          if (keys) e = new AssocArrayLiteralExp(loc, keys, values);
          else e = new ArrayLiteralExp(loc, null, values);
          break Body;
        }
        case TOK.leftCurly:
        case TOK.function_:
        case TOK.delegate_:
          jumpDelegate = true;
          break Body;

        default:
          this.error(ds("expression expected, not `%s`"), this.token.toChars());
          jumpLerr = true;
          break Body;
      }
    }

    if (jumpDelegate) {
      // case_delegate:
      const s = this.parseFunctionLiteral();
      e = new FuncExp(loc, s);
    } else if (jumpLerr) {
      // Lerr: Anything for e, as long as it's not NULL
      e = new ErrorExp();
      this.nextToken();
    }
    return e!;
  }

  /* The `LabelX:` body of parsePrimaryExp for the basic-type primaries (parse.d:8431-8454).
   * Returns the parsed expression, or null to signal `goto Lerr`. */
  private parsePrimaryExp_LabelX(loc: Loc, t: Type): Expression | null {
    const next = this.peekNext();
    if (next !== TOK.leftParenthesis && next !== TOK.dot) {
      // defer error for better diagnostics
      return new TypeExp(loc, this.parseType());
    }
    this.nextToken();
    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      let e: Expression = new TypeExp(loc, t);
      e = new CallExp(loc, e, this.parseArguments());
      return e;
    }
    this.check(TOK.dot);
    if ((this.token.value as TOK) !== TOK.identifier) {
      this.errorLoc(
        this.token.loc,
        ds("found `%s` when expecting identifier following `%s`."),
        this.token.toChars(),
        t.toChars(),
      );
      return null; // goto Lerr
    }
    const e = new DotIdExp(loc, new TypeExp(loc, t), this.token.ident!);
    this.nextToken();
    return e;
  }

  private parseUnaryExp(): Expression {
    let e: Expression;
    const loc = this.token.loc;

    Body: {
      switch ((this.token.value as TOK)) {
        case TOK.and:
          this.nextToken();
          e = this.parseUnaryExp();
          e = new AddrExp(loc, e);
          break Body;

        case TOK.plusPlus:
          this.nextToken();
          e = this.parseUnaryExp();
          e = new PreExp(EXP.prePlusPlus, loc, e);
          break Body;

        case TOK.minusMinus:
          this.nextToken();
          e = this.parseUnaryExp();
          e = new PreExp(EXP.preMinusMinus, loc, e);
          break Body;

        case TOK.mul:
          this.nextToken();
          e = this.parseUnaryExp();
          e = new PtrExp(loc, e);
          break Body;

        case TOK.min:
          this.nextToken();
          e = this.parseUnaryExp();
          e = new NegExp(loc, e);
          break Body;

        case TOK.add:
          this.nextToken();
          e = this.parseUnaryExp();
          e = new UAddExp(loc, e);
          break Body;

        case TOK.not:
          this.nextToken();
          e = this.parseUnaryExp();
          e = new NotExp(loc, e);
          break Body;

        case TOK.tilde:
          this.nextToken();
          e = this.parseUnaryExp();
          e = new ComExp(loc, e);
          break Body;

        case TOK.cast_: {
          // cast(type) expression
          this.nextToken();
          this.check(TOK.leftParenthesis);
          /* cast(), cast(const), cast(immutable), cast(shared), cast(shared const), cast(wild) ... */
          let m = 0;
          ModLoop: while (true) {
            switch ((this.token.value as TOK)) {
              case TOK.const_:
                if (this.peekNext() === TOK.leftParenthesis) break ModLoop; // const as type constructor
                m |= MODFlags.const_; // const as storage class
                this.nextToken();
                continue;

              case TOK.immutable_:
                if (this.peekNext() === TOK.leftParenthesis) break ModLoop;
                m |= MODFlags.immutable_;
                this.nextToken();
                continue;

              case TOK.shared_:
                if (this.peekNext() === TOK.leftParenthesis) break ModLoop;
                m |= MODFlags.shared_;
                this.nextToken();
                continue;

              case TOK.inout_:
                if (this.peekNext() === TOK.leftParenthesis) break ModLoop;
                m |= MODFlags.wild;
                this.nextToken();
                continue;

              default:
                break ModLoop;
            }
          }
          if ((this.token.value as TOK) === TOK.rightParenthesis) {
            this.nextToken();
            e = this.parseUnaryExp();
            // reconciled to faithful surface (W2); sweeps at this file's retranslation:
            // parse.d:8865 passes a MOD (`ubyte mod`), i.e. the expression.d:2669 overload, exposed
            // by expression.ts as the named factory arm of the Form-B pair (04 §1.1(c)).
            e = CastExp.fromMod(loc, e, m);
          } else {
            let t = this.parseType(); // cast( type )
            t = addSTC(t, ModToStc(m)); // cast( const type )
            this.check(TOK.rightParenthesis);
            e = this.parseUnaryExp();
            e = new CastExp(loc, e, t);
          }
          break Body;
        }
        case TOK.inout_:
        case TOK.shared_:
        case TOK.const_:
        case TOK.immutable_: {
          // immutable(type)(arguments) / immutable(type).init
          const stc = this.parseTypeCtor();

          let t = this.parseBasicType();
          t = addSTC(t, stc);
          if (stc === STC.none && (this.token.value as TOK) === TOK.dot) {
            this.nextToken();
            if ((this.token.value as TOK) !== TOK.identifier) {
              this.error(ds("identifier expected following `%s.`, not `%s`"), t.toChars(), this.token.toChars());
              return new ErrorExp();
            }
            e = new DotIdExp(loc, new TypeExp(loc, t), this.token.ident!);
            this.nextToken();
            e = this.parsePostExp(e);
          } else {
            e = new TypeExp(loc, t);
            if ((this.token.value as TOK) !== TOK.leftParenthesis) {
              this.error(ds("`(arguments)` expected following `%s`, not `%s`"), t.toChars(), this.token.toChars());
              return e;
            }
            const args = new DArray<Expression | null>();
            const names = new DArray<ArgumentLabel>();
            this.parseNamedArguments(args, names);
            e = new CallExp(loc, e, args, names);
          }
          break Body;
        }
        case TOK.leftParenthesis: {
          const tk_box: { value: Token } = { value: this.peek(this.token) };
          // resolved: static if (CCASTSYNTAX) -> ON (CCASTSYNTAX = 1).
          // If cast
          if (this.isDeclaration(tk_box.value, NeedDeclaratorId.no, TOK.rightParenthesis, tk_box)) {
            let tk = this.peek(tk_box.value); // skip over right parenthesis
            let isCast = false;
            CastSwitch: {
              switch (tk.value) {
                case TOK.not:
                  tk = this.peek(tk);
                  if (tk.value === TOK.is_ || tk.value === TOK.in_)
                    // !is or !in
                    break CastSwitch;
                  isCast = true;
                  break CastSwitch;

                case TOK.dot:
                case TOK.plusPlus:
                case TOK.minusMinus:
                case TOK.new_:
                case TOK.leftParenthesis:
                case TOK.identifier:
                case TOK.this_:
                case TOK.super_:
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
                case TOK.null_:
                case TOK.true_:
                case TOK.false_:
                case TOK.charLiteral:
                case TOK.wcharLiteral:
                case TOK.dcharLiteral:
                case TOK.string_:
                case TOK.interpolated:
                case TOK.function_:
                case TOK.delegate_:
                case TOK.typeof_:
                case TOK.traits:
                case TOK.vector:
                case TOK.file:
                case TOK.fileFullPath:
                case TOK.line:
                case TOK.moduleString:
                case TOK.functionString:
                case TOK.prettyFunction:
                case TOK.wchar_:
                case TOK.dchar_:
                case TOK.bool_:
                case TOK.char_:
                case TOK.int8:
                case TOK.uns8:
                case TOK.int16:
                case TOK.uns16:
                case TOK.int32:
                case TOK.uns32:
                case TOK.int64:
                case TOK.uns64:
                case TOK.int128:
                case TOK.uns128:
                case TOK.float32:
                case TOK.float64:
                case TOK.float80:
                case TOK.imaginary32:
                case TOK.imaginary64:
                case TOK.imaginary80:
                case TOK.complex32:
                case TOK.complex64:
                case TOK.complex80:
                case TOK.void_:
                  isCast = true;
                  break CastSwitch;
                default:
                  break CastSwitch;
              }
            }
            if (isCast) {
              // (type) una_exp
              this.nextToken();
              // Note: `t` may be an expression that looks like a type
              const t = this.parseType();
              this.check(TOK.rightParenthesis);

              // if .identifier or .identifier!( ... )
              if ((this.token.value as TOK) === TOK.dot) {
                if (this.peekNext() !== TOK.identifier && this.peekNext() !== TOK.new_) {
                  this.error(ds("identifier or new keyword expected following `(...)`."));
                  this.nextToken();
                  return new ErrorExp();
                }
                e = new TypeExp(loc, t);
                e.parens = true;
                e = this.parsePostExp(e);
              } else if (
                (this.token.value as TOK) === TOK.leftParenthesis ||
                (this.token.value as TOK) === TOK.plusPlus ||
                (this.token.value as TOK) === TOK.minusMinus
              ) {
                // (type)(expr) / (callable)(args) / (expr)++
                const te = new TypeExp(loc, t);
                te.parens = true;
                e = this.parsePostExp(te);
              } else {
                e = this.parseUnaryExp();
                e = new CastExp(loc, e, t);
                this.errorLoc(loc, ds("C style cast illegal, use `%s`"), e.toChars());
              }
              return e;
            }
          }
          e = this.parsePrimaryExp();
          e = this.parsePostExp(e);
          break Body;
        }
        case TOK.throw_: {
          this.nextToken();
          // Parse AssignExpression to avoid comma conflicts
          const exp = this.parseAssignExp();
          e = new ThrowExp(loc, exp);
          break Body;
        }

        default:
          e = this.parsePrimaryExp();
          e = this.parsePostExp(e);
          break Body;
      }
    }
    assert(e!);

    // ^^ is right associative and has higher precedence than the unary operators
    while ((this.token.value as TOK) === TOK.pow) {
      this.nextToken();
      const e2 = this.parseUnaryExp();
      e = new PowExp(loc, e!, e2);
    }

    return e!;
  }

  private parsePostExp(e: Expression): Expression {
    while (true) {
      const loc = this.token.loc;
      switch ((this.token.value as TOK)) {
        case TOK.dot:
          this.nextToken();
          if ((this.token.value as TOK) === TOK.identifier) {
            const id = this.token.ident!;

            this.nextToken();
            if ((this.token.value as TOK) === TOK.not && this.peekNext() !== TOK.is_ && this.peekNext() !== TOK.in_) {
              const tiargs = this.parseTemplateArguments();
              // parse.d:9090 passes `(Identifier name, Objects* tiargs)`, i.e. the expression.d:2289
              // ctor overload, exposed by expression.ts as `fromName` (04 §1.1(c)). That factory is
              // LIVE since dtemplate.ts deferred its `TypeDeduced` class into `initDtemplate()`
              // (01 §4.1), so `a.b!(args)` now produces a real node here.
              e = DotTemplateInstanceExp.fromName(loc, e, id, tiargs);
            } else e = new DotIdExp(loc, e, id);
            continue;
          }
          if ((this.token.value as TOK) === TOK.new_) {
            e = this.parseNewExp(e);
            continue;
          }
          this.error(ds("identifier or `new` expected following `.`, not `%s`"), this.token.toChars());
          break; // parse.d:9102: the offending token is consumed by the loop's trailing nextToken()

        case TOK.plusPlus:
          e = new PostExp(EXP.plusPlus, loc, e);
          break;

        case TOK.minusMinus:
          e = new PostExp(EXP.minusMinus, loc, e);
          break;

        case TOK.leftParenthesis: {
          const args = new DArray<Expression | null>();
          const names = new DArray<ArgumentLabel>();
          this.parseNamedArguments(args, names);
          e = new CallExp(loc, e, args, names);
          continue;
        }

        case TOK.leftBracket: {
          // array[index] / array[] / array[lwr .. upr]
          let index: Expression;
          let upr: Expression;
          const arguments_ = new DArray<Expression | null>();

          this.inBrackets++;
          this.nextToken();
          while ((this.token.value as TOK) !== TOK.rightBracket && (this.token.value as TOK) !== TOK.endOfFile) {
            index = this.parseAssignExp();
            if ((this.token.value as TOK) === TOK.slice) {
              // array[..., lwr..upr, ...]
              this.nextToken();
              upr = this.parseAssignExp();
              arguments_.push(new IntervalExp(loc, index, upr));
            } else arguments_.push(index);
            if ((this.token.value as TOK) === TOK.rightBracket) break;
            this.check(TOK.comma);
          }
          this.check(TOK.rightBracket);
          this.inBrackets--;
          // reconciled to faithful surface (W2); sweeps at this file's retranslation:
          // parse.d:9149 passes `Expressions* arguments`, i.e. the expression.d:2821 overload,
          // exposed by expression.ts as `fromArgs` (04 §1.1(c)).
          e = ArrayExp.fromArgs(loc, e, arguments_);
          continue;
        }
        default:
          return e;
      }
      this.nextToken();
    }
  }

  private parseMulExp(): Expression {
    let e = this.parseUnaryExp();

    while (true) {
      const loc = this.token.loc;
      switch ((this.token.value as TOK)) {
        case TOK.mul: {
          this.nextToken();
          const e2 = this.parseUnaryExp();
          e = new MulExp(loc, e, e2);
          continue;
        }
        case TOK.div: {
          this.nextToken();
          const e2 = this.parseUnaryExp();
          e = new DivExp(loc, e, e2);
          continue;
        }
        case TOK.mod: {
          this.nextToken();
          const e2 = this.parseUnaryExp();
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

  private parseAddExp(): Expression {
    let e = this.parseMulExp();

    while (true) {
      const loc = this.token.loc;
      switch ((this.token.value as TOK)) {
        case TOK.add: {
          this.nextToken();
          const e2 = this.parseMulExp();
          e = new AddExp(loc, e, e2);
          continue;
        }
        case TOK.min: {
          this.nextToken();
          const e2 = this.parseMulExp();
          e = new MinExp(loc, e, e2);
          continue;
        }
        case TOK.tilde: {
          this.nextToken();
          const e2 = this.parseMulExp();
          e = new CatExp(loc, e, e2);
          continue;
        }
        default:
          break;
      }
      break;
    }
    return e;
  }

  private parseShiftExp(): Expression {
    let e = this.parseAddExp();

    while (true) {
      const loc = this.token.loc;
      switch ((this.token.value as TOK)) {
        case TOK.leftShift: {
          this.nextToken();
          const e2 = this.parseAddExp();
          e = new ShlExp(loc, e, e2);
          continue;
        }
        case TOK.rightShift: {
          this.nextToken();
          const e2 = this.parseAddExp();
          e = new ShrExp(loc, e, e2);
          continue;
        }
        case TOK.unsignedRightShift: {
          this.nextToken();
          const e2 = this.parseAddExp();
          e = new UshrExp(loc, e, e2);
          continue;
        }
        default:
          break;
      }
      break;
    }
    return e;
  }

  private parseCmpExp(): Expression {
    let e = this.parseShiftExp();
    let op = EXP.reserved;
    const loc = this.token.loc;

    switch ((this.token.value as TOK)) {
      case TOK.equal:
        op = EXP.equal;
        {
          this.nextToken();
          const e2 = this.parseShiftExp();
          e = new EqualExp(op, loc, e, e2);
        }
        break;
      case TOK.notEqual:
        op = EXP.notEqual;
        {
          this.nextToken();
          const e2 = this.parseShiftExp();
          e = new EqualExp(op, loc, e, e2);
        }
        break;

      case TOK.not: {
        // Attempt to identify '!is'
        const tv = this.peekNext();
        if (tv === TOK.in_) {
          this.nextToken();
          this.nextToken();
          const e2 = this.parseShiftExp();
          e = new InExp(loc, e, e2);
          e = new NotExp(loc, e);
          break;
        }
        if (tv !== TOK.is_) break;
        this.nextToken();
        op = EXP.notIdentity;
        // goto Lidentity
        this.nextToken();
        {
          const e2 = this.parseShiftExp();
          e = new IdentityExp(op, loc, e, e2);
        }
        break;
      }
      case TOK.is_:
        op = EXP.identity;
        this.nextToken();
        {
          const e2 = this.parseShiftExp();
          e = new IdentityExp(op, loc, e, e2);
        }
        break;

      case TOK.lessThan:
        op = EXP.lessThan;
        {
          this.nextToken();
          const e2 = this.parseShiftExp();
          e = new CmpExp(op, loc, e, e2);
        }
        break;
      case TOK.lessOrEqual:
        op = EXP.lessOrEqual;
        {
          this.nextToken();
          const e2 = this.parseShiftExp();
          e = new CmpExp(op, loc, e, e2);
        }
        break;
      case TOK.greaterThan:
        op = EXP.greaterThan;
        {
          this.nextToken();
          const e2 = this.parseShiftExp();
          e = new CmpExp(op, loc, e, e2);
        }
        break;
      case TOK.greaterOrEqual:
        op = EXP.greaterOrEqual;
        {
          this.nextToken();
          const e2 = this.parseShiftExp();
          e = new CmpExp(op, loc, e, e2);
        }
        break;

      case TOK.in_: {
        this.nextToken();
        const e2 = this.parseShiftExp();
        e = new InExp(loc, e, e2);
        break;
      }

      default:
        break;
    }
    return e;
  }

  private parseAndExp(): Expression {
    let e = this.parseCmpExp();
    while ((this.token.value as TOK) === TOK.and) {
      this.checkParens(TOK.and, e);
      const loc = this.token.loc;
      this.nextToken();
      const e2 = this.parseCmpExp();
      this.checkParens(TOK.and, e2);
      e = new AndExp(loc, e, e2);
    }
    return e;
  }

  private parseXorExp(): Expression {
    let e = this.parseAndExp();
    while ((this.token.value as TOK) === TOK.xor) {
      this.checkParens(TOK.xor, e);
      const loc = this.token.loc;
      this.nextToken();
      const e2 = this.parseAndExp();
      this.checkParens(TOK.xor, e2);
      e = new XorExp(loc, e, e2);
    }
    return e;
  }

  private parseOrExp(): Expression {
    let e = this.parseXorExp();
    while ((this.token.value as TOK) === TOK.or) {
      this.checkParens(TOK.or, e);
      const loc = this.token.loc;
      this.nextToken();
      const e2 = this.parseXorExp();
      this.checkParens(TOK.or, e2);
      e = new OrExp(loc, e, e2);
    }
    return e;
  }

  private parseAndAndExp(): Expression {
    let e = this.parseOrExp();
    while ((this.token.value as TOK) === TOK.andAnd) {
      const loc = this.token.loc;
      this.nextToken();
      const e2 = this.parseOrExp();
      e = new LogicalExp(loc, EXP.andAnd, e, e2);
    }
    return e;
  }

  private parseOrOrExp(): Expression {
    let e = this.parseAndAndExp();
    while ((this.token.value as TOK) === TOK.orOr) {
      const loc = this.token.loc;
      this.nextToken();
      const e2 = this.parseAndAndExp();
      e = new LogicalExp(loc, EXP.orOr, e, e2);
    }
    return e;
  }

  parseCondExp(): Expression {
    let e = this.parseOrOrExp();
    if ((this.token.value as TOK) === TOK.question) {
      const loc = this.token.loc;
      this.nextToken();
      const e1 = this.parseExpression();
      this.check(TOK.colon);
      const e2 = this.parseCondExp();
      e = new CondExp(loc, e, e1, e2);
    }
    return e;
  }

  parseAssignExp(): Expression {
    let e: Expression;
    e = this.parseCondExp();
    if (e === null) return e;

    // require parens for e.g. `t ? a = 1 : b = 2`
    const checkRequiredParens = (): void => {
      if (e.op === EXP.question && !e.parens)
        this.eSink.error(
          e.loc,
          ds("`%s` must be surrounded by parentheses when next to operator `%s`"),
          e.toChars(),
          Token.toCharsValue((this.token.value as TOK)),
        );
    };

    const loc = this.token.loc;
    switch ((this.token.value as TOK)) {
      case TOK.assign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new AssignExp(loc, e, e2);
        break;
      }
      case TOK.addAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new AddAssignExp(loc, e, e2);
        break;
      }
      case TOK.minAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new MinAssignExp(loc, e, e2);
        break;
      }
      case TOK.mulAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new MulAssignExp(loc, e, e2);
        break;
      }
      case TOK.divAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new DivAssignExp(loc, e, e2);
        break;
      }
      case TOK.modAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new ModAssignExp(loc, e, e2);
        break;
      }
      case TOK.powAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new PowAssignExp(loc, e, e2);
        break;
      }
      case TOK.andAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new AndAssignExp(loc, e, e2);
        break;
      }
      case TOK.orAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new OrAssignExp(loc, e, e2);
        break;
      }
      case TOK.xorAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new XorAssignExp(loc, e, e2);
        break;
      }
      case TOK.leftShiftAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new ShlAssignExp(loc, e, e2);
        break;
      }
      case TOK.rightShiftAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new ShrAssignExp(loc, e, e2);
        break;
      }
      case TOK.unsignedRightShiftAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new UshrAssignExp(loc, e, e2);
        break;
      }
      case TOK.concatenateAssign: {
        checkRequiredParens();
        this.nextToken();
        const e2 = this.parseAssignExp();
        e = new CatAssignExp(loc, e, e2);
        break;
      }
      default:
        break;
    }

    return e;
  }

  /*************************
   * Collect argument list. Assume current token is ',', '(' or '['.
   */
  private parseArguments(): Expressions {
    // function call
    const arguments_ = new DArray<Expression | null>();
    this.parseNamedArguments(arguments_, null);
    return arguments_;
  }

  /*************************
   * Collect named argument list. Assume current token is ',', '(' or '['.
   */
  private parseNamedArguments(arguments_: Expressions, names: ArgumentLabels | null): void {
    assert(arguments_);

    const endtok = (this.token.value as TOK) === TOK.leftBracket ? TOK.rightBracket : TOK.rightParenthesis;

    this.nextToken();

    while ((this.token.value as TOK) !== endtok && (this.token.value as TOK) !== TOK.endOfFile) {
      if (this.peekNext() === TOK.colon) {
        // Named argument `name: exp`
        const loc = this.token.loc;
        const ident = this.token.ident!;
        this.check(TOK.identifier);
        this.check(TOK.colon);
        if (names) names.push(new ArgumentLabel(ident, loc));
        else this.errorLoc(loc, ds("named arguments not allowed here"));
      } else {
        if (names) names.push(new ArgumentLabel(null, Loc.initial));
      }

      const arg = this.parseAssignExp();
      arguments_.push(arg);

      if ((this.token.value as TOK) !== TOK.comma) break;

      this.nextToken(); //comma
    }
    this.check(endtok);
  }

  /*******************************************
   * Parse a NewExpression. `thisexp` is the `this` reference for an inner class, or null.
   */
  private parseNewExp(thisexp: Expression | null): Expression {
    const loc = this.token.loc;

    this.nextToken(); // skip past `new`

    // parse PlacementExpression if any
    let placement: Expression | null = null;
    if ((this.token.value as TOK) === TOK.leftParenthesis) {
      this.nextToken();
      placement = this.parseAssignExp();
      this.check(TOK.rightParenthesis);
    }

    let arguments_: Expressions | null = null;
    let names: ArgumentLabels | null = null;

    // An anonymous nested class starts with "class"
    if ((this.token.value as TOK) === TOK.class_) {
      this.nextToken();
      if ((this.token.value as TOK) === TOK.leftParenthesis) {
        arguments_ = new DArray<Expression | null>();
        names = new DArray<ArgumentLabel>();
        this.parseNamedArguments(arguments_, names);
      }

      let baseclasses: BaseClasses | null = null;
      if ((this.token.value as TOK) !== TOK.leftCurly) baseclasses = this.parseBaseClasses();

      const id: Identifier | null = null;
      let members: Dsymbols | null = null;

      if ((this.token.value as TOK) !== TOK.leftCurly) {
        this.error(ds("`{ members }` expected for anonymous class"));
      } else {
        this.nextToken();
        members = this.parseDeclDefs(0);
        if ((this.token.value as TOK) !== TOK.rightCurly) this.error(ds("class member expected"));
        this.nextToken();
      }

      const cd = new ClassDeclaration(loc, id, baseclasses, members, false);
      const e = new NewAnonClassExp(loc, placement, thisexp, cd, arguments_);
      return e;
    }

    const stc = this.parseTypeCtor();
    let t = this.parseBasicType(true);
    t = this.parseTypeSuffixes(t);
    t = addSTC(t, stc);    if (t.ty === Taarray) {
      const taa = t as TypeAArray;
      const index = taa.index;
      // `new Type[expr]` is a static array
      // D dereferences `index` here (mtype.d:131 reads `t.ty`); the port's slot is `Type | null`
      // (02 §10.1), so the call site carries the `!` at the point D would fault.
      const edim = typeToExpression(index!);
      if (edim) t = new TypeSArray(taa.next, edim);
    } else if ((this.token.value as TOK) === TOK.leftParenthesis && t.ty !== Tsarray) {
      arguments_ = new DArray<Expression | null>();
      names = new DArray<ArgumentLabel>();
      this.parseNamedArguments(arguments_, names);
    }

    const e = new NewExp(loc, placement, thisexp, t, arguments_, names);
    return e;
  }

  /**********************************************
   * `addComment(Dsymbol s, const(char)* / const(char)[])` (parse.d:9652/9658) — both overloads
   * collapse (toDString is identity in the DString model). Attaches the doc comment to `s`.
   */
  private addComment(s: Dsymbol | null, blockComment: DString | null): void {
    if (s !== null) {
      s.addComment(Lexer.combineComments(blockComment, this.token.lineComment, true));
      this.token.lineComment = null;
    }
  }

  /*****************************
   * Destructively extract storage class from pAttrs (parse.d:9936).
   */
  private getStorageClass(pAttrs: PrefixAttributes | null): STC {
    let stc: STC = STC.none;
    if (pAttrs) {
      stc = pAttrs.storageClass;
      pAttrs.storageClass = STC.none;
    }
    return stc;
  }

  /**********************************************
   * Recognize builtin @ attributes. Returns storage class for attribute, 0 if not.
   */
  static isBuiltinAtAttribute(ident: Identifier): STC {
    return ident === Id.property
      ? STC.property
      : ident === Id.nogc
        ? STC.nogc
        : ident === Id.safe
          ? STC.safe
          : ident === Id.trusted
            ? STC.trusted
            : ident === Id.system
              ? STC.system
              : ident === Id.live
                ? STC.live
                : ident === Id.future
                  ? STC.future
                  : ident === Id.disable
                    ? STC.disable
                    : STC.none;
  }

  readonly atAttrGroup: STC = (STC.property |
    STC.nogc |
    STC.safe |
    STC.trusted |
    STC.system |
    STC.live |
    STC.disable) as STC;

  usageOfBodyKeyword(): void {
    if (this.mod.edition >= Edition.v2024) {
      this.eSink.error(this.token.loc, ds("usage of identifer `body` as a keyword is obsolete. Use `do` instead."));
    }
  }
}

/* The NeedDeclaratorId enum (parse.d:7243) — Parser-nested; emitted as a module const. */
const enum NeedDeclaratorId {
  no, // Declarator part must have no identifier
  opt, // Declarator part identifier is optional
  must, // Declarator part must have identifier
  mustIfDstyle, // Declarator part must have identifier, but don't recognize old C-style syntax
}

export const enum PREC {
  zero,
  expr,
  assign,
  cond,
  oror,
  andand,
  or,
  xor,
  and,
  equal,
  rel,
  shift,
  add,
  mul,
  pow,
  unary,
  primary,
}

/**********************************
 * Operator precedence for each operator (parse.d:9732). Indexed by EXP. Used by hdrgen.
 * Sparse D associative-array-style initializer `[EXP.x : PREC.y, ...]` -> a pre-filled array.
 */
export const precedence: PREC[] = (() => {
  // EXP.max+1: rvalue is the textually-last (highest-valued) EXP member.
  const p: PREC[] = new Array<PREC>((EXP.rvalue as number) + 1).fill(PREC.zero);
  p[EXP.type] = PREC.expr;
  p[EXP.error] = PREC.expr;
  p[EXP.objcClassReference] = PREC.expr; // Objective-C class reference, same as EXP.type

  p[EXP.mixin_] = PREC.primary;

  p[EXP.import_] = PREC.primary;
  p[EXP.dotVariable] = PREC.primary;
  p[EXP.scope_] = PREC.primary;
  p[EXP.identifier] = PREC.primary;
  p[EXP.this_] = PREC.primary;
  p[EXP.super_] = PREC.primary;
  p[EXP.int64] = PREC.primary;
  p[EXP.float64] = PREC.primary;
  p[EXP.complex80] = PREC.primary;
  p[EXP.null_] = PREC.primary;
  p[EXP.string_] = PREC.primary;
  p[EXP.arrayLiteral] = PREC.primary;
  p[EXP.assocArrayLiteral] = PREC.primary;
  p[EXP.classReference] = PREC.primary;
  p[EXP.file] = PREC.primary;
  p[EXP.fileFullPath] = PREC.primary;
  p[EXP.line] = PREC.primary;
  p[EXP.moduleString] = PREC.primary;
  p[EXP.functionString] = PREC.primary;
  p[EXP.prettyFunction] = PREC.primary;
  p[EXP.typeid_] = PREC.primary;
  p[EXP.is_] = PREC.primary;
  p[EXP.assert_] = PREC.primary;
  p[EXP.halt] = PREC.primary;
  p[EXP.template_] = PREC.primary;
  p[EXP.dSymbol] = PREC.primary;
  p[EXP.function_] = PREC.primary;
  p[EXP.variable] = PREC.primary;
  p[EXP.symbolOffset] = PREC.primary;
  p[EXP.structLiteral] = PREC.primary;
  p[EXP.compoundLiteral] = PREC.primary;
  p[EXP.arrayLength] = PREC.primary;
  p[EXP.delegatePointer] = PREC.primary;
  p[EXP.delegateFunctionPointer] = PREC.primary;
  p[EXP.remove] = PREC.primary;
  p[EXP.tuple] = PREC.primary;
  p[EXP.traits] = PREC.primary;
  p[EXP.overloadSet] = PREC.primary;
  p[EXP.void_] = PREC.primary;
  p[EXP.vectorArray] = PREC.primary;
  p[EXP._Generic] = PREC.primary;

  // post
  p[EXP.dotTemplateInstance] = PREC.primary;
  p[EXP.dotIdentifier] = PREC.primary;
  p[EXP.dotTemplateDeclaration] = PREC.primary;
  p[EXP.dot] = PREC.primary;
  p[EXP.dotType] = PREC.primary;
  p[EXP.plusPlus] = PREC.primary;
  p[EXP.minusMinus] = PREC.primary;
  p[EXP.prePlusPlus] = PREC.primary;
  p[EXP.preMinusMinus] = PREC.primary;
  p[EXP.call] = PREC.primary;
  p[EXP.slice] = PREC.primary;
  p[EXP.array] = PREC.primary;
  p[EXP.index] = PREC.primary;

  p[EXP.delegate_] = PREC.unary;
  p[EXP.address] = PREC.unary;
  p[EXP.star] = PREC.unary;
  p[EXP.negate] = PREC.unary;
  p[EXP.uadd] = PREC.unary;
  p[EXP.not] = PREC.unary;
  p[EXP.tilde] = PREC.unary;
  p[EXP.delete_] = PREC.unary;
  p[EXP.new_] = PREC.unary;
  p[EXP.newAnonymousClass] = PREC.unary;
  p[EXP.cast_] = PREC.unary;
  p[EXP.throw_] = PREC.unary;

  p[EXP.vector] = PREC.unary;
  p[EXP.pow] = PREC.pow;

  p[EXP.mul] = PREC.mul;
  p[EXP.div] = PREC.mul;
  p[EXP.mod] = PREC.mul;

  p[EXP.add] = PREC.add;
  p[EXP.min] = PREC.add;
  p[EXP.concatenate] = PREC.add;

  p[EXP.leftShift] = PREC.shift;
  p[EXP.rightShift] = PREC.shift;
  p[EXP.unsignedRightShift] = PREC.shift;

  p[EXP.lessThan] = PREC.rel;
  p[EXP.lessOrEqual] = PREC.rel;
  p[EXP.greaterThan] = PREC.rel;
  p[EXP.greaterOrEqual] = PREC.rel;
  p[EXP.in_] = PREC.rel;

  /* < and != have the same precedence (parser change). */
  p[EXP.equal] = PREC.rel;
  p[EXP.notEqual] = PREC.rel;
  p[EXP.identity] = PREC.rel;
  p[EXP.notIdentity] = PREC.rel;

  p[EXP.and] = PREC.and;
  p[EXP.xor] = PREC.xor;
  p[EXP.or] = PREC.or;

  p[EXP.andAnd] = PREC.andand;
  p[EXP.orOr] = PREC.oror;

  p[EXP.question] = PREC.cond;

  p[EXP.assign] = PREC.assign;
  p[EXP.construct] = PREC.assign;
  p[EXP.blit] = PREC.assign;
  p[EXP.loweredAssignExp] = PREC.assign;
  p[EXP.addAssign] = PREC.assign;
  p[EXP.minAssign] = PREC.assign;
  p[EXP.concatenateAssign] = PREC.assign;
  p[EXP.concatenateElemAssign] = PREC.assign;
  p[EXP.concatenateDcharAssign] = PREC.assign;
  p[EXP.mulAssign] = PREC.assign;
  p[EXP.divAssign] = PREC.assign;
  p[EXP.modAssign] = PREC.assign;
  p[EXP.powAssign] = PREC.assign;
  p[EXP.leftShiftAssign] = PREC.assign;
  p[EXP.rightShiftAssign] = PREC.assign;
  p[EXP.unsignedRightShiftAssign] = PREC.assign;
  p[EXP.andAssign] = PREC.assign;
  p[EXP.orAssign] = PREC.assign;
  p[EXP.xorAssign] = PREC.assign;

  p[EXP.comma] = PREC.expr;
  p[EXP.declaration] = PREC.expr;

  p[EXP.interval] = PREC.assign;
  return p;
})();
// hdrgen.ts cannot value-import this module (load cycle; see its deferred-edge note): hand the table over.
registerPrecedence(precedence);

export const enum ParseStatementFlags {
  scope_ = 2, // start a new scope
  curly = 4, // { } statement is required
  curlyScope = 8, // { } starts a new scope
  semiOk = 0x10, // empty ';' are really ok
}

/* PrefixAttributes!AST (parse.d:9882) — value struct holding the prefix-attribute accumulator.
 * Passed by reference (`PrefixAttributes | null`) through the decl parsers. */
export class PrefixAttributes {
  storageClass: STC = STC.none;
  depmsg: Expression | null = null;
  link: LINK = LINK.default_;
  visibility: Visibility = new Visibility(Visibility.Kind.undefined);
  setAlignment = false;
  ealign: Expression | null = null;
  udas: Expressions | null = null;
  comment: DString | null = null;
}

/* ParsedLinkage!AST (parse.d:9895) — the result of `parseLinkage`. */
export class ParsedLinkage {
  link: LINK = LINK.default_;
  cppmangle: CPPMANGLE = CPPMANGLE.def;
  idents: Identifiers | null = null;
  identExps: Expressions | null = null;
}
