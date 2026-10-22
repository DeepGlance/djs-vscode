// Ported from dmd/dsymbolsem.d (module dmd.dsymbolsem), LDC 1.43.0-beta1 / DMD 2.113.
// "Does the semantic 1 pass on the AST, which looks at symbol declarations but not
//  initializers or function bodies."
//
// VISITOR IDIOM A (13 §7): this module declares 13 real `class X : Visitor` classes; there is NO
// Idiom-B nested-function dispatch switch anywhere in the file. Every `alias visit = Visitor.visit;`
// is DROPPED (13 §1 — no overload hiding in TS).
//
// FILE LAYOUT: the whole of dmd/dsymbolsem.d (10476 D lines) in D source order — the free functions
// and `Ungag` (D 1-2014), `class DsymbolSemanticVisitor` (D 2015-6191), then add-member / search /
// set-scope / import-all / field-offset / new-scope / condition-include / one-member / finalize-size /
// has-pointers and the remaining free functions (D 6193-10476). One member does NOT come from this D
// module and is marked as such: `runSemantic` (a djs-local module driver, no D counterpart).
//
// core.stdc.stdio/string/stdlib (dsymbolsem.d:15-17) are NOT modules (01 §3.7): every `printf` in
// chunk 1's range lives inside `version(none)` / `version(LOGSEARCH)` / `static if (LOG|0)` and is
// dropped; `memcpy`/`malloc`/`free`/`Mem.check` in runDeferredSemantic (dsymbolsem.d:784-800) ERASE
// to a plain array snapshot + the JS GC (03 §8, 08 §13).
//
// Cycle treatment (01 §4.2/§4.5): every import whose only use is as a parameter/field/return TYPE is
// `import type` (erased, breaks the 76-module core SCC). No top-level `new`, no top-level value read.

// `Visitor` is value-imported FIRST (we `extends` it at module-eval time in 13 classes). Import
// ORDER is load-bearing across the core SCC (01 §4.5): the visitor module must be initialised
// before any sibling that also `extends Visitor` at top level.
import { Visitor } from "./visitor/index.js";
import {
    K, KeepUnit, keepDeferred, keepDeferredPass, keepForeignErrors, keepFound, keepImportedFrom, keepImportFound,
    keepMark, keepPkgMod, keepReadErrors, keepReq, keepRetried, keepRetry, keepRun, keepSized, keepTree, keepUnwind,
} from "../keep.js";
import { ClassKind } from "./aggregate.js"; // value: interfaceNewScope compares classKind to cpp/objc
import type { AggregateDeclaration } from "./aggregate.js";
import type { AliasThis } from "./aliasthis.js";
import type { ClassDeclarations, FuncDeclarations, Parameters } from "./arraytypes.js";
import { STC } from "./astenums.js"; // value: storage-class bit tests (extern_/static_/field/ref_/disable)
import { TY } from "./astenums.js"; // value: `t.ty == Tstruct` in makeNested / checkAliasThis
import { LINK } from "./astenums.js"; // value: interfaceNewScope sets LINK.windows/cpp/objc
import { Sizeok } from "./astenums.js"; // value: makeNested gates on Sizeok.done / Sizeok.fwd
import { ThreeState } from "./astenums.js"; // value: isPOD caches into StructDeclaration.ispod
import { AliasThisRec } from "./astenums.js"; // value: checkAliasThis recursion guard bit
import { structalign_t } from "./astenums.js"; // value: alignmentScope constructs the default
import { FileType } from "./astenums.js"; // value: scopeCreateGlobal sets inCfile for FileType.c
import type { AlignDeclaration, DeprecatedDeclaration } from "./attrib.js";
import { needCopyOrMoveCtor } from "./clone.js"; // value: isPOD's copy/move-ctor probe
import type { Ref } from "./clone.js";
import { ClassDeclaration } from "./dclass.js"; // value: resolveAliasThis reads ClassDeclaration.object
import { BaseClass } from "./dclass.js"; // value: chunks 2/3 construct/compare BaseClass instances
import type { InterfaceDeclaration } from "./dclass.js";
import { AliasDeclaration } from "./declaration.js"; // value: toAliasImpl's error alias (fromType)
import { OverDeclaration } from "./declaration.js"; // value: aliasOverloadInsert wraps a template
import { ThisDeclaration } from "./declaration.js"; // value: makeNested appends vthis/vthis2
import { TupleDeclaration, VarDeclaration } from "./declaration.js"; // value: chunk 2 `new VarDeclaration`/`new TupleDeclaration`
import type { BitFieldDeclaration, Declaration } from "./declaration.js";
import { Import } from "./dimport.js"; // value: chunk 3 constructs the implicit `object` import
import { Module } from "./dmodule.js"; // value: deferred queues + Module.clearCache()
import { Package } from "./dmodule.js"; // value: chunk 3 resolves/creates package symbols
import { Scope } from "./dscope.js"; // value: scopeCreateGlobal calls Scope.alloc()
import type { StructDeclaration } from "./dstruct.js";
import { ScopeDsymbol } from "./dsymbol.js"; // value: scopeCreateGlobal builds the global ScopeDsymbol
import { DsymbolTable } from "./dsymbol.js"; // value: insert/scopeCreateGlobal create symbol tables
import { Visibility } from "./dsymbol.js"; // value: newScope/makeNested set a public Visibility
import { PASS } from "./dsymbol.js"; // value: semanticRun comparisons
import { SearchOpt } from "./dsymbol.js"; // value: search flag bits
import { ExpressionDsymbol } from "./dsymbol.js"; // value: searchScope's alias-this hit wraps the exp
import { OverloadSet } from "./dsymbol.js"; // value: aliasOverloadInsert re-parents an overload set
import { Dsymbol } from "./dsymbol.js"; // value: chunks 2/3 reach Dsymbol statics / `new Dsymbol`
import type { SearchOptFlags } from "./dsymbol.js";
import { isDsymbol, isType } from "./dtemplate.js"; // value: the RootObject classifiers (UFCS, 04 §6)
import { dsymbolToErrMsg } from "./hdrgen.js"; // value: checkDeprecated's "declared here" supplemental
import type { TemplateDeclaration, TemplateInstance } from "./dtemplate.js";
import { error, deprecation, deprecationSupplemental, errorSupplemental, Classification } from "./errors.js";
import type { ErrorSink } from "./errorsink.js";
import { DotIdExp, ThisExp, VarExp, CallExp, TypeExp } from "./expression.js"; // value: alias-this rewrites
import { Expression, StringExp } from "./expression.js"; // value: chunks 2/3 build expressions / read statics
import { expressionSemantic, resolveProperties, semanticString, toInteger, searchCtor } from "./expressionsem.js";
// Wave-6 and wave-9 sweeps (11 §2.5): the callees these lines replace were walled as "unported"/"not
// exported" and are now live exports of expressionsem.ts. Value edge only — every use is inside a body.
import {
    arrayExpressionSemantic, checkFrameAccess, expandAliasThisTuples, getConstInitializer, isAliasThisTuple,
    isBitField, prepare, toImaginary, toReal, toStringExp
} from "./expressionsem.js";
import { equals as expEquals } from "./expressionsem.js"; // ALIAS (04 §6.1): our own `equals` owns the bare name
import { FuncAliasDeclaration } from "./func.js"; // value: aliasOverloadInsert wraps a function alias
import { CtorDeclaration } from "./func.js"; // value: chunk 2 constructs the generated ctor
import type { FuncDeclaration, InvariantDeclaration } from "./func.js";
import { isVirtual, isUnique } from "./funcsem.js"; // value: findGetMembers / funcDeclEquals
import { global, DiagnosticReporting } from "./globals.js";
import { Id } from "./id.js"; // value: identifier comparisons (min/max/getmembers/NULL/...)
import { Identifier } from "./identifier.js"; // value: Identifier.idPool / Identifier.lookup
import { Type } from "./mtype.js"; // value: Type.tvoidptr / Type.terror
import { TypeTuple } from "./mtype.js"; // value: tupleDeclGetType builds the tuple type
import { Parameter } from "./mtype.js"; // value: tupleDeclGetType builds each parameter
import { TypeTypeof } from "./mtype.js"; // value: resolveAliasThis's typeof(e) wrap
import { SIZE_INVALID } from "./mtype.js"; // value: the uinteger_t "size unknown" sentinel
import { DotExpFlag } from "./mtype.js"; // value: resolveAliasThis's dotExp flags
import { isAggregate } from "./typesem.js"; // value: resolveAliasThis's aggregate-receiver classifier
import type { TypeClass, TypeStruct } from "./mtype.js";
import { search_function } from "./opover.js"; // value: findGetMembers's operator/member probe
import { Array as DArray } from "./root/array.js"; // value: tupleDeclGetType allocates a Parameters
import { speller } from "./root/speller.js"; // value: search_correctScope's edit-distance walk
import { OutBuffer } from "./common/outbuffer.js"; // value: fixupInvariantIdent builds the ident text
import { semantic3 } from "./semantic3.js"; // value: semantic3OnDependencies / runDeferredSemantic3
import { Loc } from "./location.js"; // value: Loc.initial in the speller probe / tuple-type build
import { TOK, Token } from "./tokens.js"; // value: search_correct_C maps an ident to a C keyword
import { EXP } from "./tokens.js"; // value: getAlignment / resolveAliasThis test `e.op`
import { typeSemantic, isUnsigned } from "./typesem.js"; // value: tupleDeclGetType runs sema on the built tuple
import { toDsymbol } from "./typesem.js"; // value: checkDeprecatedType / toAliasImpl
import { addSTC } from "./typesem.js"; // value: aggregateDeclGetType folds pending storage classes
import { dotExp } from "./typesem.js"; // value: resolveAliasThis forwards through `alias this`
import { size as typeSize } from "./typesem.js"; // ALIAS: our own `sizeDsymbol` owns the bare name
import { alignment as typeAlignment } from "./typesem.js"; // ALIAS: our own `alignmentScope` (Scope form)
import { assert } from "../assert.js";
import { cstr, ds } from "../dstring.js";
import type { DString } from "../dstring.js";

// ---------------------------------------------------------------------------------------------
// STITCH: imports referenced by CHUNK 2 (D 2015-6191) and CHUNK 3 (D 6193-10476). Chunk 1 owns the
// block above (it lists only what its own range references); this block completes the file. Value vs
// `import type` was decided per symbol by its actual use position in the assembled file — every
// type-only edge stays erased so the 76-module core SCC does not gain a runtime cycle (01 §4.2/§4.5).
// The four ALIASED spellings are the preamble §7B collision set: our own `resolve`-free names win the
// bare spelling, the imported ones are renamed at the import.
// ---------------------------------------------------------------------------------------------
import { assertUnreachable } from "../assert.js";
import { symbolIsVisible, symbolIsVisibleDsymbol } from "./access.js";
import { ClassKindToChars, alignmember, placeField } from "./aggregate.js";
import type { Dsymbols, Expressions, Objects, Statements } from "./arraytypes.js";
import { Baseok, Edition, MATCH, PKG, TRUST, VarArg } from "./astenums.js";
import { AttribDeclaration, CPPNamespaceDeclaration, foreachUdaNoSemantic, isEnumAttribute } from "./attrib.js";
import type { AnonDeclaration, CPPMangleDeclaration, ConditionalDeclaration, ForwardingAttribDeclaration, LinkDeclaration, MixinDeclaration, PragmaDeclaration, StaticForeachDeclaration, StaticIfDeclaration, StorageClassDeclaration, UserAttributeDeclaration, VisibilityDeclaration } from "./attrib.js";
import { foreachUda } from "./attribsem.js";
import { buildCopyOrMoveCtor, buildDtors, buildInv, buildOpAssign, buildOpEquals, buildPostBlit, buildXopCmp, buildXopEquals, buildXtoHash, hasIdentityOpAssign } from "./clone.js";
import { Include, VersionCondition, findCondition } from "./cond.js";
import { implicitConvToType, inferType } from "./dcast.js";
import { ObjectNotFound } from "./declaration.js";
import type { TypeInfoDeclaration } from "./declaration.js";
import type { EnumDeclaration, EnumMember } from "./denum.js";
import type { ForeachDg } from "./dmodule.js";
import { Contract } from "./dscope.js";
import { DSYM, FieldState, foreachDsymbol, foreachDsymbolVoid } from "./dsymbol.js";
import type { AliasAssign, ArrayScopeSymbol, CAsmDeclaration, WithScopeSymbol } from "./dsymbol.js";
import { isError, isExpression } from "./dtemplate.js";
import type { TemplateMixin } from "./dtemplate.js";
import type { DebugSymbol, VersionSymbol } from "./dversion.js";
import { enumMemberSemantic, enumSemantic } from "./enumsem.js";
import { analysisSeesErrors, fatal, message } from "./errors.js";
import {
    AddAssignExp, ArgumentList, BlitExp, CommaExp, ConstructExp, DeclarationExp, DeleteExp, DotTemplateInstanceExp,
    DotVarExp, EqualExp, ErrorExp, FuncExp, IdentifierExp, IntegerExp, ScopeExp, SliceExp, TupleExp, WANTvalue,
    lastComma
} from "./expression.js";
import type { AssignExp } from "./expression.js";
import { isLvalue, getDsymbol, expandTuples, expressionsToString } from "./expressionsem.js";
import { findFunc, lowerStaticAAs, semantic2, staticAssertFail } from "./semantic2.js"; // value (01 §4.3): called from sema bodies only
import { include as condInclude } from "./expressionsem.js"; // ALIAS (04 §6.1): our own `include` owns the bare name
import type { DtorDeclaration, NewDeclaration, PostBlitDeclaration, SharedStaticCtorDeclaration, StaticCtorDeclaration, StaticDtorDeclaration, UnitTestDeclaration } from "./func.js";
import { FuncResolveFlag, funcDeclarationSemantic, overloadApply, overloadModMatch, resolveFuncCall } from "./funcsem.js";
import { CppStdRevision, FeatureState, IN_LLVM } from "./globals.js";
import type { Output } from "./globals.js";
import { initializerToChars, stcToBuffer, toErrMsg, visibilityToChars } from "./hdrgen.js";
import { ErrorInitializer, ExpInitializer, INITinterpret, INITnointerpret, VoidInitializer, syntaxCopy as syntaxCopyInitializer } from "./init.js";
import type { ArrayInitializer, Initializer } from "./init.js";
import { inferTypeInitializer, initializerSemantic, initializerToExpression, toAssocArrayLiteral } from "./initsem.js";
import { SourceLoc } from "./location.js";
import type { BaseLoc } from "./location.js";
import { MODimplicitConv, ParameterList, TypeFunction, TypeIdentifier } from "./mtype.js";
import type { TypeInstance, TypeSArray } from "./mtype.js";
import { checkMustUseReserved } from "./mustuse.js"; // value (01 §4.3): called from class/interface sema only
import { Nspace } from "./nspace.js";
import { optimize } from "./optimize.js";
import { Parser } from "./parse.js";
import { pragmaDeclSemantic } from "./pragmasem.js";
import { CTFloat } from "./root/ctfloat.js";
import { dmdformat } from "./root/dmdformat.js";
import { startsWith } from "./root/string.js";
import { DYNCAST } from "./rootobject.js";
import type { RootObject } from "./rootobject.js";
import { isSafeBypassingInference, setUnsafe, setUnsafePreview } from "./safe.js";
// Body-fill (01 §4.3): D writes a function-local `import dmd.escape : setUnsafeDIP1000;`
// (dsymbolsem.d:3107); read only inside that body, never at load time.
import { setUnsafeDIP1000 } from "./escape.js";
import { makeTupleForeach, ready } from "./statementsem.js"; // value (01 §4.3): the D:9252 function-local import, hoisted
import { copyToTemp } from "./sideeffect.js"; // value: copyToTemp at dsymbolsem.d:2596
import { CompoundStatement, ExpStatement, IfStatement, ReturnStatement } from "./statement.js";
import type { Statement } from "./statement.js";
import type { StaticAssert } from "./staticassert.js";
// NEW cross-SCC VALUE edge (01 §4.1): dsymbolsem.ts had no runtime edge into templatesem.ts before
// this sweep. The edge is validated ONLY by the full suite (a load-order break shows up as
// "Class extends value undefined", never as a tsc error). funcsem.ts:76, semantic3.ts:147 and
// opover.ts:93 already carry the same edge. Every use is inside a body — no top-level read.
import {
    TemplateInstance_semanticTiargs, computeOneMember, declareParameters, findBestMatch, findMixinTempDecl,
    findTempDecl, semanticTiargs, templateDeclarationSemantic, templateInstanceSemantic
} from "./templatesem.js";
import { target, TargetCBitFieldStyle } from "./target.js";
import { SwitchPrefix } from "./targetcompiler.js";
import {
    addStorageClass, alignsize, arrayOf, baseElemOf, checkComplexTransition, constConv, defaultInit,
    defaultInitLiteral, hasInvariant, hasPointers, hasUnsafeBitpatterns, hasVoidInitPointers, isBaseOf, isIntegral,
    isZeroInit, mutableOf, needsDestruction, needsNested, nextOf, pointerTo, resolve as typeResolve, sharedOf,
    toBasetype, unSharedOf
} from "./typesem.js";
import { dsEquals } from "../dstring.js";
// last (01 Rule 4.8): dinterpret.ts value-imports the sema world back; entering the core SCC through
// it from here would make it the entry point.
import { ctfeInterpret } from "./dinterpret.js";
// last (01 §4.8): objc.ts value-imports this module back (addMember, dsymbolSemantic, ...), so entering it
// from an earlier position would make it the core SCC's entry. `objc()` is read only inside bodies; it is
// non-null there because the driver runs `Objc._init()` at startup (main.d:445), hence `objc()!`.
import { objc } from "./objc.js";
// dmd/dsymbolsem.d:9094 (`import gen.dpragma : DtoCheckProfileInstrPragma;`, function-local, hoisted per 01 §4).
import { DtoCheckProfileInstrPragma } from "../gen/dpragma.js";
// dmd/dsymbolsem.d:33 (`import dmd.deps;`). LAST (01 §4.8): deps.ts value-imports hdrgen.
import { addImportDep } from "./deps.js";
// dmd/dsymbolsem.d:3377 (`import dmd.iasm.gcc : gccAsmSemantic;`, function-local, hoisted per 01 §4.4; the
// CAsmDeclaration overload, renamed per 04 §1). LAST (01 §4.8): iasm/gcc.ts value-imports the *sem passes back.
import { gccAsmSemanticCAsmDeclaration } from "./iasm/gcc.js";
// dmd/dsymbolsem.d:52 (`import dmd.importc;`). LAST (01 §4.8): importc.ts value-imports typesem, dcast, dsymbolsem
// and expressionsem back, so entering the core SCC through it from an earlier position would make it the entry.
import { addDefaultCInitializer, handleSymbolRedeclarations, handleTagSymbols } from "./importc.js";

// dmd/dsymbolsem.d:84 — `enum LOG = false;` (manifest constant, 02 §4.1). Every `static if (LOG)`
// block in the file RESOLVES TO NOTHING (07 §3); each site carries its own resolved-comment.
const LOG = false;
void LOG; // referenced only by the resolved `static if (LOG)` comments; keeps the manifest visible.

/***************************************
 * dmd/dsymbolsem.d:90 — `Scope* newScope(AggregateDeclaration _this, Scope* sc)`.
 * Create a new scope from sc.
 * semantic, semantic2 and semantic3 will use this for aggregate members.
 *
 * Postconditions: the returned Scope is a fresh push of `sc` (the caller owns the matching `pop()`).
 */
export function newScope(_this: AggregateDeclaration, sc: Scope): Scope {
    // dsymbolsem.d:92 — nested `static Scope* defaultNewScope(...)` (04 §5: inner arrow).
    const defaultNewScope = (ad: AggregateDeclaration, sc_: Scope): Scope => {
        // 11 §2.5 (paired state, not protected): the scope pushed at dsymbolsem.d:94 is returned (:103) and popped by
        // the caller in D too; only non-throwing stores and predicates follow the push, so there is no throw path.
        const sc2 = sc_.push(ad);
        // branded-STC re-cast after `&` (02 §4.2) — D `sc2.stc &= STC.flowThruAggregate`
        sc2.stc = (sc2.stc & STC.flowThruAggregate) as STC;
        sc2.parent = ad;
        sc2.inunion = ad.isUnionDeclaration();
        sc2.visibility = new Visibility(Visibility.Kind.public_); // fresh construction — no copy (03 §1)
        sc2.explicitVisibility = false;
        sc2.aligndecl = null;
        sc2.userAttribDecl = null;
        sc2.namespace = null;
        return sc2;
    };

    // dsymbolsem.d:106 — nested `static Scope* classNewScope(ClassDeclaration _this, Scope* sc)`.
    const classNewScope = (cd: ClassDeclaration, sc_: Scope): Scope => {
        const sc2 = defaultNewScope(cd, sc_);
        if (cd.isCOMclass()) {
            /* This enables us to use COM objects under Linux and
             * work with things like XPCOM
             */
            sc2.linkage = target.systemLinkage();   // dsymbolsem.d:114
        }
        return sc2;
    };

    // dsymbolsem.d:119 — nested `static Scope* interfaceNewScope(InterfaceDeclaration _this, Scope* sc)`.
    const interfaceNewScope = (id: InterfaceDeclaration, sc_: Scope): Scope => {
        const sc2 = classNewScope(id, sc_);
        if (id.com)
            sc2.linkage = LINK.windows;
        else if (id.classKind === ClassKind.cpp)
            sc2.linkage = LINK.cpp;
        else if (id.classKind === ClassKind.objc)
            sc2.linkage = LINK.objc;
        return sc2;
    };

    const _id = _this.isInterfaceDeclaration();
    if (_id !== null)
        return interfaceNewScope(_id, sc);
    const cd = _this.isClassDeclaration();
    if (cd !== null)
        return classNewScope(cd, sc);
    return defaultNewScope(_this, sc);
}

/**
 * dmd/dsymbolsem.d:138 — `void addObjcSymbols(Dsymbol _this, ClassDeclarations* classes,`
 * `ClassDeclarations* categories)`. Register `_this` with the Objective-C module state.
 *
 * Both arms forward into the `Objc` strategy behind `objc()`: the `AttribDeclaration` form is
 * `addSymbolsAttribDeclaration` (Form B suffix), the `ClassDeclaration` form keeps the bare name.
 * A non-attrib, non-class symbol falls through with no effect, exactly as in D.
 */
export function addObjcSymbols(_this: Dsymbol, classes: ClassDeclarations | null,
                               categories: ClassDeclarations | null): void {
    const ad = _this.isAttribDeclaration();
    if (ad !== null)
        objc()!.addSymbolsAttribDeclaration(ad, classes, categories);
    else {
        const cd = _this.isClassDeclaration();
        if (cd !== null)
            objc()!.addSymbols(cd, classes, categories);
    }
}

/**
 * dmd/dsymbolsem.d:146 — `private void fixupInvariantIdent(InvariantDeclaration invd, size_t offset)`.
 * Give an anonymous invariant a unique name derived from its position among the aggregate's members
 * (`__invariant<offset>`), so several invariants in one aggregate do not collide.
 *
 * D module-private; a non-exported function in the same TS module reproduces that visibility exactly.
 */
function fixupInvariantIdent(invd: InvariantDeclaration, offset: number): void {
    const idBuf = new OutBuffer();
    idBuf.writestring(ds("__invariant"));
    idBuf.print(BigInt(offset)); // `OutBuffer.print(ulong)` — widen the size_t index at the boundary (09 §5)

    // `idBuf[]` is the whole-buffer VIEW (`opSliceAll`), never the consuming `extract*` (08 §13a.2).
    invd.ident = Identifier.idPool(idBuf.opSliceAll());
}

/************************************
 * dmd/dsymbolsem.d:163 — `const(char)* search_correct_C(Identifier ident)`.
 * Maybe `ident` was a C or C++ name. Check for that, and suggest the D equivalent.
 * Params:
 *  ident = unknown identifier
 * Returns:
 *  D identifier string if found, null if not
 */
export function search_correct_C(ident: Identifier): DString | null {
    // resolved: `import dmd.astenums : Twchar;` — a function-local selective import of a TY member;
    // the wchar-size test below reads `target.c.wchar_tsize`, not `Twchar` (01 §3, hoisted/erased).
    let tok: TOK;
    if (ident === Id.NULL)
        tok = TOK.null_;
    else if (ident === Id.TRUE)
        tok = TOK.true_;
    else if (ident === Id.FALSE)
        tok = TOK.false_;
    else if (ident === Id.unsigned)
        tok = TOK.uns32;
    else if (ident === Id.wchar_t) {
        tok = target.c.wchar_tsize === 2 ? TOK.wchar_ : TOK.dchar_;    // dsymbolsem.d:176
    }
    else
        return null;
    return Token.toCharsValue(tok);
}

/******************************
 * dmd/dsymbolsem.d:190 — `Dsymbol insert(Scope* _this, Dsymbol s)`.
 * Add symbol s to innermost symbol table.
 * Params:
 *  _this = scope object
 *  s = symbol to insert
 * Returns:
 *  null if already in table, `s` if not
 */
export function insert(_this: Scope, s: Dsymbol): Dsymbol | null {
    //printf("insert() %s\n", s.toChars());
    const vd = s.isVarDeclaration();
    if (vd !== null) {
        if (_this.lastVar)
            vd.lastVar = _this.lastVar;
        _this.lastVar = vd;
    } else {
        const ss = s.isWithScopeSymbol();
        if (ss !== null) {
            const wvd = ss.withstate.wthis;
            if (wvd !== null) {
                if (_this.lastVar)
                    wvd.lastVar = _this.lastVar;
                _this.lastVar = wvd;
            }
            return null;
        }
    }

    // `_this.inner()` walks to the innermost scope that HAS a scopesym; D dereferences both
    // results unconditionally (02 §10.1).
    const scopesym = _this.inner()!.scopesym!;
    //printf("\t\tscopesym = %p\n", scopesym);
    if (!scopesym.symtab)
        scopesym.symtab = new DsymbolTable();
    if (!_this.inCfile)
        return scopesym.symtabInsert(s);

    // ImportC insert
    if (!scopesym.symtabInsert(s)) { // if already in table
        const s2 = scopesym.symtabLookup(s, s.ident!)!; // s2 is existing entry

        const svar = s.isVarDeclaration();
        const s2var = s2.isVarDeclaration();
        if ((((svar !== null && (svar.storage_class & STC.extern_) !== 0n) &&
                (s2var !== null && (s2var.storage_class & STC.extern_) !== 0n)) && _this.func !== null) ||
                s.isFuncDeclaration() !== null) {
            // dmd/dsymbolsem.d:228 — `return handleSymbolRedeclarations(*_this, s, s2, scopesym);`
            return handleSymbolRedeclarations(_this, s, s2, scopesym);
        } else {
            // dmd/dsymbolsem.d:232 — `return handleTagSymbols(*_this, s, s2, scopesym);`
            return handleTagSymbols(_this, s, s2, scopesym);
        }
    }
    return s; // inserted
}

/*******************************************
 * dmd/dsymbolsem.d:243 — `FuncDeclaration findGetMembers(ScopeDsymbol dsym)`.
 * Look for member of the form:
 *      const(MemberInfo)[] getMembers(string);
 * Returns NULL if not found
 */
export function findGetMembers(dsym: ScopeDsymbol): FuncDeclaration | null {
    // resolved: `import dmd.opover : search_function;` — hoisted to the file's import block (01 §3).
    const s = search_function(dsym, Id.getmembers!);
    let fdx = s !== null ? s.isFuncDeclaration() : null;
    // resolved: version(none) { … tfgetmembers / overloadExactMatch … } (dsymbolsem.d:248-264) -> DROPPED
    // (07 §1); the `__gshared TypeFunction tfgetmembers` it declares goes with it.
    if (fdx !== null && isVirtual(fdx))
        fdx = null;
    return fdx;
}

/***********************************
 * dmd/dsymbolsem.d:279 — `ulong getMinMax(BitFieldDeclaration _this, Identifier id)`.
 * Retrieve the .min or .max values.
 * Only valid after semantic analysis.
 * Params:
 *  _this = bit field instance
 *  id = Id.min or Id.max
 * Returns:
 *  the min or max value
 *
 * 64-bit domain: the result is a D `ulong`, so `bigint` end-to-end (09 §1/§8). D computes the
 * bounds with `long` arithmetic (`1L << width`) and STORES into `ulong v`; every intermediate
 * `long` wrap and the final store are the same reduction mod 2^64, so ONE `BigInt.asUintN(64, …)`
 * on the stored value reproduces the whole chain exactly (09 §3/§4.2).
 */
export function getMinMax(_this: BitFieldDeclaration, id: Identifier): bigint {
    const width = _this.fieldWidth;
    const uns = isUnsigned(_this.type!);
    const min = id === Id.min;
    let v: bigint;
    assert(width !== 0); // should have been rejected in semantic pass
    if (width === 64) { // `width == ulong.sizeof * 8` — folded to the fixed target width (09 §1.4)
        v = uns ? (min ? 0n                                     // ulong.min
                       : 0xFFFF_FFFF_FFFF_FFFFn)                // ulong.max
                : (min ? BigInt.asUintN(64, -0x8000_0000_0000_0000n)   // long.min stored into a ulong
                       : 0x7FFF_FFFF_FFFF_FFFFn);               // long.max
    } else {
        const w = BigInt(width);
        v = uns ? (min ? 0n
                       : BigInt.asUintN(64, (1n << w) - 1n))
                : (min ? BigInt.asUintN(64, -(1n << (w - 1n)))
                       : BigInt.asUintN(64, (1n << (w - 1n)) - 1n));
    }
    return v;
}

/* dmd/dsymbolsem.d:299 — `void makeNested(AggregateDeclaration _this)`.
 * Append vthis field (this.tupleof[$-1]) to make this aggregate type nested.
 */
export function makeNested(_this: AggregateDeclaration): void {
    if (_this.enclosing) // if already nested
        return;
    if (_this.sizeok === Sizeok.done)
        return;
    if (_this.isUnionDeclaration() || _this.isInterfaceDeclaration())
        return;
    if ((_this.storage_class & STC.static_) !== 0n)
        return;

    // If nested struct, add in hidden 'this' pointer to outer scope
    let s = _this.toParentLocal();
    if (!s)
        s = _this.toParent2();
    if (!s)
        return;
    let t: Type | null = null;
    const fd = s.isFuncDeclaration();
    if (fd !== null) {
        _this.enclosing = fd;

        /* https://issues.dlang.org/show_bug.cgi?id=14422
         * If a nested class parent is a function, its
         * context pointer (== `outer`) should be void* always.
         */
        t = Type.tvoidptr;
    } else {
        const ad = s.isAggregateDeclaration();
        if (ad !== null) {
            if (_this.isClassDeclaration() && ad.isClassDeclaration()) {
                _this.enclosing = ad;
            } else if (_this.isStructDeclaration()) {
                const ti = ad.parent!.isTemplateInstance();
                if (ti !== null) {
                    _this.enclosing = ti.enclosing;
                }
            }
            t = ad.handleType();
        }
    }
    if (_this.enclosing) {
        // resolved: `import dmd.typesem : alignment;` — hoisted as `typeAlignment` (01 §3, 04 §6.1).
        //printf("makeNested %s, enclosing = %s\n", toChars(), enclosing.toChars());
        assert(t !== null);
        if (t!.ty === TY.Tstruct)
            t = Type.tvoidptr; // t should not be a ref type

        assert(_this.vthis === null);
        _this.vthis = new ThisDeclaration(_this.loc, t!);
        //vthis.storage_class |= STC.ref_;

        // Emulate vthis.addMember()
        _this.members!.push(_this.vthis);

        // Emulate vthis.dsymbolSemantic()
        _this.vthis.storage_class = (_this.vthis.storage_class | STC.field) as STC;
        _this.vthis.parent = _this;
        _this.vthis.visibility = new Visibility(Visibility.Kind.public_); // fresh construction, no copy
        // copy elided: `typeAlignment` returns a freshly-built structalign_t (typesem.ts:1493/1508),
        // an rvalue with no other alias — 03 §9 condition 2.
        _this.vthis.alignment = typeAlignment(t!);
        _this.vthis.semanticRun = PASS.semanticdone;

        if (_this.sizeok === Sizeok.fwd)
            _this.fields.push(_this.vthis);

        makeNested2(_this);
    }
}

/* dmd/dsymbolsem.d:373 — `void makeNested2(AggregateDeclaration _this)`.
 * Append vthis2 field (this.tupleof[$-1]) to add a second context pointer.
 */
export function makeNested2(_this: AggregateDeclaration): void {
    // resolved: `import dmd.typesem : alignment;` — hoisted as `typeAlignment` (01 §3).

    if (_this.vthis2)
        return;
    if (!_this.vthis)
        makeNested(_this); // can't add second before first
    if (!_this.vthis)
        return;
    if (_this.sizeok === Sizeok.done)
        return;
    if (_this.isUnionDeclaration() || _this.isInterfaceDeclaration())
        return;
    if ((_this.storage_class & STC.static_) !== 0n)
        return;

    const s0 = _this.toParentLocal();
    const s = _this.toParent2();
    if (!s || !s0 || s === s0)
        return;
    const cd = s.isClassDeclaration();
    const t: Type = cd !== null ? cd.type! : Type.tvoidptr;

    _this.vthis2 = new ThisDeclaration(_this.loc, t);
    //vthis2.storage_class |= STC.ref_;

    // Emulate vthis2.addMember()
    _this.members!.push(_this.vthis2);

    // Emulate vthis2.dsymbolSemantic()
    _this.vthis2.storage_class = (_this.vthis2.storage_class | STC.field) as STC;
    _this.vthis2.parent = _this;
    _this.vthis2.visibility = new Visibility(Visibility.Kind.public_); // fresh construction, no copy
    // copy elided: fresh rvalue from typeAlignment (03 §9 condition 2), as in makeNested above.
    _this.vthis2.alignment = typeAlignment(t);
    _this.vthis2.semanticRun = PASS.semanticdone;

    if (_this.sizeok === Sizeok.fwd)
        _this.fields.push(_this.vthis2);
}

/************************************
 * dmd/dsymbolsem.d:428 — `Dsymbol search(Scope* _this, Loc loc, Identifier ident,`
 * `out Dsymbol pscopesym, SearchOptFlags flags = SearchOpt.all)`.
 *
 * RENAMED `searchScope` (04 §1B / 04 §6.1): the bare `search` is PINNED to the `Dsymbol`-receiver
 * overload at dsymbolsem.d:7535. This is the `Scope*`-receiver family.
 *
 * Perform unqualified name lookup by following the chain of scopes up until found.
 *
 * Params:
 *  _this = Scope object
 *  loc = location to use for error messages
 *  ident = name to look up
 *  pscopesym = if supplied and name is found, set to scope that ident was found in, otherwise set to null
 *  flags = modify search based on flags
 *
 * Returns:
 *  symbol if found, null if not
 */
export function searchScope(_this: Scope, loc: Loc, ident: Identifier,
                            pscopesym: Ref<Dsymbol | null>,
                            flags: SearchOptFlags = SearchOpt.all): Dsymbol | null {
    pscopesym.value = null; // D resets an `out` parameter to `.init` on entry (03 §3.3)

    // resolved: version (LOGSEARCH) { printf + scope-chain dump + nested `printMsg` }
    // (dsymbolsem.d:430-446) -> OFF (_config.md §3; `//version=LOGSEARCH;` is commented out in
    // dscope.d:47), so the nested `printMsg` helper goes with it.

    // This function is called only for unqualified lookup
    // `assert(x)` is a boolean context, so the numeric test is made explicit (06 §2.5/§2.7).
    assert((flags & (SearchOpt.localsOnly | SearchOpt.importsOnly)) === 0);

    /* If ident is "start at module scope", only look at module scope
     */
    if (ident === Id.empty) {
        // Look for module scope
        for (let sc: Scope | null = _this; sc; sc = sc.enclosing) {
            assert(sc !== sc.enclosing);
            if (!sc.scopesym)
                continue;
            const s = sc.scopesym.isModule();
            if (s !== null) {
                //printMsg("\tfound", s);
                pscopesym.value = sc.scopesym;
                // 02 §11.5 audited upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool).
                return s as unknown as Dsymbol;
            }
        }
        return null;
    }

    /**
     * dsymbolsem.d:471 — nested `Dsymbol checkAliasThis(AggregateDeclaration ad, Identifier ident,
     * SearchOptFlags flags, Expression* exp)`. RECURSIVE; captures `loc` from the enclosing call.
     * `Expression* exp` is a pointer to the caller's Expression VARIABLE — the callee rewrites it
     * (`*exp = new DotIdExp(...)`), so it becomes a `Ref` box (03 §3.3/§7.2).
     */
    const checkAliasThis = (ad: AggregateDeclaration | null, ident2: Identifier,
                            flags2: SearchOptFlags, exp: Ref<Expression>): Dsymbol | null => {
        if (!ad || !ad.aliasthis)
            return null;

        const decl = ad.aliasthis.sym!.isDeclaration();
        if (!decl)
            return null;

        const t = decl.type!;
        let sds: ScopeDsymbol | null = null;
        let tc: TypeClass | null = null;
        let ts: TypeStruct | null = null;
        switch (t.ty) {
            case TY.Tstruct:
                ts = t.isTypeStruct();
                sds = ts!.sym;
                break;
            case TY.Tclass:
                tc = t.isTypeClass();
                sds = tc!.sym;
                break;
            case TY.Tinstance:
                sds = t.isTypeInstance()!.tempinst;
                break;
            case TY.Tenum:
                sds = t.isTypeEnum()!.sym;
                break;
            default: break;
        }

        if (!sds)
            return null;

        // `sds.search(loc, ident, flags)` — UFCS to the Dsymbol-receiver `search` (dsymbolsem.d:7535).
        const ret = search(sds, loc, ident2, flags2);
        if (ret) {
            exp.value = new DotIdExp(loc, exp.value, ad.aliasthis.identAlias);
            exp.value = new DotIdExp(loc, exp.value, ident2);
            return ret;
        }

        if (!ts && !tc)
            return null;

        let s: Dsymbol | null = null;
        exp.value = new DotIdExp(loc, exp.value, ad.aliasthis.identAlias);
        if (ts && (ts.att & AliasThisRec.tracing) === 0) {
            ts.att = (ts.att | AliasThisRec.tracing) as AliasThisRec;
            s = checkAliasThis(sds.isAggregateDeclaration(), ident2, flags2, exp);
            ts.att = (ts.att & ~AliasThisRec.tracing) as AliasThisRec;
        } else if (tc && (tc.att & AliasThisRec.tracing) === 0) {
            tc.att = (tc.att | AliasThisRec.tracing) as AliasThisRec;
            s = checkAliasThis(sds.isAggregateDeclaration(), ident2, flags2, exp);
            tc.att = (tc.att & ~AliasThisRec.tracing) as AliasThisRec;
        }
        return s;
    };

    /**
     * dsymbolsem.d:534 — nested `Dsymbol searchScopes(SearchOptFlags flags)`. Captures `_this`,
     * `loc`, `ident` and the `pscopesym` box. `flags` is a BY-VALUE parameter that the loop body
     * mutates (`flags |= SearchOpt.unqualifiedModule`), and the mutation persists across
     * iterations of one call — faithful as a plain mutable parameter.
     */
    const searchScopes = (flags2: SearchOptFlags): Dsymbol | null => {
        for (let sc: Scope | null = _this; sc; sc = sc.enclosing) {
            assert(sc !== sc.enclosing);
            if (!sc.scopesym)
                continue;
            //printf("\tlooking in scopesym '%s', kind = '%s', flags = x%x\n", …);

            // goto NotFound (dmd/dsymbolsem.d:557) — a forward jump out of the `if (s)` block to
            // the `NotFound:` label (dmd/dsymbolsem.d:566) that every other path reaches by
            // fall-through: the SKIP-FLAG shape (06 §4/§4.1). Re-armed each iteration.
            let gotoNotFound = false;

            if (sc.scopesym.isModule())
                flags2 |= SearchOpt.unqualifiedModule; // tell Module.search() that SearchOpt.localsOnly is to be obeyed
            else if (sc.inCfile && sc.scopesym.isStructDeclaration())
                continue;                              // C doesn't have struct scope

            let s = search(sc.scopesym, loc, ident, flags2);
            if (s !== null) {
                if ((flags2 & SearchOpt.tagNameSpace) !== 0) {
                    // ImportC: if symbol is not a tag, look for it in tag table
                    if (!s.isScopeDsymbol()) {
                        // `cast(void*)s in sc._module.tagSymTab` — the AA `in` yields a pointer;
                        // absent => null (02 §9, 08 §5/6). `sc._module` is dereferenced with no
                        // null test in D (02 §10.1).
                        const ps = sc._module!.tagSymTab.get(s);
                        if (ps === undefined)
                            gotoNotFound = true; // goto NotFound (dmd/dsymbolsem.d:557)
                        else
                            s = ps;
                    }
                }
                if (!gotoNotFound) {
                    //printMsg("\tfound local", s);
                    pscopesym.value = sc.scopesym;
                    return s;
                }
            }

            // NotFound: (dmd/dsymbolsem.d:566) — the tail is shared by the goto and the
            // fall-through routes and is therefore NOT gated (06 §4.1 rule ii).
            if (sc.previews.fixAliasThis) {
                const exp: Ref<Expression> = { value: new ThisExp(loc) }; // `Expression exp = new ThisExp(loc);`
                const aliasSym = checkAliasThis(sc.scopesym.isAggregateDeclaration(), ident, flags2, exp);
                if (aliasSym !== null) {
                    //printf("found aliassym: %s\n", aliasSym.toChars());
                    pscopesym.value = new ExpressionDsymbol(exp.value);
                    return aliasSym;
                }
            }

            // Stop when we hit a module, but keep going if that is not just under the global scope
            if (sc.scopesym.isModule() && !(sc.enclosing && !sc.enclosing.enclosing))
                break;
        }
        return null;
    };

    if (_this.ignoresymbolvisibility)
        flags |= SearchOpt.ignoreVisibility;

    // First look in local scopes
    let s = searchScopes(flags | SearchOpt.localsOnly);
    // resolved: version (LOGSEARCH) if (s) printMsg("-Scope.search() found local", s); (:590) -> OFF
    if (!s) {
        // Second look in imported modules
        s = searchScopes(flags | SearchOpt.importsOnly);
        // resolved: version (LOGSEARCH) if (s) printMsg("-Scope.search() found import", s); (:595) -> OFF
    }
    return s;
}

/**
 * dmd/dsymbolsem.d:600 — `Dsymbol search_correct(Scope* _this, Identifier ident)`.
 *
 * RENAMED `search_correctScope` (04 §1B / 04 §6.1): the bare `search_correct` is PINNED to the
 * `Dsymbol`-receiver overload at dsymbolsem.d:7542.
 *
 * "Did you mean" spelling correction over the scope chain. Gagged (speculative) compiles return
 * null immediately: the walk is too time consuming.
 */
export function search_correctScope(_this: Scope, ident: Identifier): Dsymbol | null {
    if (global.gag !== 0)
        return null; // don't do it for speculative compiles; too time consuming

    /************************************************
     * dsymbolsem.d:614 — nested `Dsymbol scope_search_fp(const(char)[] seed, out int cost)`.
     * Given the failed search attempt, try to find one with a close spelling.
     * Params:
     *      seed = identifier to search for
     *      cost = set to the cost, which rises with each outer scope
     * Returns:
     *      Dsymbol if found, null if not
     *
     * Passed to `speller!fp` — a template alias parameter that becomes a plain callback (04 §4.4).
     * `out int cost` becomes a box, reset to `int.init == 0` on entry (03 §3.3, 09 §1.0).
     */
    const scope_search_fp = (seed: DString, cost: Ref<number>): Dsymbol | null => {
        cost.value = 0; // D resets the `out` parameter on entry
        //printf("scope_search_fp('%s')\n", seed);
        /* If not in the lexer's string table, it certainly isn't in the symbol table.
         * Doing this first is a lot faster.
         */
        if (seed.length === 0)
            return null;
        const id = Identifier.lookup(seed);
        if (!id)
            return null;
        let sc: Scope | null = _this;
        Module.clearCache();
        const scopesym: Ref<Dsymbol | null> = { value: null };
        const s = searchScope(sc, Loc.initial, id, scopesym, SearchOpt.ignoreErrors);
        if (!s)
            return null;

        // Do not show `@disable`d declarations
        {
            const decl = s.isDeclaration();
            if (decl !== null && (decl.storage_class & STC.disable) !== 0n)
                return null;
        }
        // Or `deprecated` ones if we're not in a deprecated scope
        if (s.isDeprecated() && !sc.isDeprecated())
            return null;

        for (cost.value = 0; sc; sc = sc.enclosing, ++cost.value)
            if (sc.scopesym === scopesym.value)
                break;
        if (scopesym.value !== s.parent) {
            ++cost.value; // got to the symbol through an import
            if (s.visible().kind === Visibility.Kind.private_)
                return null;
        }
        return s;
    };

    const scopesym: Ref<Dsymbol | null> = { value: null };
    // search for exact name first
    {
        const s = searchScope(_this, Loc.initial, ident, scopesym, SearchOpt.ignoreErrors);
        if (s)
            return s;
    }
    return speller<Dsymbol>(ident.toString(), scope_search_fp);
}

/**
 * dmd/dsymbolsem.d:659 — `structalign_t alignment(Scope* _this)`.
 *
 * RENAMED `alignmentScope` (04 §1B / 04 §6.1): typesem.ts owns the bare `alignment(Type)`.
 * The struct-member alignment in effect for this scope.
 */
export function alignmentScope(_this: Scope): structalign_t {
    if (_this.aligndecl) {
        const ad = getAlignment(_this.aligndecl, _this);
        // `return ad.salign;` — a VALUE-struct field read into the return (03 §1 #3/#6).
        // `structalign_t` has live mutators (`set`/`setDefault`/`setPack`) so it is NOT in the
        // alias-safe register (03 §9.1): the caller must not alias the declaration's own slot.
        return ad.salign.copy();
    } else {
        const sa = new structalign_t();
        sa.setDefault();
        return sa;
    }
}

/**
 * dmd/dsymbolsem.d:674 — `Scope* scopeCreateGlobal(Module _module, ErrorSink eSink)`.
 *
 * Build the root scope for a module: a fresh global ScopeDsymbol (with its own symbol table), the
 * module added as its sole member, then the module scope pushed underneath. Returns the MODULE
 * scope; the caller owns TWO pops.
 *
 * (1.42 -> 1.43 MOVE, not a rename: this was `Scope.createGlobal` in dscope.d. The body is
 * unchanged in substance — no polarity flip, no changed return contract.)
 */
export function scopeCreateGlobal(_module: Module, eSink: ErrorSink): Scope {
    let sc = Scope.alloc();
    // `*sc = Scope.init` — `alloc()` returns a fresh `new Scope()` already at init values (the
    // freelist is never populated in this port, dscope.ts `pop`), so the whole-struct reset is a
    // no-op here (03 §8).
    sc._module = _module;
    sc.minst = _module;
    sc.scopesym = new ScopeDsymbol();
    sc.scopesym.symtab = new DsymbolTable();
    sc.eSink = eSink;
    assert(eSink !== null);
    // Add top level package as member of this global scope.
    // 02 §11.5 audited upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool).
    let m: Dsymbol = _module as unknown as Dsymbol;
    while (m.parent)
        m = m.parent;
    addMember(m, null, sc.scopesym);
    m.parent = null; // got changed by addMember()
    sc.previews.setFromParams(global.params);

    if (_module.filetype === FileType.c)
        sc.inCfile = true;
    // Create the module scope underneath the global scope
    // 02 §11.5 audited upcast cascade (the same shadowed Module.errors/Dsymbol.errors pair).
    // 11 §2.5 (paired state, not protected): the returned scope is popped by the caller in D too, and only one
    // field store follows the push.
    sc = sc.push(_module as unknown as ScopeDsymbol);
    sc.parent = _module as unknown as Dsymbol;
    return sc;
}

/*************************************
 * dmd/dsymbolsem.d:703 — `void dsymbolSemantic(Dsymbol dsym, Scope* sc)`.
 * Does semantic analysis on the public face of declarations.
 *
 * `dsym.accept(v)` routes each concrete symbol to its `visit<X>` override (13 §2).
 */
export function dsymbolSemantic(dsym: Dsymbol, sc: Scope | null): void {
    const v = new DsymbolSemanticVisitor(sc);
    const k = K.on ? keepMark() : 0;     // the kept-module engine: closes the unit a visitor below opens
    dsym.accept(v);
    if (K.on) keepUnwind(k);
}

/**
 * dmd/dsymbolsem.d:710 — `void semantic3OnDependencies(Module m)`.
 * function used to call semantic3 on a module's dependencies
 */
export function semantic3OnDependencies(m: Module | null): void {
    if (!m)
        return;

    if (m.semanticRun > PASS.semantic3)
        return;

    // 02 §11.5 audited upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool).
    semantic3(m as unknown as Dsymbol, null); // UFCS `m.semantic3(null)` (04 §6)

    for (let i = 1; i < m.aimports.length; i++)
        semantic3OnDependencies(m.aimports.opIndex(i));
}

/*******************************************
 * dmd/dsymbolsem.d:727 — `void addDeferredSemantic(Dsymbol s)`.
 * Can't run semantic on s now, try again later.
 *
 * `s.deferred` here is the BASE slot `Dsymbol.deferred: bool`: `s` is `Dsymbol`-typed. The derived
 * slots of the same D name on aggregates and template instances are `deferredTI` (02 §11.5b).
 */
export function addDeferredSemantic(s: Dsymbol): void {
    //printf("Module::addDeferredSemantic('%s')\n", s.toChars());
    if (!s.deferred) {
        s.deferred = true;
        Module.deferred.push(s);
        if (K.on) keepDeferred();   // the kept-module engine: the running unit defers a symbol
    }
}

/// dmd/dsymbolsem.d:737 — `void addDeferredSemantic2(Dsymbol s)`. Pass-2 deferral queue.
export function addDeferredSemantic2(s: Dsymbol): void {
    //printf("Module::addDeferredSemantic2('%s')\n", s.toChars());
    if (K.on) keepDeferredPass(s, 2);   // the kept-module engine: the running unit defers a symbol's semantic2
    if (!s.deferred2) {
        s.deferred2 = true;
        Module.deferred2.push(s);
    }
}

/// dmd/dsymbolsem.d:747 — `void addDeferredSemantic3(Dsymbol s)`. Pass-3 deferral queue.
export function addDeferredSemantic3(s: Dsymbol): void {
    //printf("Module::addDeferredSemantic3('%s')\n", s.toChars());
    if (K.on) keepDeferredPass(s, 3);   // the kept-module engine: the running unit defers a symbol's semantic3
    if (!s.deferred3) {
        s.deferred3 = true;
        Module.deferred3.push(s);
    }
}

// dmd/dsymbolsem.d:762 — `__gshared int nested;` declared INSIDE runDeferredSemantic. A D
// `__gshared` local is process-global, not a function local: it becomes module state (01 §5).
let runDeferredSemanticNested = 0;

/**
 * No D counterpart: `runDeferredSemantic`'s `nested` for the kept-module engine (src/keep.ts `retryNested`), above zero
 * inside a retry of the deferred symbols, where a nested retry returns at once.
 */
export function deferredRetryNested(): number {
    return runDeferredSemanticNested;
}

/******************************************
 * dmd/dsymbolsem.d:760 — `void runDeferredSemantic()`.
 * Run semantic() on deferred symbols.
 *
 * Loops while each pass makes progress. Re-entrant calls are a no-op (the `nested` guard), so a
 * `dsymbolSemantic` that itself triggers `runDeferredSemantic` does not recurse here.
 *
 * The D body snapshots `Module.deferred` into a `malloc`'d `todo` buffer before draining, so that
 * symbols re-deferred DURING this pass land in a fresh `Module.deferred` (the loop condition then
 * sees `length != len` and iterates). That raw-memory machinery ERASES (03 §8, 08 §13): the
 * snapshot is a plain array slice, with the same observable contract.
 */
export function runDeferredSemantic(): void {
    if (runDeferredSemanticNested)
        return;
    const retry = K.on ? keepRetry() : null;   // the kept-module engine: the running unit retries the deferred symbols
    //if (Module.deferred.length) printf("+Module::runDeferredSemantic(), len = %ld\n", deferred.length);
    runDeferredSemanticNested++;

    // 11 §2.5 (walls add exit paths D does not have — protect paired state): the drain below calls
    // `dsymbolSemantic`, which reaches this file's deferral walls and escalation stubs. D needs no guard
    // (it cannot leave here abnormally), but in the port a throw that skipped the decrement would
    // latch `runDeferredSemanticNested` and turn EVERY later `runDeferredSemantic()` in the process
    // into a silent no-op. Same shape as the `templateMixinNest` guard below.
    try {
        let len: number;
        do {
            len = Module.deferred.length;
            if (!len)
                break;

            // erased: `Dsymbol* todo / todoalloc / Mem.check(malloc(...)) / memcpy / free`
            // (dsymbolsem.d:781-800) -> a snapshot array + the JS GC (08 §13).
            const todo = Module.deferred.opSlice();
            // `deferred` slots are `Dsymbol | null` (08 §3); dsymbolsem.d:790 writes through each
            // with no null test -> `s!`.
            // This clears the BASE slot `Dsymbol.deferred: bool`, never `deferredTI` (02 §11.5b).
            for (const s of Module.deferred)
                s!.deferred = false;
            Module.deferred.setDim(0);

            for (let i = 0; i < len; i++) {
                const s = todo[i]!;
                dsymbolSemantic(s, null); // UFCS `s.dsymbolSemantic(null)` (04 §6)
                //printf("deferred: %s, parent = %s\n", s.toChars(), s.parent.toChars());
            }
            //printf("\tdeferred.length = %ld, len = %ld\n", deferred.length, len);
        } while (Module.deferred.length !== len); // while making progress
    } finally {
        runDeferredSemanticNested--;
    }
    if (retry !== null)
        keepRetried(retry);     // the kept-module engine: whether the retry did any work
    //printf("-Module::runDeferredSemantic(), len = %ld\n", deferred.length);
}

/// dmd/dsymbolsem.d:807 — `void runDeferredSemantic2()`. Run the pass-1 deferrals to completion,
/// then drain the pass-2 queue, stopping on the first reported error (in editor mode, gagged: `analysisSeesErrors`).
export function runDeferredSemantic2(): void {
    runDeferredSemantic();

    const a = Module.deferred2; // `Dsymbols* a = &Module.deferred2;` — the queue reference itself
    for (let i = 0; i < a.length; i++) {
        // slot `Dsymbol | null` (08 §3); dsymbolsem.d:815-819 dereferences with no null test -> `s!`.
        const s = a.opIndex(i)!;
        s.deferred2 = false;
        //printf("[%d] %s semantic2a\n", i, s.toPrettyChars());
        // dsymbolsem.d:817 — `s.semantic2(null)` (UFCS onto the free function, 04 §6). SWEPT:
        // authorised by dmd/semantic2.d:79 `void semantic2(Dsymbol dsym, Scope* sc)`, live at
        // semantic2.ts:197 with the D signature verbatim.
        semantic2(s, null);

        if (K.on && i + 1 < a.length)
            keepReadErrors();       // the kept-module engine: the answer decides whether the rest is drained
        if (analysisSeesErrors())   // `if (global.errors)`; in editor mode only gagged errors stop (dmd/errors.ts)
            break;
    }
    a.setDim(0);
}

/// dmd/dsymbolsem.d:825 — `void runDeferredSemantic3()`. Run the pass-2 deferrals, then drain
/// pass-3, stopping on the first reported error (in editor mode, gagged: `analysisSeesErrors`).
export function runDeferredSemantic3(): void {
    runDeferredSemantic2();

    const a = Module.deferred3; // `Dsymbols* a = &Module.deferred3;`
    for (let i = 0; i < a.length; i++) {
        // slot `Dsymbol | null` (08 §3); dsymbolsem.d:833-837 dereferences with no null test -> `s!`.
        const s = a.opIndex(i)!;
        s.deferred3 = false;
        //printf("[%d] %s semantic3a\n", i, s.toPrettyChars());
        semantic3(s, null);

        if (K.on && i + 1 < a.length)
            keepReadErrors();       // the kept-module engine: the answer decides whether the rest is drained
        if (analysisSeesErrors())   // `if (global.errors)`; in editor mode only gagged errors stop (dmd/errors.ts)
            break;
    }
    a.setDim(0);
}

/**
 * dmd/dsymbolsem.d:843 — `bool isOverlappedWith(VarDeclaration _this, VarDeclaration v)`.
 * Do the two fields overlap in the aggregate's layout? Bitfield widths override the type's size.
 *
 * Numeric domain: `type.size()` is `uinteger_t` -> bigint (09 §1.3.1). D promotes the `uint`
 * bit-offsets to `ulong` at the final comparison, so both are carried as bigint from the start
 * (widening at the boundary, 09 §5); the overlap answer must be bit-exact (09 §8).
 */
export function isOverlappedWith(_this: VarDeclaration, v: VarDeclaration): boolean {
    // resolved: `import dmd.typesem : size;` — hoisted as `typeSize` (01 §3, 04 §6.1).
    const vsz = typeSize(v.type!);
    const tsz = typeSize(_this.type!);
    assert(vsz !== SIZE_INVALID && tsz !== SIZE_INVALID);

    // Overlap is checked by comparing bit offsets
    let bitoffset = BigInt(_this.offset) * 8n;
    let vbitoffset = BigInt(v.offset) * 8n;

    // Bitsize of types are overridden by any bitfield widths.
    let tbitsize: bigint;
    {
        const bf = _this.isBitFieldDeclaration();
        if (bf !== null) {
            bitoffset += BigInt(bf.bitOffset);
            tbitsize = BigInt(bf.fieldWidth);
        } else {
            tbitsize = tsz * 8n;
        }
    }

    let vbitsize: bigint;
    {
        const vbf = v.isBitFieldDeclaration();
        if (vbf !== null) {
            vbitoffset += BigInt(vbf.bitOffset);
            vbitsize = BigInt(vbf.fieldWidth);
        } else {
            vbitsize = vsz * 8n;
        }
    }

    return bitoffset < vbitoffset + vbitsize &&
           vbitoffset < bitoffset + tbitsize;
}

/**
 * dmd/dsymbolsem.d:877 — `private Type tupleDeclGetType(TupleDeclaration _this)`.
 * If this tuple represents a type, return that type; otherwise null.
 */
function tupleDeclGetType(_this: TupleDeclaration): Type | null {
    /* If this tuple represents a type, return that type
     */

    //printf("TupleDeclaration::getType() %s\n", toChars());
    if (_this.isexp || _this.building)
        return null;
    if (_this.tupletype)
        return _this.tupletype;

    /* It's only a type tuple if all the Object's are types
     */
    for (let i = 0; i < _this.objects!.length; i++) {
        const o = _this.objects!.opIndex(i);
        if (!isType(o)) { // UFCS `o.isType()` -> dtemplate's free classifier (04 §6)
            //printf("\tnot[%d], %p, %d\n", i, o, o.dyncast());
            return null;
        }
    }

    /* We know it's a type tuple, so build the TypeTuple
     */
    // `Types* types = cast(Types*)_this.objects;` — the SAME container re-viewed as `Types`; every
    // element was just proven `isType()`. No new array is built: `types` ALIASES `_this.objects`.
    const types = _this.objects!;
    const args: Parameters = new DArray<Parameter | null>(_this.objects!.length);
    // dropped: `OutBuffer buf;` — its only use is the version(none) block at :910-916.
    let hasdeco = 1;
    for (let i = 0; i < types.length; i++) {
        const t = isType(types.opIndex(i))!;
        //printf("type = %s\n", t.toChars());
        // resolved: version (none) { buf.printf("_%s_%d", …); id = Identifier.idPool(...);
        // arg = new Parameter(Loc.initial, STC.in_, t, id, null); } (:910-916) -> DROP branch,
        // keep the `else` (07 §1).
        const arg = new Parameter(Loc.initial, STC.none, t, null, null, null);
        args.opIndexAssign(arg, i);
        if (!t.deco)
            hasdeco = 0;
    }

    _this.tupletype = new TypeTuple(args);
    if (hasdeco !== 0)
        return typeSemantic(_this.tupletype, Loc.initial, null);

    return _this.tupletype;
}

/// dmd/dsymbolsem.d:932 — `private Type aliasDeclGetType(AliasDeclaration _this)`. The alias arm of
/// `getType`: the resolved type if known, else the aliased symbol's type.
function aliasDeclGetType(_this: AliasDeclaration): Type | null {
    if (_this.type)
        return _this.type;
    return getType(toAlias(_this)); // UFCS chain `toAlias(this).getType()` (04 §6)
}

/**
 * dmd/dsymbolsem.d:939 — `private Type aggregateDeclGetType(AggregateDeclaration _this)`.
 * The aggregate arm of `getType`: the aggregate's own TypeStruct/TypeClass, with any pending
 * storage classes folded in for a still-unanalyzed (forward-referenced) aggregate.
 */
function aggregateDeclGetType(_this: AggregateDeclaration): Type | null {
    /* Apply storage classes to forward references. (Issue 22254)
     * Note: Avoid interfaces for now. Implementing qualifiers on interface
     * definitions exposed some issues in their TypeInfo generation in DMD.
     * Related PR: https://github.com/dlang/dmd/pull/13312
     */
    if (_this.semanticRun === PASS.initial && !_this.isInterfaceDeclaration()) {
        let stc = _this.storage_class;
        if (_this._scope)
            stc = (stc | _this._scope.stc) as STC; // branded flag-enum re-cast after `|` (02 §4.2)
        _this.type = addSTC(_this.type!, stc);
    }
    return _this.type;
}

/**
 * dmd/dsymbolsem.d:956 — `Type getType(Dsymbol _this)`.
 * If the symbol denotes a type — a type tuple, a type alias, an aggregate, or an enum — return that
 * type; otherwise null ("is this a type?").
 */
export function getType(_this: Dsymbol): Type | null {
    const td = _this.isTupleDeclaration();
    if (td !== null)
        return tupleDeclGetType(td);
    const ad = _this.isAliasDeclaration();
    if (ad !== null)
        return aliasDeclGetType(ad);
    const agd = _this.isAggregateDeclaration();
    if (agd !== null)
        return aggregateDeclGetType(agd);
    const ed = _this.isEnumDeclaration();
    if (ed !== null)
        return ed.type;

    // is this a type?
    return null;
}

/**
 * dmd/dsymbolsem.d:971 — `private uinteger_t aggregateDeclSize(AggregateDeclaration _this, Loc loc)`.
 * D module-private; EXPORTED here because siblings/tests in the tree touch it (01-conventions/10).
 *
 * Returns `SIZE_INVALID` (the 64-bit sentinel — never narrowed through a `number`, 09 §1.3.1) when
 * the aggregate's size cannot be determined.
 */
export function aggregateDeclSize(_this: AggregateDeclaration, loc: Loc): bigint {
    //printf("+AggregateDeclaration::size() %s, scope = %p, sizeok = %d\n", …);
    const ok = determineSize(_this, loc);
    //printf("-AggregateDeclaration::size() %s, scope = %p, sizeok = %d\n", …);
    return ok ? BigInt(_this.structsize) : SIZE_INVALID;
}

/// dmd/dsymbolsem.d:979 — `private uinteger_t declSize(Declaration _this, Loc loc)`. The declaration
/// arm of `sizeDsymbol`: the declared type's size, flagging the declaration on failure.
/// D never reads `loc` here (`_this.type.size()` takes typesem's default `Loc.initial`).
function declSize(_this: Declaration, loc: Loc): bigint {
    // resolved: `import dmd.typesem : size;` — hoisted as `typeSize` (01 §3, 04 §6.1).
    void loc; // D's body does not use it (the `size()` call is the no-Loc overload)
    assert(_this.type !== null);
    const sz = typeSize(_this.type!);
    if (sz === SIZE_INVALID)
        _this.errors = true;
    return sz;
}

/*********************************
 * dmd/dsymbolsem.d:993 — `uinteger_t size(Dsymbol _this, Loc loc)`.
 *
 * RENAMED `sizeDsymbol` (04 §1B / 04 §6.1): typesem.ts owns the bare `size(Type, Loc)`.
 *
 * Returns:
 *  SIZE_INVALID when the size cannot be determined
 */
export function sizeDsymbol(_this: Dsymbol, loc: Loc): bigint {
    const ad = _this.isAggregateDeclaration();
    if (ad !== null)
        return aggregateDeclSize(ad, loc);
    const d = _this.isDeclaration();
    if (d !== null)
        return declSize(d, loc);
    error(loc, ds("%s `%s` symbol `%s` has no size"), _this.kind(), _this.toPrettyChars(), _this.toChars());
    return SIZE_INVALID;
}

/**
 * dmd/dsymbolsem.d:1003 — `private bool funcDeclEquals(const FuncDeclaration _this, const Dsymbol s)`.
 * The function arm of `equals`: two functions are equal when they name the same declaration, with
 * `FuncAliasDeclaration` unwrapping and overload-set membership taken into account.
 *
 * `const` erased (04 §8). `s` is dereferenced unconditionally, so it is non-null here (02 §10.1).
 */
function funcDeclEquals(_this: FuncDeclaration, s: Dsymbol): boolean {
    const fd1 = _this;
    const fd2 = s.isFuncDeclaration();
    if (!fd2)
        return false;

    const fa1 = fd1.isFuncAliasDeclaration();
    const faf1 = fa1 !== null ? fa1.toAliasFunc() : fd1;

    const fa2 = fd2.isFuncAliasDeclaration();
    const faf2 = fa2 !== null ? fa2.toAliasFunc() : fd2;

    if (fa1 !== null && fa2 !== null)
        return equals(faf1, faf2) && fa1.hasOverloads === fa2.hasOverloads;

    let b1 = fa1 !== null;
    if (b1 && isUnique(faf1) && !fa1!.hasOverloads) // UFCS `faf1.isUnique()` -> funcsem.d:408 (04 §6)
        b1 = false;

    let b2 = fa2 !== null;
    if (b2 && isUnique(faf2) && !fa2!.hasOverloads)
        b2 = false;

    if (b1 !== b2)
        return false;

    // `toParent()` is dereferenced with no null test in D (02 §10.1) — the `!` marks that fault point.
    return equals(faf1.toParent()!, faf2.toParent()) &&
           faf1.ident!.equals(faf2.ident) &&   // Identifier.equals is a METHOD (identifier.d:81)
           faf1.type!.equals(faf2.type);       // Type.equals is a METHOD (mtype.d:552)
}

/// dmd/dsymbolsem.d:1035 — `private bool overDeclEquals(const OverDeclaration _this, const Dsymbol s)`.
/// `s` is dereferenced unconditionally, so it is non-null here (02 §10.1).
function overDeclEquals(_this: OverDeclaration, s: Dsymbol): boolean {
    const od2 = s.isOverDeclaration();
    if (od2 !== null)
        return equals(_this.aliassym!, od2.aliassym); // UFCS to this module's `equals` (04 §6)
    return _this.aliassym === s;
}

/// dmd/dsymbolsem.d:1042 — `private bool packageEquals(const Package _this, const Dsymbol s)`.
/// custom 'equals' for bug 17441. "package a" and "module a" are not equal.
function packageEquals(_this: Package, s: Dsymbol | null): boolean {
    // `auto p = cast(Package)s;` — a class downcast of a possibly-null reference yields null in D
    // without faulting, so the null case is absorbed here rather than at the caller.
    const p = s !== null ? s.isPackage() : null;
    // `_this.isModule() == p.isModule()`: neither Package nor Module overrides `opEquals`, so D's
    // `==` on class references is identity with null handling — exactly TS `===`.
    return p !== null && _this.isModule() === p.isModule() && _this.ident!.equals(p.ident);
}

/**
 * dmd/dsymbolsem.d:1049 — `bool equals(const Dsymbol _this, const Dsymbol s)`.
 *
 * NOTE this is dsymbolsem's OWN `equals`; dmd.expressionsem also declares one (used at
 * dsymbolsem.d:4019), which must be import-aliased (`equals as expEquals`) where it is consumed.
 */
export function equals(_this: Dsymbol, s: Dsymbol | null): boolean {
    if (_this === s)
        return true;

    const fd = _this.isFuncDeclaration();
    // `s!`: funcDeclEquals/overDeclEquals dereference `s` with no null test, so D faults on a null
    // `s` at exactly this point (02 §10.1) — the `!` marks the same crash site.
    if (fd !== null)
        return funcDeclEquals(fd, s!);
    const od = _this.isOverDeclaration();
    if (od !== null)
        return overDeclEquals(od, s!);
    const pkg = _this.isPackage();
    if (pkg !== null)
        return packageEquals(pkg, s);

    // Overload sets don't have an ident
    // Function-local declarations may have identical names
    // if they are declared in different scopes
    if (s && _this.ident && s.ident && _this.ident.equals(s.ident) && _this.localNum === s.localNum)
        return true;

    return false;
}

/**
 * dmd/dsymbolsem.d:1070 — `private bool aliasOverloadInsert(AliasDeclaration ad, Dsymbol s)`.
 *
 * Aliases aren't overloadable themselves, but if their Aliasee is overloadable they are converted
 * to an overloadable Alias (either FuncAliasDeclaration or OverDeclaration) — see the long D
 * comment reproduced below.
 */
function aliasOverloadInsert(ad: AliasDeclaration, s: Dsymbol): boolean {
    //printf("[%s] AliasDeclaration::overloadInsert('%s') s = %s %s @ [%s]\n", …);

    /** Aliases aren't overloadable themselves, but if their Aliasee is
     *  overloadable they are converted to an overloadable Alias (either
     *  FuncAliasDeclaration or OverDeclaration).
     *
     *  This is done by moving the Aliasee into such an overloadable alias
     *  which is then used to replace the existing Aliasee. The original
     *  Alias (_this_) remains a useless shell.
     *
     *  This is a horrible mess. It was probably done to avoid replacing
     *  existing AST nodes and references, but it needs a major
     *  simplification b/c it's too complex to maintain.
     *
     *  A simpler approach might be to merge any colliding symbols into a
     *  simple Overload class (an array) and then later have that resolve
     *  all collisions.
     */
    if (ad.semanticRun < PASS.semanticdone) {
        /* Don't know yet what the aliased symbol is, so assume it can
         * be overloaded and check later for correctness.
         */
        if (ad.overnext)
            return overloadInsert(ad.overnext, s);
        if (s === ad)
            return true;
        ad.overnext = s;
        return true;
    }
    /* Semantic analysis is already finished, and the aliased entity
     * is not overloadable.
     */
    if (ad.type) {
        /*
            If type has been resolved already we could
            still be inserting an alias from an import.

            If we are handling an alias then pretend
            it was inserting and return true, if not then
            false since we didn't even pretend to insert something.
        */
        return ad._import !== null && equals(ad, s);
    }

    // https://issues.dlang.org/show_bug.cgi?id=23865
    // only insert if the symbol can be part of a set
    const s1 = toAlias(s);
    const isInsertCandidate = s1.isFuncDeclaration() !== null || s1.isOverDeclaration() !== null ||
                              s1.isTemplateDeclaration() !== null;

    /* When s is added in member scope by static if, mixin("code") or others,
     * aliassym is determined already. See the case in: test/compilable/test61.d
     */
    const sa = toAlias(ad.aliassym!);

    {
        const fd = sa.isFuncDeclaration();
        if (fd !== null) {
            const fa = new FuncAliasDeclaration(ad.ident!, fd);
            fa.visibility = ad.visibility.copy(); // struct field store -> copy (03 §1 #5)
            fa.parent = ad.parent;
            ad.aliassym = fa;
            if (isInsertCandidate)
                return overloadInsert(ad.aliassym, s);
        }
    }
    {
        const td = sa.isTemplateDeclaration();
        if (td !== null) {
            const od = new OverDeclaration(ad.ident!, td.funcroot ? td.funcroot : td);
            od.visibility = ad.visibility.copy();
            od.parent = ad.parent;
            ad.aliassym = od;
            if (isInsertCandidate)
                return overloadInsert(ad.aliassym, s);
        }
    }
    {
        let od = sa.isOverDeclaration();
        if (od !== null) {
            if (sa.ident !== ad.ident || sa.parent !== ad.parent) {
                od = new OverDeclaration(ad.ident!, od);
                od.visibility = ad.visibility.copy();
                od.parent = ad.parent;
                ad.aliassym = od;
            }
            if (isInsertCandidate)
                return overloadInsert(od, s);
        }
    }
    {
        let os = sa.isOverloadSet();
        if (os !== null) {
            if (sa.ident !== ad.ident || sa.parent !== ad.parent) {
                os = new OverloadSet(ad.ident!, os);
                // TODO: visibility is lost here b/c OverloadSets have no visibility attribute
                // Might no be a practical issue, b/c the code below fails to resolve the overload anyhow.
                // ----
                // module os1;
                // import a, b;
                // private alias merged = foo; // private alias to overload set of a.foo and b.foo
                // ----
                // module os2;
                // import a, b;
                // public alias merged = bar; // public alias to overload set of a.bar and b.bar
                // ----
                // module bug;
                // import os1, os2;
                // void test() { merged(123); } // should only look at os2.merged
                //
                // os.visibility = visibility;
                os.parent = ad.parent;
                ad.aliassym = os;
            }
            if (isInsertCandidate) {
                os.push(s);
                return true;
            }
        }
    }
    return false;
}

/**********************************
 * dmd/dsymbolsem.d:1198 — `private bool templateOverloadInsert(TemplateDeclaration _this, Dsymbol s)`.
 * Overload existing TemplateDeclaration '_this' with the new one 's'.
 * Params:
 *    s = symbol to be inserted
 * Return: true if successful; i.e. no conflict.
 */
function templateOverloadInsert(_this: TemplateDeclaration, s: Dsymbol): boolean {
    // resolved: static if (LOG) { printf("TemplateDeclaration.overloadInsert('%s')\n", …) }
    // (dsymbolsem.d:1199) -> LOG is false, emits nothing (07 §3).

    const fd = s.isFuncDeclaration();
    if (fd !== null) {
        if (_this.funcroot)
            return overloadInsert(_this.funcroot, fd);
        _this.funcroot = fd;
        return overloadInsert(_this.funcroot, _this);
    }

    // https://issues.dlang.org/show_bug.cgi?id=15795
    // if candidate is an alias and its sema is not run then
    // insertion can fail because the thing it alias is not known
    const ad = s.isAliasDeclaration();
    if (ad !== null) {
        if (s._scope)
            aliasSemantic(ad, s._scope);
        if (ad.aliassym && ad.aliassym === _this)
            return false;
    }

    const td = toAlias(s).isTemplateDeclaration();
    if (!td)
        return false;

    // D: `TemplateDeclaration pthis = _this; TemplateDeclaration* ptd;
    //     for (ptd = &pthis; *ptd; ptd = &(*ptd).overnext) {}  ...  *ptd = td;`
    // `ptd` is a POINTER TO A REFERENCE SLOT — first the local `pthis`, then each node's
    // `overnext` FIELD — and `*ptd = td` writes the new tail THROUGH it. TS has no address-of a
    // field, so the slot is modelled as a get/set cell (the 03 §7.2 `Ref` box generalized from a
    // local to a field). The walk stops with the cell on the first NULL slot.
    const pthis: Ref<TemplateDeclaration | null> = { value: _this };
    let ptd: { get(): TemplateDeclaration | null; set(v: TemplateDeclaration | null): void } = {
        get: () => pthis.value,
        set: (v) => { pthis.value = v; },
    };
    for (; ptd.get() !== null; ) {
        const node = ptd.get()!;                       // `*ptd`
        ptd = { get: () => node.overnext, set: (v) => { node.overnext = v; } };  // `&(*ptd).overnext`
    }

    td.overroot = _this;
    ptd.set(td);
    // resolved: static if (LOG) { printf("\ttrue: no conflict\n"); } (dsymbolsem.d:1235) -> nothing.
    return true;
}

/**
 * dmd/dsymbolsem.d:1242 — `private bool importOverloadInsert(Import _this, Dsymbol s)`.
 * Allow multiple imports with the same package base, but disallow alias collisions
 * https://issues.dlang.org/show_bug.cgi?id=5412
 */
function importOverloadInsert(_this: Import, s: Dsymbol): boolean {
    assert(_this.ident !== null && _this.ident === s.ident);
    if (_this.aliasId)
        return false;
    const imp = s.isImport();
    return imp !== null && !imp.aliasId;
}

/**
 * dmd/dsymbolsem.d:1258 — `private bool funcOverloadInsert(FuncDeclaration _this, Dsymbol s)`.
 * Overload _this FuncDeclaration with the new one f.
 * Return true if successful; i.e. no conflict.
 */
function funcOverloadInsert(_this: FuncDeclaration, s: Dsymbol): boolean {
    //printf("FuncDeclaration::overloadInsert(s = %s) _this = %s\n", s.toChars(), toChars());
    assert(s !== _this);
    const ad = s.isAliasDeclaration();
    if (ad !== null) {
        if (_this.overnext)
            return overloadInsert(_this.overnext, ad);
        if (!ad.aliassym && ad.type!.ty !== TY.Tident && ad.type!.ty !== TY.Tinstance &&
            ad.type!.ty !== TY.Ttypeof) {
            //printf("\tad = '%s'\n", ad.type.toChars());
            return false;
        }
        _this.overnext = ad;
        //printf("\ttrue: no conflict\n");
        return true;
    }
    let td = s.isTemplateDeclaration();
    if (td) {
        if (!td.funcroot)
            td.funcroot = _this;
        if (_this.overnext)
            return overloadInsert(_this.overnext, td);
        _this.overnext = td;
        return true;
    }
    const fd = s.isFuncDeclaration();
    if (!fd)
        return false;

    if (_this.overnext) {
        td = _this.overnext.isTemplateDeclaration();
        if (td)
            overloadInsert(fd, td);
        else
            return overloadInsert(_this.overnext, fd);
    }
    _this.overnext = fd;
    //printf("\ttrue: no conflict\n");
    return true;
}

/// dmd/dsymbolsem.d:1301 — `private bool overdeclOverloadInsert(OverDeclaration _this, Dsymbol s)`.
function overdeclOverloadInsert(_this: OverDeclaration, s: Dsymbol): boolean {
    //printf("OverDeclaration::overloadInsert('%s') _this.aliassym = %p, _this.overnext = %p\n", …);
    if (_this.overnext)
        return overloadInsert(_this.overnext, s);
    if (s === _this)
        return true;
    _this.overnext = s;
    return true;
}

/**
 * dmd/dsymbolsem.d:1311 — `bool overloadInsert(Dsymbol _this, Dsymbol s)`.
 * Dispatch to the per-kind overload-insert arms. Note D's chain is `if / else if / else if` then a
 * FRESH `if` before the Import arm; every arm returns, so the flat sequence below preserves both
 * the order and the short-circuit exactly.
 */
export function overloadInsert(_this: Dsymbol, s: Dsymbol): boolean {
    // Cannot overload postblits or destructors
    if (_this.isPostBlitDeclaration() || _this.isDtorDeclaration())
        return false;
    const od = _this.isOverDeclaration();
    if (od !== null)
        return overdeclOverloadInsert(od, s);
    const fd = _this.isFuncDeclaration();
    if (fd !== null)
        return funcOverloadInsert(fd, s);
    const imp = _this.isImport();
    if (imp !== null)
        return importOverloadInsert(imp, s);
    const td = _this.isTemplateDeclaration();
    if (td !== null)
        return templateOverloadInsert(td, s);
    const ad = _this.isAliasDeclaration();
    if (ad !== null)
        return aliasOverloadInsert(ad, s);

    return false;
}

/***************************************************
 * dmd/dsymbolsem.d:1338 — `AlignDeclaration getAlignment(AlignDeclaration ad, Scope* sc)`.
 * Determine the numerical value of the AlignmentDeclaration
 * Params:
 *      ad = AlignmentDeclaration
 *      sc = context
 * Returns:
 *      ad with alignment value determined
 */
export function getAlignment(ad: AlignDeclaration, sc: Scope): AlignDeclaration {
    if (!ad.salign.isUnknown())   // UNKNOWN is 0
        return ad;

    if (!ad.exps) {
        ad.salign.setDefault();
        return ad;
    }

    let strictest = 0n;   // strictest alignment — `dinteger_t` -> bigint (09 §1/§8)
    let errors = false;
    // `foreach (ref exp; (*ad.exps)[])` — REF iteration: `exp = e` writes back into the array, so
    // the port indexes and stores (06 §1.6, 05 §7).
    // D reassigns the `sc` parameter across startCTFE/endCTFE; the widened local cursor is `cur`
    // (02 §10.1). `endCTFE()`'s `pop()` is non-null on this path — the `!` marks D's fault point.
    let cur: Scope = sc;
    for (let i = 0; i < ad.exps.length; i++) {
        const exp = ad.exps.opIndex(i)!;
        cur = cur.startCTFE();
        let e: Expression;
        // 11 §2.5 (paired state): capture-in-finally; D releases once per iteration (dsymbolsem.d:1356), no early
        // exit before it (the `continue` at :1366 is after it), and consumes the popped scope.
        try {
            e = expressionSemantic(exp, cur);
            e = resolveProperties(cur, e);
        } finally {
            cur = cur.endCTFE()!;
        }
        e = ctfeInterpret(e);        // dsymbolsem.d:1357
        ad.exps.opIndexAssign(e, i); // `exp = e;` — could be re-evaluated if exps are assigned to
                                     // more than one AlignDeclaration by CParser.applySpecifier(),
                                     // e.g. `_Alignas(8) int a, b;`
        if (e.op === EXP.error)
            errors = true;
        else {
            const n = toInteger(e); // UFCS `e.toInteger()` -> expressionsem (04 §6); dinteger_t = bigint
            if (cur.inCfile && n === 0n)       // C11 6.7.5-6 allows 0 for alignment
                continue;

            if (n < 1n || (n & (n - 1n)) !== 0n || 65535n < n || !isIntegral(e.type!)) {
                // `ushort.max < n` folded to the fixed width (09 §1.4); `n & (n-1)` is a numeric
                // truthiness test made explicit (06 §2.5).
                error(ad.loc, ds("alignment must be an integer positive power of 2, not 0x%llx"),
                      BigInt.asUintN(64, n)); // `cast(ulong)n`
                errors = true;
            }
            if (n > strictest)  // C11 6.7.5-6
                strictest = n;
        }
    }

    if (errors || strictest === 0n)  // C11 6.7.5-6 says alignment of 0 means no effect
        ad.salign.setDefault();
    else
        // `ad.salign.set(cast(uint) strictest)`: D's own narrowing to `uint`. The value is
        // provably <= 0xFFFF here (the power-of-2 / ushort.max check above rejected everything
        // else), so this crossing out of the bigint domain is exact and is D's, not the port's
        // (09 §1.3.1 permits widening/narrowing a bounded quantity, never a sentinel).
        ad.salign.set(Number(BigInt.asUintN(32, strictest)));

    return ad;
}

/*********************************
 * dmd/dsymbolsem.d:1390 — `Dsymbol toAlias2(Dsymbol s)`.
 * Resolve recursive tuple expansion in eponymous template.
 */
export function toAlias2(s: Dsymbol): Dsymbol {
    const ad = s.isAliasDeclaration();
    if (ad !== null) {
        if (ad.inuse !== 0) {
            error(ad.loc, ds("%s `%s` recursive alias declaration"), ad.kind(), ad.toPrettyChars());
            return ad;
        }
        ad.inuse = 1;
        const dsx: Dsymbol = ad.aliassym ? toAlias2(ad.aliassym) : ad;
        ad.inuse = 0;
        return dsx;
    }
    const td = s.isTupleDeclaration();
    if (td !== null) {
        //printf("TupleDeclaration::toAlias2() '%s' objects = %s\n", toChars(), objects.toChars());
        for (let i = 0; i < td.objects!.length; i++) {
            const o = td.objects!.opIndex(i);
            let dsx = isDsymbol(o); // UFCS `isDsymbol(o)` -> dtemplate's classifier (04 §6)
            if (dsx !== null) {
                dsx = toAlias2(dsx);
                td.objects!.opIndexAssign(dsx, i);
            }
        }
        return td;
    }
    return toAlias(s);
}

/**
 * dmd/dsymbolsem.d:1421 — `private Dsymbol toAliasImpl(AliasDeclaration ad)`.
 * The AliasDeclaration arm of `toAlias`: resolve the alias, running semantic if needed, and detect
 * recursion.
 */
function toAliasImpl(ad: AliasDeclaration): Dsymbol {
    // resolved: static if (0) printf("[%s] AliasDeclaration::toAlias(...)", …) (dsymbolsem.d:1423)
    // -> the `0` branch is never taken; emits nothing (07 §3).
    assert(ad !== ad.aliassym); // `assert(ad != ad.aliassym)` — class-ref identity (05 §2)
    //static int count; if (++count == 10) *(char*)0=0;

    /// dsymbolsem.d:1429 — nested `Dsymbol err()`: the shared error tail (04 §5 inner arrow,
    /// capturing `ad`; zero parameters, per 06 §4's tail rule).
    const err = (): Dsymbol => {
        // Avoid breaking "recursive alias" state during errors gagged
        if (global.gag !== 0)
            return ad;
        ad.aliassym = AliasDeclaration.fromType(ad.loc, ad.ident!, Type.terror);
        ad.type = Type.terror;
        return ad.aliassym;
    };

    // Reading the AliasDeclaration
    if (!ad.ignoreRead)
        ad.wasRead = true;                 // can never assign to this AliasDeclaration again

    if (ad.inuse === 1 && ad.type && ad._scope) {
        ad.inuse = 2;
        const olderrors = global.errors;
        let s = toDsymbol(ad.type, ad._scope); // UFCS `ad.type.toDsymbol(ad._scope)` (04 §6)
        //printf("[%s] type = %s, s = %p, this = %p\n", loc.toChars(), type.toChars(), s, this);
        if (global.errors !== olderrors)
            return err();
        if (s) {
            s = toAlias(s);
            if (global.errors !== olderrors)
                return err();
            ad.aliassym = s;
            ad.inuse = 0;
        } else {
            const t = typeSemantic(ad.type, ad.loc, ad._scope);
            if (t.ty === TY.Terror)
                return err();
            if (global.errors !== olderrors)
                return err();
            //printf("t = %s\n", t.toChars());
            ad.inuse = 0;
        }
    }
    if (ad.inuse !== 0) {
        error(ad.loc, ds("%s `%s` recursive alias declaration"), ad.kind(), ad.toPrettyChars());
        return err();
    }

    if (ad.semanticRun >= PASS.semanticdone) {
        // semantic is already done.

        // Do not see aliassym !is null, because of lambda aliases.

        // Do not see type.deco !is null, even so "alias T = const int;` needs
        // semantic analysis to take the storage class `const` as type qualifier.
        if (K.on) keepReq(ad, KeepUnit.alias);   // the kept-module engine: a request of a unit that ran
    } else {
        // stop AliasAssign tuple building
        if (ad.aliassym) {
            const td = ad.aliassym.isTupleDeclaration();
            if (td !== null) {
                if (td.building) {
                    td.building = false;
                    ad.semanticRun = PASS.semanticdone;
                    return td;
                }
            }
        }
        if (ad._import && ad._import._scope) {
            /* If this is an internal alias for selective/renamed import,
             * load the module first.
             */
            dsymbolSemantic(ad._import, null);
        }
        if (ad._scope) {
            // the kept-module engine: an alias of a non-root module is analysed here, at its first use
            // (dsymbolsem.d:2127 left it), by whatever uses it first: a unit of its own, replayed or recorded
            const k = K.on ? keepMark() : 0;
            if (!K.on || !keepRun(ad, KeepUnit.alias))
                aliasSemantic(ad, ad._scope);
            if (K.on) keepUnwind(k);
        }
    }

    ad.inuse = 1;
    const s: Dsymbol = ad.aliassym ? toAlias(ad.aliassym) : ad;
    ad.inuse = 0;
    return s;
}

/*********************************
 * dmd/dsymbolsem.d:1523 — `Dsymbol toAlias(Dsymbol s)`.
 * If this symbol is really an alias for another, return that other.
 * If needed, semantic() is invoked due to resolve forward reference.
 */
export function toAlias(s: Dsymbol): Dsymbol {
    const ad = s.isAliasDeclaration();
    if (ad !== null) {
        return toAliasImpl(ad); // UFCS `ad.toAliasImpl()` (04 §6)
    }
    const imp = s.isImport();
    if (imp !== null) {
        if (imp.aliasId)
            // 02 §11.5 audited upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool).
            return imp.mod as unknown as Dsymbol;
        return imp;
    }
    const vd = s.isVarDeclaration();
    if (vd !== null) {
        //printf("VarDeclaration::toAlias('%s', this = %p, aliassym = %p)\n", toChars(), this, aliassym);
        if ((!vd.type || !vd.type.deco) && vd._scope)
            dsymbolSemantic(vd, vd._scope);

        // `assert(vd != vd.aliasTuple)`: VarDeclaration and TupleDeclaration are SIBLING classes
        // with no structural overlap, so TS rejects a direct `!==`; the identity compare is spelled
        // through `unknown` (the tree's existing spelling, dsymbolsem.ts rung-era `toAlias`).
        assert((vd as unknown) !== (vd.aliasTuple as unknown));
        return vd.aliasTuple ? toAlias(vd.aliasTuple) : vd;
    }
    // resolve real symbol
    const ti = s.isTemplateInstance();
    if (ti !== null) {
        // resolved: static if (LOG) { printf("TemplateInstance.toAlias()\n"); } (dsymbolsem.d:1547)
        // -> LOG is false, emits nothing (07 §3).
        if (!ti.inst) {
            // Maybe we can resolve it
            if (ti._scope) {
                dsymbolSemantic(ti, ti._scope);
            }
            if (!ti.inst) {
                error(ti.loc, ds("%s `%s` cannot resolve forward reference"), ti.kind(), ti.toPrettyChars());
                ti.errors = true;
                return ti;
            }
        }

        if (ti.inst !== ti)
            return toAlias(ti.inst);

        if (ti.aliasdecl) {
            return toAlias(ti.aliasdecl);
        }

        return ti.inst;
    }
    return s;
}

/**
 * dmd/dsymbolsem.d:1579 — `const(char)* getMessage(DeprecatedDeclaration dd)`.
 * Run CTFE on the deprecation message expression the first time it is asked for, caching the
 * resulting string in `dd.msgstr`.
 */
export function getMessage(dd: DeprecatedDeclaration): DString | null {
    const sc0 = dd._scope;
    if (sc0 !== null) {
        dd._scope = null;

        // D reassigns the local `sc` across startCTFE/endCTFE; widened cursor per 02 §10.1.
        let cur: Scope = sc0;
        cur = cur.startCTFE();
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            dd.msg = expressionSemantic(dd.msg!, cur);
            dd.msg = resolveProperties(cur, dd.msg);
        } finally {
            cur = cur.endCTFE()!;
        }
        dd.msg = ctfeInterpret(dd.msg);     // dsymbolsem.d:1589

        // dsymbolsem.d:1591 — `dd.msg.toStringExp()` (UFCS, 04 §6). SWEPT: authorised by
        // dmd/expressionsem.d:425 `StringExp toStringExp(Expression _this)` (NOT expression.d, as
        // the old wall text claimed), live at expressionsem.ts:646.
        const se = toStringExp(dd.msg);
        if (se !== null)
            dd.msgstr = se.toStringz(); // `se.toStringz().ptr` — the DString IS the C-string view (02 §11.2)
        else
            error(dd.msg.loc, ds("compile time constant expected, not `%s`"), dd.msg.toChars());
    }
    return dd.msgstr;
}

/**
 * dmd/dsymbolsem.d:1599 — `bool checkDeprecated(Dsymbol d, Loc loc, Scope* sc)`.
 * Issue a deprecation message if `d` is deprecated and we are not inside a deprecated or
 * template-constraint scope. Returns true if `d` is deprecated (whether or not a message issued).
 */
export function checkDeprecated(d: Dsymbol, loc: Loc, sc: Scope): boolean {
    if (global.params.useDeprecated === DiagnosticReporting.off)
        return false;
    if (!d.isDeprecated())
        return false;
    // Don't complain if we're inside a deprecated symbol's scope
    if (sc.isDeprecated())
        return false;
    // Don't complain if we're inside a template constraint
    // https://issues.dlang.org/show_bug.cgi?id=21831
    if (sc.inTemplateConstraint)
        return false;

    let message: DString | null = null;
    for (let p: Dsymbol | null = d; p; p = p.parent) {
        // `p.depdecl` is D's `@property depdecl()` accessor; the port spells it as a method
        // (dsymbol.ts:658). `getMessage` is UFCS on the result (04 §6/§9).
        message = p.depdecl() ? getMessage(p.depdecl()!) : null;
        if (message)
            break;
    }
    if (message)
        deprecation(loc, ds("%s `%s` is deprecated - %s"), d.kind(), d.toPrettyChars(), message);
    else
        deprecation(loc, ds("%s `%s` is deprecated"), d.kind(), d.toPrettyChars());

    deprecationSupplemental(d.loc, ds("`%s` is declared here"), dsymbolToErrMsg(d));

    const tiInst = sc.parent ? sc.parent.isInstantiated() : null;
    if (tiInst !== null)
        tiInst.printInstantiationTrace(Classification.deprecation);
    else {
        const tiTempl = sc.parent ? sc.parent.isTemplateInstance() : null;
        if (tiTempl !== null)
            tiTempl.printInstantiationTrace(Classification.deprecation);
    }

    return true;
}

/*********************************
 * dmd/dsymbolsem.d:1638 — `private void checkDeprecated(Type type, Loc loc, Scope* sc)`.
 * Check type to see if it is based on a deprecated symbol.
 *
 * RENAMED `checkDeprecatedType` (04 §1B): the bare `checkDeprecated` is PINNED to the Dsymbol
 * overload above (typesem.ts:77 imports BOTH spellings).
 */
export function checkDeprecatedType(type: Type, loc: Loc, sc: Scope): void {
    const s = toDsymbol(type, sc);
    if (s !== null) {
        checkDeprecated(s, loc, sc);
    }

    const tn = nextOf(type);
    if (tn !== null)
        checkDeprecatedType(tn, loc, sc);
}

/// dmd/dsymbolsem.d:1650 — `package bool allowsContractWithoutBody(FuncDeclaration funcdecl)`.
/// Returns true if a contract can appear without a function body. D `package` visibility has no TS
/// equivalent finer than module scope; exported because siblings in other modules consume it.
export function allowsContractWithoutBody(funcdecl: FuncDeclaration): boolean {
    assert(funcdecl.fbody === null);

    /* Contracts can only appear without a body when they are virtual
     * interface functions or abstract.
     */
    const parent = funcdecl.toParent()!;
    const id = parent.isInterfaceDeclaration();

    // `funcdecl.isAbstract()` is the FuncDeclaration METHOD (func.d:588); `cd.isAbstract()` five
    // lines down is UFCS to THIS module's free `isAbstract(ClassDeclaration)` (dsymbolsem.d:9764).
    // Same spelling, two different callees — resolved per 04 §6.1 by the receiver's static type.
    if (!funcdecl.isAbstract() &&
        (funcdecl.fensures() !== null || funcdecl.frequires() !== null) &&
        !(id !== null && isVirtual(funcdecl))) {
        const cd = parent.isClassDeclaration();
        if (!(cd !== null && isAbstract(cd)))
            return false;
    }
    return true;
}

/***************************************
 * dmd/dsymbolsem.d:1685 — `bool isPOD(StructDeclaration sd)`.
 * Determine if struct is POD (Plain Old Data).
 *
 * POD is defined as:
 *      $(OL
 *      $(LI not nested)
 *      $(LI no postblits, destructors, or assignment operators)
 *      $(LI no `ref` fields or fields that are themselves non-POD)
 *      )
 * The idea being these are compatible with C structs.
 *
 * Returns:
 *     true if struct is POD
 */
export function isPOD(sd: StructDeclaration): boolean {
    // If we've already determined whether this struct is POD.
    if (sd.ispod !== ThreeState.none)
        return (sd.ispod === ThreeState.yes);

    // `out bool` parameters -> boxes reset to `bool.init == false` on entry (03 §3.3, 09 §1.0);
    // `needCopyOrMoveCtor` does the reset itself (clone.ts:1877).
    const hasCpCtorLocal: Ref<boolean> = { value: false };
    const hasMoveCtorLocal: Ref<boolean> = { value: false };
    const needCopyCtor: Ref<boolean> = { value: false };
    const needMoveCtor: Ref<boolean> = { value: false };
    needCopyOrMoveCtor(sd, hasCpCtorLocal, hasMoveCtorLocal, needCopyCtor, needMoveCtor);

    const sdAsDsymbol = sd;
    if (sd.enclosing !== null                                    || // is nested
        search(sdAsDsymbol, sd.loc, Id.postblit!) !== null       || // has postblit
        search(sdAsDsymbol, sd.loc, Id.dtor!) !== null           || // has destructor
        /* This is commented out because otherwise buildkite vibe.d:
           `canCAS!Task` fails to compile
         */
        //hasMoveCtorLocal.value               || // has move constructor
        hasCpCtorLocal.value) {                   // has copy constructor
        sd.ispod = ThreeState.no;
        return false;
    }

    // Recursively check all fields are POD.
    for (let i = 0; i < sd.fields.length; i++) {
        const v = sd.fields.opIndex(i)!;
        if ((v.storage_class & STC.ref_) !== 0n) {
            sd.ispod = ThreeState.no;
            return false;
        }

        const ts = baseElemOf(v.type!).isTypeStruct();
        if (ts !== null) {
            if (!isPOD(ts.sym!)) { // UFCS `ts.sym.isPOD()` (04 §6)
                sd.ispod = ThreeState.no;
                return false;
            }
        }
    }

    sd.ispod = ThreeState.yes;
    return true;
}

/****************************************
 * dmd/dsymbolsem.d:1746 — `bool fillVtbl(BaseClass* bc, ClassDeclaration cd, FuncDeclarations* vtbl,`
 * `int newinstance)`.
 * Fill in vtbl[] for base class based on member functions of class cd.
 * Input:
 *      bc              BaseClass
 *      vtbl            if !=NULL, fill it in
 *      newinstance     !=0 means all entries must be filled in by members
 *                      of cd, not members of any base classes of cd.
 * Returns:
 *      true if any entries were filled in by members of cd (not exclusively
 *      by base classes)
 */
export function fillVtbl(bc: BaseClass, cd: ClassDeclaration, vtbl: FuncDeclarations | null,
                         newinstance: number): boolean {
    void newinstance; // D's body does not read it either (documented input, unused)
    let result = false;

    //printf("BaseClass.fillVtbl(this='%s', cd='%s')\n", sym.toChars(), cd.toChars());
    if (vtbl)
        vtbl.setDim(bc.sym!.vtbl.length);

    // first entry is ClassInfo reference
    for (let j = bc.sym!.vtblOffset(); j < bc.sym!.vtbl.length; j++) {
        const ifd = bc.sym!.vtbl.opIndex(j)!.isFuncDeclaration();

        //printf("        vtbl[%d] is '%s'\n", j, ifd ? ifd.toChars() : "null");
        assert(ifd !== null);

        // Find corresponding function in this class
        const tf = ifd!.type!.toTypeFunction();
        // dsymbolsem.d:1764 — `cd.findFunc(ifd.ident, tf)` (UFCS, 04 §6). SWEPT: authorised by
        // dmd/semantic2.d:863 `FuncDeclaration findFunc(ClassDeclaration _this, Identifier ident,
        // TypeFunction tf)`, live at semantic2.ts:1076 with the D parameter list verbatim.
        let fd = findFunc(cd, ifd!.ident!, tf);
        if (fd !== null && !fd.isAbstract()) {
            if (fd.toParent() === cd)
                result = true;
        } else
            fd = null;
        if (vtbl)
            vtbl.opIndexAssign(fd, j);
    }
    return result;
}

/*
dmd/dsymbolsem.d:1790 — `bool checkHasBothRvalueAndCpCtor(StructDeclaration sd,`
`CtorDeclaration ctor, TemplateInstance ti)`.

If sd has a copy constructor and ctor is an rvalue constructor,
issue an error.

Params:
    sd = struct declaration that may contain both an rvalue and copy constructor
    ctor = constructor that will be checked if it is an rvalue constructor
    ti = template instance the ctor is part of

Return:
    `true` if sd has a copy constructor and ctor is an rvalue constructor
*/
export function checkHasBothRvalueAndCpCtor(sd: StructDeclaration | null, ctor: CtorDeclaration,
                                            ti: TemplateInstance): boolean {
    //printf("checkHasBothRvalueAndCpCtor() sd: %s ctor: %s ti: %s\n", …);
    /* cannot use ctor.isMoveCtor because semantic pass may not have been run yet,
     * so use isRvalueConstructor()
     */
    if (sd !== null && sd.hasCopyCtor && isRvalueConstructor(sd, ctor)) {
        error(ctor.loc, ds("cannot define both an rvalue constructor and a copy constructor for `struct %s`"),
              sd.toChars());
        errorSupplemental(ti.loc,
              ds("Template instance `%s` creates an rvalue constructor for `struct %s`"),
              ti.toPrettyChars(), sd.toChars());

        return true;
    }

    return false;
}

/************************************************
 * dmd/dsymbolsem.d:1818 — `bool isRvalueConstructor(StructDeclaration sd, CtorDeclaration ctor)`.
 * Check if ctor is an rvalue constructor.
 * A constructor that receives a single parameter of the same type as
 * `Unqual!typeof(this)` is an rvalue constructor.
 * Params:
 *      sd = struct that ctor is a member of
 *      ctor = constructor to test
 * Returns:
 *      true if it is an rvalue constructor
 */
export function isRvalueConstructor(sd: StructDeclaration, ctor: CtorDeclaration): boolean {
    // note commonality with setting isMoveCtor in the semantic code for CtorDeclaration
    const tf = ctor.type!.isTypeFunction()!;
    const dim = tf.parameterList.length();
    if (dim === 1 || (dim > 1 && tf.parameterList.opIndex(1)!.defaultArg)) {
        const param = tf.parameterList.opIndex(0)!;
        if ((param.storageClass & STC.ref_) === 0n &&
            unSharedOf(mutableOf(param.type!)) === unSharedOf(mutableOf(sd.type!))) {
            return true;
        }
    }
    return false;
}

/*************************************
 * dmd/dsymbolsem.d:1845 — `Expression resolveAliasThis(Scope* sc, Expression e, bool gag = false,`
 * `bool findOnly = false)`.
 * Find the `alias this` symbol of e's type.
 * Params:
 *      sc = context
 *      e = expression forming the `this`
 *      gag = do not print errors, return `null` instead
 *      findOnly = don't do further processing like resolving properties,
 *                 i.e. just return plain dotExp() result.
 * Returns:
 *      Expression that is `e.aliasthis`
 */
export function resolveAliasThis(sc: Scope, e: Expression, gag = false,
                                 findOnly = false): Expression | null {
    //printf("resolveAliasThis() %s\n", toChars(e));
    // resolved: `import dmd.typesem : dotExp;` — hoisted to the file's import block (01 §3).
    // D dereferences the `e` PARAMETER before any null test (`isAggregate(e.type)`), so the
    // parameter is non-null (02 §10.1); the reassignments below make the VALUE nullable, which is
    // carried by the widened local cursor `cur` (02 §10.1's canonical spelling).
    let cur: Expression | null = e;
    for (let ad: AggregateDeclaration | null = isAggregate(cur.type!); ad;) {
        if (ad.aliasthis) {
            const loc = cur!.loc;
            const tthis: Type | null = (cur!.op === EXP.type ? cur!.type : null);
            // `gag * DotExpFlag.gag` — D multiplies a bool by a flag; in TS the bool selects it.
            const flags = (DotExpFlag.noAliasThis | (gag ? DotExpFlag.gag : 0)) as DotExpFlag;
            const olderrors = gag ? global.startGagging() : 0;
            // 11 §2.5 (walls add exit paths D does not have — protect paired state):
            // `startGagging()` increments the PROCESS-global `global.gag`, and the region below
            // reaches the `overloadModMatch` wall (and walls inside dotExp/resolveProperties/
            // expressionSemantic). A throw that skipped `endGagging` would leave every later
            // diagnostic in the run silently swallowed. `gagOpen` tracks the unbalanced
            // `startGagging`; each D `endGagging` site clears it first, so the `finally` is a
            // no-op on every path D itself takes.
            let gagOpen = gag;
            try {
                // `ad.aliasthis.ident` (dsymbolsem.d:1857) reads the DERIVED slot of the shadow
                // (aliasthis.d:28), `identAlias` (02 §11.5b). D dereferences it with no null test.
                cur = dotExp(ad.type!, sc, cur, ad.aliasthis.identAlias!, flags);
                if (!cur || findOnly) {
                    // D: `return gag && e.endGagging(olderrors) ? null : e;` — the `&&` short-circuit
                    // means `endGagging` runs only when `gag`, which is exactly when it is unbalanced.
                    if (!gag)
                        return cur;
                    gagOpen = false;
                    return global.endGagging(olderrors) ? null : cur;
                }

                if (tthis && ad.aliasthis.sym!.needThis()) {
                    // goto L1 (dmd/dsymbolsem.d:1877) — a forward jump over the `intypeof` block to
                    // the `L1:` tail (dmd/dsymbolsem.d:1890) that the fall-through route also reaches:
                    // the SKIP-FLAG shape (06 §4/§4.1).
                    let gotoL1 = false;
                    const ve = cur.isVarExp();
                    if (ve !== null) {
                        let fd = ve.var_!.isFuncDeclaration(); // D `ve.var` — `var` is JS-reserved (01 §2.3)
                        if (fd !== null) {
                            // https://issues.dlang.org/show_bug.cgi?id=13009
                            // Support better match for the overloaded alias this.
                            // `ref bool hasOverloads` -> an alias box, NOT reset on entry (03 §3.2);
                            // D's local is default-initialised to `bool.init == false` (09 §1.0).
                            const hasOverloads: Ref<boolean> = { value: false };
                            // dsymbolsem.d:1870 — `fd.overloadModMatch(loc, tthis, hasOverloads)`
                            // (UFCS, 04 §6). SWEPT: authorised by dmd/funcsem.d:2603
                            // `FuncDeclaration overloadModMatch(FuncDeclaration thisfd, Loc loc,
                            // Type tthis, ref bool hasOverloads)`, live at funcsem.ts:2749; the
                            // `ref bool` keeps its alias-box spelling (03 §3.2).
                            const f = overloadModMatch(fd, loc, tthis, hasOverloads);
                            if (f !== null) {
                                if (!hasOverloads.value)
                                    fd = f;     // use exact match
                                const ve2 = new VarExp(loc, fd, hasOverloads.value);
                                ve2.type = f.type;
                                cur = new CallExp(loc, ve2);
                                gotoL1 = true; // goto L1 (dmd/dsymbolsem.d:1877)
                            }
                        }
                    }
                    if (!gotoL1) {
                        /* non-@property function is not called inside typeof(),
                         * so resolve it ahead.
                         */
                        const save = sc.intypeof;
                        sc.intypeof = 1; // bypass "need this" error check
                        // 11 §2.5 (paired state): one restore in D, no early exit.
                        try {
                            cur = resolveProperties(sc, cur!);
                        } finally {
                            sc.intypeof = save;
                        }
                    }
                    // L1: (dmd/dsymbolsem.d:1890) — shared by both routes, so NOT gated (06 §4.1 rule ii).
                    cur = new TypeExp(loc, new TypeTypeof(loc, cur!));
                    cur = expressionSemantic(cur, sc);
                }
                cur = resolveProperties(sc, cur!);
                if (!gag) {
                    checkDeprecatedAliasThis(ad.aliasthis, loc, sc); // UFCS (04 §6)
                } else {
                    gagOpen = false;
                    if (global.endGagging(olderrors))
                        cur = null;
                }
            } finally {
                if (gagOpen)
                    global.endGagging(olderrors);
            }
        }

        // resolved: `import dmd.dclass : ClassDeclaration;` — hoisted (01 §3).
        const cd = ad.isClassDeclaration();
        if ((!cur || !ad.aliasthis) && cd && cd.baseClass && cd.baseClass !== ClassDeclaration.object) {
            ad = cd.baseClass;
            continue;
        }
        break;
    }
    return cur;
}

/**
 * dmd/dsymbolsem.d:1930 — `private bool checkDeprecatedAliasThis(AliasThis at, Loc loc, Scope* sc)`.
 * Check if an `alias this` is deprecated
 *
 * Usually one would use `expression.checkDeprecated(scope, aliasthis)` to
 * check if `expression` uses a deprecated `aliasthis`, but this calls
 * `toPrettyChars` which lead to the following message:
 * "Deprecation: alias this `fullyqualified.aggregate.__anonymous` is deprecated"
 *
 * Params:
 *   at  = The `AliasThis` object to check
 *   loc = `Loc` of the expression triggering the access to `at`
 *   sc  = `Scope` of the expression
 *         (deprecations do not trigger in deprecated scopes)
 *
 * Returns:
 *   Whether the alias this was reported as deprecated.
 */
function checkDeprecatedAliasThis(at: AliasThis, loc: Loc, sc: Scope): boolean {
    if (global.params.useDeprecated !== DiagnosticReporting.off
        && at.isDeprecated() && !sc.isDeprecated()) {
        let message: DString | null = null;
        for (let p: Dsymbol | null = at; p; p = p.parent) {
            // `p.depdecl` is D's `@property depdecl()`; the port spells it as a method (04 §9).
            message = p.depdecl() ? getMessage(p.depdecl()!) : null;
            if (message)
                break;
        }
        if (message)
            deprecation(loc, ds("`alias %s this` is deprecated - %s"),
                        at.sym!.toChars(), message);
        else
            deprecation(loc, ds("`alias %s this` is deprecated"),
                        at.sym!.toChars());

        const ti = sc.parent ? sc.parent.isInstantiated() : null;
        if (ti !== null)
            ti.printInstantiationTrace(Classification.deprecation);

        return true;
    }
    return false;
}

/// dmd/dsymbolsem.d:1958 — `void deferDsymbolSemantic(Scope* sc, Dsymbol s, Scope* scx)`.
/// Save the scope and defer semantic analysis on the Dsymbol.
export function deferDsymbolSemantic(sc: Scope, s: Dsymbol, scx: Scope | null): void {
    s._scope = scx ? scx : sc.copy();
    s._scope.setNoFree();
    addDeferredSemantic(s);
}

/**
 * dmd/dsymbolsem.d:1965 — `struct Ungag`.
 *
 * *** VALUE STRUCT WITH A DESTRUCTOR — READ BEFORE USING. *** D's `~this()` restores
 * `global.gag = oldgag` when the value leaves scope (RAII). TypeScript has NO destructor, so the
 * restore CANNOT live on this class: every call site that would hold an `Ungag` must spell the
 * scope guard itself (06 §7.1):
 *
 *     const ungag = ungagSpeculative(sym);
 *     try { … } finally { global.gag = ungag.oldgag; }   // D's ~Ungag()
 *
 * Live D sites needing that wrapping (chunks 2 & 3): `sd.ungagSpeculative()` at dsymbolsem.d:4740,
 * :5262, :5927 and `auto ungag = Ungag(global.gag);` at :6755.
 *
 * `copy()` is emitted per 03 §6.3's checklist (no `@disable this(this)`); the single `uint` field
 * copies by value.
 */
export class Ungag {
    oldgag: number;

    /// dmd/dsymbolsem.d:1969 — `extern (D) this(uint old)`.
    constructor(old: number) {
        this.oldgag = old;
    }

    copy(): Ungag {
        return new Ungag(this.oldgag);
    }

    // dmd/dsymbolsem.d:1974 — `extern (C++) ~this() nothrow`, body `global.gag = oldgag;`. NOT
    // representable in TS; reproduced by the caller's `finally` (see the class doc comment).
}

/// dmd/dsymbolsem.d:1980 — `Ungag ungagSpeculative(const Dsymbol s)`. Lift gagging for a symbol
/// that is NOT speculative and not function-local, returning the guard that restores it.
/// The returned `Ungag` is a fresh rvalue — copy elided at the return (03 §9 condition 2).
export function ungagSpeculative(s: Dsymbol): Ungag {
    const oldgag = global.gag;
    if (global.gag !== 0 && !s.isSpeculative() && !s.toParent2()!.isFuncDeclaration())
        global.gag = 0;
    return new Ungag(oldgag);
}

/*******************************************
 * dmd/dsymbolsem.d:1997 — `private void checkImportDeprecation(Module m, Loc loc, Scope* sc)`.
 * Print deprecation warning if we're deprecated, when
 * this module is imported from scope sc.
 *
 * Params:
 *  m = the module
 *  sc = the scope into which we are imported
 *  loc = the location of the import statement
 */
function checkImportDeprecation(m: Module, loc: Loc, sc: Scope): void {
    void loc; // D's body diagnoses at `m.loc`, never at the import's `loc` (documented, unused)
    if (!m.md || !m.md.isdeprecated || sc.isDeprecated())
        return;

    const msg = m.md.msg;
    if (msg !== null) {
        // dsymbolsem.d:2003 — `msg.toStringExp()` (UFCS, 04 §6). SWEPT: authorised by
        // dmd/expressionsem.d:425 `StringExp toStringExp(Expression _this)`, live at
        // expressionsem.ts:646.
        const se = toStringExp(msg);
        if (se !== null) {
            const slice = se.peekString();
            if (slice.length !== 0) {
                deprecation(m.loc, ds("%s `%s` is deprecated - %.*s"),
                            m.kind(), m.toPrettyChars(), slice.length, slice);
                return;
            }
        }
    }
    deprecation(m.loc, ds("%s `%s` is deprecated"), m.kind(), m.toPrettyChars());
}

// ===========================================================================================
// dmd/dsymbolsem.d D lines 2015-6191 — `class DsymbolSemanticVisitor` in full.
//
// SPELLINGS USED BELOW (the collision set of preamble §7B, resolved at the import block):
//   typeSize            <- typesem.size(Type, Loc)            (aliased; shadows our sizeDsymbol)
//   typeAlignment       <- typesem.alignment(Type)            (aliased; shadows our alignmentScope)
//   alignmentScope      <- dsymbolsem.alignment(Scope*)       (chunk 1, D:659)
//   searchScope         <- dsymbolsem.search(Scope*, …)       (chunk 1, D:428)
//   newScopeDsymbol     <- dsymbolsem.newScope(Dsymbol, …)    (chunk 3, D:8980)
//   newScope            <- dsymbolsem.newScope(AggregateDeclaration, …) (chunk 1, D:90)
//   checkDeprecatedType <- dsymbolsem.checkDeprecated(Type, …)(chunk 1, D:1638)
//   inferTypeInitializer <- initsem.d:1221 inferType(Initializer, Scope*)  (04 §6.1 receiver-type
//                          suffix; dcast.d:3213 inferType(Expression, Type) keeps the bare name)
//   implicitConvToType  <- dcast.implicitConvTo(Type, Type)   (existing tree spelling)
//   initializerToChars  <- hdrgen.toChars(Initializer)        (hdrgen.d:212, 04 §1 Form B)
//   syntaxCopyInitializer <- init.syntaxCopy(Initializer)     (aliased; `Type.syntaxCopy` is a method)
//   DArray              <- root/array.Array
//   Ref<T>              <- clone.Ref (the 03 §3.3 one-slot box)
//   startsWith          <- root/string.startsWith
//   isCCompatible / interfaceSemantic / attribSemantic / compileIt / visitStaticCDtorDeclaration
//                       are members of THIS class (D declares them as plain methods).
//
// THE AUDITED UPCAST CASCADES (02 §11.5) — one note for the whole fragment.
// Every `x as unknown as Dsymbol` / `... as unknown as ScopeDsymbol` below is the §11.5 cascade,
// forced by the one shadowing pair left once the other pairs were split (02 §11.5b):
//   * `Module.errors` (uint, dmodule.d:173) shadows `Dsymbol.errors` (bool)
//     — hits the Module / Import-target upcasts.
// A cascade on any other receiver is a finding (§11.5c: "anything else spelled `as` on a code line").
// The two NON-cascade `as` shapes present are the branded flag-enum re-cast `(… ) as STC`
// (02 §4.2 / §11.5c #4) and the ONE tag-proved RTTI downcast marked at its site (§11.5c #3).
//
// THE `sc` MIRROR (load-bearing, read before editing any method below).
// D's `Scope* sc` is a FIELD of this visitor, and several methods reassign it; because
// `visit(BitFieldDeclaration)` forwards into `visit(VarDeclaration)` on the SAME instance, and
// `visit(StaticCtorDeclaration)` forwards into `visitStaticCDtorDeclaration`, those reassignments
// are observable by the CALLER. A method-local copy alone would silently drop that coupling.
// Convention used throughout: a non-null local `sc` mirrors the field, and every D assignment
// `sc = X` is emitted as `this.sc = sc = X` so both stay in step; after a call to a sibling method
// that reassigns it, the local is re-read (`sc = this.sc!`). Pre-guard reads use `this.sc`
// directly, because the local can only be introduced once D's `if (!sc) return;` has run.
// ===========================================================================================

// dmd/dsymbolsem.d:4083 — `__gshared int nest;` declared INSIDE `visit(TemplateMixin)`. A D
// `__gshared` local is process-global storage, not a per-call local: it must be module state here
// (preamble §3). Named for its owner so the file's other counters stay distinguishable.
let templateMixinNest = 0;

export class DsymbolSemanticVisitor extends Visitor {
    // dmd/dsymbolsem.d:2017 — `import dmd.typesem: size;` — a CLASS-SCOPED selective import whose
    // only job is to make `Type.size` (typesem) win over this module's own `size(Dsymbol, Loc)`
    // inside the class body. Hoisted to the file's import block as `size as typeSize`; every
    // `x.type.size()` below is `typeSize(x.type)`.
    // 13 §1: `alias visit = Visitor.visit;` (D:2019) dropped — no overload hiding in TS.

    /// `Scope* sc;` — a pointer to a class-backed Scope: the reference itself, nullable, no copy
    /// (02 §10). Mutated by most methods; see THE `sc` MIRROR note above.
    sc: Scope | null;

    /// dmd/dsymbolsem.d:2022 — `this(Scope* sc) scope @safe`. `scope`/`@safe` erase (04 §8).
    constructor(sc: Scope | null) {
        super();
        this.sc = sc;
    }

    /// dmd/dsymbolsem.d:2027 — the base arm: a symbol kind with no pass-1 routine is a compiler bug.
    override visitDsymbol(dsym: Dsymbol): void {
        error(dsym.loc, ds("%s `%s` %p has no semantic routine"), dsym.kind(), dsym.toPrettyChars(), dsym);
    }

    /// dmd/dsymbolsem.d:2032 — `override void visit(ScopeDsymbol) { }` (parameter unnamed in D).
    override visitScopeDsymbol(_s: ScopeDsymbol): void { }

    /// dmd/dsymbolsem.d:2033 — `override void visit(Declaration) { }` (parameter unnamed in D).
    override visitDeclaration(_d: Declaration): void { }

    /**
     * dmd/dsymbolsem.d:2035 — `override void visit(AliasThis dsym)`.
     *
     * Resolves `alias X this;` against the enclosing aggregate: find the member `X`, reject a
     * second alias-this, and reject an alias-this whose type the aggregate already converts to.
     * Preconditions: none beyond a live scope. Postconditions: on success `dsym.sym` names the
     * member and `ad.aliasthis` points back at this declaration.
     */
    override visitAliasThis(dsym: AliasThis): void {
        if (dsym.semanticRun !== PASS.initial)
            return;

        if (dsym._scope !== null) {
            this.sc = dsym._scope;
            dsym._scope = null;
        }

        if (this.sc === null)
            return;
        const sc: Scope = this.sc;

        dsym.semanticRun = PASS.semantic;
        dsym.isDeprecated_ = (sc.stc & STC.deprecated_) !== 0n;

        const p: Dsymbol | null = sc.parent!.pastMixin();
        const ad: AggregateDeclaration | null = p!.isAggregateDeclaration();
        if (ad === null) {
            error(dsym.loc, ds("alias this can only be a member of aggregate, not %s `%s`"),
                p!.kind(), p!.toChars());
            return;
        }

        assert(ad.members !== null);
        // `dsym.ident` below reads through an AliasThis reference: the DERIVED slot (02 §11.5b).
        let s: Dsymbol | null = search(ad, dsym.loc, dsym.identAlias!);
        if (s === null) {
            const pscopesym: { value: Dsymbol | null } = { value: null };
            s = searchScope(sc, dsym.loc, dsym.identAlias!, pscopesym);
            if (s !== null)
                error(dsym.loc, ds("`%s` is not a member of `%s`"), s.toChars(), ad.toChars());
            else
                error(dsym.loc, ds("undefined identifier `%s`"), dsym.identAlias!.toChars());
            return;
        }
        if (ad.aliasthis !== null && s !== ad.aliasthis) {
            error(dsym.loc, ds("there can be only one alias this"));
            return;
        }

        /* disable the alias this conversion so the implicit conversion check
         * doesn't use it.
         */
        ad.aliasthis = null;

        let sx: Dsymbol = s;
        if (sx.isAliasDeclaration() !== null)
            sx = toAlias(sx);
        const d: Declaration | null = sx.isDeclaration();
        if (d !== null && d.isTupleDeclaration() === null) {
            /* https://issues.dlang.org/show_bug.cgi?id=18429
             *
             * If the identifier in the AliasThis declaration
             * is defined later and is a voldemort type, we must
             * perform semantic on the declaration to deduce the type.
             */
            if (d.type === null)
                dsymbolSemantic(d, sc);

            const t: Type | null = d.type;
            assert(t !== null);
            if (implicitConvToType(ad.type!, t!) > MATCH.nomatch) {
                error(dsym.loc, ds("alias this is not reachable as `%s` already converts to `%s`"),
                    ad.toChars(), t!.toChars());
            }
        }

        dsym.sym = s;
        // Restore alias this
        ad.aliasthis = dsym;
        dsym.semanticRun = PASS.semanticdone;
    }

    /**
     * dmd/dsymbolsem.d:2112 — `override void visit(AliasDeclaration dsym)`. Pass-1 for
     * `alias A = B;`: pick up the scope's attributes, then hand off to `aliasSemantic` (D:6679).
     */
    override visitAliasDeclaration(dsym: AliasDeclaration): void {
        if (dsym.semanticRun >= PASS.semanticdone)
            return;
        assert(dsym.semanticRun <= PASS.semantic);

        if (this.sc === null)
            return;
        const sc: Scope = this.sc;

        dsym.semanticRun = PASS.semantic;

        dsym.storage_class = (dsym.storage_class | (sc.stc & STC.deprecated_)) as STC;
        dsym.visibility = sc.visibility.copy();
        dsym.userAttribDecl_set(sc.userAttribDecl); // `@property` setter pair (04 §9)

        if (sc.func === null && dsym.inNonRoot())
            return;

        aliasSemantic(dsym, sc);
    }

    /**
     * dmd/dsymbolsem.d:2133 — `override void visit(AliasAssign dsym)`. `alias A = B;` where `A`
     * already exists (the `alias this = that;` reassignment form); delegates to `aliasAssignSemantic`.
     */
    override visitAliasAssign(dsym: AliasAssign): void {
        //printf("visit(AliasAssign)\n");
        if (dsym.semanticRun >= PASS.semanticdone)
            return;
        assert(dsym.semanticRun <= PASS.semantic);

        const sc: Scope = this.sc!;

        if (sc.func === null && dsym.inNonRoot())
            return;

        aliasAssignSemantic(dsym, sc);
    }
    /**
     * dmd/dsymbolsem.d:2146 — `override void visit(VarDeclaration dsym)`. Pass-1 semantic for a
     * variable/field: attribute pickup, type inference or resolution, `$`-dimension inference,
     * tuple lowering, storage-class legality, default-initializer synthesis, initializer analysis,
     * and destructor construction.
     *
     * Preconditions: `dsym.semanticRun < PASS.semanticdone` (checked); `this.sc` may be null when
     * the symbol carries its own deferred `_scope`. Postconditions: `dsym.semanticRun ==
     * PASS.semanticdone` on every non-deferred exit; `dsym.type` is resolved (or `Type.terror`).
     * Cost: can recurse through `typeSemantic`/`expressionSemantic`/CTFE — never call in a loop.
     *
     * `goto Ldtor` (D:2993, D:3007) is the SKIP-FLAG shape of 06 §4.1 (this very method is that
     * section's worked instance): `gotoLdtor` gates every statement between the jump sites and
     * `Ldtor:`, while the tail after the label stays shared and un-gated.
     */
    override visitVarDeclaration(dsym: VarDeclaration): void {
        // resolved: version (none) (dmd/dsymbolsem.d:2148-2157) -> branch dropped (printf tracing).

        //if (semanticRun > PASS.initial)
        //    return;
        //semanticRun = PSSsemantic;

        if (dsym.semanticRun >= PASS.semanticdone)
            return;

        if (this.sc !== null && this.sc.inunion !== null && this.sc.inunion.isAnonDeclaration() !== null)
            dsym.overlapped = true;

        dsym.sequenceNumber = global.varSequenceNumber++;
        if (!dsym.isScope())
            dsym.maybeScope = true;

        let scx: Scope | null = null;
        if (dsym._scope !== null) {
            this.sc = dsym._scope;
            scx = this.sc;
            dsym._scope = null;
        }

        if (this.sc === null)
            return;
        let sc: Scope = this.sc;

        dsym.semanticRun = PASS.semantic;

        // 'static foreach' variables should not inherit scope properties
        // https://issues.dlang.org/show_bug.cgi?id=19482
        if ((dsym.storage_class & (STC.foreach_ | STC.local)) === (STC.foreach_ | STC.local)) {
            dsym._linkage = LINK.d;
            dsym.visibility = new Visibility(Visibility.Kind.public_);
            dsym.overlapped = false; // unset because it is modified early on this function
            dsym.userAttribDecl_set(null); // unset because it is set by Dsymbol.setScope()
        } else {
            /* Pick up storage classes from context, but except synchronized,
             * override, abstract, and final.
             */
            dsym.storage_class = (dsym.storage_class |
                (sc.stc & ~(STC.synchronized_ | STC.override_ | STC.abstract_ | STC.final_))) as STC;
            dsym.userAttribDecl_set(sc.userAttribDecl);
            dsym.cppnamespace_set(sc.namespace);
            dsym._linkage = sc.linkage;
            dsym.visibility = sc.visibility.copy();
            // `alignmentScope` builds and returns a fresh structalign_t (it never hands back an
            // aggregate's own slot), so the by-value store needs no extra `.copy()` (03 §9).
            dsym.alignment = alignmentScope(sc);
        }

        if ((dsym.storage_class & STC.extern_) !== 0n && dsym._init !== null) {
            if (sc.inCfile) {
                // https://issues.dlang.org/show_bug.cgi?id=24447
                // extern int x = 3; is allowed in C
                dsym.storage_class = (dsym.storage_class & ~STC.extern_) as STC;
            } else {
                error(dsym.loc, ds("%s `%s` extern symbols cannot have initializers"),
                    dsym.kind(), dsym.toPrettyChars());
            }
        }

        const ad: AggregateDeclaration | null = dsym.isThis();
        if (ad !== null)
            dsym.storage_class = (dsym.storage_class | (ad.storage_class & STC.TYPECTOR)) as STC;

        if ((dsym.storage_class & STC.auto_) !== 0n && (dsym.storage_class & STC.ref_) !== 0n) {
            if ((dsym.storage_class & STC.autoref) === 0n) {
                error(dsym.loc, ds("%s `%s` - `auto ref` variable must have `auto` and `ref` adjacent"),
                    dsym.kind(), dsym.toChars());
                dsym.storage_class = (dsym.storage_class | STC.autoref) as STC;
            }
        }

        /* If auto type inference, do the inference
         */
        let inferred = 0;
        if (dsym.type === null) {
            dsym.inuse++;
            // 11 §2.5 (paired state): `inferTypeInitializer` reaches walls and CTFE throws. Two pairs,
            // each with one release in D and no early exit: `sc.startCTFE()`/`sc.endCTFE()`
            // (dmd/dsymbolsem.d:2246/:2252, the popped scope consumed, so it is assigned inside the
            // `finally`) and `dsym.inuse++`/`--` (:2238/:2254).
            try {
                // Infering the type requires running semantic,
                // so mark the scope as ctfe if required
                const needctfe: boolean =
                    (dsym.storage_class & (STC.manifest | STC.static_)) !== 0n || sc.func === null;
                if (needctfe) {
                    sc.condition = true;
                    this.sc = sc = sc.startCTFE();
                }
                try {
                    //printf("inferring type for %s with init %s\n", dsym.toChars(), dsym._init.toChars());
                    dsym._init = inferTypeInitializer(dsym._init!, sc);
                    dsym.type = initializerToExpression(dsym._init, null, sc.inCfile)!.type;
                } finally {
                    if (needctfe)
                        this.sc = sc = sc.endCTFE()!;
                }
            } finally {
                dsym.inuse--;
            }
            inferred = 1;

            /* This is a kludge to support the existing syntax for RAII
             * declarations.
             */
            dsym.storage_class = (dsym.storage_class & ~STC.auto_) as STC;
            dsym.originalType = dsym.type!.syntaxCopy();
        } else {
            if (dsym.originalType === null)
                dsym.originalType = dsym.type.syntaxCopy();

            /* Prefix function attributes of variable declaration can affect
             * its type:
             *      pure nothrow void function() fp;
             *      static assert(is(typeof(fp) == void function() pure nothrow));
             */
            const sc2: Scope = sc.push();
            // 11 §2.5 (paired state): two pairs, each with one release in D and no early exit
            // (`dsym.inuse--` dmd/dsymbolsem.d:2277, `sc2.pop()` :2278), so two plain `finally`.
            try {
                sc2.stc = (sc2.stc | (dsym.storage_class & STC.FUNCATTR)) as STC;
                dsym.inuse++;
                try {
                    dsym.type = typeSemantic(dsym.type, dsym.loc, sc2);
                } finally {
                    dsym.inuse--;
                }
            } finally {
                sc2.pop();
            }
        }

        // dmd/dsymbolsem.d:2280 — `static bool hasDollarDimension(TypeSArray tsa)`. `static` nested
        // (no capture) -> inner const arrow (04 §5), declared in D source order.
        const hasDollarDimension = (tsa: TypeSArray): boolean => {
            const d = tsa.dim;
            if (d === null)
                return false;
            const ide = d.isIdentifierExp();
            if (ide === null)
                return false;
            return ide.ident === Id.dollar;
        };
        // dmd/dsymbolsem.d:2290 — `static bool hasUnresolvedDollar(Type t)` (recursive).
        const hasUnresolvedDollar = (t: Type): boolean => {
            const tsa = t.isTypeSArray();
            if (tsa === null)
                return false;
            if (hasDollarDimension(tsa))
                return true;
            return hasUnresolvedDollar(tsa.next!);
        };

        // dmd/dsymbolsem.d:2300 — `static void resolveDollarToZero(Type t, Loc loc)` (recursive).
        const resolveDollarToZero = (t: Type, loc: Loc): void => {
            const tsa = t.isTypeSArray();
            if (tsa === null)
                return;
            if (hasDollarDimension(tsa)) {
                tsa.dim = new IntegerExp(loc, 0n, Type.tsize_t);
            }
            resolveDollarToZero(tsa.next!, loc);
        };

        // dmd/dsymbolsem.d:2311 — `static bool inferExprLength(Expression e, out dinteger_t len)`.
        // The `out dinteger_t` becomes the single-slot box of 03 §3.3, RESET on entry (D's `out`
        // discards the caller's value). `dinteger_t` is the bigint domain (09 §1).
        const inferExprLength = (e: Expression | null, len: { value: bigint }): boolean => {
            len.value = 0n; // D `out` reset
            if (e === null)
                return false;

            const ale = e.isArrayLiteralExp();
            if (ale !== null) {
                len.value = BigInt(ale.elements!.length);
                return true;
            }

            const ce = e.isCatExp();
            if (ce !== null) {
                const l1 = { value: 0n };
                const l2 = { value: 0n };
                if (inferExprLength(ce.e1, l1) && inferExprLength(ce.e2, l2)) {
                    len.value = l1.value + l2.value;
                    return true;
                }
            }

            if (e.type === null)
                return false;

            const tsan = toBasetype(e.type).isTypeSArray();
            if (tsan === null)
                return false;

            const dim = tsan.dim!.isIntegerExp();
            if (dim === null)
                return false;

            len.value = dim.value;
            return true;
        };

        // dmd/dsymbolsem.d:2348 — `static bool inferSArrayDim(TypeSArray tsa, Expression ie, Loc loc, Scope* sc)`.
        // The `sc` parameter SHADOWS the visitor's field inside the D nested function; keep the
        // parameter name and never touch `this.sc` from here.
        const inferSArrayDim = (tsa: TypeSArray | null, ie: Expression | null, loc: Loc, scArg: Scope | null): boolean => {
            if (tsa === null || ie === null)
                return false;

            if (!hasDollarDimension(tsa))
                return false;

            const ale = ie.isArrayLiteralExp();
            if (ale !== null) {
                const len: bigint = BigInt(ale.elements!.length);
                tsa.dim = new IntegerExp(loc, len, Type.tsize_t);
                const innerTsa = tsa.next!.isTypeSArray();
                if (innerTsa !== null) {
                    if (ale.elements!.length > 0) {
                        const firstElem = ale.elements!.opIndex(0);
                        inferSArrayDim(innerTsa, firstElem, loc, scArg);
                    }
                }
                return true;
            } else {
                const se = ie.isStringExp();
                if (se !== null) {
                    const next: Type = toBasetype(tsa.next!);
                    if (next.ty === TY.Tchar || next.ty === TY.Twchar || next.ty === TY.Tdchar) {
                        tsa.dim = new IntegerExp(loc, BigInt(se.len), Type.tsize_t);
                        return true;
                    }
                    return false;
                }
            }

            // For other initializer forms, infer `$` only when the extent is
            // compile-time known: either a concatenation whose operands are
            // inferable, or any expression whose type is a static array.
            const len = { value: 0n };
            if (!inferExprLength(ie, len))
                return false;

            tsa.dim = new IntegerExp(loc, len.value, Type.tsize_t);
            return true;
        };

        // dmd/dsymbolsem.d:2392 — `static bool shouldTryDeepSArrayDimInference(Expression ie, Scope* sc)`.
        const shouldTryDeepSArrayDimInference = (ie: Expression | null, scArg: Scope | null): boolean => {
            if (ie === null)
                return false;

            // `new` expressions cannot provide a compile-time static extent
            // for inferring `$`, and may recurse through incomplete aggregates.
            if (ie.isNewExp() !== null)
                return false;

            // Field initializers are especially prone to recursive semantic
            // evaluation against incompletely defined aggregates.
            if (scArg !== null && scArg.parent !== null && scArg.parent.isAggregateDeclaration() !== null)
                return false;

            return true;
        };

        const tsa = dsym.type!.isTypeSArray();

        if (tsa !== null && hasDollarDimension(tsa)) {
            if (dsym._init === null || dsym._init.isVoidInitializer() !== null) {
                error(dsym.loc, ds("cannot infer static array length from `$`, provide an initializer"));
                tsa.dim = new IntegerExp(dsym.loc, 0n, Type.tsize_t);
                dsym._init = new ErrorInitializer();
                dsym.type = Type.terror;
                dsym.errors = true;
                dsym.semanticRun = PASS.semanticdone;
                return;
            } else {
                let ie: Expression | null = initializerToExpression(dsym._init, null, sc.inCfile);
                if (ie !== null && ie.op !== EXP.error) {
                    // Infer from literal syntax first to avoid prematurely
                    // semantic-analyzing expressions that may depend on
                    // incomplete types (e.g. recursive initializers).
                    // https://github.com/dlang/dmd/issues/22887
                    let dimInferred: boolean = inferSArrayDim(tsa, ie, dsym.loc, sc);
                    if (!dimInferred && shouldTryDeepSArrayDimInference(ie, sc)) {
                        ie = expressionSemantic(ie, sc);
                        ie = optimize(ie!, WANTvalue);
                        dimInferred = inferSArrayDim(tsa, ie, dsym.loc, sc);
                    }
                    if (!dimInferred) {
                        error(dsym.loc, ds("cannot infer static array length from `$`, provide an initializer"));
                        tsa.dim = new IntegerExp(dsym.loc, 0n, Type.tsize_t);
                        dsym._init = new ErrorInitializer();
                        dsym.type = Type.terror;
                        dsym.errors = true;
                        dsym.semanticRun = PASS.semanticdone;
                        return;
                    }
                    const ale = ie.isArrayLiteralExp();
                    if (ale !== null)
                        dsym._init = new ExpInitializer(dsym.loc, ale);
                }
            }
        }
        if (tsa !== null && hasUnresolvedDollar(tsa.next!)) {
            error(dsym.loc, ds("cannot infer static array length from `$`, provide an initializer"));
            resolveDollarToZero(tsa.next!, dsym.loc);
            return;
        }

        //printf(" semantic type = %s\n", dsym.type ? dsym.type.toChars() : "null");
        if (dsym.type!.ty === TY.Terror)
            dsym.errors = true;

        checkDeprecatedType(dsym.type!, dsym.loc, sc);
        dsym.parent = sc.parent;
        //printf("this = %p, parent = %p, '%s'\n", dsym, dsym.parent, dsym.parent.toChars());

        /* If scope's alignment is the default, use the type's alignment,
         * otherwise the scope overrrides.
         */
        // dmd/dsymbolsem.d:2473 `import dmd.typesem : alignment;` — hoisted as `typeAlignment`.
        if (dsym.alignment.isDefault())
            // `typeAlignment` returns a caller-owned value (typesem.ts copies the aggregate slot
            // itself), so no extra `.copy()` here (03 §9).
            dsym.alignment = typeAlignment(dsym.type!); // use type's alignment

        if (sc.inCfile && !dsym.alignment.isDefault()) {
            /* C11 6.7.5-4 alignment declaration cannot be less strict than the
             * type alignment of the object or member being declared.
             */
            if (dsym.alignment.get() < alignsize(dsym.type!)) {
                if (dsym.alignment.fromAlignas()) {
                    error(dsym.loc, ds("`_Alignas` specifier cannot be less strict than alignment of `%s`"),
                        dsym.toChars());
                }
                if (!dsym.alignment.isPack())
                    dsym.alignment.setDefault();
            }
        }

        //printf("sc.stc = %x\n", sc.stc);
        //printf("storage_class = x%x\n", storage_class);

        checkComplexTransition(dsym.type!, dsym.loc, sc);

        // Calculate type size + safety checks
        if ((dsym.storage_class & STC.gshared) !== 0n && dsym.isMember() === null) {
            // dsymbolsem.d:2502 — `sc.setUnsafe(false, dsym.loc, "using` (UFCS, 04 §6); callee live at
            // dmd/safe.d:469.
            setUnsafe(sc, false, dsym.loc, ds("using `__gshared` instead of `shared`"));
        }

        const parent: Dsymbol | null = dsym.toParent();

        let tb: Type = toBasetype(dsym.type!);
        const tbn: Type = baseElemOf(tb);
        if (tb.ty === TY.Tvoid && (dsym.storage_class & STC.lazy_) === 0n) {
            if (inferred !== 0) {
                // dmd/dsymbolsem.d:2514 — `toChars(dsym._init)` (hdrgen.d:212) is `initializerToChars`;
                // `inferred` means the type came from `_init`, so it is non-null here.
                error(dsym.loc,
                    ds("%s `%s` - type `%s` is inferred from initializer `%s`, and variables cannot be of type `void`"),
                    dsym.kind(), dsym.toPrettyChars(), dsym.type!.toChars(), initializerToChars(dsym._init!));
            } else {
                error(dsym.loc, ds("%s `%s` - variables cannot be of type `void`"),
                    dsym.kind(), dsym.toPrettyChars());
            }
            dsym.type = Type.terror;
            tb = dsym.type;
        }
        if (tb.ty === TY.Tfunction) {
            error(dsym.loc, ds("%s `%s` cannot be declared to be a function"),
                dsym.kind(), dsym.toPrettyChars());
            dsym.type = Type.terror;
            tb = dsym.type;
        }
        {
            const ts = tb.isTypeStruct();
            if (ts !== null) {
                // Require declarations, except when it's just a reference (as done for pointers)
                // or when the variable is defined externally
                if (ts.sym!.members === null && (dsym.storage_class & (STC.ref_ | STC.extern_)) === 0n) {
                    error(dsym.loc, ds("%s `%s` - no definition of struct `%s`"),
                        dsym.kind(), dsym.toPrettyChars(), ts.toChars());

                    // Explain why the definition is required when it's part of another type
                    if (dsym.type!.isTypeStruct() === null) {
                        // Prefer Loc of the dependant type
                        const s = toDsymbol(dsym.type!, sc);
                        // `Loc` is an alias-safe register member (03 §9.1) — shared, not copied.
                        const loc: Loc = (s !== null ? s : (dsym)).loc;
                        errorSupplemental(loc, ds("required by type `%s`"), dsym.type!.toChars());
                    }
                    errorSupplemental(dsym.loc, ds("see https://dlang.org/spec/struct.html#opaque_struct_unions"));
                    errorSupplemental(dsym.loc, ds("perhaps declare a variable with pointer type `%s*` instead"),
                        dsym.type!.toChars());

                    // Flag variable as error to avoid invalid error messages due to unknown size
                    dsym.type = Type.terror;
                }
            }
        }
        if ((dsym.storage_class & STC.auto_) !== 0n && inferred === 0 && (dsym.storage_class & STC.autoref) === 0n) {
            error(dsym.loc,
                ds("%s `%s` - storage class `auto` has no effect if type is not inferred, did you mean `scope`?"),
                dsym.kind(), dsym.toPrettyChars());
        }

        const tt = tb.isTypeTuple();
        if (tt !== null) {
            /* Instead, declare variables for each of the tuple elements
             * and add those.
             */
            const nelems: number = Parameter.dim(tt.arguments);
            let ie: Expression | null = (dsym._init !== null && dsym._init.isVoidInitializer() === null)
                ? initializerToExpression(dsym._init, null, sc.inCfile)
                : null;
            if (ie !== null)
                ie = expressionSemantic(ie, sc);

            // goto Lnomatch (D:2579, 2587, 2617, 2638, 2636) — SKIP-FLAG (06 §4.1): the label at
            // D:2643 sits at the END of this `if (nelems > 0 && ie)` block, so every remaining
            // statement of the block is gated on the flag and the tail is shared.
            let gotoLnomatch = false;
            if (nelems > 0 && ie !== null) {
                const iexps: Expressions = new DArray<Expression | null>();
                iexps.push(ie);
                const exps: Expressions = new DArray<Expression | null>();
                Lpos: for (let pos = 0; pos < iexps.length; pos++) {
                    // goto Lexpand1 (D:2592, 2633) — RETRY (06 §4): re-enter the loop BODY without
                    // advancing `pos`. `Lpos` labels the enclosing counting loop so the D `continue`
                    // statements keep meaning "next pos".
                    Lexpand1: for (;;) {
                        const e: Expression = iexps.opIndex(pos)!;
                        let arg: Parameter | null = Parameter.getNth(tt.arguments, pos);
                        arg!.type = typeSemantic(arg!.type!, dsym.loc, sc);
                        //printf("[%d] iexps.length = %d, ", pos, iexps.length);
                        //printf("e = (%s %s, %s), ", Token.tochars[e.op], e.toChars(), e.type.toChars());
                        //printf("arg = (%s, %s)\n", arg.toChars(), arg.type.toChars());

                        if (e !== ie) {
                            if (iexps.length > nelems) {
                                gotoLnomatch = true; // goto Lnomatch (dmd/dsymbolsem.d:2579)
                                break Lpos;
                            }
                            if (implicitConvToType(e.type!, arg!.type!) !== MATCH.nomatch)
                                continue Lpos;
                        }

                        const te = e.isTupleExp();
                        if (te !== null) {
                            if (iexps.length - 1 + te.exps!.length > nelems) {
                                gotoLnomatch = true; // goto Lnomatch (dmd/dsymbolsem.d:2587)
                                break Lpos;
                            }

                            iexps.remove(pos);
                            iexps.insert(pos, te.exps!);
                            iexps.opIndexAssign(Expression.combine(te.e0, iexps.opIndex(pos)), pos);
                            continue Lexpand1; // goto Lexpand1 (dmd/dsymbolsem.d:2592)
                        } else if (isAliasThisTuple(e) !== null) {
                            // dsymbolsem.d:2594 — callee live at dmd/expressionsem.d:1692.
                            // dsymbolsem.d:2596 — SWEPT: authorised by dmd/sideeffect.d:410
                            // `VarDeclaration copyToTemp(STC stc, const char[] name, Expression e)`,
                            // live at sideeffect.ts:560.
                            const v: VarDeclaration = copyToTemp(STC.none, ds("__tup"), e);
                            dsymbolSemantic(v, sc);
                            const ve = new VarExp(dsym.loc, v);
                            ve.type = e.type;

                            exps.setDim(1);
                            exps.opIndexAssign(ve, 0);
                            // dsymbolsem.d:2603 — SWEPT: authorised by dmd/expressionsem.d:2482
                            // `int expandAliasThisTuples(Expressions* exps, size_t starti = 0)`,
                            // live at expressionsem.ts:2930.
                            expandAliasThisTuples(exps, 0);

                            Lu: for (let u = 0; u < exps.length; u++) {
                                // goto Lexpand2 (D:2622) — RETRY (06 §4): re-enter this body without
                                // advancing `u`. `Lu` labels the counting loop so D's `continue` keeps
                                // meaning "next u".
                                Lexpand2: for (;;) {
                                    const ee: Expression = exps.opIndex(u)!;
                                    arg = Parameter.getNth(tt.arguments, pos + u);
                                    arg!.type = typeSemantic(arg!.type!, dsym.loc, sc);
                                    //printf("[%d+%d] exps.length = %d, ", pos, u, exps.length);
                                    //printf("ee = (%s %s, %s), ", Token.tochars[ee.op], ee.toChars(), ee.type.toChars());
                                    //printf("arg = (%s, %s)\n", arg.toChars(), arg.type.toChars());

                                    const iexps_dim: number = iexps.length - 1 + exps.length;
                                    if (iexps_dim > nelems) {
                                        gotoLnomatch = true; // goto Lnomatch (dmd/dsymbolsem.d:2617)
                                        break Lpos;
                                    }
                                    if (implicitConvToType(ee.type!, arg!.type!) !== MATCH.nomatch)
                                        continue Lu;

                                    // dsymbolsem.d:2621 — SWEPT: same authorising D definition,
                                    // dmd/expressionsem.d:2482 (expressionsem.ts:2930).
                                    if (expandAliasThisTuples(exps, u) !== -1)
                                        continue Lexpand2; // goto Lexpand2 (dmd/dsymbolsem.d:2622)
                                    break Lexpand2;
                                }
                            }

                            if (exps.opIndex(0) !== ve) {
                                const e0: Expression = exps.opIndex(0)!;
                                exps.opIndexAssign(new CommaExp(dsym.loc, new DeclarationExp(dsym.loc, v), e0), 0);
                                exps.opIndex(0)!.type = e0.type;

                                iexps.remove(pos);
                                iexps.insert(pos, exps);
                                continue Lexpand1; // goto Lexpand1 (dmd/dsymbolsem.d:2633)
                            }
                        }
                        break Lexpand1; // fall off the end of the D loop body -> next `pos`
                    }
                }
                if (!gotoLnomatch && iexps.length < nelems)
                    gotoLnomatch = true; // goto Lnomatch (dmd/dsymbolsem.d:2638)

                if (!gotoLnomatch)
                    ie = TupleExp.fromExps(dsym._init!.loc, iexps); // D `new TupleExp(loc, exps)` -> the 2-arg factory
            }
            // Lnomatch: (dmd/dsymbolsem.d:2642) — shared tail, NOT gated.

            if (ie !== null && ie.op === EXP.tuple) {
                const te = ie.isTupleExp()!;
                const tedim: number = te.exps!.length;
                if (tedim !== nelems) {
                    error(dsym.loc, ds("sequence of %d elements cannot be assigned to sequence of %d elements"),
                        tedim, nelems);
                    for (let u = tedim; u < nelems; u++) // fill dummy expression
                        te.exps!.push(ErrorExp.get());
                }
            }

            const exps: Objects = new DArray<RootObject | null>(nelems);
            for (let i = 0; i < nelems; i++) {
                const arg: Parameter | null = Parameter.getNth(tt.arguments, i);

                const buf = new OutBuffer();
                buf.printf(ds("__%s_field_%llu"), dsym.ident!.toChars(), BigInt(i));
                const id = Identifier.idPool(buf.opSliceAll());

                let ti: Initializer | null;
                if (ie !== null) {
                    let einit: Expression | null = ie;
                    const te = ie.isTupleExp();
                    if (te !== null) {
                        einit = te.exps!.opIndex(i);
                        if (i === 0)
                            einit = Expression.combine(te.e0, einit);
                    }
                    // Use the original initializer location, not the tuple element's location,
                    // so error messages point to the declaration site
                    ti = new ExpInitializer(dsym._init !== null ? dsym._init.loc : einit!.loc, einit!);
                } else {
                    ti = dsym._init !== null ? syntaxCopyInitializer(dsym._init) : null;
                }

                let storage_class: STC = (STC.temp | dsym.storage_class) as STC;
                if ((dsym.storage_class & STC.parameter) !== 0n && (arg!.storageClass & STC.parameter) !== 0n)
                    storage_class = (storage_class | arg!.storageClass) as STC;
                const v = new VarDeclaration(dsym.loc, arg!.type, id, ti, storage_class);
                //printf("declaring field %s of type %s\n", v.toChars(), v.type.toChars());
                v.overlapped = dsym.overlapped;

                dsymbolSemantic(v, sc);

                const e: Expression = new VarExp(dsym.loc, v);
                exps.opIndexAssign(e, i);
            }
            const v2 = new TupleDeclaration(dsym.loc, dsym.ident!, exps);
            v2.parent = dsym.parent;
            v2.isexp = true;
            dsym.aliasTuple = v2;
            dsym.semanticRun = PASS.semanticdone;
            return;
        }

        /* Storage class can modify the type
         */
        dsym.type = addStorageClass(dsym.type!, dsym.storage_class);

        /* Adjust storage class to reflect type
         */
        if (dsym.type.isConst()) {
            dsym.storage_class = (dsym.storage_class | STC.const_) as STC;
            if (dsym.type.isShared())
                dsym.storage_class = (dsym.storage_class | STC.shared_) as STC;
        } else if (dsym.type.isImmutable()) {
            dsym.storage_class = (dsym.storage_class | STC.immutable_) as STC;
        } else if (dsym.type.isShared()) {
            dsym.storage_class = (dsym.storage_class | STC.shared_) as STC;
        } else if (dsym.type.isWild()) {
            dsym.storage_class = (dsym.storage_class | STC.wild) as STC;
        }

        {
            // D declares `stc` inside the `if` condition -> hoisted const + explicit test (06 §2.6).
            const stc: STC = (dsym.storage_class &
                (STC.synchronized_ | STC.override_ | STC.abstract_ | STC.final_)) as STC;
            if (stc !== 0n) {
                if (stc === STC.final_) {
                    error(dsym.loc, ds("%s `%s` cannot be `final`, perhaps you meant `const`?"),
                        dsym.kind(), dsym.toPrettyChars());
                } else {
                    const buf = new OutBuffer();
                    stcToBuffer(buf, stc);
                    error(dsym.loc, ds("%s `%s` cannot be `%s`"),
                        dsym.kind(), dsym.toPrettyChars(), buf.peekChars());
                }
                dsym.storage_class = (dsym.storage_class & ~stc) as STC; // strip off
            }
        }

        // At this point we can add `scope` to the STC instead of `in`,
        // because we are never going to use this variable's STC for user messages
        if ((dsym.storage_class & STC.constscoperef) !== 0n)
            dsym.storage_class = (dsym.storage_class | STC.scope_) as STC;

        // dmd/dsymbolsem.d:2739 `import dmd.typesem : hasPointers;` — hoisted to the file top.

        if ((dsym.storage_class & STC.scope_) !== 0n) {
            const stc: STC = (dsym.storage_class &
                (STC.static_ | STC.extern_ | STC.manifest | STC.gshared)) as STC;
            if (stc !== 0n) {
                const buf = new OutBuffer();
                stcToBuffer(buf, stc);
                error(dsym.loc, ds("%s `%s` cannot be `scope` and `%s`"),
                    dsym.kind(), dsym.toPrettyChars(), buf.peekChars());
            } else if (dsym.isMember() !== null) {
                error(dsym.loc, ds("field `%s` cannot be `scope`"), dsym.toChars());
            } else if (!hasPointers(dsym.type)) {
                dsym.storage_class = (dsym.storage_class & ~STC.scope_) as STC; // silently ignore; may occur in generic code
                // https://issues.dlang.org/show_bug.cgi?id=23168
                if ((dsym.storage_class & STC.returnScope) !== 0n) {
                    dsym.storage_class = (dsym.storage_class & ~(STC.return_ | STC.returnScope)) as STC;
                }
            }
        }

        if ((dsym.storage_class & (STC.static_ | STC.extern_ | STC.manifest | STC.templateparameter |
            STC.gshared | STC.ctfe)) !== 0n) {
            // D's `then` branch is intentionally empty.
        } else {
            const aad: AggregateDeclaration | null = parent!.isAggregateDeclaration();
            if (aad !== null) {
                if (global.params.v.field && (dsym.storage_class & (STC.const_ | STC.immutable_)) !== 0n &&
                    dsym._init !== null && dsym._init.isVoidInitializer() === null) {
                    const s: DString = (dsym.storage_class & STC.immutable_) !== 0n ? ds("immutable") : ds("const");
                    message(dsym.loc, ds("`%s.%s` is `%s` field"), ad!.toPrettyChars(), dsym.toChars(), s);
                }
                dsym.storage_class = (dsym.storage_class | STC.field) as STC;
                const ts = tbn.isTypeStruct();
                if (ts !== null) {
                    if (ts.sym!.noDefaultCtor) {
                        if (dsym.isThisDeclaration() === null && dsym._init === null)
                            aad.noDefaultCtor = true;
                    }
                }
            }

            const id: InterfaceDeclaration | null = parent!.isInterfaceDeclaration();
            if (id !== null) {
                error(dsym.loc, ds("field `%s` not allowed in interface"), dsym.toChars());
            } else if (aad !== null && aad.sizeok === Sizeok.done) {
                error(dsym.loc, ds("cannot declare field `%s` because it will change the determined size of `%s`"),
                    dsym.toChars(), aad.toChars());
            }

            /* Templates cannot add fields to aggregates
             */
            let ti: TemplateInstance | null = parent!.isTemplateInstance();
            if (ti !== null) {
                // Take care of nested templates
                for (;;) {
                    const ti2: TemplateInstance | null = ti!.tempdecl!.parent!.isTemplateInstance();
                    if (ti2 === null)
                        break;
                    ti = ti2;
                }
                // If it's a member template
                const ad2: AggregateDeclaration | null = ti!.tempdecl!.isMember();
                if (ad2 !== null && dsym.storage_class !== STC.none) {
                    error(dsym.loc, ds("%s `%s` - cannot use template to add field to aggregate `%s`"),
                        dsym.kind(), dsym.toPrettyChars(), ad2.toChars());
                }
            }
        }

        // resolved: `mixin alignSectionVarsExtra; doAlign();` (dmd/dsymbolsem.d:2819) -> the IN_LLVM
        // instantiation is `mixin template alignSectionVarsExtra() { void doAlign() { } }`
        // (dmd/targetcompiler.d:103), i.e. an EMPTY no-op — nothing to emit (07 §6).

        if ((dsym.storage_class & (STC.ref_ | STC.field)) === (STC.ref_ | STC.field) && dsym.ident !== Id.This) {
            error(dsym.loc, ds("%s `%s` - field declarations cannot be `ref`"),
                dsym.kind(), dsym.toPrettyChars());
        }

        if (dsym.type.hasWild() !== 0) {
            if ((dsym.storage_class & (STC.static_ | STC.extern_ | STC.gshared | STC.manifest | STC.field)) !== 0n ||
                dsym.isDataseg()) {
                error(dsym.loc, ds("%s `%s` - only parameters or stack-based variables can be `inout`"),
                    dsym.kind(), dsym.toPrettyChars());
            }
            let func: FuncDeclaration | null = sc.func;
            if (func !== null) {
                if (func.fes !== null)
                    func = func.fes.func;
                let isWild = false;
                for (let fd: FuncDeclaration | null = func; fd !== null;
                     fd = fd.toParentDecl()!.isFuncDeclaration()) {
                    if (fd.type!.isTypeFunction()!.iswild()) {
                        isWild = true;
                        break;
                    }
                }
                if (!isWild) {
                    error(dsym.loc, ds("%s `%s` - `inout` variables can only be declared inside `inout` functions"),
                        dsym.kind(), dsym.toPrettyChars());
                }
            }
        }

        if ((dsym.storage_class & (STC.ctfe | STC.extern_ | STC.ref_ | STC.result)) === 0n &&
            tbn.ty === TY.Tstruct && tbn.isTypeStruct()!.sym!.noDefaultCtor) {
            if (dsym._init === null) {
                if (dsym.isField()) {
                    /* For fields, we'll check the constructor later to make sure it is initialized
                     */
                    dsym.storage_class = (dsym.storage_class | STC.nodefaultctor) as STC;
                } else if ((dsym.storage_class & STC.parameter) !== 0n) {
                    // D's branch is intentionally empty.
                } else {
                    error(dsym.loc, ds("%s `%s` - default construction is disabled for type `%s`"),
                        dsym.kind(), dsym.toPrettyChars(), dsym.type.toChars());
                }
            }
        }

        let dsymIsRef: boolean = (dsym.storage_class &
            (STC.ref_ | STC.field | STC.parameter | STC.temp | STC.foreach_)) === STC.ref_;
        if (dsymIsRef) {
            if (dsym._init === null && dsym.ident !== Id.This) {
                if ((dsym.storage_class & STC.autoref) !== 0n) {
                    dsymIsRef = false;
                    dsym.storage_class = (dsym.storage_class & ~STC.ref_) as STC;
                } else {
                    error(dsym.loc, ds("%s `%s` - initializer is required for `ref` variable"),
                        dsym.kind(), dsym.toPrettyChars());
                }
            } else if (dsym._init!.isVoidInitializer() !== null) {
                error(dsym.loc, ds("%s `%s` - void initializer not allowed for `ref` variable"),
                    dsym.kind(), dsym.toPrettyChars());
            }
        }

        const fd: FuncDeclaration | null = parent!.isFuncDeclaration();
        if (dsym.type.isScopeClass() && (dsym.storage_class & STC.nodtor) === 0n) {
            if ((dsym.storage_class & (STC.field | STC.out_ | STC.ref_ | STC.static_ | STC.manifest |
                STC.gshared)) !== 0n || fd === null) {
                error(dsym.loc,
                    ds("%s `%s` globals, statics, fields, manifest constants, ref and out parameters cannot be `scope`"),
                    dsym.kind(), dsym.toPrettyChars());
            }

            // @@@DEPRECATED_2.097@@@  https://dlang.org/deprecate.html#scope%20as%20a%20type%20constraint
            // Deprecated in 2.087
            // Remove this when the feature is removed from the language
            if ((dsym.storage_class & STC.scope_) === 0n) {
                if ((dsym.storage_class & STC.parameter) === 0n && dsym.ident !== Id.withSym) {
                    error(dsym.loc, ds("%s `%s` reference to `scope class` must be `scope`"),
                        dsym.kind(), dsym.toPrettyChars());
                }
            }
        }

        // Calculate type size + safety checks
        if (sc.func !== null) {
            if (dsym._init !== null && dsym._init.isVoidInitializer() !== null &&
                (dsym.storage_class & STC.temp) === 0n) {
                // Don't do these checks for STC.temp vars because the generated `opAssign`
                // for a struct with postblit and destructor void initializes a temporary
                // __swap variable, which can be trusted

                // dsymbolsem.d:2919 — `sc.setUnsafe(false, dsym.loc,` and the same at :2922 (UFCS, 04 §6);
                // callee live at dmd/safe.d:469.
                if (hasPointers(dsym.type)) { // also computes type size
                    setUnsafe(sc, false, dsym.loc, ds("`void` initializing a pointer"));
                } else if (hasInvariant(dsym.type)) {
                    setUnsafe(sc, false, dsym.loc, ds("`void` initializing a struct with an invariant"));
                } else if (toBasetype(dsym.type).ty === TY.Tbool) {
                    setUnsafePreview(sc, global.params.systemVariables, false, dsym.loc,
                        ds("`void` initializing a `bool` (which must always be 0 or 1)"));
                } else if (hasUnsafeBitpatterns(dsym.type)) {
                    setUnsafePreview(sc, global.params.systemVariables, false, dsym.loc,
                        ds("`void` initializing a type with unsafe bit patterns"));
                }
            } else if (dsym._init === null &&
                (dsym.storage_class & (STC.static_ | STC.extern_ | STC.gshared | STC.manifest |
                    STC.field | STC.parameter)) === 0n &&
                hasVoidInitPointers(dsym.type)) {
                // dsymbolsem.d:2935 — `sc.setUnsafe(false, dsym.loc, "`; UFCS (04 §6), callee live at
                // dmd/safe.d:469.
                setUnsafe(sc, false, dsym.loc, ds("`void` initializers for pointers"));
            }
        }

        // D writes `dsym._init.isVoidInitializer` without call parens (D's optional-parens rule
        // CALLS the zero-argument method; `&f` would be needed to take its address), so this is the
        // ordinary nullable-reference test of 06 §2.7.
        if ((dsym._init === null || dsym._init.isVoidInitializer() !== null) && fd === null) {
            // If not mutable, initializable by constructor only
            dsym.setInCtorOnly = true;
        }

        if (dsym._init !== null) {
            // remember we had an explicit initializer
        } else if ((dsym.storage_class & STC.manifest) !== 0n) {
            error(dsym.loc, ds("%s `%s` - manifest constants must have initializers"),
                dsym.kind(), dsym.toPrettyChars());
        }

        // Don't allow non-extern, non-__gshared variables to be interfaced with C++
        if (dsym._linkage === LINK.cpp &&
            (dsym.storage_class & (STC.ctfe | STC.extern_ | STC.gshared)) === 0n && dsym.isDataseg()) {
            const p: DString = (dsym.storage_class & STC.shared_) !== 0n ? ds("shared") : ds("static");
            error(dsym.loc, ds("%s `%s` cannot have `extern(C++)` linkage because it is `%s`"),
                dsym.kind(), dsym.toPrettyChars(), p);
            errorSupplemental(dsym.loc, ds("perhaps declare it as `__gshared` instead"));
            dsym.errors = true;
        }

        let isBlit = false;
        let sz: bigint = 0n;
        if (sc.inCfile && dsym._init === null) {
            // dmd/dsymbolsem.d:2963 — `addDefaultCInitializer(dsym);`
            addDefaultCInitializer(dsym);
        }
        // goto Ldtor (D:2993, D:3007) — SKIP-FLAG (06 §4.1). EVERY statement between the jump sites
        // and `Ldtor:` is gated on this flag; the tail after the label is shared and un-gated.
        let gotoLdtor = false;
        if (dsym._init === null &&
            (dsym.storage_class & (STC.static_ | STC.gshared | STC.extern_)) === 0n &&
            fd !== null &&
            ((dsym.storage_class & (STC.field | STC.in_ | STC.foreach_ | STC.parameter | STC.result)) === 0n ||
                (dsym.storage_class & STC.out_) !== 0n) &&
            (sz = typeSize(dsym.type)) !== 0n) {
            // Provide a default initializer

            //printf("Providing default initializer for '%s'\n", dsym.toChars());
            if (sz === SIZE_INVALID && dsym.type.ty !== TY.Terror) {
                error(dsym.loc, ds("%s `%s` - size of type `%s` is invalid"),
                    dsym.kind(), dsym.toPrettyChars(), dsym.type.toChars());
            }

            let tv: Type = dsym.type;
            while (tv.ty === TY.Tsarray)    // Don't skip Tenum
                tv = nextOf(tv)!;
            if (needsNested(tv)) {
                /* Nested struct requires valid enclosing frame pointer.
                 * In StructLiteralExp::toElem(), it's calculated.
                 */
                assert(tbn.ty === TY.Tstruct);
                // dsymbolsem.d:2987 — SWEPT: authorised by dmd/expressionsem.d:18527
                // `bool checkFrameAccess(Loc loc, Scope* sc, AggregateDeclaration ad, size_t
                // iStart = 0)`, live at expressionsem.ts:20837. D discards the bool result.
                checkFrameAccess(dsym.loc, sc, tbn.isTypeStruct()!.sym!);

                let e: Expression = defaultInitLiteral(tv, dsym.loc)!;
                e = new BlitExp(dsym.loc, new VarExp(dsym.loc, dsym), e);
                e = expressionSemantic(e, sc);
                dsym._init = new ExpInitializer(dsym.loc, e);
                gotoLdtor = true; // goto Ldtor (dmd/dsymbolsem.d:2993)
            }
            if (!gotoLdtor) {
                if (tv.ty === TY.Tstruct && tv.isTypeStruct()!.sym!.zeroInit) {
                    /* If a struct is all zeros, as a special case
                     * set its initializer to the integer 0.
                     * In AssignExp::toElem(), we check for this and issue
                     * a memset() to initialize the struct.
                     * Must do same check in interpreter.
                     */
                    let e: Expression = IntegerExp.literal(0);
                    e = new BlitExp(dsym.loc, new VarExp(dsym.loc, dsym), e);
                    e.type = dsym.type;      // don't type check this, it would fail
                    dsym._init = new ExpInitializer(dsym.loc, e);
                    gotoLdtor = true; // goto Ldtor (dmd/dsymbolsem.d:3007)
                }
            }
            if (!gotoLdtor) {
                if (baseElemOf(dsym.type).ty === TY.Tvoid) {
                    error(dsym.loc, ds("%s `%s` of type `%s` does not have a default initializer"),
                        dsym.kind(), dsym.toPrettyChars(), dsym.type.toChars());
                } else {
                    const e = defaultInit(dsym.type, dsym.loc);
                    if (e !== null) {
                        dsym._init = new ExpInitializer(dsym.loc, e);
                    }
                }

                // Default initializer is always a blit
                isBlit = true;
            }
        }
        if (!gotoLdtor && dsym._init !== null) {
            this.sc = sc = sc.push();
            // 11 §2.5 (paired state): capture-in-finally; D has one release (`sc = sc.pop()`, dmd/dsymbolsem.d:3331)
            // and no early exit between it and the push (:3023), and consumes the popped scope, so it is assigned in
            // the `finally`.
            try {
                sc.stc = (sc.stc
                    & ~(STC.TYPECTOR | STC.pure_ | STC.nothrow_ | STC.nogc | STC.ref_ | STC.disable)) as STC;

                if (sc.inCfile &&
                    dsym.type.isTypeSArray() !== null &&
                    dsym.type.isTypeSArray()!.isIncomplete() &&
                    dsym._init.isVoidInitializer() !== null &&
                    (dsym.storage_class & STC.field) === 0n) {
                    error(dsym.loc, ds("%s `%s` - incomplete array type must have initializer"),
                        dsym.kind(), dsym.toPrettyChars());
                }

                let ei: ExpInitializer | null = dsym._init.isExpInitializer();

                if (ei !== null) { // https://issues.dlang.org/show_bug.cgi?id=13424
                        // Preset the required type to fail in FuncLiteralDeclaration::semantic3
                    ei.exp = inferType(ei.exp!, dsym.type);
                }

                /*
                 * https://issues.dlang.org/show_bug.cgi?id=24474
                 * at function scope, the compiler thinks the type of the variable is not known yet
                 * (semantically complete) so looks like typeof gets locked in a cyclic situation
                 * semantics is actually done. just set it for importc
                 */
                if (sc.func !== null && dsym.type !== null && dsym.type.deco !== null && sc.inCfile)
                    dsym.semanticRun = PASS.semanticdone;

                // If inside function, there is no semantic3() call
                if (sc.func !== null || sc.intypeof === 1) {
                    // If local variable, use AssignExp to handle all the various
                    // possibilities.
                    if (fd !== null &&
                        (dsym.storage_class & (STC.manifest | STC.static_ | STC.gshared | STC.extern_)) === 0n &&
                        dsym._init.isVoidInitializer() === null) {
                        //printf("fd = '%s', var = '%s'\n", fd.toChars(), dsym.toChars());
                        if (ei === null) {
                            const ai: ArrayInitializer | null = dsym._init.isArrayInitializer();
                            let e: Expression | null;
                            if (ai !== null && tb.ty === TY.Taarray)
                                e = toAssocArrayLiteral(ai);
                            else
                                e = initializerToExpression(dsym._init, dsym.type, sc.inCfile);
                            if (e === null) {
                                // Run semantic, but don't need to interpret
                                const txBox = { value: dsym.type! }; // D `ref Type tx` -> box (03 §3.2)
                                dsym._init = initializerSemantic(dsym._init, sc, txBox, INITnointerpret);
                                dsym.type = txBox.value;
                                e = initializerToExpression(dsym._init, null, sc.inCfile);
                                if (e === null) {
                                    error(dsym.loc, ds("%s `%s` is not a static and cannot have static initializer"),
                                        dsym.kind(), dsym.toPrettyChars());
                                    e = ErrorExp.get();
                                }
                            }
                            ei = new ExpInitializer(dsym._init.loc, e);
                            dsym._init = ei;
                        } else if (sc.inCfile && dsym.type.isTypeSArray() !== null &&
                                   dsym.type.isTypeSArray()!.isIncomplete()) {
                            // C11 6.7.9-22 determine the size of the incomplete array,
                            // or issue an error that the initializer is invalid.
                            const txBox = { value: dsym.type! };
                            dsym._init = initializerSemantic(dsym._init, sc, txBox, INITinterpret);
                            dsym.type = txBox.value;
                        }

                        if (ei !== null && dsym.isScope()) {
                            let ex: Expression = lastComma(ei.exp!);
                            // tag-proved downcast below: op is blit/construct (02 §11.5c)
                            if (ex.op === EXP.blit || ex.op === EXP.construct)
                                ex = (ex as unknown as AssignExp).e2!;
                            const ne = ex.isNewExp();
                            if (ne !== null) {
                                if (ne.placement !== null) {
                                    // D's branch is intentionally empty.
                                }
                                /* See if initializer is a NewExp that can be allocated on the stack.
                                 */
                                else if (toBasetype(dsym.type).ty === TY.Tclass) {
                                    /* Unsafe to allocate on stack if constructor is not `scope` because the `this`
                                     * can leak.
                                     * https://issues.dlang.org/show_bug.cgi?id=23145
                                     */
                                    if (ne.member !== null && (ne.member.storage_class & STC.scope_) === 0n) {
                                        // dmd/dsymbolsem.d:3107 `import dmd.escape : setUnsafeDIP1000;` (hoisted).
                                        // dsymbolsem.d:3108 — D evaluates `sc.func.isSafeBypassingInference()` (UFCS,
                                        // 04 §6; callee live at dmd/safe.d:348) and never reads `inSafeFunc` again, so
                                        // the port evaluates it too and discards the value. D's trailing comment
                                        // says it "may call setUnsafe()"; for this call shape it has no effect:
                                        // `isSafe`'s `setFunctionToUnsafe` (safe.d:343) is gated on the
                                        // `safetyInprocess` flag the `&&` at safe.d:350 has already excluded.
                                        const inSafeFunc = sc.func !== null && isSafeBypassingInference(sc.func);
                                        void inSafeFunc;
                                        // dsymbolsem.d:3109 — callee live at dmd/escape.d:2211. `ref Scope sc` is an
                                        // alias, not a copy (03 §3.2); `RootObject[] args...` is a typesafe variadic
                                        // (04 §3.2) -> the rest argument `dsym`. `Scope.useDIP1000` answers enabled or
                                        // disabled only, never `default_`: with dip1000 off the callee returns false;
                                        // with `-preview=dip1000` (or edition v2024) it reaches `setUnsafe`
                                        // (safe.d:469).
                                        if (setUnsafeDIP1000(sc, false, dsym.loc,
                                            ds("`scope` allocation of `%s` with a non-`scope` constructor"), dsym))
                                            errorSupplemental(ne.member.loc, ds("is the location of the constructor"));
                                    }
                                    ne.onstack = true; // D `ne.onstack = 1` on a `bool` field
                                    dsym.onstack = true;
                                    // resolved: version (IN_LLVM) (dmd/dsymbolsem.d:3114) -> ON, branch KEPT.
                                    const tcStatic = toBasetype(dsym.type).isTypeClass();
                                    let tcDynamic = toBasetype(ne.newtype!).isTypeClass();
                                    if (tcDynamic === null) {
                                        //printf(".: resolving %s\n", ne.newtype.toPrettyChars());
                                        ne.newtype = typeSemantic(ne.newtype!, dsym.loc, sc);
                                        tcDynamic = toBasetype(ne.newtype).isTypeClass();
                                        assert(tcDynamic !== null);
                                    }

                                    dsym.onstackWithMatchingDynType = tcStatic!.sym === tcDynamic!.sym;
                                }
                            } else {
                                const fe = ex.isFuncExp();
                                if (fe !== null) {
                                    // or a delegate that doesn't escape a reference to the function
                                    const f: FuncDeclaration = fe.fd!;
                                    if (f.tookAddressOf !== 0)
                                        f.tookAddressOf--;
                                } else {
                                    const ale = ex.isArrayLiteralExp();
                                    if (ale !== null) {
                                        // or an array literal assigned to a `scope` variable
                                        if (sc.useDIP1000() === FeatureState.enabled &&
                                            !needsDestruction(nextOf(dsym.type)!))
                                            ale.onstack = true;
                                    }
                                }
                            }
                        }

                        // `exp` is REASSIGNED by the nested `constructInit`; D closes over the local,
                        // so the TS arrow closes over a `let` in the same frame (04 §5, 03 §3.2).
                        let exp: Expression = ei!.exp!;
                        const e1: Expression = new VarExp(dsym.loc, dsym);

                        // dmd/dsymbolsem.d:3149 — `void constructInit(bool isBlit)`. Captures
                        // `exp` / `e1` / `dsym` / `sc`; mutates `exp`.
                        const constructInit = (isBlitArg: boolean): void => {
                            if (isBlitArg)
                                exp = new BlitExp(dsym.loc, e1, exp);
                            else
                                exp = new ConstructExp(dsym.loc, e1, exp);
                            dsym.canassign++;
                            // 11 §2.5 (paired state): one release in D (dmd/dsymbolsem.d:3157), no early exit.
                            try {
                                exp = expressionSemantic(exp, sc);
                            } finally {
                                dsym.canassign--;
                            }
                        };

                        // follow logic similar to typesem.argumentMatchParameter() and statementsem.visitForeach()
                        if (dsymIsRef) {
                            dsym.storage_class = (dsym.storage_class | STC.nodtor) as STC;
                            exp = expressionSemantic(exp, sc);
                            const tp: Type = dsym.type;
                            const ta: Type = exp.type!;
                            if (!isLvalue(exp)) {
                                if ((dsym.storage_class & STC.autoref) !== 0n) {
                                    dsym.storage_class = (dsym.storage_class & ~STC.ref_) as STC;
                                    constructInit(isBlit);
                                } else {
                                    error(dsym.loc, ds("rvalue `%s` cannot be assigned to `ref %s`"),
                                        exp.toChars(), dsym.toChars());
                                    exp = ErrorExp.get();
                                }
                            } else if (constConv(ta, tp) === MATCH.nomatch) {
                                if ((dsym.storage_class & STC.autoref) !== 0n) {
                                    dsym.storage_class = (dsym.storage_class & ~STC.ref_) as STC;
                                    constructInit(false);
                                } else {
                                    error(dsym.loc, ds("type `%s` cannot be assigned to `ref %s %s`"),
                                        ta.toChars(), tp.toChars(), dsym.toChars());
                                    exp = ErrorExp.get();
                                }
                            } else if (isBitField(exp) !== null) { // dsymbolsem.d:3192 (callee: expressionsem.d:20129)
                                if ((dsym.storage_class & STC.autoref) !== 0n) {
                                    dsym.storage_class = (dsym.storage_class & ~STC.ref_) as STC;
                                    constructInit(false);
                                } else {
                                    error(dsym.loc, ds("bitfield `%s` cannot be assigned to `ref %s`"),
                                        exp.toChars(), dsym.toChars());
                                    exp = ErrorExp.get();
                                }
                            } else {
                                constructInit(false);
                            }
                        } else {
                            constructInit(isBlit);
                        }

                        if (exp.op === EXP.error) {
                            dsym._init = new ErrorInitializer();
                            ei = null;
                        } else {
                            ei!.exp = optimize(exp, WANTvalue);
                        }
                    } else {
                        // https://issues.dlang.org/show_bug.cgi?id=14166
                        // Don't run CTFE for the temporary variables inside typeof
                        const txBox = { value: dsym.type! };
                        dsym._init = initializerSemantic(dsym._init, sc, txBox,
                            sc.intypeof === 1 ? INITnointerpret : INITinterpret);
                        dsym.type = txBox.value;
                        // dmd/dsymbolsem.d:3228 `import dmd.semantic2 : lowerStaticAAs;` — hoisted to the
                        // module-level TS import (01 §4.4).
                        // dmd/dsymbolsem.d:3229 — `lowerStaticAAs(dsym, sc);`; callee live at
                        // dmd/semantic2.d:980 (`void lowerStaticAAs(VarDeclaration vd, Scope* sc)`; the
                        // `Expression` overload at :996 is a different family and is not called here).
                        lowerStaticAAs(dsym, sc);
                        const init_err: ExpInitializer | null = dsym._init.isExpInitializer();
                        if (init_err !== null && init_err.exp!.op === EXP.showCtfeContext) {
                            init_err.exp = ErrorExp.get();
                            errorSupplemental(dsym.loc, ds("compile time context created here"));
                        }
                    }
                } else if (parent!.isAggregateDeclaration() !== null) {
                    dsym._scope = scx !== null ? scx : sc.copy();
                    dsym._scope.setNoFree();
                } else if ((dsym.storage_class & (STC.const_ | STC.immutable_ | STC.manifest)) !== 0n ||
                           dsym.type.isConst() || dsym.type.isImmutable() ||
                           sc.inCfile) {
                    /* Because we may need the results of a const declaration in a
                     * subsequent type, such as an array dimension, before semantic2()
                     * gets ordinarily run, try to run semantic2() now.
                     * If a C array is of unknown size, the initializer can provide the size. Do this
                     * eagerly because C does it eagerly.
                     * Ignore failure.
                     */
                    if (inferred === 0) {
                        const errors = global.errors;
                        dsym.inuse++;
                        // 11 §2.5 (paired state): initializer semantic reaches walls and CTFE throws; D has one
                        // release (dmd/dsymbolsem.d:3318) and no early exit, so a plain `finally`.
                        try {
                            // Bug 20549. Don't try this on modules or packages, syntaxCopy
                            // could crash (inf. recursion) on a mod/pkg referencing itself
                            if (ei !== null
                                && (ei.exp!.op !== EXP.scope_
                                    ? true : ei.exp!.isScopeExp()!.sds!.isPackage() === null)) {
                                if (ei.exp!.type !== null) {
                                    // If exp is already resolved we are done, our original init exp
                                    // could have a type painting that we need to respect
                                    // e.g.  ['a'] typed as string, or [['z'], ""] as string[]
                                    // See https://issues.dlang.org/show_bug.cgi?id=15711
                                } else {
                                    let exp: Expression = ei.exp!.syntaxCopy();

                                    const needctfe: boolean =
                                        dsym.isDataseg() || (dsym.storage_class & STC.manifest) !== 0n;
                                    if (needctfe)
                                        this.sc = sc = sc.startCTFE();
                                    // 11 §2.5 (paired state): `startCTFE`/`endCTFE` (dmd/dsymbolsem.d:3275/:3282) and
                                    // `push`/`pop` (:3276/:3280) each release once with no early exit; the popped
                                    // scope is consumed, so it is assigned inside the `finally`.
                                    try {
                                        this.sc = sc = sc.push();
                                        try {
                                            sc.varDecl = dsym; // https://issues.dlang.org/show_bug.cgi?id=24051
                                            exp = expressionSemantic(exp, sc);
                                            exp = resolveProperties(sc, exp);
                                        } finally {
                                            this.sc = sc = sc.pop()!;
                                        }
                                    } finally {
                                        if (needctfe)
                                            this.sc = sc = sc.endCTFE()!;
                                    }
                                    ei.exp = exp;
                                }

                                const tb2: Type = toBasetype(dsym.type);
                                const ti: Type = toBasetype(ei.exp!.type!);

                                /* The problem is the following code:
                                 *  struct CopyTest {
                                 *     double x;
                                 *     this(double a) { x = a * 10.0;}
                                 *     this(this) { x += 2.0; }
                                 *  }
                                 *  const CopyTest z = CopyTest(5.3);  // ok
                                 *  const CopyTest w = z;              // not ok, postblit not run
                                 *  static assert(w.x == 55.0);
                                 * because the postblit doesn't get run on the initialization of w.
                                 */
                                const ts = ti.isTypeStruct();
                                if (ts !== null) {
                                    const sd: StructDeclaration = ts.sym!;
                                    /* Look to see if initializer involves a copy constructor
                                     * (which implies a postblit)
                                     */
                                    // there is a copy constructor
                                    // and exp is the same struct
                                    if (sd.postblit !== null && toDsymbol(tb2, null) === sd) {
                                        // The only allowable initializer is a (non-copy) constructor
                                        if (isLvalue(ei.exp!)) {
                                            error(dsym.loc,
                                                ds("%s `%s` of type struct `%s` uses `this(this)`, which is not allowed in static initialization"),
                                                dsym.kind(), dsym.toPrettyChars(), tb2.toChars());
                                        }
                                    }
                                }
                            }

                            const txBox = { value: dsym.type! };
                            dsym._init = initializerSemantic(dsym._init, sc, txBox, INITinterpret);
                            dsym.type = txBox.value;
                        } finally {
                            dsym.inuse--;
                        }
                        if (global.errors > errors) {
                            dsym._init = new ErrorInitializer();
                            dsym.type = Type.terror;
                        }
                    } else {
                        dsym._scope = scx !== null ? scx : sc.copy();
                        dsym._scope.setNoFree();
                    }
                }
            } finally {
                this.sc = sc = sc.pop()!;
            }
        }

        // Ldtor: (dmd/dsymbolsem.d:3334) — reached BOTH by the two `goto Ldtor`s above and by
        // fall-through; the tail is shared and un-gated (06 §4.1).
        /* Build code to execute destruction, if necessary
         */
        dsym.edtor = callScopeDtor(dsym, sc);
        if (dsym.edtor !== null) {
            if (sc.func !== null && (dsym.storage_class & (STC.static_ | STC.gshared)) !== 0n)
                dsym.edtor = expressionSemantic(dsym.edtor, sc._module!._scope!);
            else
                dsym.edtor = expressionSemantic(dsym.edtor, sc);

            // resolved: version (none) (dmd/dsymbolsem.d:3345-3350) -> branch dropped.
        }

        dsym.semanticRun = PASS.semanticdone;

        if (toBasetype(dsym.type!).ty === TY.Terror)
            dsym.errors = true;

        if (sc.scopesym !== null && sc.scopesym.isAggregateDeclaration() === null) {
            for (let sym: ScopeDsymbol | null = sc.scopesym; sym !== null && dsym.endlinnum === 0;
                 sym = sym.parent !== null ? sym.parent.isScopeDsymbol() : null) {
                dsym.endlinnum = sym.endlinnum;
            }
        }
    }
    /// dmd/dsymbolsem.d:3366 — a TypeInfo declaration is created already-analysed; only its linkage
    /// invariant is asserted.
    override visitTypeInfoDeclaration(dsym: TypeInfoDeclaration): void {
        assert(dsym._linkage === LINK.c);
    }

    /// dmd/dsymbolsem.d:3371 — `override void visit(CAsmDeclaration dsym)`.
    /// resolved: version (IN_LLVM) (D:3375) -> ON: the branch imports `dmd.iasm.gcc : gccAsmSemantic`
    /// (hoisted to the import block, 01 §4.4); the `else` branch (`dmd.iasm : asmSemantic`) is dead and emits
    /// nothing (07 §1).
    override visitCAsmDeclaration(dsym: CAsmDeclaration): void {
        if (dsym.semanticRun >= PASS.semanticdone)
            return;
        gccAsmSemanticCAsmDeclaration(dsym, this.sc!);
        dsym.semanticRun = PASS.semanticdone;
    }

    /**
     * dmd/dsymbolsem.d:3388 — `override void visit(BitFieldDeclaration dsym)`. Runs the whole
     * VarDeclaration pass first (D forwards through `visit(cast(VarDeclaration)dsym)`, which mutates
     * the SHARED `sc` field — see THE `sc` MIRROR note), then CTFEs and range-checks the bit width.
     */
    override visitBitFieldDeclaration(dsym: BitFieldDeclaration): void {
        //printf("BitField::semantic('%s')\n", dsym.toChars());
        if (dsym.semanticRun >= PASS.semanticdone)
            return;

        const isAnonymous: boolean = dsym.isAnonymous();
        if (isAnonymous && dsym._init !== null) {
            error(dsym._init.loc, ds("anonymous bitfield cannot have default initializer"));
            dsym._init = null;
            dsym.errors = true;
        }

        // 13 §4: `visit(cast(VarDeclaration)dsym)` -> the base's named slot; the cast vanishes.
        this.visitVarDeclaration(dsym);
        if (dsym.errors)
            return;
        // Re-read the mirror: visitVarDeclaration reassigns `this.sc` (it may adopt `dsym._scope`
        // and it pushes/pops around the initializer analysis).
        let sc: Scope = this.sc!;

        if (!(sc.previews.bitfields || sc.inCfile)) {
            error(dsym.loc, ds("%s `%s` use `-%spreview=bitfields` for bitfield support"),
                dsym.kind(), dsym.toPrettyChars(), SwitchPrefix);
        }

        if (dsym.parent!.isStructDeclaration() === null && dsym.parent!.isClassDeclaration() === null) {
            error(dsym.loc, ds("%s `%s` - bitfield must be member of struct, union, or class"),
                dsym.kind(), dsym.toPrettyChars());
        }

        this.sc = sc = sc.startCTFE();
        let width: Expression;
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            width = expressionSemantic(dsym.width!, sc);
        } finally {
            this.sc = sc = sc.endCTFE()!;
        }
        width = ctfeInterpret(width);       // dsymbolsem.d:3419
        if (!isIntegral(dsym.type!)) {
            // C11 6.7.2.1-5
            if (isAnonymous)
                error(dsym.loc, ds("anonymous bitfield cannot be of non-integral type `%s`"), dsym.type!.toChars());
            else
                error(dsym.loc, ds("bitfield `%s` cannot be of non-integral type `%s`"),
                    dsym.toChars(), dsym.type!.toChars());
            dsym.errors = true;
            return;
        }
        if (width.isIntegerExp() === null) {
            error(width.loc, ds("bitfield width `%s` is not an integer constant"), dsym.width!.toChars());
            dsym.errors = true;
        }
        const uwidth: bigint = toInteger(width); // uwidth is unsigned
        if (uwidth === 0n && !isAnonymous) {
            error(dsym.loc, ds("bitfield `%s` cannot have zero width"), dsym.toChars());
            dsym.errors = true;
        }
        // `cast(long)uwidth` — reinterpret the same 64 bits in the SIGNED domain (09 §3.1).
        if (BigInt.asIntN(64, uwidth) < 0n) {
            if (isAnonymous) {
                error(width.loc, ds("anonymous bitfield has negative width `%lld`"), BigInt.asIntN(64, uwidth));
            } else {
                error(width.loc, ds("bitfield `%s` has negative width `%lld`"),
                    dsym.toChars(), BigInt.asIntN(64, uwidth));
            }
            dsym.errors = true;
        } else {
            const sz: bigint = typeSize(dsym.type!);
            if (sz === SIZE_INVALID)
                dsym.errors = true;
            // D's `sz` is `uinteger_t` (ulong), so `sz * 8` WRAPS modulo 2^64 — reachable here
            // because the `sz == SIZE_INVALID` branch above only sets `errors` and falls through
            // (D:3451-3452). Re-truncate after the 64-bit multiply (09 §3).
            const max_width: bigint = BigInt.asUintN(64, sz * 8n);
            if (uwidth > max_width) {
                if (isAnonymous) {
                    error(width.loc, ds("width `%lld` of anonymous bitfield does not fit in type `%s`"),
                        BigInt.asIntN(64, uwidth), dsym.type!.toChars());
                } else {
                    error(width.loc, ds("width `%lld` of bitfield `%s` does not fit in type `%s`"),
                        BigInt.asIntN(64, uwidth), dsym.toChars(), dsym.type!.toChars());
                }
                dsym.errors = true;
            }
        }
        // `cast(uint)uwidth` — truncate to 32 bits, then leave the index/width domain (09 §2).
        dsym.fieldWidth = Number(BigInt.asUintN(32, uwidth));
    }

    /**
     * dmd/dsymbolsem.d:3467 — `override void visit(Import imp)`. Loads the imported module, records
     * the import edge on the importing module, and resolves each selective/renamed alias.
     *
     * dropped: `timeTraceBeginEvent(TimeTraceEventType.sema1Import)` (D:3469) and its
     * `scope (exit) timeTraceEndEvent(…)` (D:3470) — `dmd.timetrace` is a profiling-only module
     * outside the port perimeter; the pair has no effect on the AST, and dropping both together
     * keeps the `scope(exit)` balanced (so no try/finally is needed either). Flagged for integrator
     * ratification in this wave's report.
     * resolved: static if (LOG) (D:3471-3476) -> false, emits nothing.
     */
    override visitImport(imp: Import): void {
        if (imp.semanticRun > PASS.initial)
            return;

        if (imp._scope !== null) {
            this.sc = imp._scope;
            imp._scope = null;
        }
        if (this.sc === null)
            return;
        let sc: Scope = this.sc;

        imp.parent = sc.parent;

        imp.semanticRun = PASS.semantic;

        // Load if not already done so
        if (imp.mod === null) {
            // https://issues.dlang.org/show_bug.cgi?id=22857
            // if parser errors occur when loading a module
            // we should just stop compilation
            if (load(imp, sc)) {
                for (let i = 0; i < imp.aliasdecls.length; i++)
                    imp.aliasdecls.opIndex(i)!.type = Type.terror;
                return;
            }

            if (imp.mod !== null) {
                importAll(imp.mod, null);
                checkImportDeprecation(imp.mod, imp.loc, sc);
            }
        }
        if (imp.mod === null) {
            imp.semanticRun = PASS.semanticdone;
            addImportDep(global.params.moduleDeps, imp, sc._module!); // dmd/deps.d:168
        }

        // Modules need a list of each imported module

        // if inside a template instantiation, the instantianting
        // module gets the import.
        // https://issues.dlang.org/show_bug.cgi?id=17181
        let importer: Module = sc._module!;
        if (sc.minst !== null && sc.tinst !== null) {
            importer = sc.minst;
            if (!sc.tinst.importedModules.contains(imp.mod))
                sc.tinst.importedModules.push(imp.mod);
        }
        //printf("%s imports %s\n", importer.toChars(), imp.mod.toChars());
        if (!importer.aimports.contains(imp.mod))
            importer.aimports.push(imp.mod);

        if (sc.explicitVisibility)
            imp.visibility = sc.visibility.copy();

        if (imp.aliasId === null && imp.names.length === 0) { // neither a selective nor a renamed import
            const scopesym: ScopeDsymbol = sc.getScopesym()!;

            if (imp.isstatic === 0) {
                // `Visibility visibility` is a BY-VALUE parameter (dsymbol.d:1162) and `Visibility`
                // has no register row (03 §9.1) — copy at the call site (03 §1 #2 / §3.1).
                scopesym.importScope(imp.mod as unknown as Dsymbol, imp.visibility.copy());
            }

            imp.addPackageAccess(scopesym);
        }

        // if a module has errors it means that parsing has failed.
        if (imp.mod!.errors === 0)
            dsymbolSemantic(imp.mod as unknown as Dsymbol, null);

        if (imp.mod!.needmoduleinfo !== 0) {
            //printf("module4 %s because of %s\n", importer.toChars(), imp.mod.toChars());
            importer.needmoduleinfo = 1;
        }

        this.sc = sc = sc.push(imp.mod as unknown as ScopeDsymbol);
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            sc.visibility = imp.visibility.copy();
            for (let i = 0; i < imp.aliasdecls.length; i++) {
                const ad: AliasDeclaration = imp.aliasdecls.opIndex(i)!;
                //printf("\tImport %s alias %s = %s, scope = %p\n", toPrettyChars(), aliases[i].toChars(), names[i].toChars(), ad._scope);
                const sym: Dsymbol | null = search(imp.mod as unknown as Dsymbol, imp.loc,
                    imp.names.opIndex(i)!, SearchOpt.ignorePrivateImports);
                if (sym !== null) {
                    // dmd/dsymbolsem.d:3568 `import dmd.access : symbolIsVisible;` — hoisted.
                    if (!symbolIsVisible(sc, sym) && !sym.errors) {
                        error(imp.loc, ds("%s `%s` member `%s` is not visible from module `%s`"),
                            imp.mod!.kind(), imp.mod!.toPrettyChars(),
                            imp.names.opIndex(i)!.toChars(), sc._module!.toChars());
                        sym.errors = true;
                        if (K.on) keepForeignErrors(sym);   // the kept-module engine: another module's symbol
                    }
                    dsymbolSemantic(ad, sc);
                    // If the import declaration is in non-root module,
                    // analysis of the aliased symbol is deferred.
                    // Therefore, don't see the ad.aliassym or ad.type here.
                } else {
                    const s: Dsymbol | null = search_correct(imp.mod as unknown as Dsymbol, imp.names.opIndex(i)!);
                    // https://issues.dlang.org/show_bug.cgi?id=23908
                    // Don't suggest symbols from the importer's module
                    if (s !== null && s.parent !== (importer as unknown as Dsymbol)) {
                        error(imp.loc, ds("%s `%s` import `%s` not found, did you mean %s `%s`?"),
                            imp.mod!.kind(), imp.mod!.toPrettyChars(), imp.names.opIndex(i)!.toChars(),
                            s.kind(), s.toPrettyChars());
                    } else {
                        error(imp.loc, ds("%s `%s` import `%s` not found"),
                            imp.mod!.kind(), imp.mod!.toPrettyChars(), imp.names.opIndex(i)!.toChars());
                    }
                    ad.type = Type.terror;
                }
            }
        } finally {
            this.sc = sc = sc.pop()!;
        }

        imp.semanticRun = PASS.semanticdone;
        addImportDep(global.params.moduleDeps, imp, sc._module!); // dmd/deps.d:168
    }

    /**
     * dmd/dsymbolsem.d:3598 — `void attribSemantic(AttribDeclaration ad)`. A plain method (not a
     * visitor slot): run pass-1 on whichever members the attribute currently includes.
     *
     * Preconditions: `ad.semanticRun == PASS.initial` (checked). Postconditions: `semanticdone`,
     * and `ad.errors` set if any member errored. The member scope, when `newScopeDsymbol` produced
     * a fresh one, is popped before returning.
     */
    attribSemantic(ad: AttribDeclaration): void {
        if (ad.semanticRun !== PASS.initial)
            return;
        ad.semanticRun = PASS.semantic;
        const sc: Scope | null = this.sc;
        const d: Dsymbols | null = include(ad, sc);
        //printf("\tAttribDeclaration::semantic '%s', d = %p\n",toChars(), d);
        if (d === null) {
            ad.semanticRun = PASS.semanticdone;
            return;
        }

        // `ad`'s static type is AttribDeclaration -> the Dsymbol overload of `newScope`
        // (dmd/dsymbolsem.d:8980), NOT the AggregateDeclaration one (04 §1B, preamble §7A).
        const sc2: Scope | null = newScopeDsymbol(ad, sc!);
        let errors = false;
        for (let i = 0; i < d.length; i++) {
            const s: Dsymbol = d.opIndex(i)!;
            dsymbolSemantic(s, sc2);
            errors = errors || s.errors;
        }
        if (errors)
            ad.errors = true;
        if (sc2 !== sc)
            sc2!.pop();

        ad.semanticRun = PASS.semanticdone;
    }

    /// dmd/dsymbolsem.d:3627 — `override void visit(AttribDeclaration atd)`.
    override visitAttribDeclaration(atd: AttribDeclaration): void {
        this.attribSemantic(atd);
    }

    /// dmd/dsymbolsem.d:3632 — `override void visit(AnonDeclaration scd)`. An anonymous
    /// struct/union body: analyse its members in a scope that records the enclosing union.
    override visitAnonDeclaration(scd: AnonDeclaration): void {
        //printf("\tAnonDeclaration::semantic isunion:%d ptr:%p\n", scd.isunion, scd);
        let sc: Scope = this.sc!;
        assert(sc.parent !== null);
        const p: Dsymbol | null = sc.parent!.pastMixin();
        const ad: AggregateDeclaration | null = p!.isAggregateDeclaration();
        if (ad === null) {
            error(scd.loc, ds("%s can only be a part of an aggregate, not %s `%s`"),
                scd.kind(), p!.kind(), p!.toChars());
            scd.errors = true;
            return;
        }

        if (scd.decl === null)
            return;

        this.sc = sc = sc.push();
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            sc.stc = (sc.stc & ~(STC.auto_ | STC.scope_ | STC.static_ | STC.gshared)) as STC;
            sc.inunion = scd.isunion ? (scd) : sc.inunion;
            sc.resetAllFlags();
            for (let i = 0; i < scd.decl.length; i++) {
                const s: Dsymbol = scd.decl.opIndex(i)!;
                // D writes `s.isVarDeclaration` without parens — the optional-parens rule CALLS it.
                const var_ = s.isVarDeclaration();
                if (var_ !== null) {
                    if (scd.isunion)
                        var_.overlapped = true;
                }
                dsymbolSemantic(s, sc);
            }
        } finally {
            this.sc = sc = sc.pop()!;
        }
    }

    /// dmd/dsymbolsem.d:3665 — `override void visit(PragmaDeclaration pd)`.
    /// dmd/dsymbolsem.d:3667 `import dmd.pragmasem : pragmaDeclSemantic;` — hoisted.
    override visitPragmaDeclaration(pd: PragmaDeclaration): void {
        pragmaDeclSemantic(pd, this.sc!);
    }

    /// dmd/dsymbolsem.d:3671 — `override void visit(StaticIfDeclaration sid)`.
    override visitStaticIfDeclaration(sid: StaticIfDeclaration): void {
        this.attribSemantic(sid);
    }

    /// dmd/dsymbolsem.d:3676 — `override void visit(StaticForeachDeclaration sfd)`.
    override visitStaticForeachDeclaration(sfd: StaticForeachDeclaration): void {
        this.attribSemantic(sfd);
    }

    /**
     * dmd/dsymbolsem.d:3681 — `private Dsymbols* compileIt(MixinDeclaration cd)`. CTFE the mixin's
     * expression list to a string, then PARSE it as a declaration list.
     *
     * Returns null on any failure (string evaluation, parse errors, trailing tokens).
     * Cost: runs a full sub-parse; the `str` buffer is NUL-terminated in place and consumed
     * (`extractSlice`, 08 §13a.2 — the OutBuffer is emptied by design).
     */
    compileIt(cd: MixinDeclaration): Dsymbols | null {
        //printf("MixinDeclaration::compileIt(loc = %d) %s\n", cd.loc.linnum, cd.exp.toChars());
        const sc: Scope = this.sc!;
        const buf = new OutBuffer();
        // dmd/dsymbolsem.d:3685 — `if (expressionsToString(buf, sc, cd.exps, cd.loc, null, true))`;
        // callee live at dmd/expressionsem.d:1166 (`bool expressionsToString(ref OutBuffer buf,
        // Scope* sc, Expressions* exps, Loc loc, const(char)* fmt, bool expandTuples)`).
        if (expressionsToString(buf, sc, cd.exps, cd.loc, null, true))
            return null;

        const errors = global.errors;
        const len = buf.length();
        buf.writeByte(0);
        const str: DString = buf.extractSlice().subarray(0, len);
        const doUnittests: boolean = global.params.parsingUnittestsRequired();
        // `scope p = new Parser!ASTCodegen(...)` — `scope` erases (04 §8); the `!ASTCodegen`
        // instantiation is monomorphized away (13 §3). The D ctor overload without a leading `Loc`
        // maps to the single TS ctor with `loc = null` (04 §1A).
        const p = new Parser(null, sc._module, str, false, global.errorSink!, global.compileEnv, doUnittests);
        adjustLocForMixin(str, cd.loc, p.baseLoc!, global.params.mixinOut);
        p.linnum = p.baseLoc!.startLine;
        p.nextToken();

        const d: Dsymbols | null = p.parseDeclDefs(0);
        if (global.errors !== errors)
            return null;

        if (p.token.value !== TOK.endOfFile) {
            error(cd.loc, ds("%s `%s` incomplete mixin declaration `%s`"),
                cd.kind(), cd.toPrettyChars(), str);
            return null;
        }
        return d;
    }

    /***********************************************************
     * https://dlang.org/spec/module.html#mixin-declaration
     * dmd/dsymbolsem.d:3713 — `override void visit(MixinDeclaration cd)`.
     */
    override visitMixinDeclaration(cd: MixinDeclaration): void {
        //printf("MixinDeclaration::semantic()\n");
        if (!cd.compiled) {
            cd.decl = this.compileIt(cd);
            attribAddMember(cd, this.sc, cd.scopesym!);
            cd.compiled = true;

            if (cd._scope !== null && cd.decl !== null) {
                for (let i = 0; i < cd.decl.length; i++) {
                    const s: Dsymbol = cd.decl.opIndex(i)!;
                    setScope(s, cd._scope);
                }
            }
        }
        this.attribSemantic(cd);
    }

    /**
     * dmd/dsymbolsem.d:3734 — `override void visit(CPPNamespaceDeclaration ns)`. `extern(C++, ns)`:
     * when the namespace is named by an identifier the whole thing is an ordinary attribute; when it
     * is named by a compile-time string (or a tuple of strings), the expression is CTFE'd first and
     * a namespace chain is built from the result.
     */
    override visitCPPNamespaceDeclaration(ns: CPPNamespaceDeclaration): void {
        let sc: Scope = this.sc!;

        // dmd/dsymbolsem.d:3736 — nested `Identifier identFromSE(StringExp se)`; captures `ns`.
        // Declared here (D declaration order) even though its only uses are past the wall below.
        const identFromSE = (se: StringExp): Identifier | null => {
            const sident: DString = se.toStringz();
            if (sident.length === 0 || !Identifier.isValidIdentifier(sident)) {
                error(ns.exp!.loc, ds("expected valid identifier for C++ namespace but got `%s`"), toErrMsg(se));
                return null;
            } else {
                return Identifier.idPool(sident);
            }
        };
        if (ns.ident !== null) {
            this.attribSemantic(ns);
            return;
        }

        ns.cppnamespace_set(sc.namespace);
        this.sc = sc = sc.startCTFE();
        // 11 §2.5 (paired state): capture-in-finally; D releases once (dsymbolsem.d:3755), no early exit, and the
        // popped scope is consumed, so it is assigned inside the `finally`.
        try {
            ns.exp = expressionSemantic(ns.exp!, sc);
            ns.exp = resolveProperties(sc, ns.exp);
        } finally {
            this.sc = sc = sc.endCTFE()!;
        }
        ns.exp = ctfeInterpret(ns.exp);     // dsymbolsem.d:3756
        // Can be either a tuple of strings or a string itself
        const te = ns.exp.isTupleExp();
        if (te !== null) {
            // dmd/dsymbolsem.d:3760 — `expandTuples(te.exps);`; callee live at dmd/expressionsem.d:343
            // (`void expandTuples(Expressions* exps, ArgumentLabels* names = null)`); D omits the
            // default `names` argument, so the port omits it too.
            expandTuples(te.exps);
            let current: CPPNamespaceDeclaration | null = ns.cppnamespace();
            for (let d = 0; d < te.exps!.length; ++d) {
                const exp: Expression = te.exps!.opIndex(d)!;
                const prev: CPPNamespaceDeclaration | null = d !== 0 ? current : ns.cppnamespace();
                current = (d + 1) !== te.exps!.length
                    ? new CPPNamespaceDeclaration(ns.loc, exp, null)
                    : ns;
                current!.exp = exp;
                current!.cppnamespace_set(prev);
                const se = toStringExp(exp); // dsymbolsem.d:3771 (callee: expressionsem.d:425)
                if (se !== null) {
                    current.ident = identFromSE(se);
                    if (current.ident === null)
                        return; // An error happened in `identFromSE`
                } else {
                    error(ns.exp.loc, ds("`%s`: index %llu is not a string constant, it is a `%s`"),
                        ns.exp.toChars(), BigInt(d), ns.exp.type!.toChars());
                }
            }
        } else {
            const se = toStringExp(ns.exp); // dsymbolsem.d:3782 (callee: expressionsem.d:425)
            if (se !== null) {
                ns.ident = identFromSE(se);
            }
            // Empty Tuple
            else if (ns.exp.isTypeExp() !== null &&
                     toBasetype(ns.exp.isTypeExp()!.type!).isTypeTuple() !== null) {
                // D's branch is intentionally empty.
            } else if (ns.exp.type!.isTypeError() === null) {
                error(ns.exp.loc, ds("compile time string constant (or sequence) expected, not `%s`"),
                    ns.exp.toChars());
            }
        }
        this.attribSemantic(ns);
    }

    /// dmd/dsymbolsem.d:3794 — `override void visit(UserAttributeDeclaration uad)`.
    override visitUserAttributeDeclaration(uad: UserAttributeDeclaration): void {
        //printf("UserAttributeDeclaration::semantic() %p\n", this);
        const sc: Scope = this.sc!;
        if (uad.decl !== null && uad._scope === null)
            setScope(uad, sc); // for function local symbols
        // dsymbolsem.d:3799 — `arrayExpressionSemantic(uad.atts.peekSlice(), sc, true)`. SWEPT:
        // authorised by dmd/expressionsem.d:1923 `extern(D) bool arrayExpressionSemantic(
        // Expression[] exps, Scope* sc, bool preserveErrors = false)`, live at
        // expressionsem.ts:2301 (the old wall text's "not exported" claim is now false).
        // The D parameter is a SLICE that `foreach (ref e; exps)` WRITES BACK THROUGH, and
        // `peekSlice` in this port returns a COPY — so the live-backing spelling `tdata()` is
        // mandatory here (expressionsem.ts:2286-2298 states the contract). D's `peekSlice` on a
        // null `Expressions*` yields an empty slice, hence the null arm.
        arrayExpressionSemantic(uad.attsUda !== null ? uad.attsUda.tdata() : [], sc, true);
        this.attribSemantic(uad);
    }

    /**
     * dmd/dsymbolsem.d:3803 — `override void visit(StaticAssert sa)`.
     *
     * https://issues.dlang.org/show_bug.cgi?id=24645 — the short-circuit here fires a module-scope
     * `static assert(false, …)` during semantic1 so it is not drowned out by later import errors.
     * Inside mixin templates the check is deliberately left to semantic2 (you want the trace).
     */
    override visitStaticAssert(sa: StaticAssert): void {
        if (sa.semanticRun < PASS.semanticdone)
            sa.semanticRun = PASS.semanticdone;
        else
            return;

        const sc: Scope = this.sc!;
        if (sc.parent !== null && sc.parent.isModule() !== null) {
            const i = sa.exp!.isIntegerExp();
            if (i !== null) {
                if (toInteger(i) === 0n) {
                    // dmd/dsymbolsem.d:3825 — `staticAssertFail(sa, sc);`; callee live at
                    // dmd/semantic2.d:1043 (`void staticAssertFail(StaticAssert sa, Scope* sc)`).
                    staticAssertFail(sa, sc);
                }
            }
        }
    }

    /// dmd/dsymbolsem.d:3828 — `override void visit(DebugSymbol ds)`. Parameter renamed to `dsy`:
    /// `ds` is the module's DString literal helper (01 §2.3-style local collision avoidance).
    override visitDebugSymbol(dsy: DebugSymbol): void {
        //printf("DebugSymbol::semantic() %s\n", toChars());
        if (dsy.semanticRun < PASS.semanticdone)
            dsy.semanticRun = PASS.semanticdone;
    }

    /// dmd/dsymbolsem.d:3835 — `override void visit(VersionSymbol vs)`.
    override visitVersionSymbol(vs: VersionSymbol): void {
        if (vs.semanticRun < PASS.semanticdone)
            vs.semanticRun = PASS.semanticdone;
    }

    /// dmd/dsymbolsem.d:3841 — `override void visit(Package pkg)`.
    override visitPackage(pkg: Package): void {
        if (pkg.semanticRun < PASS.semanticdone)
            pkg.semanticRun = PASS.semanticdone;
    }

    /**
     * dmd/dsymbolsem.d:3847 — `override void visit(Module m)`. Pass 1 over a whole module.
     *
     * NOTE the D body declares its OWN local `Scope* sc` (D:3858), shadowing the visitor field —
     * this method never touches `this.sc`.
     *
     * dropped: `timeTraceBeginEvent(TimeTraceEventType.sema1Module)` (D:3852) and its
     * `scope (exit) timeTraceEndEvent(…)` (D:3853) — see the matching note on `visitImport`.
     */
    override visitModule(m: Module): void {
        if (m.semanticRun !== PASS.initial) {
            if (K.on) keepReq(m, KeepUnit.sem1);   // the kept-module engine: a request of a unit that ran
            return;
        }
        if (K.on && keepRun(m, KeepUnit.sem1))     // the kept-module engine: replays a kept unit, or records
            return;

        //printf("+Module::semantic(this = %p, '%s'): parent = %p\n", this, toChars(), parent);
        m.semanticRun = PASS.semantic;
        // Note that modules get their own scope, from scratch.
        // This is so regardless of where in the syntax a module
        // gets imported, it is unaffected by context.
        let sc: Scope | null = m._scope; // see if already got one from importAll()
        if (sc === null) {
            sc = scopeCreateGlobal(m, global.errorSink!); // create root scope
        }

        //printf("Module = %p, linkage = %d\n", sc.scopesym, sc.linkage);
        // Pass 1 semantic routines: do public side of the definition
        foreachDsymbolVoid(m.members, (s: Dsymbol): void => {
            //printf("\tModule('%s'): '%s'.dsymbolSemantic()\n", toChars(), s.toChars());
            dsymbolSemantic(s, sc);
            runDeferredSemantic();
        });

        if (m.userAttribDecl() !== null) { // `@property` getter pair (04 §9)
            dsymbolSemantic(m.userAttribDecl()!, sc);
        }
        if (m._scope === null) {
            sc = sc.pop();
            sc!.pop(); // 2 pops because scopeCreateGlobal() created 2
        }
        m.semanticRun = PASS.semanticdone;
        //printf("-Module::semantic(this = %p, '%s'): parent = %p\n", this, toChars(), parent);
    }

    /// dmd/dsymbolsem.d:3888 — `override void visit(EnumDeclaration ed)`.
    override visitEnumDeclaration(ed: EnumDeclaration): void {
        enumSemantic(this.sc, ed);
    }

    /// dmd/dsymbolsem.d:3893 — `override void visit(EnumMember em)`.
    override visitEnumMember(em: EnumMember): void {
        enumMemberSemantic(this.sc, em);
    }

    /// dmd/dsymbolsem.d:3898 — `override void visit(TemplateDeclaration tempdecl)`.
    override visitTemplateDeclaration(tempdecl: TemplateDeclaration): void {
        // dsymbolsem.d:3900 — SWEPT: authorised by dmd/templatesem.d:731
        // `void templateDeclarationSemantic(Scope* sc, TemplateDeclaration tempdecl)`, live at
        // templatesem.ts:1081.
        templateDeclarationSemantic(this.sc, tempdecl);
    }

    /// dmd/dsymbolsem.d:3903 — `override void visit(TemplateInstance ti)`.
    override visitTemplateInstance(ti: TemplateInstance): void {
        // dsymbolsem.d:3905 — SWEPT: authorised by dmd/templatesem.d:869
        // `void templateInstanceSemantic(TemplateInstance tempinst, Scope* sc,
        // ArgumentList argumentList)`, live at templatesem.ts:1224. (The old wall cited :940,
        // which is inside the body, not the declaration.)
        templateInstanceSemantic(ti, this.sc!, new ArgumentList());
    }
    /**
     * dmd/dsymbolsem.d:3908 — `override void visit(TemplateMixin tm)`. Instantiate a `mixin T!(…);`
     * declaration: match the template, copy its member trees in, and run pass-1 on the copies.
     *
     * resolved: static if (LOG) at D:3910, :3920, :3927, :4047, :4076, :4124 -> false, emit nothing.
     */
    override visitTemplateMixin(tm: TemplateMixin): void {
        if (tm.semanticRun !== PASS.initial) {
            // When a class/struct contains mixin members, and is done over
            // because of forward references, never reach here so semanticRun
            // has been reset to PASS.initial.
            return;
        }
        tm.semanticRun = PASS.semantic;

        let scx: Scope | null = null;
        if (tm._scope !== null) {
            this.sc = tm._scope;
            scx = tm._scope; // save so we don't make redundant copies
            tm._scope = null;
        }
        let sc: Scope = this.sc!;

        /* Run semantic on each argument, place results in tiargs[],
         * then find best match template with tiargs
         */
        // dsymbolsem.d:3943 — three UFCS calls (04 §6); callees live at dmd/templatesem.d:2160, :5366 and
        // :3680. `ArgumentList()` is a fresh by-value temporary, so no copy is taken (03 §1).
        if (!findMixinTempDecl(tm, sc) || !semanticTiargs(tm, sc) || !findBestMatch(tm, sc, new ArgumentList())) {
            // 02 §11.4 (assignment-narrowing variant): `tm.semanticRun = PASS.semantic` above makes TS
            // treat the field as PASS.semantic forever; D's callees here can reset it to PASS.initial.
            // A freshly-declared alias of the OBJECT drops the stale flow type (an annotated re-read of
            // the FIELD does not — verified against tsc).
            const tmRead: TemplateMixin = tm;
            if (tmRead.semanticRun === PASS.initial) { // forward reference had occurred
                //printf("forward reference - deferring\n");
                deferDsymbolSemantic(sc, tm, scx);
                return;
            }

            tm.inst = tm;
            tm.errors = true;
            return; // error recovery
        }

        const tempdecl: TemplateDeclaration | null = tm.tempdecl!.isTemplateDeclaration();
        assert(tempdecl !== null);

        if (tm.ident === null) {
            /* Assign scope local unique identifier, as same as lambdas.
             */
            const s: DString = ds("__mixin");

            // goto L1 (D:3971) — SKIP-FLAG (06 §4.1): the jump enters the `else` arm past its first
            // statement. Every statement between the jump site and `L1:` is gated on the flag.
            let gotoL1 = false;
            const func: FuncDeclaration | null = sc.parent!.isFuncDeclaration();
            if (func !== null) {
                tm.symtab = func.localsymtab;
                if (tm.symtab !== null) {
                    // Inside template constraint, symtab is not set yet.
                    gotoL1 = true;
                }
            }
            if (func === null || gotoL1) {
                if (!gotoL1)
                    tm.symtab = sc.parent!.isScopeDsymbol()!.symtab;
                // L1: (dmd/dsymbolsem.d:3977)
                assert(tm.symtab !== null);
                tm.ident = Identifier.generateIdWithSuffix(s, tm.symtab!.length() + 1);
                tm.symtab!.insert(tm);
            }
        }

        tm.inst = tm;
        tm.parent = sc.parent;

        /* Detect recursive mixin instantiations.
         */
        // The D label `Lcontinue:` sits at the very END of this loop body, so `goto Lcontinue`
        // from the INNER loop is exactly a labelled `continue` of the outer loop (06 §4/§6); the
        // TS label carries the D label's own name.
        Lcontinue: for (let s: Dsymbol | null = tm.parent; s !== null; s = s.parent) {
            //printf("\ts = '%s'\n", s.toChars());
            const tmix: TemplateMixin | null = s.isTemplateMixin();
            if (tmix === null || tempdecl !== tmix.tempdecl)
                continue;

            /* Different argument list lengths happen with variadic args
             */
            if (tm.tiargs!.length !== tmix.tiargs!.length)
                continue;

            for (let i = 0; i < tm.tiargs!.length; i++) {
                const o: RootObject = tm.tiargs!.opIndex(i)!;
                const ta: Type | null = isType(o);
                const ea: Expression | null = isExpression(o);
                const sa: Dsymbol | null = isDsymbol(o);
                const tmo: RootObject = tmix.tiargs!.opIndex(i)!;
                if (ta !== null) {
                    const tmta: Type | null = isType(tmo);
                    if (tmta === null)
                        continue Lcontinue; // goto Lcontinue (dmd/dsymbolsem.d:4012)
                    if (!ta.equals(tmta))
                        continue Lcontinue; // goto Lcontinue (dmd/dsymbolsem.d:4014)
                } else if (ea !== null) {
                    const tme: Expression | null = isExpression(tmo);
                    // dsymbolsem.d:4019 — `dmd.expressionsem.equals(ea, tme)`; callee live at expressionsem.d:919.
                    if (tme === null || !expEquals(ea, tme))
                        continue Lcontinue; // goto Lcontinue (dmd/dsymbolsem.d:4020)
                } else if (sa !== null) {
                    const tmsa: Dsymbol | null = isDsymbol(tmo);
                    if (sa !== tmsa)
                        continue Lcontinue; // goto Lcontinue (dmd/dsymbolsem.d:4026)
                } else {
                    assertUnreachable();
                }
            }
            error(tm.loc, ds("%s `%s` recursive mixin instantiation"), tm.kind(), tm.toPrettyChars());
            return;

            // Lcontinue: (dmd/dsymbolsem.d:4034) — `continue;` is the loop's own fall-through.
        }

        // Copy the syntax trees from the TemplateDeclaration
        tm.members = Dsymbol.arraySyntaxCopy(tempdecl!.members);
        if (tm.members === null)
            return;

        tm.symtab = new DsymbolTable();

        sc.getScopesym()!.importScope(tm, new Visibility(Visibility.Kind.public_));

        const scy: Scope = sc.push(tm);
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            scy.parent = tm;

            /* https://issues.dlang.org/show_bug.cgi?id=930
             *
             * If the template that is to be mixed in is in the scope of a template
             * instance, we have to also declare the type aliases in the new mixin scope.
             */
            const parentInstance: TemplateInstance | null =
                tempdecl!.parent !== null ? tempdecl!.parent.isTemplateInstance() : null;
            if (parentInstance !== null) {
                // dsymbolsem.d:4061 — `parentInstance.declareParameters(scy)` (UFCS, 04 §6). SWEPT:
                // authorised by dmd/templatesem.d:5242 `void declareParameters(TemplateInstance ti,
                // Scope* sc)`, live at templatesem.ts:5578.
                declareParameters(parentInstance, scy);
            }

            tm.argsym = new ScopeDsymbol();
            tm.argsym.parent = scy.parent;
            const argscope: Scope = scy.push(tm.argsym);

            const errorsave = global.errors;

            // Declare each template parameter as an alias for the argument type
            // dsymbolsem.d:4070 — `tm.declareParameters(argscope)` (UFCS, 04 §6). SWEPT: same
            // authorising D definition, dmd/templatesem.d:5242 (templatesem.ts:5578); `TemplateMixin`
            // derives from `TemplateInstance` (dtemplate.ts:1430), so the receiver passes unchanged.
            declareParameters(tm, argscope);

            // Add members to enclosing scope, as well as this scope
            foreachDsymbolVoid(tm.members, (s: Dsymbol): void => {
                addMember(s, argscope, tm);
            });

            // Do semantic() analysis on template instance members
            const sc2: Scope = argscope.push(tm);
            // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
            try {
                //size_t deferred_dim = Module.deferred.length;

                // `__gshared int nest;` (D:4083) lives at module scope as `templateMixinNest` (preamble §3).
                //printf("%d\n", nest);
                if (++templateMixinNest > global.recursionLimit) {
                    global.gag = 0; // ensure error message gets printed
                    error(tm.loc, ds("%s `%s` recursive expansion"), tm.kind(), tm.toPrettyChars());
                    fatal();
                }

                // The `++nest` / `nest--` pair is UNPAIRED in the port the moment a wall inside the region
                // throws (11 §2.5 "protect paired state"); D needs no try/finally here, the port does.
                try {
                    foreachDsymbolVoid(tm.members, (s: Dsymbol): void => { setScope(s, sc2); });

                    foreachDsymbolVoid(tm.members, (s: Dsymbol): void => { importAll(s, sc2); });

                    foreachDsymbolVoid(tm.members, (s: Dsymbol): void => { dsymbolSemantic(s, sc2); });
                } finally {
                    templateMixinNest--;
                }

                /* In DeclDefs scope, TemplateMixin does not have to handle deferred symbols.
                 * Because the members would already call addDeferredSemantic() for themselves.
                 * See Struct, Class, Interface, and EnumDeclaration.dsymbolSemantic().
                 */
                //if (!sc.func && Module.deferred.length > deferred_dim) {}

                const ad: AggregateDeclaration | null = tm.isMember();
                if (sc.func !== null && ad === null) {
                    // dsymbolsem.d:4109 — `tm.semantic2(sc2)` (UFCS, 04 §6). SWEPT: authorised by
                    // dmd/semantic2.d:79 `void semantic2(Dsymbol dsym, Scope* sc)` (semantic2.ts:197).
                    semantic2(tm, sc2);
                    semantic3(tm, sc2);
                }

                // Give additional context info if error occurred during instantiation
                if (global.errors !== errorsave) {
                    error(tm.loc, ds("%s `%s` error instantiating"), tm.kind(), tm.toPrettyChars());
                    tm.errors = true;
                }

            } finally {
                sc2.pop();
            }
            argscope.pop();
        } finally {
            scy.pop();
        }
    }

    /**
     * dmd/dsymbolsem.d:4130 — `override void visit(Nspace ns)`. `extern(C++, ns) { … }` blocks
     * whose name may be a compile-time string or a tuple of strings (the tuple form builds a nested
     * namespace chain and re-parents the members).
     *
     * resolved: static if (LOG) at D:4134, :4234 -> false, emit nothing.
     */
    override visitNspace(ns: Nspace): void {
        if (ns.semanticRun !== PASS.initial)
            return;
        if (ns._scope !== null) {
            this.sc = ns._scope;
            ns._scope = null;
        }
        if (this.sc === null)
            return;
        let sc: Scope = this.sc;

        let repopulateMembers = false;
        if (ns.identExp !== null) {
            // resolve the namespace identifier
            this.sc = sc = sc.startCTFE();
            let resolved: Expression;
            // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
            try {
                resolved = expressionSemantic(ns.identExp, sc);
                resolved = resolveProperties(sc, resolved);
            } finally {
                this.sc = sc = sc.endCTFE()!;
            }
            resolved = ctfeInterpret(resolved);     // dsymbolsem.d:4155
            let name: StringExp | null = toStringExp(resolved); // dsymbolsem.d:4156 (callee: expressionsem.d:425)
            const tup: TupleExp | null = name !== null ? null : resolved.isTupleExp();
            if (tup === null && name === null) {
                error(ns.loc, ds("expected string expression for namespace name, got `%s`"),
                    ns.identExp.toChars());
                return;
            }
            ns.identExp = resolved; // we don't need to keep the old AST around
            if (name !== null) {
                const ident: DString = name.toStringz();
                if (ident.length === 0 || !Identifier.isValidIdentifier(ident)) {
                    error(ns.loc, ds("expected valid identifier for C++ namespace but got `%.*s`"),
                        ident.length, ident);
                    return;
                }
                ns.ident = Identifier.idPool(ident);
            } else {
                // create namespace stack from the tuple
                let parentns: Nspace = ns;
                for (const [i, exp] of tup!.exps!.opSlice().entries()) {
                    name = toStringExp(exp!); // dsymbolsem.d:4180 (callee: expressionsem.d:425)
                    if (name === null) {
                        error(ns.loc, ds("expected string expression for namespace name, got `%s`"),
                            exp!.toChars());
                        return;
                    }
                    const ident: DString = name.toStringz();
                    if (ident.length === 0 || !Identifier.isValidIdentifier(ident)) {
                        error(ns.loc, ds("expected valid identifier for C++ namespace but got `%.*s`"),
                            ident.length, ident);
                        return;
                    }
                    if (i === 0) {
                        ns.ident = Identifier.idPool(ident);
                    } else {
                        // insert the new namespace
                        const childns = new Nspace(ns.loc, Identifier.idPool(ident), null, parentns.members);
                        parentns.members = new DArray<Dsymbol | null>();
                        parentns.members.push(childns);
                        parentns = childns;
                        repopulateMembers = true;
                    }
                }
            }
        }

        ns.semanticRun = PASS.semantic;
        ns.parent = sc.parent;
        // Link does not matter here, if the UDA is present it will error
        checkGNUABITag(ns, LINK.cpp);

        if (ns.members === null) {
            ns.semanticRun = PASS.semanticdone;
            return;
        }
        assert(this.sc !== null); // D: `assert(sc);` — tested through the field, no cast needed
        this.sc = sc = sc.push(ns);
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            sc.linkage = LINK.cpp; // note that namespaces imply C++ linkage
            sc.parent = ns;
            for (const s of ns.members) {
                if (repopulateMembers) {
                    addMember(s!, sc, sc.scopesym!);
                    setScope(s!, sc);
                }
                importAll(s!, sc);
            }
            for (const s of ns.members) {
                dsymbolSemantic(s!, sc);
            }
        } finally {
            sc.pop();
        }
        ns.semanticRun = PASS.semanticdone;
    }

    /// Do the semantic analysis on the external interface to the function.
    /// dmd/dsymbolsem.d:4245 — `override void visit(FuncDeclaration funcdecl)`.
    override visitFuncDeclaration(funcdecl: FuncDeclaration): void {
        funcDeclarationSemantic(this.sc, funcdecl);
    }

    /**
     * dmd/dsymbolsem.d:4250 — `override void visit(CtorDeclaration ctd)`. Pass-1 for a constructor,
     * plus the struct-specific classification of default / copy / move constructors.
     */
    override visitCtorDeclaration(ctd: CtorDeclaration): void {
        //printf("CtorDeclaration::semantic() %p %s\n", ctd, ctd.toChars());
        if (ctd.semanticRun >= PASS.semanticdone)
            return;
        if (ctd._scope !== null) {
            this.sc = ctd._scope;
            ctd._scope = null;
        }
        let sc: Scope = this.sc!;

        ctd.parent = sc.parent;
        const p: Dsymbol | null = ctd.toParentDecl();
        const ad: AggregateDeclaration | null = p!.isAggregateDeclaration();
        if (ad === null) {
            error(ctd.loc, ds("constructor can only be a member of aggregate, not %s `%s`"),
                p!.kind(), p!.toChars());
            ctd.type = Type.terror;
            ctd.errors = true;
            return;
        }

        this.sc = sc = sc.push();
        // 11 §2.5 (paired state): plain finally; D pops once (dsymbolsem.d:4286) with no early exit between the
        // push (:4272) and the pop (the `return` at :4289 is after it).
        try {
            if ((sc.stc & STC.static_) !== 0n) {
                if ((sc.stc & STC.shared_) !== 0n) {
                    error(ctd.loc,
                        ds("`shared static` has no effect on a constructor inside a `shared static` block. Use `shared static this()`"));
                } else {
                    error(ctd.loc,
                        ds("`static` has no effect on a constructor inside a `static` block. Use `static this()`"));
                }
            }

            sc.stc = (sc.stc & ~STC.static_) as STC; // not a static constructor

            funcDeclarationSemantic(sc, ctd);
        } finally {
            // D does NOT re-assign `sc` here: `sc.pop()`'s result is discarded, so `sc` keeps pointing
            // at the pushed scope for the rest of the method. Reproduced verbatim.
            sc.pop();
        }

        if (ctd.errors)
            return;

        const tf: TypeFunction = ctd.type!.toTypeFunction();
        const dim: number = tf.parameterList.length();
        const sd: StructDeclaration | null = ad.isStructDeclaration();

        /* See if it's the default constructor
         * But, template constructor should not become a default constructor.
         */
        if (ctd.parent!.isTemplateInstance() === null || ctd.parent!.isTemplateMixin() !== null) {
            if (sd === null) {
                if (dim === 0 && tf.parameterList.varargs === VarArg.none)
                    ad.defaultCtor = ctd;
                return;
            }

            if (dim === 0 && tf.parameterList.varargs === VarArg.none) { // empty default ctor w/o any varargs
                if (ctd.fbody !== null || (ctd.storage_class & STC.disable) === 0n) {
                    error(ctd.loc, ds("%s `%s` default constructor for structs only allowed " +
                        "with `@disable`, no body, and no parameters"), ctd.kind(), ctd.toPrettyChars());
                    ctd.storage_class = (ctd.storage_class | STC.disable) as STC;
                    ctd.fbody = null;
                }
                sd.noDefaultCtor = true;
            } else if (dim === 0 && tf.parameterList.varargs !== VarArg.none) { // allow varargs only ctor
                // D's branch is intentionally empty.
            } else if (dim !== 0 && !tf.parameterList.hasArgsWithoutDefault()) {
                if ((ctd.storage_class & STC.disable) !== 0n) {
                    error(ctd.loc, ds("%s `%s` is marked `@disable`, so it cannot have default " +
                        "arguments for all parameters."), ctd.kind(), ctd.toPrettyChars());
                    errorSupplemental(ctd.loc,
                        ds("Use `@disable this();` if you want to disable default initialization."));
                } else {
                    error(ctd.loc, ds("%s `%s` all parameters have default arguments, " +
                        "but structs cannot have default constructors."), ctd.kind(), ctd.toPrettyChars());
                }
            } else if (dim === 1 || (dim > 1 && tf.parameterList.opIndex(1)!.defaultArg !== null)) {
                //printf("tf: %s\n", toChars(tf));
                const param: Parameter = tf.parameterList.opIndex(0)!;
                if (unSharedOf(mutableOf(param.type!)) === unSharedOf(mutableOf(sd.type!))) {
                    //printf("copy constructor %p\n", ctd);
                    assert(!ctd.isCpCtor && !ctd.isMoveCtor);
                    if ((param.storageClass & STC.ref_) !== 0n)
                        ctd.isCpCtor = true;            // copy constructor
                    else
                        ctd.isMoveCtor = true;          // move constructor
                    assert(!(ctd.isCpCtor && ctd.isMoveCtor));
                }
            }
        }
        // https://issues.dlang.org/show_bug.cgi?id=22593
        else {
            const ti: TemplateInstance | null = ctd.parent!.isTemplateInstance();
            if (ti !== null) {
                // dsymbolsem.d:4352 — defined in this module (dsymbolsem.d:1790).
                checkHasBothRvalueAndCpCtor(sd, ctd, ti);
            }
        }
    }

    /// dmd/dsymbolsem.d:4356 — `override void visit(PostBlitDeclaration pbd)`.
    override visitPostBlitDeclaration(pbd: PostBlitDeclaration): void {
        //printf("PostBlitDeclaration::semantic() %s\n", toChars());
        //printf("ident: %s, %s, %p, %p\n", ident.toChars(), Id.dtor.toChars(), ident, Id.dtor);
        //printf("stc = x%llx\n", sc.stc);
        if (pbd.semanticRun >= PASS.semanticdone)
            return;
        if (pbd._scope !== null) {
            this.sc = pbd._scope;
            pbd._scope = null;
        }
        let sc: Scope = this.sc!;

        pbd.parent = sc.parent;
        const p: Dsymbol | null = pbd.toParent2();
        const ad: StructDeclaration | null = p!.isStructDeclaration();
        if (ad === null) {
            error(pbd.loc, ds("postblit can only be a member of struct, not %s `%s`"),
                p!.kind(), p!.toChars());
            pbd.type = Type.terror;
            pbd.errors = true;
            return;
        }
        if (pbd.ident === Id.postblit && pbd.semanticRun < PASS.semantic)
            ad.postblits.push(pbd);
        if (pbd.type === null)
            pbd.type = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d, pbd.storage_class);

        this.sc = sc = sc.push();
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            sc.stc = (sc.stc & ~STC.static_) as STC; // not static
            sc.linkage = LINK.d;

            funcDeclarationSemantic(sc, pbd);

        } finally {
            sc.pop(); // result discarded in D — `sc` still names the pushed scope
        }
    }

    /// dmd/dsymbolsem.d:4393 — `override void visit(DtorDeclaration dd)`. Also reserves the C++
    /// vtable slot(s) for a `extern(C++)` destructor.
    override visitDtorDeclaration(dd: DtorDeclaration): void {
        //printf("DtorDeclaration::semantic() %s\n", dd.toChars());
        //printf("ident: %s, %s, %p, %p\n", dd.ident.toChars(), Id.dtor.toChars(), dd.ident, Id.dtor);
        if (dd.semanticRun >= PASS.semanticdone)
            return;
        if (dd._scope !== null) {
            this.sc = dd._scope;
            dd._scope = null;
        }
        let sc: Scope = this.sc!;

        dd.parent = sc.parent;
        const p: Dsymbol | null = dd.toParent2();
        const ad: AggregateDeclaration | null = p!.isAggregateDeclaration();
        if (ad === null) {
            error(dd.loc, ds("destructor can only be a member of aggregate, not %s `%s`"),
                p!.kind(), p!.toChars());
            dd.type = Type.terror;
            dd.errors = true;
            return;
        }

        if (ad.isClassDeclaration() !== null && ad.classKind === ClassKind.d) {
            // Class destructors are implicitly `scope`
            dd.storage_class = (dd.storage_class | STC.scope_) as STC;
        }

        if (dd.ident === Id.dtor && dd.semanticRun < PASS.semantic)
            ad.userDtors.push(dd);
        if (dd.type === null) {
            dd.type = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d, dd.storage_class);
            if (ad.classKind === ClassKind.cpp && dd.ident === Id.dtor) {
                const cldec: ClassDeclaration | null = ad.isClassDeclaration();
                if (cldec !== null) {
                    assert(cldec.cppDtorVtblIndex === -1); // double-call check already by dd.type
                    if (cldec.baseClass !== null && cldec.baseClass.cppDtorVtblIndex !== -1) {
                        // override the base virtual
                        cldec.cppDtorVtblIndex = cldec.baseClass.cppDtorVtblIndex;
                    } else if (!dd.isFinal()) {
                        // reserve the dtor slot for the destructor (which we'll create later)
                        cldec.cppDtorVtblIndex = cldec.vtbl.length;
                        cldec.vtbl.push(dd);
                        if (target.cpp.twoDtorInVtable)     // dmd/dsymbolsem.d:4442
                            cldec.vtbl.push(dd); // deleting destructor uses a second slot
                    }
                }
            }
        }

        this.sc = sc = sc.push();
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            sc.stc = (sc.stc & ~STC.static_) as STC; // not a static destructor
            if (sc.linkage !== LINK.cpp)
                sc.linkage = LINK.d;

            funcDeclarationSemantic(sc, dd);

        } finally {
            sc.pop(); // result discarded in D
        }
    }

    /**
     * dmd/dsymbolsem.d:4459 — `void visitStaticCDtorDeclaration(FuncDeclaration sd, bool isDestructor)`.
     * The shared body of `visit(StaticCtorDeclaration)` and `visit(StaticDtorDeclaration)`: legality
     * checks, the instantiation gate prologue, D-linkage enforcement, and the ModuleInfo requirement.
     *
     * Reassigns `this.sc` (it adopts `sd._scope`) — the two callers must re-read the mirror.
     */
    visitStaticCDtorDeclaration(sd: FuncDeclaration, isDestructor: boolean): void {
        if (sd.semanticRun >= PASS.semanticdone)
            return;
        if (sd._scope !== null) {
            this.sc = sd._scope;
            sd._scope = null;
        }
        const sc: Scope = this.sc!;
        sd.parent = sc.parent;
        const p: Dsymbol | null = sd.parent!.pastMixin();
        const isShared: boolean = sd.isSharedStaticDtorDeclaration() !== null ||
            sd.isSharedStaticCtorDeclaration() !== null;
        const what: DString = isDestructor ? ds("destructor") : ds("constructor");
        if (p!.isScopeDsymbol() === null) {
            const s: DString = isShared ? ds("shared ") : ds("");
            error(sd.loc, ds("`%sstatic` %s can only be member of module/aggregate/template, not %s `%s`"),
                s, what, p!.kind(), p!.toChars());
            sd.type = Type.terror;
            sd.errors = true;
            return;
        }

        if (sd.type === null)
            sd.type = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d, sd.storage_class);

        /* If the static [dc]tor appears within a template instantiation,
         * it could get called multiple times by the module constructors
         * for different modules. Thus, protect it with a gate.
         */
        if (sd.isInstantiated() !== null && sd.semanticRun < PASS.semantic) {
            /* Add this prefix to the constructor:
             * ```
             * static int gate;
             * if ([--|++]gate != [0|1]) return; // dependant on ctor/dtor
             * ```
             * or, for shared constructor:
             * ```
             * shared int gate;
             * enum op  = isDestructor ? "-=" : "+=";
             * enum cmp = isDestructor ? 0 : 1;
             * if (core.atomic.atomicOp!op(gate, 1) != cmp) return;
             * ```
             */

            const v = new VarDeclaration(Loc.initial, Type.tint32, Id.gate!, null);
            v.storage_class = (STC.temp | STC.static_ | (isShared ? STC.shared_ : STC.none)) as STC;

            let s: Statement = ExpStatement.fromDsymbol(Loc.initial, v); // D `new ExpStatement(loc, Dsymbol)`
            const sa: Statements = new DArray<Statement | null>();
            sa.push(s);

            let e: Expression | null;
            if (isShared) {
                e = doAtomicOp(isDestructor ? ds("-=") : ds("+="), v.ident!, IntegerExp.literal(1));
                if (e === null) {
                    error(sd.loc,
                        ds("%s `%s` shared static %s within a template require `core.atomic : atomicOp` to be present"),
                        sd.kind(), sd.toPrettyChars(), what);
                    return;
                }
            } else {
                const one: IntegerExp = isDestructor ? IntegerExp.literal(-1) : IntegerExp.literal(1);
                e = new AddAssignExp(Loc.initial, new IdentifierExp(Loc.initial, v.ident!), one);
            }
            const cmp: IntegerExp = isDestructor ? IntegerExp.literal(0) : IntegerExp.literal(1);
            e = new EqualExp(EXP.notEqual, Loc.initial, e, cmp);
            s = new IfStatement(Loc.initial, null, e, new ReturnStatement(Loc.initial, null), null, Loc.initial);

            sa.push(s);
            if (sd.fbody !== null)
                sa.push(sd.fbody);

            sd.fbody = new CompoundStatement(Loc.initial, sa);
            if (isDestructor)
                (sd as unknown as StaticDtorDeclaration).vgate = v;
        }
        const save: LINK = sc.linkage;
        if (save !== LINK.d) {
            const s: DString = isShared ? ds("shared ") : ds("");
            deprecation(sd.loc, ds("`%sstatic` %s can only be of D linkage"), s, what);
            // Just correct it
            sc.linkage = LINK.d;
        }
        // 11 §2.5 (paired state): `funcDeclarationSemantic` reaches walls; one restore in D, no early exit.
        try {
            funcDeclarationSemantic(sc, sd);
        } finally {
            sc.linkage = save;
        }

        // We're going to need ModuleInfo
        let m: Module | null = sd.getModule();
        if (m === null)
            m = sc._module;
        if (m !== null) {
            m.needmoduleinfo = 1;
            //printf("module2 %s needs moduleinfo\n", m.toChars());
        }
    }

    /// dmd/dsymbolsem.d:4559 — `override void visit(StaticCtorDeclaration scd)`.
    override visitStaticCtorDeclaration(scd: StaticCtorDeclaration): void {
        //printf("StaticCtorDeclaration::semantic()\n");
        this.visitStaticCDtorDeclaration(scd, false);
        // Re-read the mirror: visitStaticCDtorDeclaration may have adopted `scd._scope`.
        const sc: Scope = this.sc!;

        foreachUda(scd, sc, (e: Expression): number => {
            // dmd/dsymbolsem.d:4565 `import dmd.attrib : isEnumAttribute;` — hoisted.
            if (!isEnumAttribute(e, Id.udaStandalone!))
                return 0;

            const sharedCtor: SharedStaticCtorDeclaration | null = scd.isSharedStaticCtorDeclaration();
            if (sharedCtor !== null) {
                const trust: TRUST = sharedCtor.type!.isTypeFunction()!.trust;
                if (trust !== TRUST.system && trust !== TRUST.trusted) {
                    error(e.loc, ds("a module constructor using `@%s` must be `@system` or `@trusted`"),
                        Id.udaStandalone!.toChars());
                }
                sharedCtor.standalone = true;
            } else {
                error(e.loc, ds("`@%s` can only be used on shared static constructors"),
                    Id.udaStandalone!.toChars());
            }

            return 1;
        });
    }

    /// dmd/dsymbolsem.d:4583 — `override void visit(StaticDtorDeclaration sdd)`.
    override visitStaticDtorDeclaration(sdd: StaticDtorDeclaration): void {
        this.visitStaticCDtorDeclaration(sdd, true);
    }

    /// dmd/dsymbolsem.d:4588 — `override void visit(InvariantDeclaration invd)`.
    override visitInvariantDeclaration(invd: InvariantDeclaration): void {
        if (invd.semanticRun >= PASS.semanticdone)
            return;
        if (invd._scope !== null) {
            this.sc = invd._scope;
            invd._scope = null;
        }
        let sc: Scope = this.sc!;

        invd.parent = sc.parent;
        const p: Dsymbol | null = invd.parent!.pastMixin();
        const ad: AggregateDeclaration | null = p!.isAggregateDeclaration();
        if (ad === null) {
            error(invd.loc, ds("`invariant` can only be a member of aggregate, not %s `%s`"),
                p!.kind(), p!.toChars());
            invd.type = Type.terror;
            invd.errors = true;
            return;
        }
        if (invd.ident !== Id.classInvariant &&
             invd.semanticRun < PASS.semantic &&
             ad.isUnionDeclaration() === null           // users are on their own with union fields
           ) {
            fixupInvariantIdent(invd, ad.invs.length);
            ad.invs.push(invd);
        }
        if (invd.type === null)
            invd.type = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d, invd.storage_class);

        this.sc = sc = sc.push();
        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
        try {
            sc.stc = (sc.stc & ~STC.static_) as STC; // not a static invariant
            sc.stc = (sc.stc | STC.const_) as STC; // invariant() is always const
            sc.contract = Contract.invariant_;
            sc.linkage = LINK.d;

            funcDeclarationSemantic(sc, invd);

        } finally {
            sc.pop(); // result discarded in D
        }
    }

    /// dmd/dsymbolsem.d:4630 — `override void visit(UnitTestDeclaration utd)`.
    /// resolved: version (none) (D:4662-4676) -> branch dropped.
    override visitUnitTestDeclaration(utd: UnitTestDeclaration): void {
        if (utd.semanticRun >= PASS.semanticdone)
            return;
        if (utd._scope !== null) {
            this.sc = utd._scope;
            utd._scope = null;
        }
        const sc: Scope = this.sc!;

        utd.visibility = sc.visibility.copy();

        utd.parent = sc.parent;
        const p: Dsymbol | null = utd.parent!.pastMixin();
        if (p!.isScopeDsymbol() === null) {
            error(utd.loc, ds("`unittest` can only be a member of module/aggregate/template, not %s `%s`"),
                p!.kind(), p!.toChars());
            utd.type = Type.terror;
            utd.errors = true;
            return;
        }

        if (global.params.useUnitTests) {
            if (utd.type === null)
                utd.type = new TypeFunction(new ParameterList(null), Type.tvoid, LINK.d, utd.storage_class);
            const sc2: Scope = sc.push();
            // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
            try {
                sc2.linkage = LINK.d;
                // D passes `sc`, NOT `sc2`, to funcDeclarationSemantic here — reproduced verbatim
                // (dmd/dsymbolsem.d:4657); `sc2` exists only for its linkage side effect and the pop.
                funcDeclarationSemantic(sc, utd);
            } finally {
                sc2.pop();
            }
        }
    }

    /// dmd/dsymbolsem.d:4679 — `override void visit(NewDeclaration nd)`.
    override visitNewDeclaration(nd: NewDeclaration): void {
        //printf("NewDeclaration::semantic()\n");
        if (nd.semanticRun >= PASS.semanticdone)
            return;
        if (nd.type === null)
            nd.type = new TypeFunction(new ParameterList(null), pointerTo(Type.tvoid), LINK.d, nd.storage_class);

        funcDeclarationSemantic(this.sc, nd);
    }
    /**
     * dmd/dsymbolsem.d:4690 — `override void visit(StructDeclaration sd)`. Pass-1 for a struct or
     * union: resolve its own type, pick up scope attributes, build the symbol table, run pass-1 on
     * every member, determine the fields, then generate the special members (dtor, copy/move ctor,
     * postblit, opAssign, opEquals, TypeInfo hooks, invariant).
     *
     * resolved: `enum log = false;` (D:4692) -> every `if (log) printf(...)` guard drops (07 §3).
     * resolved: version (none) at D:4929 and D:4954 -> branches dropped.
     */
    override visitStructDeclaration(sd: StructDeclaration): void {
        //static int count; if (++count == 20) assert(0);

        if (sd.semanticRun >= PASS.semanticdone)
            return;
        const errors = global.errors;

        //printf("+StructDeclaration::semantic(this=%p, '%s', sizeok = %d)\n", sd, sd.toPrettyChars(), sd.sizeok);
        let scx: Scope | null = null;
        if (sd._scope !== null) {
            this.sc = sd._scope;
            scx = sd._scope; // save so we don't make redundant copies
            sd._scope = null;
        }
        let sc: Scope = this.sc!;

        if (sd.parent === null) {
            assert(sc.parent !== null && sc.func !== null);
            sd.parent = sc.parent;
        }
        assert(sd.parent !== null && !sd.isAnonymous());

        if (sd.errors)
            sd.type = Type.terror;
        if (sd.semanticRun === PASS.initial)
            sd.type = addSTC(sd.type!, (sc.stc | sd.storage_class) as STC);
        sd.type = typeSemantic(sd.type!, sd.loc, sc);
        const ts = sd.type.isTypeStruct();
        if (ts !== null) {
            if (ts.sym !== sd) {
                const ti: TemplateInstance | null = ts.sym!.isInstantiated();
                if (ti !== null && isError(ti))
                    ts.sym = sd;
                /* For C modules, if module A contains `struct S;` and
                 * module B contains `struct S { members...}` then replace
                 * the former with the latter
                 */
                else if (ts.sym!.members === null && sd.members !== null)
                    ts.sym = sd;
            }
        }

        // Ungag errors when not speculative.
        // `Ungag` is a D VALUE struct whose `~this()` restores `global.gag` (dmd/dsymbolsem.d:1965).
        // TS has no destructor: the RAII scope becomes try/finally (06 §7.1), covering everything
        // from here to the end of the method — including the early `return`s below.
        const ungag = ungagSpeculative(sd);
        try {
            if (sd.semanticRun === PASS.initial) {
                sd.visibility = sc.visibility.copy();

                if (sd.alignment.isUnknown())       // can be set already by `struct __declspec(align(N)) Tag { ... }`
                    sd.alignment = alignmentScope(sc);

                sd.storage_class = (sd.storage_class | sc.stc) as STC;
                if ((sd.storage_class & STC.abstract_) !== 0n) {
                    error(sd.loc, ds("%s `%s` structs, unions cannot be `abstract`"),
                        sd.kind(), sd.toPrettyChars());
                }

                sd.userAttribDecl_set(sc.userAttribDecl);

                if (sc.linkage === LINK.cpp)
                    sd.classKind = ClassKind.cpp;
                else if (sc.linkage === LINK.c)
                    sd.classKind = ClassKind.c;
                sd.cppnamespace_set(sc.namespace);
                sd.cppmangle = sc.cppmangle;
            } else if (sd.symtab !== null && scx === null) {
                return;
            }

            sd.semanticRun = PASS.semantic;
            checkGNUABITag(sd, sc.linkage);

            if (sd.members === null) { // if opaque declaration
                sd.semanticRun = PASS.semanticdone;
                return;
            }
            if (sd.symtab === null) {
                sd.symtab = new DsymbolTable();

                foreachDsymbolVoid(sd.members, (s: Dsymbol): void => {
                    addMember(s, sc, sd);
                });
            }

            const sc2: Scope = newScope(sd, sc);

            /* Set scope so if there are forward references, we still might be able to
             * resolve individual members like enums.
             */
            foreachDsymbolVoid(sd.members, (s: Dsymbol): void => { setScope(s, sc2); });
            foreachDsymbolVoid(sd.members, (s: Dsymbol): void => { importAll(s, sc2); });
            foreachDsymbolVoid(sd.members, (s: Dsymbol): void => {
                dsymbolSemantic(s, sc2);
                if (sd.errors) s.errors = true;
            });

            if (sd.errors)
                sd.type = Type.terror;

            if (!determineFields(sd)) {
                if (sd.type.ty !== TY.Terror) {
                    error(sd.loc, ds("%s `%s` circular or forward reference"), sd.kind(), sd.toPrettyChars());
                    sd.errors = true;
                    sd.type = Type.terror;
                }

                sc2.pop();
                sd.semanticRun = PASS.semanticdone;
                return;
            }
            /* Following special member functions creation needs semantic analysis
             * completion of sub-structs in each field types. For example, buildDtor
             * needs to check existence of elaborate dtor in type of each fields.
             * See the case in compilable/test14838.d
             */
            for (const v of sd.fields) {
                const tb: Type = baseElemOf(v!.type!);
                if (tb.ty !== TY.Tstruct)
                    continue;
                // D writes the unchecked `cast(TypeStruct)tb`; the tag test on the line above is the
                // proof, so the port uses the tag-proved `isTypeStruct()` form (02 §11.5c #3).
                const sdec: StructDeclaration = tb.isTypeStruct()!.sym!;
                if (sdec.semanticRun >= PASS.semanticdone)
                    continue;

                sc2.pop();

                deferDsymbolSemantic(sc, sd, scx);
                return;
            }

            /* Look for special member functions.
             */
            sd.disableNew = search(sd, Loc.initial, Id.classNew!) !== null;

            // Look for the constructor
            sd.ctor = searchCtor(sd);

            buildDtors(sd, sc2);

            const hasCopyCtor: Ref<boolean> = { value: false }; // D `out bool` -> box (03 §3.3)
            const hasMoveCtor: Ref<boolean> = { value: false };
            const needCopyCtor: Ref<boolean> = { value: false };
            const needMoveCtor: Ref<boolean> = { value: false };
            needCopyOrMoveCtor(sd, hasCopyCtor, hasMoveCtor, needCopyCtor, needMoveCtor);
            //printf("%s hasCopy %d hasMove %d needCopy %d needMove %d\n", sd.toChars(), hasCopyCtor, hasMoveCtor, needCopyCtor, needMoveCtor);

            /* When generating a move ctor, generate a copy ctor too, otherwise
             *  https://github.com/s-ludwig/taggedalgebraic/issues/75
             */
            // D guards this with a literal `0 &&` — kept verbatim as `false &&` (it is a runtime
            // constant, not a `version`/`static if`, so 07 does not fold it away).
            if (false && needMoveCtor.value && !hasCopyCtor.value) {
                needCopyCtor.value = true;
            }

            if (needCopyCtor.value) {
                assert(hasCopyCtor.value === false);
                buildCopyOrMoveCtor(sd, sc2, false); // build copy constructor
                hasCopyCtor.value = true;
            }
            if (needMoveCtor.value) {
                assert(hasMoveCtor.value === false);
                buildCopyOrMoveCtor(sd, sc2, true); // build move constructor
                hasMoveCtor.value = true;
            }
            sd.hasCopyCtor = hasCopyCtor.value;
            sd.hasMoveCtor = hasMoveCtor.value;

            sd.postblit = buildPostBlit(sd, sc2);

            buildOpAssign(sd, sc2);
            buildOpEquals(sd, sc2);

            // probe: `Type.dtypeinfo` is declared non-null but is unset until the object.d import
            // runs; D tests `if (Type.dtypeinfo)` (02 §11.4).
            if (!sc2.inCfile &&
                global.params.useTypeInfo && (Type as { dtypeinfo?: unknown }).dtypeinfo) { // these functions are used for TypeInfo
                sd.xeq = buildXopEquals(sd, sc2);
                sd.xcmp = buildXopCmp(sd, sc2);
                sd.xhash = buildXtoHash(sd, sc2);
            }

            sd.inv = buildInv(sd, sc2);

            sd.rtInfoScope = sc2;
            sc2.setNoFree();

            sd.semanticRun = PASS.semanticdone;

            sc2.pop();

            if (sd.ctor !== null) {
                const scall: Dsymbol | null = search(sd, Loc.initial, Id.opCall!);
                if (scall !== null) {
                    const xerrors = global.startGagging();
                    // 11 §2.5 (protect paired state): `startGagging`/`endGagging` bracket a
                    // process-global counter, and `resolveFuncCall` can reach a wall in an
                    // unported callee. D needs no guard; the port must not leak `global.gag`.
                    let fcall: FuncDeclaration | null;
                    try {
                        this.sc = sc = sc.push();
                        // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
                        try {
                            sc.tinst = null;
                            sc.minst = null;
                            fcall = resolveFuncCall(sd.loc, sc, scall, null, null,
                                new ArgumentList(), FuncResolveFlag.quiet);
                        } finally {
                            this.sc = sc = sc.pop()!;
                        }
                    } finally {
                        global.endGagging(xerrors);
                    }

                    if (fcall !== null && fcall.isStatic()) {
                        error(fcall.loc, ds("%s `%s` `static opCall` is hidden by constructors and can never be called"),
                            sd.kind(), sd.toPrettyChars());
                        errorSupplemental(fcall.loc,
                            ds("Please use a factory method instead, or replace all constructors with `static opCall`."));
                    }
                }
            }

            if (ts !== null && ts.sym !== sd) {
                const sym: StructDeclaration = ts.sym!;
                if (sd.isCsymbol() && sym.isCsymbol()) {
                    if (!DsymbolSemanticVisitor.isCCompatible(sd, sym)) {
                        // Already issued an error.
                        errorSupplemental(sd.loc, ds("C %ss with the same name from different imports are merged"),
                            sd.kind());
                    } else {
                        /* This is two structs imported from different C files.
                         * Just ignore sd, the second one. The first one will always
                         * be found when going through the type.
                         */
                    }
                } else {
                    // https://issues.dlang.org/show_bug.cgi?id=19024
                    error(sd.loc, ds("%s `%s` already exists at %s. Perhaps in another function with the same name?"),
                        sd.kind(), sd.toPrettyChars(), sym.loc.toChars());
                }
            }

            if (global.errors !== errors) {
                // The type is no good.
                sd.type = Type.terror;
                sd.errors = true;
                // `sd.deferred` through a StructDeclaration reference: the DERIVED slot (02 §11.5b),
                // written only by templatesem.d:1349.
                if (sd.deferredTI !== null)
                    sd.deferredTI.errors = true;
            }

            if (sd.deferredTI !== null && global.gag === 0) {
                // dsymbolsem.d:4950 — `sd.deferred.semantic2(sc)` (UFCS, 04 §6). SWEPT:
                // authorised by dmd/semantic2.d:79 `void semantic2(Dsymbol dsym, Scope* sc)`
                // (semantic2.ts:197).
                semantic2(sd.deferredTI, sc);
                semantic3(sd.deferredTI, sc);
            }
            //printf("-StructDeclaration::semantic(this=%p, '%s', sizeok = %d)\n", sd, sd.toPrettyChars(), sd.sizeok);
        } finally {
            // Ungag.~this() (dmd/dsymbolsem.d:1974) — restore the saved gag level.
            global.gag = ungag.oldgag;
        }
    }

    //
    // dmd/dsymbolsem.d:4969 — `static bool isCCompatible(StructDeclaration a, StructDeclaration b)`.
    // Checks if two structs are compatible.
    // Implements the rules according to C23 6.2.7.
    //
    // Returns true when compatible; otherwise it has ALREADY issued the diagnostics and returns false.
    //
    // ALIGNMENT COMPARE (05 §2 / preamble §8): D's `a.alignment != b.alignment` is a default
    // FIELD-WISE struct compare, but the ported `structalign_t` (astenums.ts:523) exposes no
    // `opEquals`, so `!==` (reference identity) would be wrong. The closest expressible form is the
    // field-wise compare over its complete observable surface — `get()` is the `ushort value`, and
    // `isPack()`/`fromAlignas()` are the ONLY two bits of the `ubyte flags` (astenums.ts:506-507).
    // Filed as a `dependency signature` escalation so `structalign_t.opEquals` lands at its owner.
    //
    static isCCompatible(a: StructDeclaration, b: StructDeclaration): boolean {
        // dmd/dsymbolsem.d:4972 — nested `static const(char)* typeName(Type t)`.
        // Get the name of a type, while avoiding exposing "__tagXXX" anonymous structs
        const typeName = (t: Type): DString => {
            const ts = t.isTypeStruct();
            if (ts !== null) {
                if (startsWith(ts.sym!.ident!.toString(), ds("__tag")))
                    return ts.sym!.isUnionDeclaration() !== null ? ds("(anonymous union)") : ds("(anonymous struct)");
            }
            return t.toChars();
        };

        // dmd/dsymbolsem.d:4982 — nested `void incompatError()`; captures `a` and `b`.
        const incompatError = (): void => {
            error(a.loc, ds("%s `%s` already exists with an incompatible definition."),
                a.kind(), typeName(a.type!));
            errorSupplemental(b.loc, ds("previously declared here"));
        };

        // dmd/dsymbolsem.d:4991 — nested `static bool isCCompatibleUnnamedStruct(Type a, Type b)`.
        // For recursive calls into unnamed structs (so Type.equals() doesn't work).
        const isCCompatibleUnnamedStruct = (at: Type, bt: Type): boolean => {
            const ats = at.isTypeStruct();
            if (ats === null) return false;
            const bts = bt.isTypeStruct();
            if (bts === null) return false;
            // Hack, anonymous structs within a struct are given
            // an anonymous id starting with __tag.
            if (!startsWith(ats.sym!.ident!.toString(), ds("__tag")))
                return false;
            if (!startsWith(bts.sym!.ident!.toString(), ds("__tag")))
                return false;
            return DsymbolSemanticVisitor.isCCompatible(ats.sym!, bts.sym!);
        };

        // dmd/dsymbolsem.d:5007 — nested `static bool isCCompatibleType(Type a, Type b)` (recursive).
        // Treat arrays of anonymous structs/unions as compatible when element types match.
        const isCCompatibleType = (at: Type, bt: Type): boolean => {
            if (at.equals(bt))
                return true;

            const asa = at.isTypeSArray();
            if (asa !== null) {
                const bsa = bt.isTypeSArray();
                if (bsa !== null && asa.dim !== null && bsa.dim !== null &&
                    toInteger(asa.dim) === toInteger(bsa.dim))
                    return isCCompatibleType(nextOf(asa)!, nextOf(bsa)!);
            }

            return isCCompatibleUnnamedStruct(at, bt);
        };

        // See the ALIGNMENT COMPARE note on this method: the field-wise stand-in for D's
        // `structalign_t ==`.
        const alignEquals = (x: structalign_t, y: structalign_t): boolean =>
            x.get() === y.get() && x.isPack() === y.isPack() && x.fromAlignas() === y.fromAlignas();

        if (a.fields.length !== b.fields.length) {
            incompatError();
            errorSupplemental(a.loc, ds("`%s` has %zu field(s) while `%s` has %zu field(s)"),
                a.toPrettyChars(), a.fields.length, b.toPrettyChars(), b.fields.length);
            return false;
        }
        // both are structs or both are unions
        if ((a.isUnionDeclaration() === null) !== (b.isUnionDeclaration() === null)) {
            incompatError();
            errorSupplemental(a.loc, ds("`%s` is a %s while `%s` is a %s"),
                a.toPrettyChars(), a.kind(), b.toPrettyChars(), b.kind());
            return false;
        }
        if (!alignEquals(a.alignment, b.alignment)) {
            incompatError();
            errorSupplemental(a.loc, ds("`%s` has different alignment or packing"), a.toPrettyChars());
            if (a.alignment.isDefault() && !b.alignment.isDefault()) {
                errorSupplemental(a.loc, ds("`%s` alignment: default"), a.toPrettyChars());
                errorSupplemental(b.loc, ds("`%s` alignment: %u"), b.toPrettyChars(), b.alignment.get() >>> 0);
            } else if (!a.alignment.isDefault() && b.alignment.isDefault()) {
                errorSupplemental(a.loc, ds("`%s` alignment: %u"), a.toPrettyChars(), a.alignment.get() >>> 0);
                errorSupplemental(b.loc, ds("`%s` alignment: default"), b.toPrettyChars());
            } else if (a.alignment.get() !== b.alignment.get()) {
                errorSupplemental(a.loc, ds("`%s` alignment: %u"), a.toPrettyChars(), a.alignment.get() >>> 0);
                errorSupplemental(b.loc, ds("`%s` alignment: %u"), b.toPrettyChars(), b.alignment.get() >>> 0);
            }
            if (a.alignment.isPack() !== b.alignment.isPack()) {
                errorSupplemental(a.loc, ds("`%s` packed: %s"),
                    a.toPrettyChars(), a.alignment.isPack() ? ds("true") : ds("false"));
                errorSupplemental(b.loc, ds("`%s` packed: %s"),
                    b.toPrettyChars(), b.alignment.isPack() ? ds("true") : ds("false"));
            }
            return false;
        }
        for (const [i, a_field] of a.fields.opSlice().entries()) {
            const b_field: VarDeclaration = b.fields.opIndex(i)!;
            //
            // — there shall be a one-to-one correspondence between
            //   their members such that each pair of corresponding
            //   members are declared with compatible types;
            //
            if (!isCCompatibleType(a_field!.type!, b_field.type!)) {
                // Already errored, just bail
                incompatError();
                if (a_field!.type!.isTypeError() !== null) return false;
                if (b_field.type!.isTypeError() !== null) return false;

                errorSupplemental(a_field!.loc, ds("Field %zu differs in type"), i);
                errorSupplemental(a_field!.loc, ds("typeof(%s): %s"),
                    a_field!.toChars(), typeName(a_field!.type!));
                errorSupplemental(b_field.loc, ds("typeof(%s): %s"),
                    b_field.toChars(), typeName(b_field.type!));
                return false;
            }
            //
            // — if one member of the pair is declared with an
            //   alignment specifier, the second is declared with an
            //   equivalent alignment specifier;
            //
            if (!alignEquals(a_field!.alignment, b_field.alignment)) {
                incompatError();
                errorSupplemental(a_field!.loc, ds("Field %zu differs in alignment or packing"), i);
                if (a_field!.alignment.isDefault() && !b_field.alignment.isDefault()) {
                    errorSupplemental(a_field!.loc, ds("`%s.%s` alignment: default"),
                        a.toPrettyChars(), a_field!.toChars());
                    errorSupplemental(b_field.loc, ds("`%s.%s` alignment: %u"),
                        b.toPrettyChars(), b_field.toChars(), b_field.alignment.get() >>> 0);
                } else if (!a_field!.alignment.isDefault() && b_field.alignment.isDefault()) {
                    errorSupplemental(a_field!.loc, ds("`%s.%s` alignment: %u"),
                        a.toPrettyChars(), a_field!.toChars(), a_field!.alignment.get() >>> 0);
                    errorSupplemental(b_field.loc, ds("`%s.%s` alignment: default"),
                        b.toPrettyChars(), b_field.toChars());
                } else if (a_field!.alignment.get() !== b_field.alignment.get()) {
                    errorSupplemental(a_field!.loc, ds("`%s.%s` alignment: %u"),
                        a.toPrettyChars(), a_field!.toChars(), a_field!.alignment.get() >>> 0);
                    errorSupplemental(b_field.loc, ds("`%s.%s` alignment: %u"),
                        b.toPrettyChars(), b_field.toChars(), b_field.alignment.get() >>> 0);
                }
                if (a_field!.alignment.isPack() !== b_field.alignment.isPack()) {
                    errorSupplemental(a_field!.loc, ds("`%s.%s` packed: %s"),
                        a.toPrettyChars(), a_field!.toChars(),
                        a_field!.alignment.isPack() ? ds("true") : ds("false"));
                    errorSupplemental(b_field.loc, ds("`%s.%s` packed: %s"),
                        b.toPrettyChars(), b_field.toChars(),
                        b_field.alignment.isPack() ? ds("true") : ds("false"));
                }
                return false;
            }
            //
            // - and, if one member of the pair is declared with a
            //   name, the second is declared with the same name.
            //
            if (a_field!.ident!.isAnonymous()) {
                if (!b_field.ident!.isAnonymous()) {
                    incompatError();
                    errorSupplemental(a_field!.loc, ds("Field %zu differs in name"), i);
                    errorSupplemental(a_field!.loc, ds("(anonymous)"), a_field!.ident!.toChars());
                    errorSupplemental(b_field.loc, ds("%s"), b_field.ident!.toChars());
                    return false;
                }
            } else if (b_field.ident!.isAnonymous()) {
                incompatError();
                errorSupplemental(a_field!.loc, ds("Field %zu differs in name"), i);
                errorSupplemental(a_field!.loc, ds("%s"), a_field!.ident!.toChars());
                errorSupplemental(b_field.loc, ds("(anonymous)"));
                return false;
            } else if (a_field!.ident !== b_field.ident) {
                incompatError();
                errorSupplemental(a_field!.loc, ds("Field %zu differs in name"), i);
                errorSupplemental(a_field!.loc, ds("%s"), a_field!.ident!.toChars());
                errorSupplemental(b_field.loc, ds("%s"), b_field.ident!.toChars());
                return false;
            }

            //
            // For two structures or unions, corresponding bitfields shall have the same widths.
            //
            const bfa: BitFieldDeclaration | null = a_field!.isBitFieldDeclaration();
            const bfb: BitFieldDeclaration | null = b_field.isBitFieldDeclaration();
            if ((bfa === null) !== (bfb === null)) {
                incompatError();
                errorSupplemental(a_field!.loc, ds("Field %zu differs in being a bitfield"), i);
                if (bfa === null) {
                    errorSupplemental(a_field!.loc, ds("`%s.%s` is not a bitfield"),
                        a.toPrettyChars(), a_field!.toChars());
                    errorSupplemental(b_field.loc, ds("`%s.%s` is a bitfield"),
                        b.toPrettyChars(), b_field.toChars());
                } else if (bfb === null) {
                    errorSupplemental(a_field!.loc, ds("`%s.%s` *is a bitfield"),
                        a.toPrettyChars(), a_field!.toChars());
                    errorSupplemental(b_field.loc, ds("`%s.%s` is not a bitfield"),
                        b.toPrettyChars(), b_field.toChars());
                }
                return false;
            }
            if (bfa !== null && bfb !== null) {
                if (bfa.fieldWidth !== bfb.fieldWidth) {
                    incompatError();
                    errorSupplemental(a_field!.loc, ds("Field %zu differs in bitfield width"), i);
                    errorSupplemental(a_field!.loc, ds("`%s.%s`: %u"),
                        a.toPrettyChars(), a_field!.toChars(), bfa.fieldWidth);
                    errorSupplemental(b_field.loc, ds("`%s.%s`: %u"),
                        b.toPrettyChars(), b_field.toChars(), bfb.fieldWidth);
                    return false;
                }
            }
        }
        return true;
    }
    /// dmd/dsymbolsem.d:5209 — `void interfaceSemantic(ClassDeclaration cd)`. Flatten the direct
    /// interface list into `vtblInterfaces`, appending each base's own transitive interfaces.
    interfaceSemantic(cd: ClassDeclaration): void {
        cd.vtblInterfaces = new DArray<BaseClass | null>();
        cd.vtblInterfaces.reserve(cd.interfaces!.length);
        for (const b of cd.interfaces!) {
            cd.vtblInterfaces.push(b);
            b!.copyBaseInterfaces(cd.vtblInterfaces);
        }
    }

    /**
     * dmd/dsymbolsem.d:5220 — `override void visit(ClassDeclaration cldec)`. Pass-1 for a class:
     * resolve the base class and interface list (deferring on forward references), lay out the
     * vtable, run pass-1 on the members, then generate the special members.
     *
     * resolved: version (none) at D:5833 and D:5872 -> branches dropped.
     */
    override visitClassDeclaration(cldec: ClassDeclaration): void {
        //printf("ClassDeclaration.dsymbolSemantic(%s), type = %p, sizeok = %d, this = %p\n", cldec.toChars(), cldec.type, cldec.sizeok, this);
        //{ static int n;  if (++n == 20) *(char*)0=0; }

        if (cldec.semanticRun >= PASS.semanticdone)
            return;
        const errors = global.errors;

        let scx: Scope | null = null;
        if (cldec._scope !== null) {
            this.sc = cldec._scope;
            scx = cldec._scope; // save so we don't make redundant copies
            cldec._scope = null;
        }
        let sc: Scope = this.sc!;

        if (cldec.parent === null) {
            assert(sc.parent !== null);
            cldec.parent = sc.parent;
        }

        if (cldec.errors)
            cldec.type = Type.terror;
        if (cldec.semanticRun === PASS.initial)
            cldec.type = addSTC(cldec.type!, (sc.stc | cldec.storage_class) as STC);
        cldec.type = typeSemantic(cldec.type!, cldec.loc, sc);
        {
            const tc = cldec.type.isTypeClass();
            if (tc !== null) {
                if (tc.sym !== cldec) {
                    const ti: TemplateInstance | null = tc.sym!.isInstantiated();
                    if (ti !== null && isError(ti))
                        tc.sym = cldec;
                }
            }
        }

        // Ungag errors when not speculative — D RAII (`Ungag`), so try/finally here (06 §7.1).
        const ungag = ungagSpeculative(cldec);
        try {
            if (cldec.semanticRun === PASS.initial) {
                cldec.visibility = sc.visibility.copy();

                cldec.storage_class = (cldec.storage_class | sc.stc) as STC;
                if ((cldec.storage_class & STC.auto_) !== 0n) {
                    error(cldec.loc,
                        ds("%s `%s` storage class `auto` is invalid when declaring a class, did you mean to use `scope`?"),
                        cldec.kind(), cldec.toPrettyChars());
                }
                if ((cldec.storage_class & STC.scope_) !== 0n)
                    cldec.stack = true;
                if ((cldec.storage_class & STC.abstract_) !== 0n)
                    cldec.isabstract = ThreeState.yes;

                cldec.userAttribDecl_set(sc.userAttribDecl);

                if (sc.linkage === LINK.cpp)
                    cldec.classKind = ClassKind.cpp;
                cldec.cppnamespace_set(sc.namespace);
                cldec.cppmangle = sc.cppmangle;
                if (sc.linkage === LINK.objc)
                    objc()!.setObjc(cldec); // dmd/dsymbolsem.d:5283
            } else if (cldec.symtab !== null && scx === null) {
                return;
            }
            cldec.rtInfoScope = sc;
            sc.setNoFree();

            cldec.semanticRun = PASS.semantic;
            checkGNUABITag(cldec, sc.linkage);
            // dmd/dsymbolsem.d:5294 — `checkMustUseReserved(cldec);`; callee live at dmd/mustuse.d:58
            // (`void checkMustUseReserved(Dsymbol sym)`), exported by mustuse.ts.
            checkMustUseReserved(cldec);

            // goto Lancestorsdone (D:5358) — SKIP-FLAG (06 §4.1): the label at D:5568 sits just past
            // the end of this `if (baseok < done)` block, so the jump gates the block's remainder.
            let gotoLancestorsdone = false;
            if (cldec.baseok < Baseok.done) {
                /* https://issues.dlang.org/show_bug.cgi?id=12078 / 12143 / 15733
                 * While resolving base classes and interfaces, a base may refer
                 * the member of this derived class. In that time, if all bases of
                 * this class can  be determined, we can go forward the semantc process
                 * beyond the Lancestorsdone. To do the recursive semantic analysis,
                 * temporarily set and unset `_scope` around exp().
                 */
                // dmd/dsymbolsem.d:5307 — `T resolveBase(T)(lazy T exp)`. MONOMORPHIZED at
                // translation time into the two instantiations this method uses (07 §3, preamble §4):
                // T = Type (D:5335) and T = void (D:5406, :5487). `lazy T exp` -> a thunk `() => T`,
                // and every call site wraps its argument in an arrow (04 §4.1).
                const resolveBaseType = (exp: () => Type): Type => {
                    if (scx === null) {
                        scx = sc.copy();
                        scx.setNoFree();
                    }
                    // static if (!is(T == void)) -> TAKEN for T = Type.
                    cldec._scope = scx;
                    const r = exp();
                    cldec._scope = null;
                    return r;
                };
                const resolveBaseVoid = (exp: () => void): void => {
                    if (scx === null) {
                        scx = sc.copy();
                        scx.setNoFree();
                    }
                    // static if (!is(T == void)) -> NOT taken for T = void; the `else` arm.
                    cldec._scope = scx;
                    exp();
                    cldec._scope = null;
                };

                cldec.baseok = Baseok.start;

                // Expand any tuples in baseclasses[]
                for (let i = 0; i < cldec.baseclasses.length;) {
                    let b: BaseClass = cldec.baseclasses.opIndex(i)!;
                    b.type = resolveBaseType(() => typeSemantic(b.type!, cldec.loc, sc));

                    const tb: Type = toBasetype(b.type!);
                    const tup = tb.isTypeTuple();
                    if (tup !== null) {
                        cldec.baseclasses.remove(i);
                        const dim: number = Parameter.dim(tup.arguments);
                        for (let j = 0; j < dim; j++) {
                            const arg: Parameter | null = Parameter.getNth(tup.arguments, j);
                            b = new BaseClass(arg!.type!);
                            cldec.baseclasses.insert(i + j, b);
                        }
                    } else {
                        i++;
                    }
                }

                if (cldec.baseok >= Baseok.done) {
                    //printf("%s already semantic analyzed, semanticRun = %d\n", toChars(), semanticRun);
                    if (cldec.semanticRun >= PASS.semanticdone)
                        return;
                    gotoLancestorsdone = true; // goto Lancestorsdone (dmd/dsymbolsem.d:5358)
                }

                if (!gotoLancestorsdone) {
                    // See if there's a base class as first in baseclasses[]
                    if (cldec.baseclasses.length !== 0) {
                        // goto L7 (D:5372, :5384, :5392) — SKIP-FLAG: `L7:` is the empty label that
                        // closes this `if` block, so each jump gates the block's remainder.
                        let gotoL7 = false;
                        const b: BaseClass = cldec.baseclasses.opIndex(0)!;
                        const tb: Type = toBasetype(b.type!);
                        const tc = tb.isTypeClass();
                        if (tc === null) {
                            if (b.type !== Type.terror) {
                                error(cldec.loc, ds("%s `%s` base type must be `class` or `interface`, not `%s`"),
                                    cldec.kind(), cldec.toPrettyChars(), b.type!.toChars());
                            }
                            cldec.baseclasses.remove(0);
                            gotoL7 = true;
                        }
                        if (!gotoL7) {
                            if (tc!.sym!.isDeprecated()) {
                                if (!cldec.isDeprecated()) {
                                    // Deriving from deprecated class makes this one deprecated too
                                    cldec.setDeprecated();
                                    checkDeprecatedType(tc!, cldec.loc, sc);
                                }
                            }
                            if (tc!.sym!.isInterfaceDeclaration() !== null)
                                gotoL7 = true;
                        }
                        if (!gotoL7) {
                            for (let cdb: ClassDeclaration | null = tc!.sym; cdb !== null; cdb = cdb.baseClass) {
                                if (cdb === cldec) {
                                    error(cldec.loc, ds("%s `%s` circular inheritance"),
                                        cldec.kind(), cldec.toPrettyChars());
                                    cldec.baseclasses.remove(0);
                                    gotoL7 = true;
                                    break;
                                }
                            }
                        }
                        if (!gotoL7) {
                            /* https://issues.dlang.org/show_bug.cgi?id=11034
                             * Class inheritance hierarchy
                             * and instance size of each classes are orthogonal information.
                             * Therefore, even if tc.sym.sizeof == Sizeok.none,
                             * we need to set baseClass field for class covariance check.
                             */
                            cldec.baseClass = tc!.sym;
                            b.sym = cldec.baseClass;

                            if (tc!.sym!.baseok < Baseok.done)
                                // Try to resolve forward reference
                                resolveBaseVoid(() => { dsymbolSemantic(tc!.sym!, null); });
                            if (tc!.sym!.baseok < Baseok.done) {
                                //printf("\ttry later, forward reference of base class %s\n", tc.sym.toChars());
                                if (tc!.sym!._scope !== null)
                                    addDeferredSemantic(tc!.sym!);
                                cldec.baseok = Baseok.none;
                            }
                        }
                        // L7: (dmd/dsymbolsem.d:5414) — empty label closing the block.
                    }

                    // Treat the remaining entries in baseclasses as interfaces
                    // Check for errors, handle forward references
                    let multiClassError: number = cldec.baseClass === null ? 0 : 1;

                    BCLoop: for (let i = (cldec.baseClass !== null ? 1 : 0); i < cldec.baseclasses.length;) {
                        const b: BaseClass = cldec.baseclasses.opIndex(i)!;
                        const tb: Type = toBasetype(b.type!);
                        const tc = tb.isTypeClass();
                        if (tc === null || tc.sym!.isInterfaceDeclaration() === null) {
                            // It's a class
                            if (tc !== null) {
                                if (multiClassError === 0) {
                                    error(cldec.loc, ds("`%s`: base class must be specified first, " +
                                        "before any interfaces."), cldec.toPrettyChars());
                                    multiClassError += 1;
                                } else if (multiClassError >= 1) {
                                    if (multiClassError === 1) {
                                        error(cldec.loc, ds("`%s`: multiple class inheritance is not supported." +
                                            " Use multiple interface inheritance and/or composition."),
                                            cldec.toPrettyChars());
                                    }
                                    multiClassError += 1;

                                    if (tc.sym!.fields.length !== 0) {
                                        errorSupplemental(cldec.loc,
                                            ds("`%s` has fields, consider making it a member of `%s`"),
                                            b.type!.toChars(), cldec.type!.toChars());
                                    } else {
                                        errorSupplemental(cldec.loc,
                                            ds("`%s` has no fields, consider making it an `interface`"),
                                            b.type!.toChars());
                                    }
                                }
                            }
                            // It's something else: e.g. `int` in `class Foo : Bar, int { ... }`
                            else if (b.type !== Type.terror) {
                                error(cldec.loc, ds("`%s`: base type must be `interface`, not `%s`"),
                                    cldec.toPrettyChars(), b.type!.toChars());
                            }
                            cldec.baseclasses.remove(i);
                            continue;
                        }

                        // Check for duplicate interfaces
                        {
                            let duplicate = false;
                            for (let j = (cldec.baseClass !== null ? 1 : 0); j < i; j++) {
                                const b2: BaseClass = cldec.baseclasses.opIndex(j)!;
                                if (b2.sym === tc.sym) {
                                    error(cldec.loc, ds("%s `%s` inherits from duplicate interface `%s`"),
                                        cldec.kind(), cldec.toPrettyChars(), b2.sym!.toChars());
                                    cldec.baseclasses.remove(i);
                                    duplicate = true;
                                    break;
                                }
                            }
                            if (duplicate)
                                continue BCLoop;
                        }
                        if (tc.sym!.isDeprecated()) {
                            if (!cldec.isDeprecated()) {
                                // Deriving from deprecated class makes this one deprecated too
                                cldec.setDeprecated();
                                checkDeprecatedType(tc, cldec.loc, sc);
                            }
                        }

                        b.sym = tc.sym;

                        if (tc.sym!.baseok < Baseok.done)
                            // Try to resolve forward reference
                            resolveBaseVoid(() => { dsymbolSemantic(tc.sym!, null); });
                        if (tc.sym!.baseok < Baseok.done) {
                            //printf("\ttry later, forward reference of base %s\n", tc.sym.toChars());
                            if (tc.sym!._scope !== null)
                                addDeferredSemantic(tc.sym!);
                            cldec.baseok = Baseok.none;
                        }
                        i++;
                    }
                    if (cldec.baseok === Baseok.none) {
                        // Forward referencee of one or more bases, try again later
                        deferDsymbolSemantic(sc, cldec, scx);
                        return;
                    }
                    cldec.baseok = Baseok.done;

                    if (cldec.classKind === ClassKind.objc ||
                        (cldec.baseClass !== null && cldec.baseClass.classKind === ClassKind.objc)) {
                        cldec.classKind = ClassKind.objc; // Objective-C classes do not inherit from Object
                    }

                    // If no base class, and this is not an Object, use Object as base class
                    if (cldec.baseClass === null && cldec.ident !== Id.Object &&
                        ClassDeclaration.object !== null && cldec.classKind === ClassKind.d) {
                        // dmd/dsymbolsem.d:5511 — nested `void badObjectDotD()`; captures `cldec`.
                        const badObjectDotD = (): void => {
                            ObjectNotFound(cldec.loc, cldec.ident!);
                        };

                        if (ClassDeclaration.object === null || ClassDeclaration.object.errors)
                            badObjectDotD();

                        let t: Type = ClassDeclaration.object!.type!;
                        t = toBasetype(typeSemantic(t, cldec.loc, sc));
                        if (t.ty === TY.Terror)
                            badObjectDotD();
                        const tc = t.isTypeClass();
                        assert(tc !== null);

                        const b = new BaseClass(tc!);
                        cldec.baseclasses.shift(b);

                        cldec.baseClass = tc!.sym;
                        assert(cldec.baseClass!.isInterfaceDeclaration() === null);
                        b.sym = cldec.baseClass;
                    }
                    if (cldec.baseClass !== null) {
                        if ((cldec.baseClass.storage_class & STC.final_) !== 0n) {
                            error(cldec.loc, ds("%s `%s` cannot inherit from class `%s` because it is `final`"),
                                cldec.kind(), cldec.toPrettyChars(), cldec.baseClass.toChars());
                        }

                        // Inherit properties from base class
                        if (cldec.baseClass.isCOMclass())
                            cldec.com = true;
                        if (cldec.baseClass.isCPPclass())
                            cldec.classKind = ClassKind.cpp;
                        if (cldec.classKind !== cldec.baseClass.classKind) {
                            error(cldec.loc,
                                ds("%s `%s` with %s linkage cannot inherit from class `%s` with %s linkage"),
                                cldec.kind(), cldec.toPrettyChars(),
                                ClassKindToChars(cldec.classKind), cldec.baseClass.toChars(),
                                ClassKindToChars(cldec.baseClass.classKind));
                        }

                        if (cldec.baseClass.stack)
                            cldec.stack = true;
                        cldec.enclosing = cldec.baseClass.enclosing;
                        cldec.storage_class =
                            (cldec.storage_class | (cldec.baseClass.storage_class & STC.TYPECTOR)) as STC;
                    }

                    // D: `cldec.interfaces = cldec.baseclasses.tdata()[lo .. hi];` — a D slice SHARES
                    // the container's backing store (02 §8). JS has no aliasing sub-range, so the
                    // port takes a snapshot; `baseclasses` is not mutated past this point in either
                    // this method or `interfaceSemantic`, so the two are observationally equal here.
                    cldec.interfaces = cldec.baseclasses.tdata()
                        .slice(cldec.baseClass !== null ? 1 : 0, cldec.baseclasses.length);
                    for (const b of cldec.interfaces) {
                        // If this is an interface, and it derives from a COM interface,
                        // then this is a COM interface too.
                        if (b!.sym!.isCOMinterface())
                            cldec.com = true;
                        if (cldec.classKind === ClassKind.cpp && !b!.sym!.isCPPinterface()) {
                            error(cldec.loc, ds("C++ class `%s` cannot implement D interface `%s`"),
                                cldec.toPrettyChars(), b!.sym!.toPrettyChars());
                        }
                    }
                    this.interfaceSemantic(cldec);
                }
            }
            // Lancestorsdone: (dmd/dsymbolsem.d:5568) — shared join, NOT gated.
            //printf("\tClassDeclaration.dsymbolSemantic(%s) baseok = %d\n", toChars(), baseok);

            if (cldec.members === null) { // if opaque declaration
                cldec.semanticRun = PASS.semanticdone;
                return;
            }
            if (cldec.symtab === null) {
                cldec.symtab = new DsymbolTable();

                /* https://issues.dlang.org/show_bug.cgi?id=12152
                 * The semantic analysis of base classes should be finished
                 * before the members semantic analysis of this class, in order to determine
                 * vtbl in this class. However if a base class refers the member of this class,
                 * it can be resolved as a normal forward reference.
                 * Call addMember() and setScope() to make this class members visible from the base classes.
                 */
                foreachDsymbolVoid(cldec.members, (s: Dsymbol): void => {
                    addMember(s, sc, cldec);
                });

                const sc2a: Scope = newScope(cldec, sc);

                /* Set scope so if there are forward references, we still might be able to
                 * resolve individual members like enums.
                 */
                foreachDsymbolVoid(cldec.members, (s: Dsymbol): void => { setScope(s, sc2a); });

                sc2a.pop();
            }

            for (let i = 0; i < cldec.baseclasses.length; i++) {
                const b: BaseClass = cldec.baseclasses.opIndex(i)!;
                const tb: Type = toBasetype(b.type!);
                const tc = tb.isTypeClass();
                if (tc!.sym!.semanticRun < PASS.semanticdone) {
                    // Forward referencee of one or more bases, try again later
                    if (tc!.sym!._scope !== null)
                        addDeferredSemantic(tc!.sym!);
                    //printf("\tL%d semantic('%s') failed due to forward references\n", __LINE__, toChars());
                    deferDsymbolSemantic(sc, cldec, scx);
                    return;
                }
            }

            if (cldec.baseok === Baseok.done) {
                cldec.baseok = Baseok.semanticdone;
                objc()!.setMetaclass(cldec, sc); // dmd/dsymbolsem.d:5617

                // initialize vtbl
                if (cldec.baseClass !== null) {
                    if (cldec.classKind === ClassKind.cpp && cldec.baseClass.vtbl.length === 0) {
                        error(cldec.loc, ds("%s `%s` C++ base class `%s` needs at least one virtual function"),
                            cldec.kind(), cldec.toPrettyChars(), cldec.baseClass.toChars());
                    }

                    // Copy vtbl[] from base class
                    assert(cldec.vtbl.length === 0);
                    cldec.vtbl.setDim(cldec.baseClass.vtbl.length);
                    // D: `memcpy(cldec.vtbl.tdata(), cldec.baseClass.vtbl.tdata(), (void*).sizeof * len)`
                    // — an element-wise copy of CLASS REFERENCES into a pre-sized array, not a byte
                    // blit (preamble §8): the referents are shared, exactly as in D.
                    for (let i = 0; i < cldec.vtbl.length; i++)
                        cldec.vtbl.opIndexAssign(cldec.baseClass.vtbl.opIndex(i), i);

                    cldec.vthis = cldec.baseClass.vthis;
                    cldec.vthis2 = cldec.baseClass.vthis2;
                } else {
                    // No base class, so this is the root of the class hierarchy
                    cldec.vtbl.setDim(0);
                    if (cldec.vtblOffset() !== 0)
                        cldec.vtbl.push(cldec); // leave room for classinfo as first member
                }

                /* If this is a nested class, add the hidden 'this'
                 * member which is a pointer to the enclosing scope.
                 */
                if (cldec.vthis !== null) { // if inheriting from nested class
                    // Use the base class's 'this' member
                    if ((cldec.storage_class & STC.static_) !== 0n) {
                        error(cldec.loc, ds("%s `%s` static class cannot inherit from nested class `%s`"),
                            cldec.kind(), cldec.toPrettyChars(), cldec.baseClass!.toChars());
                    }
                    if (cldec.toParentLocal() !== cldec.baseClass!.toParentLocal() &&
                        (cldec.toParentLocal() === null ||
                         getType(cldec.baseClass!.toParentLocal()!) === null ||
                         !isBaseOf(getType(cldec.baseClass!.toParentLocal()!)!,
                             getType(cldec.toParentLocal()!), null))) {
                        if (cldec.toParentLocal() !== null) {
                            error(cldec.loc,
                                ds("%s `%s` is nested within `%s`, but super class `%s` is nested within `%s`"),
                                cldec.kind(), cldec.toPrettyChars(),
                                cldec.toParentLocal()!.toChars(),
                                cldec.baseClass!.toChars(),
                                cldec.baseClass!.toParentLocal()!.toChars());
                        } else {
                            error(cldec.loc,
                                ds("%s `%s` is not nested, but super class `%s` is nested within `%s`"),
                                cldec.kind(), cldec.toPrettyChars(),
                                cldec.baseClass!.toChars(),
                                cldec.baseClass!.toParentLocal()!.toChars());
                        }
                    }
                    if (cldec.vthis2 !== null) {
                        if (cldec.toParent2() !== cldec.baseClass!.toParent2() &&
                            (cldec.toParent2() === null ||
                             getType(cldec.baseClass!.toParent2()!) === null ||
                             !isBaseOf(getType(cldec.baseClass!.toParent2()!)!,
                                 getType(cldec.toParent2()!), null))) {
                            if (cldec.toParent2() !== null && cldec.toParent2() !== cldec.toParentLocal()) {
                                error(cldec.loc,
                                    ds("%s `%s` needs the frame pointer of `%s`, but super class `%s` needs the frame pointer of `%s`"),
                                    cldec.kind(), cldec.toPrettyChars(),
                                    cldec.toParent2()!.toChars(),
                                    cldec.baseClass!.toChars(),
                                    cldec.baseClass!.toParent2()!.toChars());
                            } else {
                                error(cldec.loc,
                                    ds("%s `%s` doesn't need a frame pointer, but super class `%s` needs the frame pointer of `%s`"),
                                    cldec.kind(), cldec.toPrettyChars(),
                                    cldec.baseClass!.toChars(),
                                    cldec.baseClass!.toParent2()!.toChars());
                            }
                        }
                    } else {
                        makeNested2(cldec);
                    }
                } else {
                    makeNested(cldec);
                }
            }

            const sc2: Scope = newScope(cldec, sc);

            foreachDsymbolVoid(cldec.members, (s: Dsymbol): void => { importAll(s, sc2); });

            // Note that members.length can grow due to tuple expansion during semantic()
            foreachDsymbolVoid(cldec.members, (s: Dsymbol): void => { dsymbolSemantic(s, sc2); });

            if (!determineFields(cldec)) {
                assert(cldec.type === Type.terror);
                sc2.pop();
                return;
            }
            /* Following special member functions creation needs semantic analysis
             * completion of sub-structs in each field types.
             */
            for (const v of cldec.fields) {
                const tb: Type = baseElemOf(v!.type!);
                if (tb.ty !== TY.Tstruct)
                    continue;
                // tag-proved downcast (02 §11.5c #3): D writes `cast(TypeStruct)tb`.
                const sd: StructDeclaration = tb.isTypeStruct()!.sym!;
                if (sd.semanticRun >= PASS.semanticdone)
                    continue;

                sc2.pop();

                //printf("\tdeferring %s\n", toChars());
                deferDsymbolSemantic(sc, cldec, scx);
                return;
            }

            /* Look for special member functions.
             * They must be in this class, not in a base class.
             */
            // Can be in base class
            cldec.disableNew = search(cldec, Loc.initial, Id.classNew!) !== null;

            // Look for the constructor
            cldec.ctor = searchCtor(cldec);

            if (cldec.ctor === null && cldec.noDefaultCtor) {
                // A class object is always created by constructor, so this check is legitimate.
                for (const v of cldec.fields) {
                    if ((v!.storage_class & STC.nodefaultctor) !== 0n)
                        error(v!.loc, ds("field `%s` must be initialized in constructor"), v!.toChars());
                }
            }

            // If this class has no constructor, but base class has a default
            // ctor, create a constructor:
            //    this() { }
            if (cldec.ctor === null && cldec.baseClass !== null && cldec.baseClass.ctor !== null) {
                let fd: FuncDeclaration | null = resolveFuncCall(cldec.loc, sc2, cldec.baseClass.ctor,
                    null, cldec.type, new ArgumentList(), FuncResolveFlag.quiet);
                if (fd === null) { // try shared base ctor instead
                    fd = resolveFuncCall(cldec.loc, sc2, cldec.baseClass.ctor, null,
                        sharedOf(cldec.type!), new ArgumentList(), FuncResolveFlag.quiet);
                }
                if (fd !== null && !fd.errors) {
                    //printf("Creating default this(){} for class %s\n", toChars());
                    const btf: TypeFunction = fd.type!.toTypeFunction();
                    const tf = new TypeFunction(new ParameterList(null), null, LINK.d, fd.storage_class);
                    tf.mod = btf.mod;
                    // Don't copy @safe, ... from the base class constructor and let it be inferred instead
                    // This is required if other lowerings add code to the generated constructor which
                    // is less strict (e.g. `preview=dtorfields` might introduce a call to a less qualified dtor)

                    const ctor = new CtorDeclaration(cldec.loc, Loc.initial, STC.none, tf);
                    ctor.storage_class =
                        (ctor.storage_class | STC.inference | (fd.storage_class & STC.scope_)) as STC;
                    ctor.isGenerated = true;
                    ctor.fbody = new CompoundStatement(Loc.initial, new DArray<Statement | null>());

                    cldec.members!.push(ctor);
                    addMember(ctor, sc, cldec);
                    dsymbolSemantic(ctor, sc2);

                    cldec.ctor = ctor;
                    cldec.defaultCtor = ctor;
                } else {
                    error(cldec.loc,
                        ds("%s `%s` cannot implicitly generate a default constructor when base class `%s` is missing a default constructor"),
                        cldec.kind(), cldec.toPrettyChars(), cldec.baseClass.toPrettyChars());
                }
            }

            buildDtors(cldec, sc2);

            if (cldec.classKind === ClassKind.cpp && cldec.cppDtorVtblIndex !== -1) {
                // now we've built the aggregate destructor, we'll make it virtual and assign it to the reserved vtable slot
                cldec.dtor!.vtblIndex = cldec.cppDtorVtblIndex;
                cldec.vtbl.opIndexAssign(cldec.dtor, cldec.cppDtorVtblIndex);

                if (target.cpp.twoDtorInVtable) {       // dmd/dsymbolsem.d:5794
                    // TODO: create a C++ compatible deleting destructor (call out to `operator delete`)
                    //       for the moment, we'll call the non-deleting destructor and leak
                    cldec.vtbl.opIndexAssign(cldec.dtor, cldec.cppDtorVtblIndex + 1);
                }
            }

            {
                const f: FuncDeclaration | null = hasIdentityOpAssign(cldec, sc2);
                if (f !== null) {
                    if ((f.storage_class & STC.disable) === 0n) {
                        error(f.loc, ds("%s `%s` identity assignment operator overload is illegal"),
                            cldec.kind(), cldec.toPrettyChars());
                    }
                }
            }

            cldec.inv = buildInv(cldec, sc2);

            cldec.semanticRun = PASS.semanticdone;
            //printf("-ClassDeclaration.dsymbolSemantic(%s), type = %p\n", toChars(), type);

            sc2.pop();

            /* isAbstract() is undecidable in some cases because of circular dependencies.
             * Now that semantic is finished, get a definitive result, and error if it is not the same.
             */
            if (cldec.isabstract !== ThreeState.none) {   // if evaluated it before completion
                const isabstractsave: ThreeState = cldec.isabstract;
                cldec.isabstract = ThreeState.none;
                isAbstract(cldec);               // recalculate
                // 02 §11.4 (assignment-narrowing variant, as above): `cldec.isabstract = ThreeState.none`
                // pins the flow type; `isAbstract(cldec)` recomputes the field. Alias the object to re-read.
                const cldecRead: ClassDeclaration = cldec;
                if (cldecRead.isabstract !== isabstractsave) {
                    error(cldec.loc, ds("%s `%s` cannot infer `abstract` attribute due to circular dependencies"),
                        cldec.kind(), cldec.toPrettyChars());
                }
            }

            if (cldec.type!.ty === TY.Tclass && cldec.type!.isTypeClass()!.sym !== cldec) {
                // https://issues.dlang.org/show_bug.cgi?id=17492
                const cd: ClassDeclaration = cldec.type!.isTypeClass()!.sym!;
                error(cldec.loc, ds("%s `%s` already exists at %s. Perhaps in another function with the same name?"),
                    cldec.kind(), cldec.toPrettyChars(), cd.loc.toChars());
            }

            if (global.errors !== errors || (cldec.baseClass !== null && cldec.baseClass.errors)) {
                // The type is no good, but we should keep the
                // the type so that we have more accurate error messages
                // See: https://issues.dlang.org/show_bug.cgi?id=23552
                cldec.errors = true;
                // `cldec.deferred` through a ClassDeclaration reference: the DERIVED slot (02 §11.5b).
                if (cldec.deferredTI !== null)
                    cldec.deferredTI.errors = true;
            }

            // Verify fields of a synchronized class are not public
            if ((cldec.storage_class & STC.synchronized_) !== 0n) {
                for (const vd of cldec.fields) {
                    if (vd!.isThisDeclaration() === null &&
                        vd!.visible().opCmp(new Visibility(Visibility.Kind.public_)) >= 0) {
                        error(vd!.loc, ds("%s `%s` Field members of a `synchronized` class cannot be `%s`"),
                            vd!.kind(), vd!.toPrettyChars(), visibilityToChars(vd!.visible().kind));
                    }
                }
            }

            if (cldec.deferredTI !== null && global.gag === 0) {
                // dsymbolsem.d:5867 — `cldec.deferred.semantic2(sc)` (UFCS, 04 §6). SWEPT:
                // authorised by dmd/semantic2.d:79 `void semantic2(Dsymbol dsym, Scope* sc)`
                // (semantic2.ts:197).
                semantic2(cldec.deferredTI, sc);
                semantic3(cldec.deferredTI, sc);
            }
            //printf("-ClassDeclaration.dsymbolSemantic(%s), type = %p, sizeok = %d, this = %p\n", toChars(), type, sizeok, this);
        } finally {
            // Ungag.~this() (dmd/dsymbolsem.d:1974) — restore the saved gag level.
            global.gag = ungag.oldgag;
        }
    }
    /**
     * dmd/dsymbolsem.d:5883 — `override void visit(InterfaceDeclaration idec)`. Pass-1 for an
     * interface: resolve the base-interface list (deferring on forward references), concatenate the
     * base vtables, then run pass-1 on the members.
     *
     * resolved: version (none) at D:6171 and D:6181 -> branches dropped.
     */
    override visitInterfaceDeclaration(idec: InterfaceDeclaration): void {
        /// dmd/dsymbolsem.d:5886 — nested `static bool isAnonymousMetaclass(InterfaceDeclaration)`.
        /// Returns: `true` is this is an anonymous Objective-C metaclass
        const isAnonymousMetaclass = (id: InterfaceDeclaration): boolean => {
            // D writes `id.isAnonymous` without parens — the optional-parens rule CALLS it.
            return id.classKind === ClassKind.objc &&
                id.objc.isMeta &&
                id.isAnonymous();
        };

        //printf("InterfaceDeclaration.dsymbolSemantic(%s), type = %p\n", toChars(), type);
        if (idec.semanticRun >= PASS.semanticdone)
            return;
        const errors = global.errors;

        let scx: Scope | null = null;
        if (idec._scope !== null) {
            this.sc = idec._scope;
            scx = idec._scope; // save so we don't make redundant copies
            idec._scope = null;
        }
        const sc: Scope = this.sc!;

        if (idec.parent === null) {
            assert(sc.parent !== null && sc.func !== null);
            idec.parent = sc.parent;
        }
        // Objective-C metaclasses are anonymous
        // D precedence: `&&` binds tighter than `||`.
        assert((idec.parent !== null && !idec.isAnonymous()) || isAnonymousMetaclass(idec));

        if (idec.errors)
            idec.type = Type.terror;
        idec.type = typeSemantic(idec.type!, idec.loc, sc);
        if (idec.type.ty === TY.Tclass && idec.type.isTypeClass()!.sym !== idec) {
            // tag-proved downcast (02 §11.5c #3): D writes `cast(TypeClass)idec.type`.
            const ti: TemplateInstance | null = idec.type.isTypeClass()!.sym!.isInstantiated();
            if (ti !== null && isError(ti))
                idec.type.isTypeClass()!.sym = idec;
        }

        // Ungag errors when not speculative — D RAII (`Ungag`), so try/finally here (06 §7.1).
        const ungag = ungagSpeculative(idec);
        try {
            if (idec.semanticRun === PASS.initial) {
                idec.visibility = sc.visibility.copy();

                idec.storage_class = (idec.storage_class | sc.stc) as STC;
                idec.userAttribDecl_set(sc.userAttribDecl);
            } else if (idec.symtab !== null) {
                if (idec.sizeok === Sizeok.done || scx === null) {
                    idec.semanticRun = PASS.semanticdone;
                    return;
                }
            }
            idec.semanticRun = PASS.semantic;

            // goto Lancestorsdone (D:5999) — SKIP-FLAG (06 §4.1), same shape as the class version.
            let gotoLancestorsdone = false;
            if (idec.baseok < Baseok.done) {
                // dmd/dsymbolsem.d:5948 — `T resolveBase(T)(lazy T exp)`, MONOMORPHIZED into the two
                // instantiations used here: T = Type (D:5976) and T = void (D:6056). `lazy T exp`
                // becomes a thunk `() => T` (04 §4.1, preamble §4).
                const resolveBaseType = (exp: () => Type): Type => {
                    if (scx === null) {
                        scx = sc.copy();
                        scx.setNoFree();
                    }
                    // static if (!is(T == void)) -> TAKEN for T = Type.
                    idec._scope = scx;
                    const r = exp();
                    idec._scope = null;
                    return r;
                };
                const resolveBaseVoid = (exp: () => void): void => {
                    if (scx === null) {
                        scx = sc.copy();
                        scx.setNoFree();
                    }
                    // static if (!is(T == void)) -> NOT taken for T = void; the `else` arm.
                    idec._scope = scx;
                    exp();
                    idec._scope = null;
                };

                idec.baseok = Baseok.start;

                // Expand any tuples in baseclasses[]
                for (let i = 0; i < idec.baseclasses.length;) {
                    let b: BaseClass = idec.baseclasses.opIndex(i)!;
                    b.type = resolveBaseType(() => typeSemantic(b.type!, idec.loc, sc));

                    const tb: Type = toBasetype(b.type!);
                    const tup = tb.isTypeTuple();
                    if (tup !== null) {
                        idec.baseclasses.remove(i);
                        const dim: number = Parameter.dim(tup.arguments);
                        for (let j = 0; j < dim; j++) {
                            const arg: Parameter | null = Parameter.getNth(tup.arguments, j);
                            b = new BaseClass(arg!.type!);
                            idec.baseclasses.insert(i + j, b);
                        }
                    } else {
                        i++;
                    }
                }

                if (idec.baseok >= Baseok.done) {
                    //printf("%s already semantic analyzed, semanticRun = %d\n", toChars(), semanticRun);
                    if (idec.semanticRun >= PASS.semanticdone)
                        return;
                    gotoLancestorsdone = true; // goto Lancestorsdone (dmd/dsymbolsem.d:5999)
                }

                if (!gotoLancestorsdone) {
                    if (idec.baseclasses.length === 0 && sc.linkage === LINK.cpp)
                        idec.classKind = ClassKind.cpp;
                    idec.cppnamespace_set(sc.namespace);
                    checkGNUABITag(idec, sc.linkage);
                    // dmd/dsymbolsem.d:6006 — `checkMustUseReserved(idec);`; callee live at dmd/mustuse.d:58
                    // (`void checkMustUseReserved(Dsymbol sym)`), exported by mustuse.ts.
                    checkMustUseReserved(idec);

                    if (sc.linkage === LINK.objc)
                        objc()!.setObjcInterfaceDeclaration(idec); // dmd/dsymbolsem.d:6009 (Form B suffix)

                    // Check for errors, handle forward references
                    BCLoop: for (let i = 0; i < idec.baseclasses.length;) {
                        const b: BaseClass = idec.baseclasses.opIndex(i)!;
                        const tb: Type = toBasetype(b.type!);
                        // D writes `(tb.ty == Tclass) ? cast(TypeClass)tb : null` — the tag-proved
                        // form is `isTypeClass()` (02 §11.5c #3), identical in effect.
                        const tc = tb.ty === TY.Tclass ? tb.isTypeClass() : null;
                        if (tc === null || tc.sym!.isInterfaceDeclaration() === null) {
                            if (b.type !== Type.terror) {
                                error(idec.loc, ds("%s `%s` base type must be `interface`, not `%s`"),
                                    idec.kind(), idec.toPrettyChars(), b.type!.toChars());
                            }
                            idec.baseclasses.remove(i);
                            continue;
                        }

                        // Check for duplicate interfaces
                        {
                            let duplicate = false;
                            for (let j = 0; j < i; j++) {
                                const b2: BaseClass = idec.baseclasses.opIndex(j)!;
                                if (b2.sym === tc.sym) {
                                    error(idec.loc, ds("%s `%s` inherits from duplicate interface `%s`"),
                                        idec.kind(), idec.toPrettyChars(), b2.sym!.toChars());
                                    idec.baseclasses.remove(i);
                                    duplicate = true;
                                    break;
                                }
                            }
                            if (duplicate)
                                continue BCLoop;
                        }
                        if (tc.sym === idec || idec.isBaseOf2(tc.sym)) {
                            error(idec.loc, ds("%s `%s` circular inheritance of interface"),
                                idec.kind(), idec.toPrettyChars());
                            idec.baseclasses.remove(i);
                            continue;
                        }
                        if (tc.sym!.isDeprecated()) {
                            if (!idec.isDeprecated()) {
                                // Deriving from deprecated interface makes this one deprecated too
                                idec.setDeprecated();
                                checkDeprecatedType(tc, idec.loc, sc);
                            }
                        }

                        b.sym = tc.sym;

                        if (tc.sym!.baseok < Baseok.done)
                            // Try to resolve forward reference
                            resolveBaseVoid(() => { dsymbolSemantic(tc.sym!, null); });
                        if (tc.sym!.baseok < Baseok.done) {
                            //printf("\ttry later, forward reference of base %s\n", tc.sym.toChars());
                            if (tc.sym!._scope !== null)
                                addDeferredSemantic(tc.sym!);
                            idec.baseok = Baseok.none;
                        }
                        i++;
                    }
                    if (idec.baseok === Baseok.none) {
                        // Forward referencee of one or more bases, try again later
                        deferDsymbolSemantic(sc, idec, scx);
                        return;
                    }
                    idec.baseok = Baseok.done;

                    // D slice of the container's backing store (02 §8); see the matching note in
                    // `visitClassDeclaration` — the port snapshots because JS has no aliasing view.
                    idec.interfaces = idec.baseclasses.tdata().slice(0, idec.baseclasses.length);
                    for (const b of idec.interfaces) {
                        // If this is an interface, and it derives from a COM interface,
                        // then this is a COM interface too.
                        if (b!.sym!.isCOMinterface())
                            idec.com = true;
                        if (b!.sym!.isCPPinterface())
                            idec.classKind = ClassKind.cpp;
                    }

                    this.interfaceSemantic(idec);
                }
            }
            // Lancestorsdone: (dmd/dsymbolsem.d:6086) — shared join, NOT gated.

            if (idec.members === null) { // if opaque declaration
                idec.semanticRun = PASS.semanticdone;
                return;
            }
            if (idec.symtab === null)
                idec.symtab = new DsymbolTable();

            for (let i = 0; i < idec.baseclasses.length; i++) {
                const b: BaseClass = idec.baseclasses.opIndex(i)!;
                const tb: Type = toBasetype(b.type!);
                const tc = tb.isTypeClass();
                if (tc!.sym!.semanticRun < PASS.semanticdone) {
                    // Forward referencee of one or more bases, try again later
                    if (tc!.sym!._scope !== null)
                        addDeferredSemantic(tc!.sym!);
                    deferDsymbolSemantic(sc, idec, scx);
                    return;
                }
            }

            if (idec.baseok === Baseok.done) {
                idec.baseok = Baseok.semanticdone;
                objc()!.setMetaclassInterfaceDeclaration(idec, sc); // dmd/dsymbolsem.d:6113 (Form B suffix)

                // initialize vtbl
                if (idec.vtblOffset() !== 0)
                    idec.vtbl.push(idec); // leave room at vtbl[0] for classinfo

                // Cat together the vtbl[]'s from base interfaces
                // The D label `Lcontinue:` is the empty label that closes this foreach body, so
                // `goto Lcontinue` is a plain `continue` (06 §4/§6).
                for (const [i, b] of idec.interfaces!.entries()) {
                    // Skip if b has already appeared
                    let seen = false;
                    for (let k = 0; k < i; k++) {
                        if (b === idec.interfaces![k]) {
                            seen = true;
                            break;
                        }
                    }
                    if (seen)
                        continue; // goto Lcontinue (dmd/dsymbolsem.d:6126)

                    // Copy vtbl[] from base class
                    if (b!.sym!.vtblOffset() !== 0) {
                        const d: number = b!.sym!.vtbl.length;
                        if (d > 1) {
                            idec.vtbl.pushSlice(b!.sym!.vtbl.opSlice(1, d));
                        }
                    } else {
                        idec.vtbl.append(b!.sym!.vtbl);
                    }

                    // Lcontinue: (dmd/dsymbolsem.d:6143)
                }
            }

            foreachDsymbolVoid(idec.members, (s: Dsymbol): void => {
                addMember(s, sc, idec);
            });

            const sc2: Scope = newScope(idec, sc);

            /* Set scope so if there are forward references, we still might be able to
             * resolve individual members like enums.
             */
            foreachDsymbolVoid(idec.members, (s: Dsymbol): void => { setScope(s, sc2); });

            foreachDsymbolVoid(idec.members, (s: Dsymbol): void => { importAll(s, sc2); });

            foreachDsymbolVoid(idec.members, (s: Dsymbol): void => { dsymbolSemantic(s, sc2); });

            idec.semanticRun = PASS.semanticdone;
            //printf("-InterfaceDeclaration.dsymbolSemantic(%s), type = %p\n", toChars(), type);

            sc2.pop();

            if (global.errors !== errors) {
                // The type is no good.
                idec.type = Type.terror;
            }

            assert(idec.type!.ty !== TY.Tclass || idec.type!.isTypeClass()!.sym === idec);
        } finally {
            // Ungag.~this() (dmd/dsymbolsem.d:1974) — restore the saved gag level.
            global.gag = ungag.oldgag;
        }
    }
}

/*
Adds dsym as a member of scope sds.

Params:
    dsym = dsymbol to inserted
    sc = scope where the dsymbol is declared
    sds = ScopeDsymbol where dsym is inserted

dmd/dsymbolsem.d:6201 — `void addMember(Dsymbol dsym, Scope* sc, ScopeDsymbol sds)`.
*/
export function addMember(dsym: Dsymbol, sc: Scope | null, sds: ScopeDsymbol): void {
    const addMemberVisitor = new AddMemberVisitor(sc, sds);
    dsym.accept(addMemberVisitor);
}

/**
 * dmd/dsymbolsem.d:6207 — `private void attribAddMember(AttribDeclaration atb, Scope* sc, ScopeDsymbol sds)`.
 * D module-private; shared by the AttribDeclaration / VisibilityDeclaration / ForwardingAttribDeclaration
 * arms of `AddMemberVisitor` below.
 *
 * Preconditions: `atb` is non-null. `sc` may be null (`include`/`newScopeDsymbol` both tolerate it).
 * Postconditions: any scope `newScopeDsymbol` pushed is popped again before return.
 */
function attribAddMember(atb: AttribDeclaration, sc: Scope | null, sds: ScopeDsymbol): void {
    const d: Dsymbols | null = include(atb, sc);
    if (d !== null) {
        const sc2 = newScopeDsymbol(atb, sc);
        // D `d.foreachDsymbol(s => s.addMember(sc2, sds))` binds the `void delegate` overload
        // (dsymbol.d:94) -> `foreachDsymbolVoid` (04 §1B rename in dsymbol.ts).
        foreachDsymbolVoid(d, (s) => addMember(s, sc2, sds));
        if (sc2 !== sc)
            sc2!.pop();
    }
}

/***********************************************************
 * dmd/dsymbolsem.d:6219 — `private extern(C++) class AddMemberVisitor : Visitor`.
 *
 * 13 §1: `alias visit = Visitor.visit;` dropped (no overload hiding in TS); each `visit(X)` overload
 * becomes the distinct named slot `visitX`, and every `visit(cast(Base)x)` forward becomes
 * `this.visitBase(x)` (13 §4).
 *
 * D module-private; emitted without `private` (01 §2.5) — the module's own free functions drive it.
 */
class AddMemberVisitor extends Visitor {
    sc: Scope | null;
    sds: ScopeDsymbol;

    constructor(sc: Scope | null, sds: ScopeDsymbol) {
        super();
        this.sc = sc;
        this.sds = sds;
    }

    override visitDsymbol(dsym: Dsymbol): void {
        //printf("Dsymbol::addMember('%s')\n", toChars());
        //printf("Dsymbol::addMember(this = %p, '%s' scopesym = '%s')\n", this, toChars(), sds.toChars());
        //printf("Dsymbol::addMember(this = %p, '%s' sds = %p, sds.symtab = %p)\n", this, toChars(), sds, sds.symtab);
        dsym.parent = this.sds;
        if (dsym.isAnonymous()) // no name, so can't add it to symbol table
            return;

        if (this.sds.symtabInsert(dsym) === null) { // if name is already defined
            if (dsym.isAliasDeclaration() !== null && dsym._scope === null)
                setScope(dsym, this.sc);
            const s2 = this.sds.symtabLookup(dsym, dsym.ident!);
            /* https://issues.dlang.org/show_bug.cgi?id=17434
             *
             * If we are trying to add an import to the symbol table
             * that has already been introduced, then keep the one with
             * larger visibility. This is fine for imports because if
             * we have multiple imports of the same file, if a single one
             * is public then the symbol is reachable.
             */
            const i1 = dsym.isImport();
            if (i1 !== null) {
                const i2 = s2!.isImport();
                if (i2 !== null) {
                    // `sc.visibility > i2.visibility` — Visibility has opCmp (05 §3).
                    if (this.sc!.explicitVisibility && this.sc!.visibility.opCmp(i2.visibility) > 0)
                        this.sds.symtab!.update(dsym);
                }
            }

            // If using C tag/prototype/forward declaration rules
            if (this.sc !== null && this.sc.inCfile && dsym.isImport() === null) {
                // When merging master, replace with: if (sc && sc.inCfile && !dsym.isImport())
                // dmd/dsymbolsem.d:6267 — `if (handleTagSymbols(*sc, dsym, s2, sds))`
                if (handleTagSymbols(this.sc, dsym, s2!, this.sds) !== null)
                    return;
                // dmd/dsymbolsem.d:6269 — `if (handleSymbolRedeclarations(*sc, dsym, s2, sds))`
                if (handleSymbolRedeclarations(this.sc, dsym, s2!, this.sds) !== null)
                    return;

                ScopeDsymbol.multiplyDefined(Loc.initial, dsym, s2!);  // ImportC doesn't allow overloading
                dsym.errors = true;
                return;
            }

            if (!overloadInsert(s2!, dsym)) {
                const _td = s2!.isTemplateDeclaration();
                if (_td !== null) {
                    // dmd/dsymbolsem.d:6280 — `_td.computeOneMember()` (UFCS, 04 §6). SWEPT:
                    // authorised by dmd/templatesem.d:441 `void computeOneMember(
                    // TemplateDeclaration td)` (NOT dtemplate.d, as the old wall text claimed),
                    // live at templatesem.ts:761.
                    computeOneMember(_td);
                }
                ScopeDsymbol.multiplyDefined(Loc.initial, dsym, s2!);
                dsym.errors = true;
            }
        }
        if (this.sds.isAggregateDeclaration() !== null || this.sds.isEnumDeclaration() !== null) {
            if (dsym.ident === Id.__sizeof ||
                !(this.sc !== null && this.sc.inCfile) &&
                    (dsym.ident === Id.__xalignof || dsym.ident === Id._mangleof)) {
                error(dsym.loc, ds("%s `%s` `.%s` property cannot be redefined"),
                    dsym.kind(), dsym.toPrettyChars(), dsym.ident!.toChars());
                dsym.errors = true;
            }
        }
    }

    override visitStaticAssert(_: StaticAssert): void {
        // we didn't add anything
    }

    /*****************************
     * Add import to sd's symbol table.
     */
    override visitImport(imp: Import): void {
        //printf("Import.addMember(this=%s, sds=%s, sc=%p)\n", imp.toChars(), sds.toChars(), sc);
        if (imp.names.length === 0)
            return this.visitDsymbol(imp);
        if (imp.aliasId !== null)
            this.visitDsymbol(imp);

        /* Instead of adding the import to sds's symbol table,
         * add each of the alias=name pairs
         */
        for (let i = 0; i < imp.names.length; i++) {
            const name = imp.names.opIndex(i)!;
            let _alias = imp.aliases.opIndex(i);
            if (_alias === null)
                _alias = name;
            const tname = new TypeIdentifier(imp.loc, name);
            // D `new AliasDeclaration(loc, ident, Type)` — the Type-arm of the ctor overload set
            // becomes the named factory `fromType` (04 §1B / declaration.ts).
            const ad = AliasDeclaration.fromType(imp.loc, _alias, tname);
            ad._import = imp;
            addMember(ad, this.sc, this.sds);
            imp.aliasdecls.push(ad);
        }
    }

    override visitAttribDeclaration(atb: AttribDeclaration): void {
        attribAddMember(atb, this.sc, this.sds);
    }

    override visitStorageClassDeclaration(stcd: StorageClassDeclaration): void {
        const d: Dsymbols | null = include(stcd, this.sc);
        if (d !== null) {
            const sc2 = newScopeDsymbol(stcd, this.sc);

            // void-delegate body (no `return <value>`) -> the `void delegate` overload.
            foreachDsymbolVoid(d, (s) => {
                //printf("\taddMember %s to %s\n", s.toChars(), sds.toChars());
                // STC.local needs to be attached before the member is added to the scope
                // (because it influences the parent symbol)
                const decl = s.isDeclaration();
                if (decl !== null) {
                    // branded flag-enum re-cast after `|` / `&` (02 §4.2, 11.5c item 4)
                    decl.storage_class = (decl.storage_class | (stcd.stc & STC.local)) as STC;
                    // TODO: why is this not enough to deal with the nested case? (upstream note)
                    const sdecl = s.isStorageClassDeclaration();
                    if (sdecl !== null) {
                        sdecl.stc = (sdecl.stc | (stcd.stc & STC.local)) as STC;
                    }
                }
                addMember(s, sc2, this.sds);
            });

            if (sc2 !== this.sc)
                sc2!.pop();
        }
    }

    override visitVisibilityDeclaration(visd: VisibilityDeclaration): void {
        if (visd.pkg_identifiers !== null) {
            // D `Dsymbol tmp; Package.resolve(visd.pkg_identifiers, &tmp, null);` — `&tmp` on a local
            // class-typed variable is the out-param box (03 §3.3/§7.2).
            const tmp: { value: Dsymbol | null } = { value: null };
            Package.resolve(visd.pkg_identifiers, tmp, null);
            visd.visibility.pkg = tmp.value !== null ? tmp.value.isPackage() : null;
            visd.pkg_identifiers = null;
        }
        if (visd.visibility.kind === Visibility.Kind.package_ && visd.visibility.pkg !== null &&
            this.sc!._module !== null) {
            const m = this.sc!._module!;

            // https://issues.dlang.org/show_bug.cgi?id=17441
            // While isAncestorPackageOf does an equality check, the fix for the issue adds a check to see if
            // each package's .isModule() properites are equal.
            //
            // Properties generated from `package(foo)` i.e. visibility.pkg have .isModule() == null.
            // This breaks package declarations of the package in question if they are declared in
            // the same package.d file, which _do_ have a module associated with them, and hence a non-null
            // isModule()
            if (m.isPackage() === null ||
                !visd.visibility.pkg.ident!.equals(m.isPackage()!.ident)) {
                const pkg = m.parent !== null ? m.parent.isPackage() : null;
                if (pkg === null || !visd.visibility.pkg.isAncestorPackageOf(pkg))
                    error(visd.loc, ds("%s `%s` does not bind to one of ancestor packages of module `%s`"),
                        visd.kind(), visd.toPrettyChars(false), m.toPrettyChars(true));
            }
        }
        attribAddMember(visd, this.sc, this.sds);
    }

    override visitStaticIfDeclaration(sid: StaticIfDeclaration): void {
        //printf("StaticIfDeclaration::addMember() '%s'\n", sid.toChars());
        /* This is deferred until the condition evaluated later (by the include() call),
         * so that expressions in the condition can refer to declarations
         * in the same scope, such as:
         *
         * template Foo(int i)
         * {
         *     const int j = i + 1;
         *     static if (j == 3)
         *         const int k;
         * }
         */
        sid.scopesym = this.sds;
    }

    override visitStaticForeachDeclaration(sfd: StaticForeachDeclaration): void {
        // used only for caching the enclosing symbol
        sfd.scopesym = this.sds;
    }

    /***************************************
     * Lazily initializes the scope to forward to.
     */
    override visitForwardingAttribDeclaration(fad: ForwardingAttribDeclaration): void {
        fad.sym!.parent = this.sds;
        this.sds = fad.sym!;
        attribAddMember(fad, this.sc, fad.sym!);
    }

    override visitMixinDeclaration(md: MixinDeclaration): void {
        //printf("MixinDeclaration::addMember(sc = %p, sds = %p, memnum = %d)\n", sc, sds, md.memnum);
        md.scopesym = this.sds;
    }

    // renamed: D parameter `ds` -> `dsy` (same reason as aliasSemantic's `dsym`: it would
    // shadow the module's `ds()` DString-literal helper, used by this body's diagnostics).
    override visitDebugSymbol(dsy: DebugSymbol): void {
        //printf("DebugSymbol::addMember('%s') %s\n", sds.toChars(), ds.toChars());
        const m = this.sds.isModule();
        // Do not add the member to the symbol table,
        // just make sure subsequent debug declarations work.
        if (m === null) {
            error(dsy.loc, ds("%s `%s` declaration must be at module level"), dsy.kind(), dsy.toPrettyChars());
            dsy.errors = true;
        } else {
            if (m.debugidsNot !== null && findCondition(m.debugidsNot, dsy.ident!)) {
                error(dsy.loc, ds("%s `%s` defined after use"), dsy.kind(), dsy.toPrettyChars());
                dsy.errors = true;
            }
            if (m.debugids === null)
                m.debugids = new DArray<Identifier | null>();
            m.debugids.push(dsy.ident);
        }
    }

    override visitVersionSymbol(vs: VersionSymbol): void {
        //printf("VersionSymbol::addMember('%s') %s\n", sds.toChars(), vs.toChars());
        const m = this.sds.isModule();
        // Do not add the member to the symbol table,
        // just make sure subsequent debug declarations work.
        VersionCondition.checkReserved(vs.loc, vs.ident!.toString());
        if (m === null) {
            error(vs.loc, ds("%s `%s` declaration must be at module level"), vs.kind(), vs.toPrettyChars());
            vs.errors = true;
        } else {
            if (m.versionidsNot !== null && findCondition(m.versionidsNot, vs.ident!)) {
                error(vs.loc, ds("%s `%s` defined after use"), vs.kind(), vs.toPrettyChars());
                vs.errors = true;
            }
            if (m.versionids === null)
                m.versionids = new DArray<Identifier | null>();
            m.versionids.push(vs.ident);
        }
    }

    override visitNspace(ns: Nspace): void {
        this.visitDsymbol(ns);

        if (ns.members !== null) {
            if (ns.symtab === null)
                ns.symtab = new DsymbolTable();
            // The namespace becomes 'imported' into the enclosing scope
            // D `for (Scope* sce = sc; 1; sce = sce.enclosing)` — the `1` condition is an infinite
            // loop broken from inside (06 §2.5: an integral literal condition, `1 != 0`).
            for (let sce: Scope | null = this.sc; ; sce = sce!.enclosing) {
                const sds2 = sce!.scopesym;
                if (sds2 !== null) {
                    sds2.importScope(ns, new Visibility(Visibility.Kind.public_));
                    break;
                }
            }
            assert(this.sc !== null);
            this.sc = this.sc!.push(ns);
            // 11 §2.5 (paired state): plain finally; D pops once (dsymbolsem.d:6506), no early exit after the
            // push (:6502), and discards the pop's result (`sc` keeps naming the pushed scope).
            try {
                this.sc.linkage = LINK.cpp; // namespaces default to C++ linkage
                this.sc.parent = ns;
                foreachDsymbolVoid(ns.members, (s) => addMember(s, this.sc, ns));
            } finally {
                this.sc.pop();
            }
        }
    }

    override visitEnumDeclaration(ed: EnumDeclaration): void {
        // dropped: version (none) { printf("EnumDeclaration::addMember() …") } (dsymbolsem.d:6512-6520)
        if (!ed.isAnonymous()) {
            this.visitDsymbol(ed);
        }

        addEnumMembersToSymtab(ed, this.sc, this.sds);
    }
}

/*******************************************
 * dmd/dsymbolsem.d:6537 — Add members of EnumDeclaration to the symbol table(s).
 * Params:
 *      ed = EnumDeclaration
 *      sc = context of `ed`
 *      sds = symbol table that `ed` resides in
 */
export function addEnumMembersToSymtab(ed: EnumDeclaration, sc: Scope | null, sds: ScopeDsymbol): void {
    const isCEnum: boolean = sc!.inCfile; // it's an ImportC enum
    //printf("addEnumMembersToSymtab(ed: %s added: %d Cfile: %d)\n", ed.toChars(), ed.added, isCEnum);
    if (ed.added)
        return;
    ed.added = true;

    if (ed.members === null)
        return;

    const isAnon: boolean = ed.isAnonymous();

    if ((isCEnum || isAnon) && sds.symtab === null)
        sds.symtab = new DsymbolTable();

    if ((isCEnum || !isAnon) && ed.symtab === null)
        ed.symtab = new DsymbolTable();

    // The D delegate body uses bare `return;` -> the `void delegate` overload (dsymbol.d:94).
    foreachDsymbolVoid(ed.members, (s) => {
        const em = s.isEnumMember();
        if (em !== null) {
            //printf("adding EnumMember %s to %s %d\n", em.toChars(), ed.toChars(), isCEnum);
            em.ed = ed;
            if (isCEnum) {
                /* C doesn't add the enum member to the symbol table of the enum tag, it adds
                 * it to the symbol table that the tag is in. This is in contrast to D, where enum
                 * members become members of the enum tag. To accommodate this, we add
                 * the enum members to both symbol tables.
                 */
                addMember(em, sc, ed);   // add em to ed's symbol table
                if (em.errors)
                    return;
                addMember(em, sc, sds);  // add em to symbol table that ed is in
                em.parent = ed; // restore it after previous addMember() changed it
            } else {
                addMember(em, sc, isAnon ? sds : ed);
            }
        }
    });
}

/**
 * dmd/dsymbolsem.d:6583 — `private OverloadSet mergeOverloadSet(ScopeDsymbol sds, Identifier ident,`
 * `OverloadSet os, Dsymbol s)`. D module-private; reached by UFCS from `SearchVisitor` below
 * (`sds.mergeOverloadSet(ident, a, s)` -> `mergeOverloadSet(sds, ident, a, s)`, 04 §6).
 *
 * Merges `s` (or, when `s` is itself an overload set, each of its members) into `os`, creating `os`
 * on first use. Returns the (possibly new) overload set — never null.
 */
function mergeOverloadSet(sds: ScopeDsymbol, ident: Identifier, os: OverloadSet | null,
                          s: Dsymbol): OverloadSet {
    if (os === null) {
        os = new OverloadSet(ident);
        os.parent = sds;
    }
    const os2 = s.isOverloadSet();
    if (os2 !== null) {
        // Merge the cross-module overload set 'os2' into 'os'
        if (os.a.length === 0) {
            os.a.setDim(os2.a.length);
            // D `memcpy(os.a.tdata(), os2.a.tdata(), (os.a[0]).sizeof * os2.a.length)` copies CLASS
            // REFERENCES into a pre-sized array (08 §13 / 03 §1.1): element-wise reference copy, not a
            // byte blit — the pointees stay shared, exactly as in D.
            for (let i = 0; i < os2.a.length; i++)
                os.a.opIndexAssign(os2.a.opIndex(i), i);
        } else {
            for (let i = 0; i < os2.a.length; i++) {
                os = mergeOverloadSet(sds, ident, os, os2.a.opIndex(i)!);
            }
        }
        return os;
    }

    assert(s.isOverloadable());
    /* Don't add to os[] if s is alias of previous sym
     */
    for (let j = 0; j < os.a.length; j++) {
        const s2 = os.a.opIndex(j)!;
        if (toAlias(s) === toAlias(s2)) {
            // `s2.visible() < s.visible()` — Visibility opCmp (05 §3).
            if (s2.isDeprecated() ||
                (s2.visible().opCmp(s.visible()) < 0 && s.visible().kind !== Visibility.Kind.none)) {
                os.a.opIndexAssign(s, j);
            }
            return os;
        }
    }
    os.push(s);
    return os;
}

/***
 * dmd/dsymbolsem.d:6631 — Returns true if any of the symbols `p1` or `p2` resides in the enclosing
 * instantiation scope of `d`.
 */
export function followInstantiationContext(d: Dsymbol, p1: Dsymbol | null, p2: Dsymbol | null = null): boolean {
    // dmd/dsymbolsem.d:6633 — nested `static bool has2This(Dsymbol s)` (04 §5: inner const arrow).
    const has2This = (s: Dsymbol): boolean => {
        const f = s.isFuncDeclaration();
        if (f !== null)
            return f.hasDualContext;
        const ad = s.isAggregateDeclaration();
        if (ad !== null)
            return ad.vthis2 !== null;
        return false;
    };

    if (!has2This(d))
        return false;

    assert(p1 !== null);
    let outer = d.toParent();
    while (outer !== null) {
        const ti = outer.isTemplateInstance();
        if (ti === null)
            return false;
        for (const oarg of ti.tiargs!) {
            // dmd/dsymbolsem.d:6654 — `auto sa = getDsymbol(oarg);`; callee live at
            // dmd/expressionsem.d:5260 (`Dsymbol getDsymbol(RootObject oarg)`).
            let sa: Dsymbol | null = getDsymbol(oarg);
            if (sa === null)
                continue;
            sa = toAlias(sa).toParent2();
            if (sa === null)
                continue;
            if (sa === p1)
                return true;
            if (p2 !== null && sa === p2)
                return true;
        }
        outer = ti.tempdecl!.toParent();
    }
    return false;
}

/**
 * dmd/dsymbolsem.d:6675 — Returns the declaration scope of `d` unless any of the symbols
 * `p1` or `p2` resides in its enclosing instantiation scope, in which case the latter is returned.
 */
export function toParentP(d: Dsymbol, p1: Dsymbol | null, p2: Dsymbol | null = null): Dsymbol | null {
    return followInstantiationContext(d, p1, p2) ? d.toParent2() : d.toParentLocal();
}

/**
 * dmd/dsymbolsem.d:6681 — `void aliasSemantic(AliasDeclaration ds, Scope* sc)`.
 * Function used to perform semantic on AliasDeclaration.
 *
 * renamed: D parameter `ds` -> `dsym`. `ds` is the module's DString-literal helper (a djs runtime
 * name with no D counterpart) and a same-name parameter would shadow it for the whole body, leaving
 * the diagnostics below unable to build their format strings. Same shape as the local-shadow rename
 * at typesem.ts:6953.
 *
 * Postconditions: on every exit `dsym.inuse == 0`, `dsym.semanticRun == PASS.semanticdone`, and
 * `global.gag` is restored to its entry value (the D `Ungag` RAII guard -> try/finally, 06 §7.1).
 */
export function aliasSemantic(dsym: AliasDeclaration, sc: Scope): void {
    //printf("AliasDeclaration::semantic() %s %p\n", dsym.toChars(), dsym.aliassym);

    // as DsymbolSemanticVisitor::visit(AliasDeclaration), in case we're called first.
    // see https://issues.dlang.org/show_bug.cgi?id=21001
    dsym.storage_class = (dsym.storage_class | (sc.stc & STC.deprecated_)) as STC;
    dsym.visibility = sc.visibility.copy();          // Visibility is a value struct (03 §1 #5)
    dsym.userAttribDecl_set(sc.userAttribDecl);      // D `@property` setter pair (04 §9 / dsymbol.ts)

    // dmd/dsymbolsem.d:6691 — nested `void normalRet()`; a BAIL tail called as `return normalRet();`
    // (06 §4). Zero params — it captures `dsym` (never a positional parameter list).
    const normalRet = (): void => {
        dsym.inuse = 0;
        dsym.semanticRun = PASS.semanticdone;

        const sx = dsym.overnext;
        if (sx !== null) {
            dsym.overnext = null;
            if (!overloadInsert(dsym, sx))
                ScopeDsymbol.multiplyDefined(Loc.initial, sx, dsym);
        }
    };

    // dmd/dsymbolsem.d:6704 — nested `void errorRet()`; the error BAIL tail.
    const errorRet = (): void => {
        dsym.aliassym = null;
        dsym.type = Type.terror;
        dsym.inuse = 0;
        normalRet();
    };

    // preserve the original type
    if (dsym.originalType === null && dsym.type !== null)
        dsym.originalType = dsym.type.syntaxCopy();

    if (dsym.aliassym !== null) {
        const fd = dsym.aliassym.isFuncLiteralDeclaration();
        const td = dsym.aliassym.isTemplateDeclaration();
        if (fd !== null || td !== null && td.literal) {
            if (fd !== null && fd.semanticRun >= PASS.semanticdone)
                return normalRet();

            let e: Expression = new FuncExp(dsym.loc, dsym.aliassym);
            e = expressionSemantic(e, sc);
            const fe = e.isFuncExp();
            if (fe !== null) {
                dsym.aliassym = fe.td !== null ? fe.td : fe.fd;
                return normalRet();
            } else
                return errorRet();
        }

        if (dsym.aliassym.isTemplateInstance() !== null)
            dsymbolSemantic(dsym.aliassym, sc);
        return normalRet();
    }
    dsym.inuse = 1;

    // Given:
    //  alias foo.bar.abc def;
    // it is not knowable from the syntax whether `def` is an alias
    // for type `foo.bar.abc` or an alias for symbol `foo.bar.abc`. It is up to the semantic()
    // pass to distinguish.
    // If it is a type, then `.type` is set and getType() will return that
    // type. If it is a symbol, then `.aliassym` is set and type is `null` -
    // toAlias() will return `.aliassym`

    const errors = global.errors;
    // dmd/dsymbolsem.d:6752 `Type oldtype = ds.type;` — a DEAD local upstream (never read again).
    // Dropped rather than emitted: `noUnusedLocals` rejects it and there is no behaviour attached.

    // dmd/dsymbolsem.d:6755 `auto ungag = Ungag(global.gag);` — a D RAII value struct whose `~this`
    // restores `global.gag` on EVERY exit of this function. TS has no destructor: the guard becomes
    // an explicit save + `try { … } finally { … }` over the remainder (06 §7.1).
    const ungagSavedGag = global.gag;
    try {
        //printf("%s parent = %s, gag = %d, instantiated = %d\n", dsym.toChars(), dsym.parent.toChars(), global.gag, dsym.isInstantiated() !is null);
        if (dsym.parent !== null && global.gag !== 0 && dsym.isInstantiated() === null &&
            dsym.toParent2()!.isFuncDeclaration() === null && (sc.minst !== null || sc.tinst !== null)) {
            //printf("%s type = %s\n", dsym.toPrettyChars(), dsym.type.toChars());
            global.gag = 0;
        }

        // https://issues.dlang.org/show_bug.cgi?id=18480
        // Detect `alias sym = sym;` to prevent creating loops in overload overnext lists.
        const tident = dsym.type!.isTypeIdentifier();
        if (tident !== null) {
            if (sc.hasEdition(Edition.v2024) && tident.idents.length !== 0) {
                const mt = tident;                       // D `alias mt = tident;` (02 §5.3 rebind)
                const pscopesym: { value: Dsymbol | null } = { value: null };
                let s = searchScope(sc, dsym.loc, mt.ident!, pscopesym);
                // detect `alias a = var1.member_var;` which confusingly resolves to
                // `typeof(var1).member_var`, which can be valid inside the aggregate type
                if (s !== null && s.isVarDeclaration() !== null &&
                    mt.ident !== Id.This && mt.ident !== Id._super) {
                    s = toDsymbol(tident, sc);
                    // don't error for `var1.static_symbol`
                    if (s !== null && s.needThis()) {
                        error(dsym.loc, ds("cannot alias %s member `%s` of variable `%s`"),
                            s.kind(), s.toChars(), mt.ident!.toChars());
                        errorSupplemental(dsym.loc, ds("Use `typeof(%s)` instead to preserve behaviour"),
                            mt.ident!.toChars());
                    }
                }
            }
            // Selective imports are allowed to alias to the same name `import mod : sym=sym`.
            if (dsym._import === null) {
                if (tident.ident === dsym.ident && tident.idents.length === 0) {
                    error(dsym.loc,
                        ds("`alias %s = %s;` cannot alias itself, use a qualified name to create an overload set"),
                        dsym.ident!.toChars(), tident.ident!.toChars());
                    dsym.type = Type.terror;
                }
            }
        }
        /* This section is needed because Type.resolve() will:
         *   const x = 3;
         *   alias y = x;
         * try to convert identifier x to 3.
         */
        let s: Dsymbol | null = toDsymbol(dsym.type!, sc);
        if (errors !== global.errors)
            return errorRet();
        if (s === (dsym)) {
            error(dsym.loc, ds("%s `%s` cannot resolve"), dsym.kind(), dsym.toPrettyChars());
            return errorRet();
        }
        if (s === null || s.isEnumMember() === null) {
            let sc2 = sc;
            // D `out Expression e, out Type t, out Dsymbol s` -> boxes, reset on entry (03 §3.3).
            const pe: { value: Expression | null } = { value: null };
            const pt: { value: Type | null } = { value: null };
            const ps: { value: Dsymbol | null } = { value: s };
            // 11 §2.5 (paired state): plain finally with D's own condition; the push (dsymbolsem.d:6821) is
            // conditional and the single release `if (sc2 != sc) sc2.pop()` (:6826) has no early exit before it.
            try {
                if ((dsym.storage_class & (STC.ref_ | STC.nothrow_ | STC.nogc | STC.pure_ | STC.disable)) !== 0n) {
                    // For 'ref' to be attached to function types, and picked
                    // up by Type.resolve(), it has to go into sc.
                    sc2 = sc.push();
                    sc2.stc = (sc2.stc | (dsym.storage_class &
                        (STC.ref_ | STC.nothrow_ | STC.nogc | STC.pure_ | STC.shared_ | STC.disable))) as STC;
                }
                dsym.type = addSTC(dsym.type!, dsym.storage_class);
                typeResolve(dsym.type!, dsym.loc, sc2, pe, pt, ps);
            } finally {
                if (sc2 !== sc)
                    sc2.pop();
            }
            const e = pe.value;
            const t = pt.value;
            s = ps.value;

            if (e !== null) {  // Try to convert Expression to Dsymbol
                // TupleExp is naturally converted to a TupleDeclaration
                const te = e.isTupleExp();
                if (te !== null)
                    s = new TupleDeclaration(te.loc, dsym.ident!, te.exps);
                else {
                    // dmd/dsymbolsem.d:6836 — `s = getDsymbol(e);`; callee live at
                    // dmd/expressionsem.d:5260 (`Dsymbol getDsymbol(RootObject oarg)`).
                    s = getDsymbol(e);
                    if (s === null) {
                        if (e.op !== EXP.error)
                            error(dsym.loc, ds("%s `%s` cannot alias an expression `%s`"),
                                dsym.kind(), dsym.toPrettyChars(), e.toChars());
                        return errorRet();
                    }
                }
            }
            dsym.type = t;
        }
        if (s === (dsym)) {
            assert(global.errors !== 0);   // `assert(global.errors)` — uint in a boolean context (09 §9)
            return errorRet();
        }
        if (s !== null) { // it's a symbolic alias
            //printf("alias %s resolved to %s %s\n", dsym.toChars(), s.kind(), s.toChars());
            dsym.type = null;
            dsym.aliassym = s;
        } else {          // it's a type alias
            //printf("alias %s resolved to type %s\n", dsym.toChars(), dsym.type.toChars());
            dsym.type = typeSemantic(dsym.type!, dsym.loc, sc);
            dsym.aliassym = null;
        }

        if (global.gag !== 0 && errors !== global.errors)
            return errorRet();

        normalRet();
    } finally {
        // `~Ungag()` (dsymbolsem.d:1974) — restore the gag level saved at :6755.
        global.gag = ungagSavedGag;
    }
}

/********************
 * dmd/dsymbolsem.d:6875 — `private void aliasAssignSemantic(AliasAssign ds, Scope* sc)`.
 * Perform semantic on AliasAssignment.
 * Has a lot of similarities to aliasSemantic(). Perhaps they should share code.
 *
 * D module-private; driven from `DsymbolSemanticVisitor.visit(AliasAssign)` in this same module.
 *
 * renamed: D parameter `ds` -> `dsym`. `ds` is the module's DString-literal helper (a djs
 * runtime name with no D counterpart) and a same-name parameter would shadow it for the whole
 * body, leaving the diagnostics below unable to build their format strings. Same shape as the
 * local-shadow rename at typesem.ts:6953.
 */
function aliasAssignSemantic(dsym: AliasAssign, sc: Scope): void {
    //printf("AliasAssign::semantic() %p,  %s\n", dsym, dsym.identAssign.toChars());

    // dmd/dsymbolsem.d:6879 — nested `void errorRet()`; the error BAIL tail (06 §4).
    const errorRet = (): void => {
        dsym.errors = true;
        dsym.type = Type.terror;
        dsym.semanticRun = PASS.semanticdone;
        return;
    };

    /* dmd/dsymbolsem.d:6890 — nested `AliasDeclaration findAliasDeclaration(AliasAssign dsym, Scope* sc)`.
     * Find the AliasDeclaration corresponding to dsym.
     * Returns: AliasDeclaration if found, null if error
     */
    const findAliasDeclaration = (dsym: AliasAssign, sc: Scope): AliasDeclaration | null => {
        const scopesym: { value: Dsymbol | null } = { value: null };
        const as = searchScope(sc, dsym.loc, dsym.identAssign!, scopesym);
        if (as === null) {
            error(dsym.loc, ds("%s `%s` undefined identifier `%s`"),
                dsym.kind(), dsym.toPrettyChars(), dsym.identAssign!.toChars());
            return null;
        }
        if (as.errors)
            return null;

        const ad = as.isAliasDeclaration();
        if (ad === null) {
            error(dsym.loc, ds("%s `%s` identifier `%s` must be an alias declaration"),
                dsym.kind(), dsym.toPrettyChars(), as.toChars());
            return null;
        }

        if (ad.overnext !== null) {
            error(dsym.loc, ds("%s `%s` cannot reassign overloaded alias"), dsym.kind(), dsym.toPrettyChars());
            return null;
        }

        // Check constraints on the parent
        let adParent = ad.toParent();
        if (adParent !== dsym.toParent()) {
            if (adParent === null)
                adParent = dsym.toParent();
            error(dsym.loc, ds("`%s` must have same parent `%s` as alias `%s`"),
                dsym.identAssign!.toChars(), adParent!.toChars(), ad.toChars());
            return null;
        }
        if (adParent!.isTemplateInstance() === null) {
            error(dsym.loc, ds("%s `%s` must be a member of a template"), dsym.kind(), dsym.toPrettyChars());
            return null;
        }

        return ad;
    };

    const aliassym = findAliasDeclaration(dsym, sc);
    if (aliassym === null)
        return errorRet();

    if (aliassym.wasRead) {
        if (!aliassym.errors)
            error(dsym.loc, ds("%s was read, so cannot reassign"), aliassym.toChars());
        aliassym.errors = true;
        return errorRet();
    }

    aliassym.ignoreRead = true; // temporarilly allow reads of aliassym

    const storage_class = (sc.stc & (STC.deprecated_ | STC.ref_ | STC.nothrow_ | STC.nogc |
        STC.pure_ | STC.shared_ | STC.disable)) as STC;

    if (dsym.aliassym !== null) {
        const fd = dsym.aliassym.isFuncLiteralDeclaration();
        const td = dsym.aliassym.isTemplateDeclaration();
        if (fd !== null && fd.semanticRun >= PASS.semanticdone) {
            // (empty in D)
        } else if (fd !== null || td !== null && td.literal) {
            let e: Expression = new FuncExp(dsym.loc, dsym.aliassym);
            e = expressionSemantic(e, sc);
            const fe = e.isFuncExp();
            if (fe === null)
                return errorRet();
            dsym.aliassym = fe.td !== null ? fe.td : fe.fd;
        } else if (dsym.aliassym.isTemplateInstance() !== null)
            dsymbolSemantic(dsym.aliassym, sc);

        aliassym.type = null;
        aliassym.aliassym = dsym.aliassym;
        return;
    }

    /* Given:
     *    abc = def;
     * it is not knownable from the syntax whether `def` is a type or a symbol.
     * It appears here as `dsym.type`. Do semantic analysis on `def` to disambiguate.
     */

    const errors = global.errors;
    let s: Dsymbol | null = null;

    // dmd/dsymbolsem.d:6994 `goto Lsymdone;` / label `Lsymdone:` at :7055 — a SKIP-FLAG (06 §4.1):
    // the jump enters the `if (s)` arm past the whole type-resolution middle, which every other
    // path reaches by falling through. Every statement between goto site and label is gated.
    let gotoLsymdone = false;

    // Try AliasSeq optimization
    const ti0 = dsym.type !== null ? dsym.type.isTypeInstance() : null;
    if (ti0 !== null) {
        // dmd/dsymbolsem.d:6986-6987 — function-local `import dmd.templatesem : findTempDecl;`
        // then `findTempDecl(ti.tempinst, sc, null)` (hoisted, 01 §3). SWEPT: authorised by
        // dmd/templatesem.d:2055 `bool findTempDecl(TemplateInstance ti, Scope* sc,
        // WithScopeSymbol* pwithsym)`, live at templatesem.ts:2330. FAMILY: the same bare name
        // also exists at expressionsem.ts:1658 over a `DotTemplateInstanceExp` first parameter —
        // D's explicit `import dmd.templatesem` AND the `TemplateInstance` argument both select
        // the templatesem overload.
        if (!findTempDecl(ti0.tempinst!, sc, null))
            return errorRet();
        const tempinst = isAliasSeq(sc, ti0);
        if (tempinst !== null) {
            s = aliasAssignInPlace(sc, tempinst, aliassym);
            if (s === null)
                return errorRet();
            gotoLsymdone = true;   // goto Lsymdone; (dmd/dsymbolsem.d:6994)
        }
    }

    if (!gotoLsymdone) {
        /* This section is needed because Type.resolve() will:
         *   const x = 3;
         *   alias y = x;
         * try to convert identifier x to 3.
         */
        s = toDsymbol(dsym.type!, sc);
        if (errors !== global.errors)
            return errorRet();
        if (s === (aliassym)) {
            error(dsym.loc, ds("%s `%s` cannot resolve"), dsym.kind(), dsym.toPrettyChars());
            return errorRet();
        }

        if (s === null || s.isEnumMember() === null) {
            let sc2 = sc;
            const pe: { value: Expression | null } = { value: null };
            const pt: { value: Type | null } = { value: null };
            const ps: { value: Dsymbol | null } = { value: s };
            // 11 §2.5 (paired state): plain finally with D's own condition; the push (dsymbolsem.d:7021) is
            // conditional and the single release `if (sc2 != sc) sc2.pop()` (:7026) has no early exit before it.
            try {
                if ((storage_class & (STC.ref_ | STC.nothrow_ | STC.nogc | STC.pure_ | STC.shared_ | STC.disable))
                    !== 0n) {
                    // For 'ref' to be attached to function types, and picked
                    // up by Type.resolve(), it has to go into sc.
                    sc2 = sc.push();
                    sc2.stc = (sc2.stc | (storage_class &
                        (STC.ref_ | STC.nothrow_ | STC.nogc | STC.pure_ | STC.shared_ | STC.disable))) as STC;
                }
                dsym.type = addSTC(dsym.type!, storage_class);
                typeResolve(dsym.type!, dsym.loc, sc2, pe, pt, ps);
            } finally {
                if (sc2 !== sc)
                    sc2.pop();
            }
            const e = pe.value;
            const t = pt.value;
            s = ps.value;

            if (e !== null) {  // Try to convert Expression to Dsymbol
                // TupleExp is naturally converted to a TupleDeclaration
                const te = e.isTupleExp();
                if (te !== null)
                    s = new TupleDeclaration(te.loc, dsym.identAssign!, te.exps);
                else {
                    // dmd/dsymbolsem.d:7036 — `s = getDsymbol(e);`; callee live at
                    // dmd/expressionsem.d:5260 (`Dsymbol getDsymbol(RootObject oarg)`).
                    s = getDsymbol(e);
                    if (s === null) {
                        if (e.op !== EXP.error)
                            error(dsym.loc, ds("%s `%s` cannot alias an expression `%s`"),
                                dsym.kind(), dsym.toPrettyChars(), e.toChars());
                        return errorRet();
                    }
                }
            }
            dsym.type = t;
        }
        if (s === (aliassym)) {
            assert(global.errors !== 0);
            return errorRet();
        }
    }

    if (gotoLsymdone || s !== null) { // it's a symbolic alias
        // Lsymdone:  (dmd/dsymbolsem.d:7055)
        //printf("alias %s resolved to %s %s\n", toChars(), s.kind(), s.toChars());
        aliassym.type = null;
        aliassym.aliassym = s;
        aliassym.storage_class = (aliassym.storage_class | (sc.stc & STC.deprecated_)) as STC;
        aliassym.visibility = sc.visibility.copy();      // value struct (03 §1 #5)
        aliassym.userAttribDecl_set(sc.userAttribDecl);
    } else {          // it's a type alias
        //printf("alias %s resolved to type %s\n", toChars(), type.toChars());
        aliassym.type = typeSemantic(dsym.type!, dsym.loc, sc);
        aliassym.aliassym = null;
    }

    aliassym.ignoreRead = false;

    if (aliassym.type !== null && aliassym.type.ty === TY.Terror ||
        global.gag !== 0 && errors !== global.errors) {
        aliassym.type = Type.terror;
        aliassym.aliassym = null;
        return errorRet();
    }

    dsym.semanticRun = PASS.semanticdone;
}

/***************************************
 * dmd/dsymbolsem.d:7092 — `private TupleDeclaration aliasAssignInPlace(Scope* sc,`
 * `TemplateInstance tempinst, AliasDeclaration aliassym)`.
 *
 * Expands template instance arguments inside 'alias assign' target declaration (aliassym),
 * instead of inside 'tempinst.tiargs' every time.
 * Params:
 *      tempinst = AliasSeq instance
 *      aliassym = the AliasDeclaration corresponding to AliasAssign
 * Returns:
 *       null on error, else the built/extended TupleDeclaration.
 */
function aliasAssignInPlace(sc: Scope, tempinst: TemplateInstance,
                            aliassym: AliasDeclaration): TupleDeclaration | null {
    // Mark instance with semantic done, not needed but just in case.
    tempinst.inst = tempinst;
    tempinst.semanticRun = PASS.semanticdone;
    let td: TupleDeclaration | null = null;
    if (aliassym.type !== null) {
        // Convert TypeTuple to TupleDeclaration to avoid back and forth allocations
        // in the assignment process
        const tt = aliassym.type.isTypeTuple();
        if (tt !== null) {
            const objs: Objects = new DArray<RootObject | null>(tt.arguments!.length);
            // D `foreach (i, p; *tt.arguments)` — the container has no `.entries()`, so the
            // index form is the plain counter `for` (06 §1.2/§1.6).
            for (let i = 0; i < tt.arguments!.length; i++) {
                const pa = tt.arguments!.opIndex(i)!;
                objs.opIndexAssign(pa.type, i);
            }
            td = new TupleDeclaration(tempinst.loc, aliassym.ident!, objs);
            td.storage_class = (td.storage_class | STC.templateparameter) as STC;
            td.building = true;
            aliassym.type = null;
        } else if (aliassym.type.isTypeError() !== null)
            return null;
    } else {
        const otd = aliassym.aliassym!.isTupleDeclaration();
        if (otd !== null) {
            if (otd.building)
                td = otd;
            else {
                td = new TupleDeclaration(tempinst.loc, aliassym.ident!, otd.objects!.copy());
                td.storage_class = (td.storage_class | STC.templateparameter) as STC;
                td.building = true;
            }
        }
    }
    // If starting from single element in aliassym (td == null) we need to build the tuple
    // after semanticTiargs to keep same semantics (for example a FuncLiteraldeclaration
    // template argument is converted to FuncExp)
    if (td !== null)
        aliassym.aliassym = td;
    aliassym.semanticRun = PASS.semanticdone;
    // dmd/dsymbolsem.d:7134 — SWEPT: authorised by dmd/templatesem.d:5393
    // `bool TemplateInstance_semanticTiargs(Loc loc, Scope* sc, Objects* tiargs, int flags,
    // TupleDeclaration atd = null)`, live at templatesem.ts:5748.
    if (!TemplateInstance_semanticTiargs(tempinst.loc, sc, tempinst.tiargs, 0, td)) {
        tempinst.errors = true;
        return null;
    }
    // The alias will stop tuple 'building' mode when used (in AliasDeclaration.toAlias(),
    // then TupleDeclaration.getType() will work again)
    aliassym.semanticRun = PASS.initial;
    if (td === null) {
        td = new TupleDeclaration(tempinst.loc, aliassym.ident!, tempinst.tiargs);
        td.storage_class = (td.storage_class | STC.templateparameter) as STC;
        td.building = true;
        return td;
    }

    const tiargs = tempinst.tiargs!;
    const oldlen = td.objects!.length;
    let origstart = 0;
    let insertidx = 0;
    let insertlen = 0;
    for (let i = 0; i < tiargs.length; i++) {
        const o = tiargs.opIndex(i);
        if (o !== (td)) {
            ++insertlen;
            continue;
        }
        // tuple contains itself (tuple = AliasSeq!(..., tuple, ...))
        if (insertlen !== 0) { // insert any left element before
            td.objects!.insert(insertidx, tiargs.opSlice(i - insertlen, i));
            if (insertidx === 0) // reset original tuple start point
                origstart = insertlen;
            insertlen = 0;
        }
        if (insertidx !== 0) { // insert tuple if found more than one time
            td.objects!.reserve(oldlen); // reserve first to assert a valid slice
            td.objects!.pushSlice(td.objects!.opSlice(origstart, origstart + oldlen));
        }
        insertidx = td.objects!.length;
    }
    if (insertlen !== 0) {
        if (insertlen !== tiargs.length) // insert any left element
            td.objects!.pushSlice(tiargs.opSlice(tiargs.opDollar() - insertlen, tiargs.opDollar()));
        else
            // just assign tiargs if tuple = AliasSeq!(nottuple, nottuple...)
            td.objects = tempinst.tiargs;
    }
    return td;
}

/*********************************
 * dmd/dsymbolsem.d:7200 — `int apply(Dsymbol symbol, int function(Dsymbol, void*) fp, void* ctx)`.
 * Iterate this dsymbol or members of this scoped dsymbol, then call `fp` with the found symbol.
 *
 * The D `void* ctx` is PRESERVED as `unknown` (02 §10): a free function's protocol is ported 1:1
 * (04 §0.1), and D's own callers pass a real context (`cast(void*) ad` at dsymbolsem.d:7285/:7327,
 * `null` at :9805/:9843 and expressionsem.d:19641). The `static` D callbacks read their context out
 * of this parameter; the port's callbacks are nested arrows that CAPTURE it instead (04 §5), so
 * they name the parameter `_ctx` and ignore it — the protocol still matches for outside callers.
 *
 * Params:
 *  symbol = the dsymbol or parent of members to call fp on
 *  fp = callback to process the iterated symbol. If it returns nonzero, the iteration is aborted.
 *  ctx = context parameter passed to fp.
 * Returns:
 *  nonzero if the iteration is aborted by the return value of fp, or 0 if it's completed.
 */
export function apply(symbol: Dsymbol, fp: (s: Dsymbol, ctx: unknown) => number, ctx: unknown): number {
    const nd = symbol.isNspace();
    if (nd !== null) {
        // D `s && s.apply(fp, ctx)` is a bool-valued `&&` implicitly converted to the delegate's
        // `int` return (09 §9 / 06 §2.5): non-null AND non-zero -> 1, else 0.
        return foreachDsymbol(nd.members, (s) => (s !== null && apply(s, fp, ctx) !== 0) ? 1 : 0);
    }
    const ad = symbol.isAttribDeclaration();
    if (ad !== null) {
        return foreachDsymbol(include(ad, ad._scope),
            (s) => (s !== null && apply(s, fp, ctx) !== 0) ? 1 : 0);
    }
    const tm = symbol.isTemplateMixin();
    if (tm !== null) {
        if (tm._scope !== null) // if fwd reference
            dsymbolSemantic(tm, null); // try to resolve it

        return foreachDsymbol(tm.members, (s) => (s !== null && apply(s, fp, ctx) !== 0) ? 1 : 0);
    }

    return fp(symbol, ctx);
}

/***************************************
 * dmd/dsymbolsem.d:7226 — `private TemplateInstance isAliasSeq(Scope* sc, TypeInstance ti)`.
 * Check if a template instance is a trivial AliasSeq but without other overloads.
 * We can only be 100% sure of being AliasSeq after running semanticTiargs()
 * and findBestMatch() but this optimization must happen before that.
 */
function isAliasSeq(sc: Scope, ti: TypeInstance): TemplateInstance | null {
    void sc; // D's `sc` is unused in the body (kept: it is part of the D signature, 04 §0.1)
    const tovers = ti.tempinst!.tempdecl!.isOverloadSet();
    for (let oi = 0; oi < (tovers !== null ? tovers.a.length : 1); oi++) {
        const dstart = tovers !== null ? tovers.a.opIndex(oi)! : ti.tempinst!.tempdecl!;
        // dmd/dsymbolsem.d:7232 — SWEPT: authorised by dmd/funcsem.d:4084 `extern (D) int
        // overloadApply(Dsymbol fstart, scope int delegate(Dsymbol) dg, Scope* sc = null)`,
        // live at funcsem.ts:4197.
        const r = overloadApply(dstart, (s: Dsymbol) => {
            const td = s.isTemplateDeclaration();
            return (td !== null && td.isTrivialAliasSeq) ? 0 : 1;
        });
        if (r !== 0)
            return null;
    }
    return ti.tempinst;
}

/***************************************
 * dmd/dsymbolsem.d:7256 — `bool determineFields(AggregateDeclaration ad)`.
 * Find all instance fields in `ad`, then push them into `fields`.
 *
 * Runs semantic() for all instance field variables, but also
 * the field types can remain yet not resolved forward references,
 * except direct recursive definitions.
 * After the process sizeok is set to Sizeok.fwd.
 *
 * Params:
 *      ad = the AggregateDeclaration to examine
 * Returns:
 *      false if any errors occur.
 */
export function determineFields(ad: AggregateDeclaration): boolean {
    if (ad._scope !== null)
        dsymbolSemantic(ad, null);
    // 02 §11.4: `ad.sizeok` is mutated behind every call below (dsymbolSemantic here, `apply(func)`
    // later), so each test group re-reads it into a fresh explicitly-typed const.
    const sizeok0: Sizeok = ad.sizeok;
    if (sizeok0 !== Sizeok.none)
        return true;

    //printf("determineFields() %s, fields.length = %d\n", toChars(), fields.length);
    // determineFields can be called recursively from one of the fields's v.semantic
    ad.fields.setDim(0);

    // dmd/dsymbolsem.d:7267 — nested `static int func(Dsymbol s, void* ctx)`, where D's first
    // statement is `auto ad = cast(AggregateDeclaration)ctx;`. As a nested arrow it CAPTURES `ad`
    // (04 §5) and ignores the context parameter, which `apply`'s protocol still carries (04 §0.1).
    // It is self-recursive through `apply`, so it is declared as a `const` with an explicit type.
    const func: (s: Dsymbol, _ctx: unknown) => number = (s: Dsymbol, _ctx: unknown): number => {
        const v = s.isVarDeclaration();
        if (v === null)
            return 0;
        if ((v.storage_class & STC.manifest) !== 0n)
            return 0;

        if (v.semanticRun < PASS.semanticdone)
            dsymbolSemantic(v, null);
        // Return in case a recursive determineFields triggered by v.semantic already finished
        const sizeokAfterVar: Sizeok = ad.sizeok;   // 02 §11.4 re-read after the mutating call
        if (sizeokAfterVar !== Sizeok.none)
            return 1;

        if (v.aliasTuple !== null) {
            // If this variable was really a tuple, process each element.
            return v.aliasTuple.foreachVarFromIntDelegate((tv) => apply(tv, func, ad));
        }

        if ((v.storage_class & (STC.static_ | STC.extern_ | STC.tls | STC.gshared | STC.manifest |
                                STC.ctfe | STC.templateparameter)) !== 0n)
            return 0;
        if (!v.isField() || v.semanticRun < PASS.semanticdone)
            return 1;   // unresolvable forward reference

        ad.fields.push(v);

        if ((v.storage_class & STC.ref_) !== 0n)
            return 0;
        const tv = baseElemOf(v.type!);
        const tvs = tv.isTypeStruct();
        if (tvs !== null) {
            if (ad === tvs.sym) {
                if (ad.type!.ty === TY.Terror || ad.errors)
                    return 1;   // failed already

                const psz: DString = (toBasetype(v.type!).ty === TY.Tsarray)
                    ? ds("static array of ") : ds("");
                if (!v.isAnonymous())
                    error(v.loc, ds("%s `%s` cannot have field `%s` with %ssame struct type"),
                        ad.kind(), ad.toPrettyChars(), v.toChars(), psz);
                else
                    error(v.loc, ds("%s `%s` cannot have anonymous field with %ssame struct type"),
                        ad.kind(), ad.toPrettyChars(), psz);
                // Don't cache errors from speculative semantic
                if (global.gag === 0) {
                    ad.type = Type.terror;
                    ad.errors = true;
                }
                return 1;
            }
        }
        return 0;
    };

    if (ad.members !== null) {
        for (let i = 0; i < ad.members.length; i++) {
            const s = ad.members.opIndex(i)!;
            // D: `s.apply(&func, cast(void *)ad)` (dsymbolsem.d:7327) — UFCS (04 §6).
            if (apply(s, func, ad) !== 0) {
                const sizeokAfterApply: Sizeok = ad.sizeok;   // 02 §11.4 re-read
                if (sizeokAfterApply !== Sizeok.none) {
                    // recursive determineFields already finished
                    return true;
                }
                return false;
            }
        }
    }

    const sizeokFinal: Sizeok = ad.sizeok;   // 02 §11.4 re-read after the member walk
    if (sizeokFinal !== Sizeok.done)
        ad.sizeok = Sizeok.fwd;

    return true;
}

// dmd/dsymbolsem.d:7352 / :7366 / :7379 — three `__gshared` locals. A D `__gshared` declared INSIDE a
// function is process-global storage, not a local: it lives at module scope here (01 §5), starts
// null, and is filled lazily by `loadModuleFromLibrary` through its `ref` parameter (03 §3.2).
let core_stdc_config: Module | null = null;
let core_atomic: Module | null = null;
let std_math: Module | null = null;

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`). The three library-module singletons above point into the finished compile's module
 * table (a later compile resolving `std.math.pow` through them reads the old module), and the two
 * function-static recursion counters (`runDeferredSemantic`'s `nested`, `visit(TemplateMixin)`'s `nest`) stay
 * raised after a compile stopped by `fatal()`.
 */
export function resetDsymbolsemState(): void {
    core_stdc_config = null;
    core_atomic = null;
    std_math = null;
    runDeferredSemanticNested = 0;
    templateMixinNest = 0;
}

/****************************
 * dmd/dsymbolsem.d:7350 — A Singleton that loads core.stdc.config
 * Returns:
 *  Module of core.stdc.config, null if couldn't find it
 */
export function loadCoreStdcConfig(): Module | null {
    // D `auto pkgids = new Identifier[2];` — a raw D array (02 §8), NOT an `arraytypes.d` alias, so
    // its element type is decided here: every slot is written before the array escapes, and
    // `loadModuleFromLibrary` / `Module.load` both take `Identifier[]` (dmodule.ts:593).
    const pkgids: Identifier[] = new globalThis.Array<Identifier>(2);
    pkgids[0] = Id.core!;
    pkgids[1] = Id.stdc!;
    // `ref Module mod` -> a one-slot box over the module-level singleton (03 §3.2/§7.2); the
    // callee writes through it, so the slot is copied back on return.
    const modRef: { value: Module | null } = { value: core_stdc_config };
    const r = loadModuleFromLibrary(modRef, pkgids, Id.config!);
    core_stdc_config = modRef.value;
    return r;
}

/****************************
 * dmd/dsymbolsem.d:7364 — `private Module loadCoreAtomic()`. A Singleton that loads core.atomic.
 * D module-private (only `doAtomicOp` below uses it).
 * Returns:
 *  Module of core.atomic, null if couldn't find it
 */
function loadCoreAtomic(): Module | null {
    const pkgids: Identifier[] = new globalThis.Array<Identifier>(1);
    pkgids[0] = Id.core!;
    const modRef: { value: Module | null } = { value: core_atomic };
    const r = loadModuleFromLibrary(modRef, pkgids, Id.atomic!);
    core_atomic = modRef.value;
    return r;
}

/****************************
 * dmd/dsymbolsem.d:7377 — A Singleton that loads std.math
 * Returns:
 *  Module of std.math, null if couldn't find it
 */
export function loadStdMath(): Module | null {
    const pkgids: Identifier[] = new globalThis.Array<Identifier>(1);
    pkgids[0] = Id.std!;
    const modRef: { value: Module | null } = { value: std_math };
    const r = loadModuleFromLibrary(modRef, pkgids, Id.math!);
    std_math = modRef.value;
    return r;
}

/**********************************
 * dmd/dsymbolsem.d:7394 — `extern (D) private static Module loadModuleFromLibrary(ref Module mod,`
 * `Identifier[] pkgids, Identifier modid)`. Load a Module from the library.
 *
 * `static` on a module-level D function is a no-op storage class; it erases (04 §8).
 *
 * Params:
 *  mod = cached return value of this call — a `ref` parameter, so it is the one-slot box (03 §3.2)
 *  pkgids = package identifiers
 *  modid = module id
 * Returns:
 *  Module loaded, null if cannot load it
 */
function loadModuleFromLibrary(mod: { value: Module | null }, pkgids: Identifier[],
                               modid: Identifier): Module | null {
    if (mod.value !== null)
        return mod.value;

    // D `pkgids[]` is the whole-slice expression of the array parameter — the array itself (02 §8).
    const imp = new Import(Loc.initial, pkgids, modid, null, 1);
    // Module.load will call fatal() if there's no module available.
    // Gag the error here, pushing the error handling to the caller.
    const errors = global.startGagging();
    // 11 §2.5 (protect paired state): `load`/`importAll`/`dsymbolSemantic` all reach walls in this
    // port, and `global.gag` is process state — a throw that skipped `endGagging` would swallow
    // every later diagnostic in the run. D needs no guard here.
    try {
        load(imp, null);
        if (imp.mod !== null) {
            // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
            importAll(imp.mod as unknown as Dsymbol, null);
            dsymbolSemantic(imp.mod as unknown as Dsymbol, null);
        }
    } finally {
        global.endGagging(errors);
    }
    mod.value = imp.mod;
    return mod.value;
}

/**
 * dmd/dsymbolsem.d:7415 — `private CallExp doAtomicOp (string op, Identifier var, Expression arg)`.
 * Do an atomic operation (currently tailored to [shared] static ctors|dtors).
 *
 * D module-private; the single call site is `visitStaticCDtorDeclaration` (dsymbolsem.d:4513),
 * which passes the literal `"-="` or `"+="` — a D `string`, i.e. a `DString` here (08 §11).
 *
 * Returns: the built `atomicOp!op(var, arg)` call, or null when core.atomic cannot be loaded.
 */
function doAtomicOp(op: DString, var_: Identifier, arg: Expression): CallExp | null {
    assert(dsEquals(op, ds("-=")) || dsEquals(op, ds("+=")));

    const mod = loadCoreAtomic();
    if (mod === null)
        return null;    // core.atomic couldn't be loaded

    const loc = Loc.initial;

    const tiargs: Objects = new DArray<RootObject | null>(1);
    // D `new StringExp(loc, op)` binds the `const(void)[]` ctor — the byte payload of the literal.
    tiargs.opIndexAssign(new StringExp(loc, globalThis.Array.from(op)), 0);

    const args: Expressions = new DArray<Expression | null>(2);
    args.opIndexAssign(new IdentifierExp(loc, var_), 0);
    args.opIndexAssign(arg, 1);

    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    const sc = new ScopeExp(loc, mod as unknown as ScopeDsymbol);
    // D's `(Loc, Expression, Identifier, Objects*)` ctor -> the port's named factory (04 §1.1(c)).
    const dti = DotTemplateInstanceExp.fromName(loc, sc, Id.atomicOp, tiargs);

    return CallExp.create(loc, dti, args);
}

/***************************************************
 * dmd/dsymbolsem.d:7450 — `void adjustLocForMixin(const(char)[] input, Loc loc, ref BaseLoc baseLoc,`
 * `ref Output mixinOut)`.
 *
 * Set up loc for a parse of a mixin. Append the input text to the mixin.
 * Params:
 *      input = mixin text
 *      loc = location of expansion
 *      baseLoc = location to adjust — a `ref` value struct: the object itself, mutated in place (03 §3.2)
 *      mixinOut = sink for mixin text data — likewise a `ref` alias
 */
export function adjustLocForMixin(input: DString, loc: Loc, baseLoc: BaseLoc, mixinOut: Output): void {
    if (mixinOut.doOutput) {
        const lines = mixinOut.bufferLines;
        // `ref int lines` -> one-slot box, written back into the field it aliases (03 §3.2/§7.2).
        const linesRef: { value: number } = { value: mixinOut.bufferLines };
        writeMixin(input, loc, linesRef, mixinOut.buffer!);
        mixinOut.bufferLines = linesRef.value;
        baseLoc.startLine = lines + 2;
        baseLoc.filename = mixinOut.name!;
        return;
    }

    const sl = SourceLoc.fromLoc(loc);       // D `SourceLoc sl = SourceLoc(loc)` -> named factory
    if (sl.filename.length === 0) {
        // Rare case of compiler-generated mixin exp, e.g. __xtoHash
        baseLoc.filename = ds("");
        return;
    }

    /* Create a pseudo-filename for the mixin string, as it may not even exist
     * in the source file.
     */
    // erased: the `len` sizing + `mem.xmalloc` + `snprintf` (dsymbolsem.d:7472-7474). `dmdformat`
    // allocates its own exactly-sized buffer (08 §13, 10 §3.5); the `cast(int)` narrowings of the
    // length/linnum arguments are C-variadic promotions with no TS counterpart.
    const filename = dmdformat(ds("%.*s-mixin-%d"), [sl.filename.length, sl.filename, sl.linnum]);
    baseLoc.startLine = sl.line;
    baseLoc.filename = filename;
}

/**************************************
 * dmd/dsymbolsem.d:7488 — `private void writeMixin(const(char)[] s, Loc loc, ref int lines,`
 * `ref OutBuffer buf)`. Append source code text to output for better debugging.
 * Canonicalize line endings. D module-private.
 * Params:
 *      s = source code text
 *      loc = location of source code text
 *      lines = line count to update — a `ref int`, so the one-slot box (03 §3.2)
 *      output = sink for output — a `ref` alias to the buffer object
 */
function writeMixin(s: DString, loc: Loc, lines: { value: number }, buf: OutBuffer): void {
    buf.writestring(ds("// expansion at "));
    // dsymbolsem.d:7491 `writestring(const(char)*)`: the bytes before the NUL
    buf.writestring(cstr(loc.toChars()));
    buf.writenl();

    ++lines.value;

    // write by line to create consistent line endings
    let lastpos = 0;
    for (let i = 0; i < s.length; ++i) {
        // detect LF and CRLF
        const c = s[i];
        if (c === 0x0a /* '\n' */ || (c === 0x0d /* '\r' */ && i + 1 < s.length && s[i + 1] === 0x0a)) {
            buf.writestring(s.subarray(lastpos, i));
            buf.writenl();
            ++lines.value;
            if (c === 0x0d)
                ++i;
            lastpos = i + 1;
        }
    }

    if (lastpos < s.length)
        buf.writestring(s.subarray(lastpos));

    if (s.length === 0 || s[s.length - 1] !== 0x0a)  {
        buf.writenl(); // ensure empty line after expansion
        ++lines.value;
    }
    buf.writenl();
    ++lines.value;
}

/*********************************************
 * dmd/dsymbolsem.d:7535 — `Dsymbol search(Dsymbol d, Loc loc, Identifier ident,`
 * `SearchOptFlags flags = SearchOpt.all)`. Search for `ident` as member of `d`.
 *
 * D calls this via UFCS (`d.search(loc, ident, flags)`); the port keeps it a free function and
 * rewrites every call site to `search(d, loc, ident, flags)` (04 §6). Name PINNED (typesem.ts and
 * the sema test suites import this exact spelling); the `Scope`-receiver overload that D also
 * declares in this module is `searchScope` (04 §1B / 04 §6.1).
 *
 * Params:
 *  d = dsymbol where ident is searched for
 *  loc = location to print for error messages
 *  ident = identifier to search for
 *  flags = search options
 * Returns:
 *  null if not found
 */
export function search(d: Dsymbol, loc: Loc, ident: Identifier,
                       flags: SearchOptFlags = SearchOpt.all): Dsymbol | null {
    const v = new SearchVisitor(loc, ident, flags);
    d.accept(v);
    return v.result;
}

/*********************************************
 * dmd/dsymbolsem.d:7542 — `Dsymbol search_correct(Dsymbol d, Identifier ident)`. After a failed
 * member lookup, find a member of `d` with a close spelling ("did you mean"). Name PINNED; the
 * `Scope`-receiver overload is `search_correctScope`.
 */
export function search_correct(d: Dsymbol, ident: Identifier): Dsymbol | null {
    /***************************************************
     * dmd/dsymbolsem.d:7547 — nested `Dsymbol symbol_search_fp(const(char)[] seed, out int cost)`:
     * the speller's probe. `out int cost` -> the one-slot box (03 §3.3).
     * Search for symbol with correct spelling.
     */
    const symbol_search_fp = (seed: DString, cost: { value: number }): Dsymbol | null => {
        /* If not in the lexer's string table, it certainly isn't in the symbol table.
         * Doing this first is a lot faster.
         */
        if (!seed.length)
            return null;
        const id = Identifier.lookup(seed);
        if (id === null)
            return null;
        cost.value = 0;   // all the same cost
        const s: Dsymbol = d;
        Module.clearCache();
        return search(s, Loc.initial, id, SearchOpt.ignoreErrors);
    };

    if (global.gag !== 0)
        return null; // don't do it for speculative compiles; too time consuming
    // search for exact name first
    {
        const s = search(d, Loc.initial, ident, SearchOpt.ignoreErrors);
        if (s !== null)
            return s;
    }

    // dmd/dsymbolsem.d:7569 — function-local `import dmd.root.speller : speller;` (hoisted, 01 §3).
    return speller<Dsymbol>(ident.toString(), symbol_search_fp);
}

/***********************************************************
 * dmd/dsymbolsem.d:7573 — `private extern(C++) class SearchVisitor : Visitor`.
 * 13 §1: `alias visit = Visitor.visit;` dropped. D module-private; emitted without `private`.
 */
class SearchVisitor extends Visitor {
    readonly loc: Loc;
    ident: Identifier;
    flags: SearchOptFlags;
    result: Dsymbol | null = null;

    constructor(loc: Loc, ident: Identifier, flags: SearchOptFlags) {
        super();
        this.loc = loc;
        this.ident = ident;
        this.flags = flags;
    }

    /// dmd/dsymbolsem.d:7589 — the single write-point for `result`; every arm ends `return setResult(x)`.
    setResult(d: Dsymbol | null): void {
        this.result = d;
    }

    override visitDsymbol(_d: Dsymbol): void {
        //printf("Dsymbol::search(this=%p,%s, ident='%s')\n", d, d.toChars(), ident.toChars());
        return this.setResult(null);
    }

    override visitScopeDsymbol(sds: ScopeDsymbol): void {
        //printf("%s.ScopeDsymbol::search(ident='%s', flags=x%x)\n", sds.toChars(), ident.toChars(), flags);
        //if (strcmp(ident.toChars(),"c") == 0) *(char*)0=0;

        // Look in symbols declared in this module
        if (sds.symtab !== null && !(this.flags & SearchOpt.importsOnly)) {
            //printf(" look in locals\n");
            const s1 = sds.symtab.lookup(this.ident);
            if (s1 !== null) {
                //printf("\tfound in locals = '%s.%s'\n",toChars(),s1.toChars());
                return this.setResult(s1);
            }
        }
        //printf(" not found in locals\n");

        // Look in imported scopes
        if (sds.importedScopes === null)
            return this.setResult(null);

        //printf(" look in imports\n");
        let s: Dsymbol | null = null;
        let a: OverloadSet | null = null;
        // Look in imported modules
        for (let i = 0; i < sds.importedScopes.length; i++) {
            // If private import, don't search it
            if ((this.flags & SearchOpt.ignorePrivateImports) &&
                sds.visibilities![i] === Visibility.Kind.private_)
                continue;
            // remember these in recursive searches
            let sflags: SearchOptFlags = this.flags & (SearchOpt.ignoreErrors | SearchOpt.ignoreAmbiguous);
            const ss = sds.importedScopes.opIndex(i)!;
            //printf("\tscanning import '%s', visibilities = %d, isModule = %p, isImport = %p\n", ss.toChars(), visibilities[i], ss.isModule(), ss.isImport());

            if (ss.isModule() !== null) {
                if (this.flags & SearchOpt.localsOnly)
                    continue;
            } else { // mixin template
                if (this.flags & SearchOpt.importsOnly)
                    continue;

                sflags |= SearchOpt.localsOnly;
            }

            /* Don't find private members if ss is a module
             */
            let s2 = search(ss, this.loc, this.ident,
                sflags | (ss.isModule() !== null ? SearchOpt.ignorePrivateImports : SearchOpt.all));
            // dmd/dsymbolsem.d:7651 — function-local `import dmd.access : symbolIsVisible;`
            // (hoisted, 01 §3). The `(Dsymbol origin, Dsymbol s)` arm of that D overload set is
            // `symbolIsVisibleDsymbol` in access.ts (04 §1B).
            if (K.on && s2 !== null) keepImportFound(sds, i, s2);   // the kept-module engine: which scope found it
            if (s2 === null || !(this.flags & SearchOpt.ignoreVisibility) && !symbolIsVisibleDsymbol(sds, s2))
                continue;
            if (s === null) {
                s = s2;
                if (s !== null && s.isOverloadSet() !== null)
                    a = mergeOverloadSet(sds, this.ident, a, s);
            } else if (s2 !== null && s !== s2) {
                if (toAlias(s) === toAlias(s2) ||
                    getType(s) === getType(s2) && getType(s) !== null) {
                    /* After following aliases, we found the same
                     * symbol, so it's not an ambiguity.  But if one
                     * alias is deprecated or less accessible, prefer
                     * the other.
                     */
                    if (s.isDeprecated() ||
                        s.visible().opCmp(s2.visible()) < 0 && s2.visible().kind !== Visibility.Kind.none)
                        s = s2;
                } else {
                    /* Two imports of the same module should be regarded as
                     * the same.
                     */
                    const i1 = s.isImport();
                    const i2 = s2.isImport();
                    if (!(i1 !== null && i2 !== null && (i1.mod === i2.mod ||
                          (i1.parent!.isImport() === null && i2.parent!.isImport() === null &&
                           i1.ident!.equals(i2.ident))))) {
                        /* https://issues.dlang.org/show_bug.cgi?id=8668
                         * Public selective import adds AliasDeclaration in module.
                         * To make an overload set, resolve aliases in here and
                         * get actual overload roots which accessible via s and s2.
                         */
                        s = toAlias(s);
                        s2 = toAlias(s2);
                        /* If both s2 and s are overloadable (though we only
                         * need to check s once)
                         */

                        const so2 = s2.isOverloadSet();
                        if ((so2 !== null || s2.isOverloadable()) && (a !== null || s.isOverloadable())) {
                            if (symbolIsVisibleDsymbol(sds, s2)) {
                                a = mergeOverloadSet(sds, this.ident, a, s2);
                            }
                            if (!symbolIsVisibleDsymbol(sds, s))
                                s = s2;
                            continue;
                        }

                        /* Two different overflow sets can have the same members
                         * https://issues.dlang.org/show_bug.cgi?id=16709
                         */
                        const so = s.isOverloadSet();
                        if (so !== null && so2 !== null) {
                            if (so.a.length === so2.a.length) {
                                // dmd/dsymbolsem.d:7715 `goto L1;` / label `L1:` at :7718 — a
                                // SKIP-FLAG (06 §4/§4.1): the jump leaves the compare loop and skips
                                // the `continue` that treats the two sets as identical. The label's
                                // own body is empty (`{ } // different`).
                                let gotoL1 = false;
                                for (let j = 0; j < so.a.length; j++) {
                                    if (so.a.opIndex(j) !== so2.a.opIndex(j)) {
                                        gotoL1 = true;   // goto L1; (dmd/dsymbolsem.d:7715)
                                        break;
                                    }
                                }
                                if (!gotoL1)
                                    continue;  // the same
                                // L1: { } // different
                            }
                        }

                        if (this.flags & SearchOpt.ignoreAmbiguous) // if return NULL on ambiguity
                            return this.setResult(null);

                        /* If two imports from C import files, pick first one, as C has global name space
                         */
                        if (s.isCsymbol() && s2.isCsymbol())
                            continue;

                        if (!(this.flags & SearchOpt.ignoreErrors))
                            ScopeDsymbol.multiplyDefined(this.loc, s, s2);
                        break;
                    }
                }
            }
        }
        if (s !== null) {
            /* Build special symbol if we had multiple finds
             */
            if (a !== null) {
                if (s.isOverloadSet() === null)
                    a = mergeOverloadSet(sds, this.ident, a, s);
                s = a;
            }
            //printf("\tfound in imports %s.%s\n", toChars(), s.toChars());
            return this.setResult(s);
        }
        //printf(" not found in imports\n");
        return this.setResult(null);
    }

    override visitWithScopeSymbol(ws: WithScopeSymbol): void {
        //printf("WithScopeSymbol.search(%s)\n", ident.toChars());
        if (this.flags & SearchOpt.importsOnly)
            return this.setResult(null);
        // Acts as proxy to the with class declaration
        let s: Dsymbol | null = null;
        let eold: Expression | null = null;
        for (let e: Expression | null = ws.withstate.exp; e !== null && e !== eold;
             e = resolveAliasThis(ws._scope!, e, true)) {
            const se = e.isScopeExp();
            if (se !== null) {
                s = se.sds;
            } else if (e.isTypeExp() !== null) {
                s = toDsymbol(e.type!, null);
            } else {
                const t = toBasetype(e.type!);
                s = toDsymbol(t, null);
            }
            if (s !== null) {
                s = search(s, this.loc, this.ident, this.flags);
                if (s !== null)
                    return this.setResult(s);
            }
            eold = e;
        }
        return this.setResult(null);
    }

    override visitArrayScopeSymbol(ass: ArrayScopeSymbol): void {
        //printf("ArrayScopeSymbol::search('%s', flags = %d)\n", ident.toChars(), flags);
        if (this.ident !== Id.dollar)
            return this.visitScopeDsymbol(ass);

        /* D `VarDeclaration* pvar` is the ADDRESS OF A FIELD (`&ie.lengthVar`), read through
         * (`if (!*pvar)`) and written through (`*pvar = v`). A plain `Ref<T>` value cell cannot
         * alias someone else's field, so the one-slot box takes its accessor form: a get/set pair
         * bound to the owning node (03 §7.2 — the value-cell rule generalized to a field target;
         * see the docFeedback note for this wave).
         */
        let pvar!: { get(): VarDeclaration | null; set(v: VarDeclaration): void };
        let ce: Expression;

        // dmd/dsymbolsem.d:7798 — nested `static Dsymbol dollarFromTypeTuple(Loc, TypeTuple, Scope*)`.
        const dollarFromTypeTuple = (loc: Loc, tt: TypeTuple, sc: Scope | null): Dsymbol => {
            /* $ gives the number of type entries in the type tuple
             */
            const v = new VarDeclaration(loc, Type.tsize_t, Id.dollar!, null);
            const e: Expression = new IntegerExp(Loc.initial, BigInt(tt.arguments!.length), Type.tsize_t);
            v._init = new ExpInitializer(Loc.initial, e);
            v.storage_class = (v.storage_class | STC.temp | STC.static_ | STC.const_) as STC;
            dsymbolSemantic(v, sc);
            return v;
        };

        const kind: DYNCAST = ass.arrayContent.dyncast();
        // `switch (kind) with (DYNCAST)` — the `with` re-qualifies each case label (06 §3.3).
        switch (kind) {
        case DYNCAST.dsymbol: {
            // D `cast(...)` on the RootObject payload — tag-proved by `dyncast()` (02 §11.5c item 3)
            const td = ass.arrayContent as unknown as TupleDeclaration;
            /* $ gives the number of elements in the tuple
             */
            const v = new VarDeclaration(this.loc, Type.tsize_t, Id.dollar!, null);
            const e: Expression = new IntegerExp(Loc.initial, BigInt(td.objects!.length), Type.tsize_t);
            v._init = new ExpInitializer(Loc.initial, e);
            v.storage_class = (v.storage_class | STC.temp | STC.static_ | STC.const_) as STC;
            dsymbolSemantic(v, ass._scope);
            return this.setResult(v);
        }
        case DYNCAST.type:
            return this.setResult(
                // D `cast(...)` on the RootObject payload — tag-proved by `dyncast()` (02 §11.5c item 3)
                dollarFromTypeTuple(this.loc, ass.arrayContent as unknown as TypeTuple, ass._scope));
        default:
            break;
        }
        // D `cast(...)` on the RootObject payload — tag-proved by the `dyncast()` switch above (02 §11.5c item 3)
        const exp = ass.arrayContent as unknown as Expression;
        const ie = exp.isIndexExp();
        const se0 = ie === null ? exp.isSliceExp() : null;
        const ae0 = (ie === null && se0 === null) ? exp.isArrayExp() : null;
        if (ie !== null) {
            /* array[index] where index is some function of $
             */
            pvar = { get: () => ie.lengthVar, set: (v) => { ie.lengthVar = v; } };
            ce = ie.e1!;
        } else if (se0 !== null) {
            /* array[lwr .. upr] where lwr or upr is some function of $
             */
            pvar = { get: () => se0.lengthVar, set: (v) => { se0.lengthVar = v; } };
            ce = se0.e1!;
        } else if (ae0 !== null) {
            /* array[e0, e1, e2, e3] where e0, e1, e2 are some function of $
             * $ is a opDollar!(dim)() where dim is the dimension(0,1,2,...)
             */
            pvar = { get: () => ae0.lengthVar, set: (v) => { ae0.lengthVar = v; } };
            ce = ae0.e1!;
        } else {
            /* Didn't find $, look in enclosing scope(s).
             */
            return this.setResult(null);
        }
        ce = lastComma(ce);
        /* If we are indexing into an array that is really a type
         * tuple, rewrite this as an index into a type tuple and
         * try again.
         */
        {
            const te = ce.isTypeExp();
            if (te !== null) {
                const ttp = te.type!.isTypeTuple();
                if (ttp !== null)
                    return this.setResult(dollarFromTypeTuple(this.loc, ttp, ass._scope));
            }
        }
        /* *pvar is lazily initialized, so if we refer to $
         * multiple times, it gets set only once.
         */
        if (pvar.get() === null) { // if not already initialized
            /* Create variable v and set it to the value of $
             */
            let v: VarDeclaration;
            let t: Type | null;
            const tupexp = ce.isTupleExp();
            if (tupexp !== null) {
                /* It is for an expression tuple, so the
                 * length will be a const.
                 */
                const e: Expression = new IntegerExp(Loc.initial, BigInt(tupexp.exps!.length), Type.tsize_t);
                v = new VarDeclaration(this.loc, Type.tsize_t, Id.dollar!,
                    new ExpInitializer(Loc.initial, e));
                v.storage_class = (v.storage_class | STC.temp | STC.static_ | STC.const_) as STC;
            } else if (ce.type !== null && (t = toBasetype(ce.type)) !== null &&
                       (t.ty === TY.Tstruct || t.ty === TY.Tclass)) {
                // Look for opDollar
                assert(exp.op === EXP.array || exp.op === EXP.slice);
                const ad = isAggregate(t);
                assert(ad !== null);
                let s = search(ad, this.loc, Id.opDollar!);
                if (s === null) // no dollar exists -- search in higher scope
                    return this.setResult(null);
                s = toAlias(s);
                let e: Expression | null = null;
                // Check for multi-dimensional opDollar(dim) template.
                const td = s.isTemplateDeclaration();
                if (td !== null) {
                    let dim = 0n;                      // `dinteger_t dim = 0;` -> bigint (09 §1)
                    const ae1 = exp.isArrayExp();
                    if (ae1 !== null) {
                        dim = BigInt(ae1.currentDimension);
                    } else if (exp.isSliceExp() !== null) {
                        dim = 0n; // slices are currently always one-dimensional
                    } else {
                        assertUnreachable();
                    }
                    let edim: Expression = new IntegerExp(Loc.initial, dim, Type.tsize_t);
                    edim = expressionSemantic(edim, ass._scope!);
                    // D `new Objects(edim)` is the TYPESAFE-VARIADIC ctor (`this(U)(U[] args...)`,
                    // array.d:60) — a one-element array, NOT a dim-sized one (08 §2.9).
                    const tiargs: Objects = DArray.from<RootObject | null>(edim);
                    e = DotTemplateInstanceExp.fromName(this.loc, ce, td.ident, tiargs);
                } else {
                    /* opDollar exists, but it's not a template.
                     * This is acceptable ONLY for single-dimension indexing.
                     * Note that it's impossible to have both template & function opDollar,
                     * because both take no arguments.
                     */
                    const ae2 = exp.isArrayExp();
                    if (ae2 !== null && ae2.arguments_!.length !== 1) {
                        error(exp.loc, ds("`%s` only defines opDollar for one dimension"), ad!.toChars());
                        return this.setResult(null);
                    }
                    const d = s.isDeclaration();
                    assert(d !== null);
                    e = new DotVarExp(this.loc, ce, d!);
                }
                e = expressionSemantic(e, ass._scope!);
                if (e!.type === null)
                    error(exp.loc, ds("`%s` has no value"), e!.toChars());
                t = toBasetype(e!.type!);
                if (t !== null && t.ty === TY.Tfunction)
                    e = new CallExp(e!.loc, e);
                v = new VarDeclaration(this.loc, null, Id.dollar!, new ExpInitializer(Loc.initial, e));
                v.storage_class = (v.storage_class | STC.temp | STC.ctfe | STC.rvalue) as STC;
            } else {
                /* For arrays, $ will either be a compile-time constant
                 * (in which case its value in set during constant-folding),
                 * or a variable (in which case an expression is created in
                 * toir.c).
                 */

                // https://issues.dlang.org/show_bug.cgi?id=16213
                // For static arrays $ is known at compile time,
                // so declare it as a manifest constant.
                const tsa = ce.type !== null ? ce.type.isTypeSArray() : null;
                if (tsa !== null) {
                    const e = new ExpInitializer(this.loc, tsa.dim);
                    v = new VarDeclaration(this.loc, tsa.dim!.type, Id.dollar, e, STC.manifest);
                } else {
                    const e = new VoidInitializer(Loc.initial);
                    e.type = Type.tsize_t;
                    v = new VarDeclaration(this.loc, Type.tsize_t, Id.dollar!, e);
                    // it's never a true static variable
                    v.storage_class = (v.storage_class | STC.temp | STC.ctfe) as STC;
                }
            }
            pvar.set(v);
        }
        dsymbolSemantic(pvar.get()!, ass._scope);
        return this.setResult(pvar.get());
    }

    override visitImport(imp: Import): void {
        //printf("%s.Import.search(ident = '%s', flags = x%x)\n", imp.toChars(), ident.toChars(), flags);
        // 02 §11.4: `load(...)` SETS `imp.pkg`, so the test reads a freshly-declared local instead
        // of narrowing the field itself.
        const pkgOnEntry: Package | null = imp.pkg;
        if (pkgOnEntry === null) {
            load(imp, null);
            // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
            importAll(imp.mod as unknown as Dsymbol, null);
            dsymbolSemantic(imp.mod as unknown as Dsymbol, null);
        }
        // Forward it to the package/module
        return this.setResult(search(imp.pkg!, this.loc, this.ident, this.flags));
    }

    override visitNspace(ns: Nspace): void {
        //printf("%s.Nspace.search('%s')\n", toChars(), ident.toChars());
        if (ns._scope !== null && ns.symtab === null)
            dsymbolSemantic(ns, ns._scope);

        if (ns.members === null || ns.symtab === null) { // opaque or semantic() is not yet called
            if (!(this.flags & SearchOpt.ignoreErrors))
                error(this.loc, ds("%s `%s` is forward referenced when looking for `%s`"),
                    ns.kind(), ns.toPrettyChars(), this.ident.toChars());
            return this.setResult(null);
        }

        this.visitScopeDsymbol(ns);
    }

    override visitEnumDeclaration(em: EnumDeclaration): void {
        //printf("%s.EnumDeclaration::search('%s')\n", em.toChars(), ident.toChars());
        if (em._scope !== null) {
            // Try one last time to resolve this enum
            dsymbolSemantic(em, em._scope);
        }

        this.visitScopeDsymbol(em);
    }

    override visitPackage(pkg: Package): void {
        //printf("%s Package.search('%s', flags = x%x)\n", pkg.toChars(), ident.toChars(), flags);
        // `flags &= ~cast(int)SearchOpt.localsOnly` — SearchOptFlags is a plain `number` domain.
        this.flags &= ~SearchOpt.localsOnly;  // searching an import is always transitive
        if (pkg.isModule() === null && pkg.mod !== null) {
            // Prefer full package name.
            const s = pkg.symtab !== null ? pkg.symtab.lookup(this.ident) : null;
            if (s !== null)
                return this.setResult(s);
            //printf("[%s] through pkdmod: %s\n", loc.toChars(), toChars());
            // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
            return this.setResult(search(pkg.mod as unknown as Dsymbol, this.loc, this.ident, this.flags));
        }

        this.visitScopeDsymbol(pkg);
    }

    override visitModule(m: Module): void {
        /* Since modules can be circularly referenced,
         * need to stop infinite recursive searches.
         * This is done with the cache.
         */
        //printf("%s Module.search('%s', flags = x%x) insearch = %d\n", m.toChars(), ident.toChars(), flags, m.insearch);
        if (m.insearch)
            return this.setResult(null);

        /* Qualified module searches always search their imports,
         * even if SearchLocalsOnly
         */
        if (!(this.flags & SearchOpt.unqualifiedModule))
            this.flags &= ~(SearchOpt.unqualifiedModule | SearchOpt.localsOnly);

        if (m.searchCacheIdent === this.ident && m.searchCacheFlags === this.flags) {
            //printf("%s Module::search('%s', flags = %d) insearch = %d searchCacheSymbol = %s\n",
            //        toChars(), ident.toChars(), flags, insearch, searchCacheSymbol ? searchCacheSymbol.toChars() : "null");
            return this.setResult(m.searchCacheSymbol);
        }

        const errors = global.errors;

        // 13 §4.2 — the base-overload call is SANDWICHED in stateful logic: `insearch` is set around
        // it and `result` is read back on the same visitor instance. Port statement by statement.
        m.insearch = true;
        // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
        this.visitScopeDsymbol(m as unknown as ScopeDsymbol);
        const s = this.result;
        m.insearch = false;
        if (K.on && s !== null) keepFound(m, this.ident, s);   // the kept-module engine: what the search finds

        if (errors === global.errors) {
            // https://issues.dlang.org/show_bug.cgi?id=10752
            // Can cache the result only when it does not cause
            // access error so the side-effect should be reproduced in later search.
            m.searchCacheIdent = this.ident;
            m.searchCacheSymbol = s;
            m.searchCacheFlags = this.flags;
        }
        return this.setResult(s);
    }

    override visitDeclaration(decl: Declaration): void {
        let s: Dsymbol | null = null;
        if (decl.type !== null) {
            s = toDsymbol(decl.type, decl._scope);
            if (s !== null)
                s = search(s, this.loc, this.ident, this.flags);
        }
        return this.setResult(s);
    }

    override visitStructDeclaration(sd: StructDeclaration): void {
        //printf("%s.StructDeclaration::search('%s', flags = x%x)\n", sd.toChars(), ident.toChars(), flags);
        if (sd._scope !== null && sd.symtab === null)
            dsymbolSemantic(sd, sd._scope);

        if (sd.members === null || sd.symtab === null) { // opaque or semantic() is not yet called
            // .stringof is always defined (but may be hidden by some other symbol)
            if (this.ident !== Id.stringof && !(this.flags & SearchOpt.ignoreErrors) &&
                sd.semanticRun < PASS.semanticdone)
                error(this.loc, ds("%s `%s` is forward referenced when looking for `%s`"),
                    sd.kind(), sd.toPrettyChars(), this.ident.toChars());
            return this.setResult(null);
        }

        this.visitScopeDsymbol(sd);
    }

    override visitClassDeclaration(cd: ClassDeclaration): void {
        //printf("%s.ClassDeclaration.search('%s', flags=x%x)\n", cd.toChars(), ident.toChars(), flags);
        //if (_scope) printf("%s baseok = %d\n", toChars(), baseok);
        if (cd._scope !== null && cd.baseok < Baseok.semanticdone) {
            if (!cd.inuse) {
                // must semantic on base class/interfaces
                cd.inuse = true;
                dsymbolSemantic(cd, null);
                cd.inuse = false;
            }
        }

        if (cd.members === null || cd.symtab === null) { // opaque or addMember is not yet done
            // .stringof is always defined (but may be hidden by some other symbol)
            if (this.ident !== Id.stringof && !(this.flags & SearchOpt.ignoreErrors) &&
                cd.semanticRun < PASS.semanticdone)
                cd.classError(ds("%s `%s` is forward referenced when looking for `%s`"),
                    this.ident.toChars());
            //*(char*)0=0;
            return this.setResult(null);
        }

        this.visitScopeDsymbol(cd);
        let s = this.result;

        // don't search imports of base classes
        if (this.flags & SearchOpt.importsOnly)
            return this.setResult(s);

        if (s !== null)
            return this.setResult(s);

        // Search bases classes in depth-first, left to right order
        for (const b of cd.baseclasses!.opSlice()) {
            if (b!.sym === null)
                continue;

            if (b!.sym!.symtab === null) {
                cd.classError(ds("%s `%s` base `%s` is forward referenced"), b!.sym!.ident!.toChars());
                continue;
            }

            // dmd/dsymbolsem.d:8152 — function-local `import dmd.access : symbolIsVisible;`.

            s = search(b!.sym!, this.loc, this.ident, this.flags);
            if (s === null)
                continue;
            if (s === cd) // happens if s is nested in this and derives from this
                s = null;
            else if (!(this.flags & SearchOpt.ignoreVisibility) &&
                     !(s.visible().kind === Visibility.Kind.protected_) &&
                     !symbolIsVisibleDsymbol(cd, s))
                s = null;
            else
                break;
        }

        return this.setResult(s);
    }
}

/*************************************
 * dmd/dsymbolsem.d:8176 — `void setScope(Dsymbol d, Scope* sc)`.
 * Set scope for future semantic analysis so we can deal better with forward references.
 *
 * Params:
 *   d = dsymbol for which the scope is set
 *   sc = scope that is used to set the value
 */
export function setScope(d: Dsymbol, sc: Scope | null): void {
    const setScopeVisitor = new SetScopeVisitor(sc);
    d.accept(setScopeVisitor);
}

/***********************************************************
 * dmd/dsymbolsem.d:8182 — `private extern(C++) class SetScopeVisitor : Visitor`.
 * 13 §1: `alias visit = typeof(super).visit;` dropped. D module-private; emitted without `private`.
 */
class SetScopeVisitor extends Visitor {
    sc: Scope | null;

    constructor(sc: Scope | null) {
        super();
        this.sc = sc;
    }

    override visitDsymbol(d: Dsymbol): void {
        //printf("Dsymbol::setScope() %p %s, %p stc = %llx\n", d, d.toChars(), sc, sc.stc);
        if (!this.sc!.nofree)
            this.sc!.setNoFree(); // may need it even after semantic() finishes
        d._scope = this.sc;
        if (this.sc!.depdecl !== null)
            d.depdecl_set(this.sc!.depdecl);
        if (d.userAttribDecl() === null)
            d.userAttribDecl_set(this.sc!.userAttribDecl);
    }

    override visitImport(i: Import): void {
        this.visitDsymbol(i);
        if (i.aliasdecls.length !== 0) {
            if (i.mod === null)
                importAll(i, this.sc);

            // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
            this.sc = this.sc!.push(i.mod as unknown as ScopeDsymbol);
            // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
            try {
                this.sc.visibility = i.visibility.copy();   // Visibility is a value struct (03 §1 #5)
                for (const ad of i.aliasdecls)
                    setScope(ad!, this.sc);
            } finally {
                this.sc = this.sc.pop();
            }
        }
    }

    override visitNspace(ns: Nspace): void {
        this.visitDsymbol(ns);
        if (ns.members !== null) {
            assert(this.sc !== null);
            this.sc = this.sc!.push(ns);
            // 11 §2.5 (paired state): release on a throw too; D releases once, no early exit.
            try {
                this.sc.linkage = LINK.cpp; // namespaces default to C++ linkage
                this.sc.parent = ns;
                foreachDsymbolVoid(ns.members, (s) => setScope(s, this.sc));
            } finally {
                this.sc.pop();
            }
        }
    }

    override visitEnumDeclaration(ed: EnumDeclaration): void {
        if (ed.semanticRun > PASS.initial)
            return;
        this.visitDsymbol(ed);
    }

    override visitAggregateDeclaration(ad: AggregateDeclaration): void {
        // Might need a scope to resolve forward references. The check for
        // semanticRun prevents unnecessary setting of _scope during deferred
        // setScope phases for aggregates which already finished semantic().
        // See https://issues.dlang.org/show_bug.cgi?id=16607
        if (ad.semanticRun < PASS.semanticdone)
            this.visitDsymbol(ad);
    }

    override visitAttribDeclaration(atr: AttribDeclaration): void {
        const d: Dsymbols | null = include(atr, this.sc);
        //printf("\tAttribDeclaration::setScope '%s', d = %p\n",toChars(), d);
        if (d !== null) {
            const sc2 = newScopeDsymbol(atr, this.sc);
            foreachDsymbolVoid(d, (s) => setScope(s, sc2));
            if (sc2 !== this.sc)
                sc2!.pop();
        }
    }

    override visitDeprecatedDeclaration(dd: DeprecatedDeclaration): void {
        //printf("DeprecatedDeclaration::setScope() %p\n", this);
        if (dd.decl !== null)
            this.visitDsymbol(dd); // for forward reference
        this.visitAttribDeclaration(dd);
    }

    override visitCPPMangleDeclaration(cppmd: CPPMangleDeclaration): void {
        if (cppmd.decl !== null)
            this.visitDsymbol(cppmd); // for forward reference
        this.visitAttribDeclaration(cppmd);
    }

    override visitAnonDeclaration(anond: AnonDeclaration): void {
        if (anond.decl !== null)
            this.visitDsymbol(anond); // for forward reference
        this.visitAttribDeclaration(anond);
    }

    override visitConditionalDeclaration(condd: ConditionalDeclaration): void {
        foreachDsymbolVoid(include(condd, this.sc), (s) => setScope(s, this.sc));
    }

    override visitStaticIfDeclaration(sid: StaticIfDeclaration): void {
        // do not evaluate condition before semantic pass
        // But do set the scope, in case we need it for forward referencing
        this.visitDsymbol(sid); // for forward reference
    }

    override visitStaticForeachDeclaration(sfd: StaticForeachDeclaration): void {
        // do not evaluate condition before semantic pass
        // But do set the scope, in case we need it for forward referencing
        this.visitDsymbol(sfd); // for forward reference
    }

    override visitMixinDeclaration(md: MixinDeclaration): void {
        this.visitDsymbol(md);
    }

    override visitUserAttributeDeclaration(uad: UserAttributeDeclaration): void {
        //printf("UserAttributeDeclaration::setScope() %p\n", this);
        if (uad.decl !== null)
            this.visitDsymbol(uad);
        this.visitAttribDeclaration(uad);
    }
}

/**
 * dmd/dsymbolsem.d:8319 — `void importAll(Dsymbol d, Scope* sc)`.
 */
export function importAll(d: Dsymbol, sc: Scope | null): void {
    const iav = new ImportAllVisitor(sc);
    const k = K.on ? keepMark() : 0;     // the kept-module engine: closes the unit a visitor below opens
    d.accept(iav);
    if (K.on) keepUnwind(k);
}

/***********************************************************
 * dmd/dsymbolsem.d:8325 — `extern(C++) class ImportAllVisitor : Visitor` (NOT `private` in D, so
 * it stays exported). 13 §1: `alias visit = typeof(super).visit;` dropped.
 */
export class ImportAllVisitor extends Visitor {
    sc: Scope | null;

    constructor(sc: Scope | null) {
        super();
        this.sc = sc;
    }

    override visitDsymbol(_d: Dsymbol): void {}

    override visitImport(imp: Import): void {
        // 02 §11.4: `load(...)` below SETS `imp.mod`, so the field must never be narrowed by a test
        // — each test group reads it into a freshly-declared, explicitly-typed local and tests THAT.
        const modOnEntry: Module | null = imp.mod;
        if (modOnEntry !== null) return; // Already done

        /*
         * https://issues.dlang.org/show_bug.cgi?id=15525
         *
         * Loading the import has failed,
         * most likely because of parsing errors.
         * Therefore we cannot trust the resulting AST.
         */
        if (load(imp, this.sc)) {
            // https://issues.dlang.org/show_bug.cgi?id=23873
            // For imports that are not at module or function level,
            // e.g. aggregate level, the import symbol is added to the
            // symbol table and later semantic is performed on it.
            // This leads to semantic analysis on an malformed AST
            // which causes all kinds of segfaults.
            // The fix is to note that the module has errors and avoid
            // semantic analysis on it.
            const modAfterLoad: Module | null = imp.mod;   // 02 §11.4 fresh read (see above)
            if (modAfterLoad !== null)
                // `Module.errors` is a `uint` that SHADOWS `Dsymbol.errors` (bool) — D's `= true`
                // is the implicit bool->uint conversion, i.e. 1 (02 §11.5 / dmodule.ts:377).
                modAfterLoad.errors = 1;
            return;
        }

        const mod: Module | null = imp.mod;   // 02 §11.4 fresh read (see above)
        if (mod === null) return; // Failed

        if ((this.sc!.stc & STC.static_) !== 0n)
            imp.isstatic = 1;
        // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
        importAll(mod as unknown as Dsymbol, null);
        checkImportDeprecation(mod, imp.loc, this.sc!);
        if (this.sc!.explicitVisibility)
            imp.visibility = this.sc!.visibility.copy();   // value struct (03 §1 #5)
        if (imp.isstatic === 0 && imp.aliasId === null && imp.names.length === 0)
            // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool). `Visibility` is a
            // by-value parameter (dsymbol.d:1162) with no register row — copy at the call site
            // (03 §1 #2 / §3.1).
            this.sc!.scopesym!.importScope(mod as unknown as Dsymbol, imp.visibility.copy());
        // Enable access to pkgs/mod as soon as posible, because compiler
        // can traverse them before the import gets semantic (Issue: 21501)
        if (imp.aliasId === null && imp.names.length === 0)
            imp.addPackageAccess(this.sc!.scopesym!);
    }

    override visitModule(m: Module): void {
        //printf("+Module::importAll(this = %p, '%s'): parent = %p\n", m, m.toChars(), m.parent);
        if (m._scope !== null) {
            if (K.on) keepReq(m, KeepUnit.importAll);   // the kept-module engine: a request of a unit that ran
            return; // already done
        }
        if (K.on && keepRun(m, KeepUnit.importAll))     // the kept-module engine: replays a kept unit, or records
            return;
        if (m.filetype === FileType.ddoc) {
            error(m.loc, ds("%s `%s` is a Ddoc file, cannot import it"), m.kind(), m.toPrettyChars());
            return;
        }

        /* Note that modules get their own scope, from scratch.
         * This is so regardless of where in the syntax a module
         * gets imported, it is unaffected by context.
         * Ignore prevsc.
         */
        // D declares a LOCAL `Scope* sc` here that shadows the visitor's `sc` field; in TS the
        // field is `this.sc`, so a plain local carries the D name.
        let sc: Scope | null = scopeCreateGlobal(m, global.errorSink!); // create root scope

        if (m.md !== null && m.md.msg !== null)
            m.md.msg = semanticString(sc!, m.md.msg, ds("deprecation message"));

        // Add import of "object", even for the "object" module.
        // If it isn't there, some compiler rewrites, like
        //    classinst == classinst -> .object.opEquals(classinst, classinst)
        // would fail inside object.d.
        if (m.filetype !== FileType.c &&
            (m.members!.length === 0 ||
             m.members!.opIndex(0)!.ident !== Id.object ||
             m.members!.opIndex(0)!.isImport() === null)) {
            const im = new Import(m.loc, null, Id.object, null, 0);
            m.members!.shift(im);
        }
        if (m.symtab === null) {
            // Add all symbols into module's symbol table
            m.symtab = new DsymbolTable();
            for (let i = 0; i < m.members!.length; i++) {
                const s = m.members!.opIndex(i)!;
                addMember(s, sc, sc!.scopesym!);
            }
        }
        // anything else should be run after addMember, so version/debug symbols are defined
        /* Set scope for the symbols so that if we forward reference
         * a symbol, it can possibly be resolved on the spot.
         * If this works out well, it can be extended to all modules
         * before any semantic() on any of them.
         */
        // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
        setScope(m as unknown as Dsymbol, sc); // remember module scope for semantic
        for (let i = 0; i < m.members!.length; i++) {
            const s = m.members!.opIndex(i)!;
            setScope(s, sc);
        }
        for (let i = 0; i < m.members!.length; i++) {
            const s = m.members!.opIndex(i)!;
            importAll(s, sc);
        }
        sc = sc!.pop();
        sc!.pop(); // 2 pops because scopeCreateGlobal() created 2
    }

    override visitAttribDeclaration(atb: AttribDeclaration): void {
        const d: Dsymbols | null = include(atb, this.sc);
        //printf("\tAttribDeclaration::importAll '%s', d = %p\n", toChars(), d);
        if (d !== null) {
            const sc2 = newScopeDsymbol(atb, this.sc);
            foreachDsymbolVoid(d, (s) => importAll(s, sc2));
            if (sc2 !== this.sc)
                sc2!.pop();
        }
    }

    // do not evaluate condition before semantic pass
    override visitStaticIfDeclaration(_: StaticIfDeclaration): void {}
    // do not evaluate aggregate before semantic pass
    override visitStaticForeachDeclaration(_: StaticForeachDeclaration): void {}
}

/*******************************
 * dmd/dsymbolsem.d:8467 — `extern (D) bool load(Import imp, Scope* sc)`. Load module.
 * Returns:
 *  true for errors, false for success
 */
export function load(imp: Import, sc: Scope | null): boolean {
    // See if existing module
    const errors = global.errors;
    // `Package.resolve(imp.packages, null, &imp.pkg)` — `&imp.pkg` is the address of a FIELD, so the
    // out-slot is a one-slot box read back into the field on return (03 §3.3/§7.2).
    const ppkg: { value: Package | null } = { value: imp.pkg };
    const dst = Package.resolve(imp.packages, null, ppkg);
    imp.pkg = ppkg.value;
    // dropped: version (none) { … "can only import from a module, not from a member of module" … }
    //          (dsymbolsem.d:8472-8480)
    const s = dst.lookup(imp.id!);
    if (s !== null) {
        if (s.isModule() !== null)
            imp.mod = s.isModule()!;
        else {
            if (s.isAliasDeclaration() !== null) {
                error(imp.loc, ds("%s `%s` conflicts with `%s`"),
                    s.kind(), s.toPrettyChars(), imp.id!.toChars());
            } else {
                const p = s.isPackage();
                if (p !== null) {
                    if (p.isPkgMod === PKG.unknown) {
                        const preverrors = global.errors;
                        imp.mod = Module.load(imp.loc, imp.packages, imp.id!);
                        if (imp.mod === null) {
                            p.isPkgMod = PKG.package_;
                            if (K.on) keepPkgMod(p);   // the kept-module engine: a module tree change
                        }
                        else {
                            // imp.mod is a package.d, or a normal module which conflicts with the package name.
                            if (imp.mod.isPackageFile)
                                imp.mod.tag = p.tag; // reuse the same package tag
                            else {
                                // show error if Module.load does not
                                if (preverrors === global.errors)
                                    error(imp.loc, ds("%s `%s` from file %s conflicts with %s `%s`"),
                                        imp.mod.kind(), imp.mod.toPrettyChars(), imp.mod.srcfile.toChars(),
                                        p.kind(), p.toPrettyChars());
                                return true;
                            }
                        }
                    } else {
                        imp.mod = p.isPackageMod();
                    }
                    if (imp.mod === null) {
                        error(imp.loc, ds("can only import from a module, not from package `%s.%s`"),
                            p.toPrettyChars(), imp.id!.toChars());
                    }
                } else if (imp.pkg !== null) {
                    error(imp.loc, ds("can only import from a module, not from package `%s.%s`"),
                        imp.pkg.toPrettyChars(), imp.id!.toChars());
                } else {
                    error(imp.loc, ds("can only import from a module, not from package `%s`"),
                        imp.id!.toChars());
                }
            }
        }
    }
    if (imp.mod === null) {
        // Load module
        imp.mod = Module.load(imp.loc, imp.packages, imp.id!);
        if (imp.mod !== null) {
            // imp.id may be different from mod.ident, if so then insert alias
            // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
            dst.insertByIdent(imp.id!, imp.mod as unknown as Dsymbol);
            if (K.on) keepTree(dst, imp.id!, imp.mod as unknown as Dsymbol);   // the kept-module engine
        }
    }
    // the kept-module engine: recorded whether or not it is set here, since a replay may be the first to reach it
    if (K.on && imp.mod !== null) keepImportedFrom(imp.mod, sc !== null ? sc._module : null, imp.loc);
    if (imp.mod !== null && imp.mod.importedFrom === null)
        imp.mod.importedFrom = sc !== null ? sc._module!.importedFrom : Module.rootModule;
    if (imp.pkg === null) {
        if (imp.mod !== null && imp.mod.isPackageFile) {
            // one level depth package.d file (import pkg; ./pkg/package.d)
            // it's necessary to use the wrapping Package already created
            imp.pkg = imp.mod.pkg;
        } else
            // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
            imp.pkg = imp.mod as unknown as Package | null;
    }
    return global.errors !== errors;
}

/**
 * dmd/dsymbolsem.d:8559 — `void setFieldOffset(Dsymbol d, AggregateDeclaration ad,`
 * `FieldState* fieldState, bool isunion)`. `FieldState*` is a pointer to a VALUE struct used as an
 * alias — the class reference itself, never a copy (02 §10, 03 §7.2).
 */
export function setFieldOffset(d: Dsymbol, ad: AggregateDeclaration, fieldState: FieldState,
                               isunion: boolean): void {
    const v = new SetFieldOffsetVisitor(ad, fieldState, isunion);
    d.accept(v);
}

/***********************************************************
 * dmd/dsymbolsem.d:8565 — `private extern(C++) class SetFieldOffsetVisitor : Visitor`.
 * The class-scope `import dmd.typesem: size;` is hoisted to the file's imports and spelled
 * `typeSize` (04 §1B — typesem also owns the `Type` overload our own `sizeDsymbol` renamed away
 * from). 13 §1: `alias visit = Visitor.visit;` dropped.
 */
class SetFieldOffsetVisitor extends Visitor {
    ad: AggregateDeclaration;
    fieldState: FieldState;
    isunion: boolean;

    constructor(ad: AggregateDeclaration, fieldState: FieldState, isunion: boolean) {
        super();
        this.ad = ad;
        this.fieldState = fieldState;
        this.isunion = isunion;
    }

    override visitDsymbol(_d: Dsymbol): void {}

    override visitNspace(ns: Nspace): void {
        //printf("Nspace::setFieldOffset() %s\n", toChars());
        if (ns._scope !== null) // if fwd reference
            dsymbolSemantic(ns, null); // try to resolve it
        foreachDsymbolVoid(ns.members, (s) => setFieldOffset(s, this.ad, this.fieldState, this.isunion));
    }

    override visitVarDeclaration(vd: VarDeclaration): void {
        //printf("VarDeclaration::setFieldOffset(ad = %s) %s\n", ad.toChars(), vd.toChars());

        if (vd.aliasTuple !== null) {
            // If this variable was really a tuple, set the offsets for the tuple fields
            vd.aliasTuple.foreachVar((s) => { setFieldOffset(s, this.ad, this.fieldState, this.isunion); });
            return;
        }

        if (!vd.isField())
            return;
        assert((vd.storage_class & (STC.static_ | STC.extern_ | STC.parameter)) === 0n);

        //printf("+VarDeclaration::setFieldOffset(ad = %s) %s\n", ad.toChars(), toChars());

        /* Fields that are tuples appear both as part of TupleDeclarations and
         * as members. That means ignore them if they are already a field.
         */
        if (vd.offset !== 0) {
            // already a field
            this.fieldState.offset = this.ad.structsize; // https://issues.dlang.org/show_bug.cgi?id=13613
            return;
        }
        for (let i = 0; i < this.ad.fields.length; i++) {
            if (this.ad.fields.opIndex(i) === vd) {
                // already a field
                this.fieldState.offset = this.ad.structsize; // https://issues.dlang.org/show_bug.cgi?id=13613
                return;
            }
        }

        // Check for forward referenced types which will fail the size() call
        let t = toBasetype(vd.type!);
        if ((vd.storage_class & STC.ref_) !== 0n) {
            // References are the size of a pointer
            t = Type.tvoidptr;
        }
        const tv = baseElemOf(t);
        if (tv.ty === TY.Tstruct) {
            const ts = tv.isTypeStruct()!;
            // already checked in ad.determineFields()
            assert(ts.sym !== this.ad);
            if (!determineSize(ts.sym!, vd.loc)) {
                vd.type = Type.terror;
                vd.errors = true;
                return;
            }
        }

        // List in ad.fields. Even if the type is error, it's necessary to avoid
        // pointless error diagnostic "more initializers than fields" on struct literal.
        this.ad.fields.push(vd);

        if (t.ty === TY.Terror)
            return;

        /* If coming after a bit field in progress,
         * advance past the field
         */
        this.fieldState.inFlight = false;

        const sz = typeSize(t, vd.loc);
        assert(sz !== SIZE_INVALID && sz < 0xFFFFFFFFn);
        const memsize = Number(sz);                     // size of member
        const memalignsize = target.fieldalign(t);      // size of member for alignment purposes
        // D's `ref uint` out-params -> one-slot boxes written back into their fields (03 §3.2).
        const nextoffset = { value: this.fieldState.offset };
        const aggsize = { value: this.ad.structsize };
        const aggalignsize = { value: this.ad.alignsize };
        // `structalign_t alignment` is a BY-VALUE parameter (aggregate.d:275) and `structalign_t`
        // has live mutators (`set`/`setDefault`/`setPack`), so it can never enter the alias-safe
        // register (03 §9.1): copy the published field at the call site (03 §1 #2 / §3.1).
        vd.offset = placeField(vd.loc,
            nextoffset,
            memsize, memalignsize, vd.alignment.copy(),
            aggsize, aggalignsize,
            this.isunion);
        this.fieldState.offset = nextoffset.value;
        this.ad.structsize = aggsize.value;
        this.ad.alignsize = aggalignsize.value;

        //printf("\t%s: memalignsize = %d\n", vd.toChars(), memalignsize);
        //printf(" addField '%s' to '%s' at offset %d, size = %d\n", vd.toChars(), ad.toChars(), fieldState.offset, memsize);
    }

    override visitBitFieldDeclaration(bfd: BitFieldDeclaration): void {
        // resolved: `enum log = false` (dsymbolsem.d:8676) -> the `static if (log)` trace block
        // (:8677-8686, including its nested `void print(const FieldState*)`) emits NOTHING (07 §3),
        // and every later `if (log) printf(...)` guard is dropped for the same reason.

        const t = toBasetype(bfd.type!);
        const anon: boolean = bfd.isAnonymous();

        // List in ad.fields. Even if the type is error, it's necessary to avoid
        // pointless error diagnostic "more initializers than fields" on struct literal.
        if (!anon)
            this.ad.fields.push(bfd);

        if (t.ty === TY.Terror)
            return;

        const sz = typeSize(t, bfd.loc);
        assert(sz !== SIZE_INVALID && sz < 0xFFFFFFFFn);
        const memsize = Number(sz);                    // size of member
        const memalignsize = target.fieldalign(t);     // size of member for alignment purposes

        // Handled in dsymbolSemantic as errors
        assert(bfd.fieldWidth !== 0 || anon, "named bit fields cannot have 0 width");
        assert(bfd.fieldWidth <= memsize * 8, "bit field width is larger than type");

        const style = target.c.bitFieldStyle;                  // dmd/dsymbolsem.d:8709
        if (style !== TargetCBitFieldStyle.MS && style !== TargetCBitFieldStyle.Gcc_Clang)
            assertUnreachable("unsupported bitfield style");

        const isMicrosoftStyle = style === TargetCBitFieldStyle.MS;
        const contributesToAggregateAlignment = target.c.contributesToAggregateAlignment(bfd);

        const ad = this.ad;
        const fieldState = this.fieldState;
        const isunion = this.isunion;

        // dmd/dsymbolsem.d:8716 — nested `void startNewField()`.
        const startNewField = (): void => {
            let alignsize: number;
            if (isMicrosoftStyle)
                alignsize = memsize; // not memalignsize
            else {
                if (bfd.fieldWidth > 32)
                    alignsize = memalignsize;
                else if (bfd.fieldWidth > 16)
                    alignsize = 4;
                else if (bfd.fieldWidth > 8)
                    alignsize = 2;
                else
                    alignsize = 1;
            }

            // D's `ref uint` arguments -> one-slot boxes written back into their fields (03 §3.2);
            // `contributesToAggregateAlignment ? ad.alignsize : dummy` is a ref conditional, so the
            // box is written back to `ad.alignsize` only on its true arm.
            const dummy = { value: 0 };
            const nextoffset = { value: fieldState.offset };
            const aggsize = { value: ad.structsize };
            const aggalignsize = contributesToAggregateAlignment ? { value: ad.alignsize } : dummy;
            bfd.offset = placeField(bfd.loc,
                nextoffset,
                memsize, alignsize, bfd.alignment.copy(),
                aggsize,
                aggalignsize,
                isunion);
            fieldState.offset = nextoffset.value;
            ad.structsize = aggsize.value;
            if (contributesToAggregateAlignment)
                ad.alignsize = aggalignsize.value;

            fieldState.inFlight = true;
            fieldState.fieldOffset = bfd.offset;
            fieldState.bitOffset = 0;
            fieldState.fieldSize = memsize;
        };

        if (ad.alignsize === 0)
            ad.alignsize = 1;
        if (!isMicrosoftStyle && contributesToAggregateAlignment && ad.alignsize < memalignsize)
            ad.alignsize = memalignsize;

        if (bfd.fieldWidth === 0) {
            if (!isMicrosoftStyle && !isunion) {
                // Use type of zero width field to align to next field
                fieldState.offset = ((fieldState.offset + memalignsize - 1) & ~(memalignsize - 1)) >>> 0;
                ad.structsize = fieldState.offset;
            } else if (isMicrosoftStyle && fieldState.inFlight && !isunion) {
                // documentation says align to next int
                //const alsz = cast(uint)Type.tint32.size();
                const alsz = memsize; // but it really does this
                fieldState.offset = ((fieldState.offset + alsz - 1) & ~(alsz - 1)) >>> 0;
                ad.structsize = fieldState.offset;
            }

            fieldState.inFlight = false;
            return;
        }

        if (!fieldState.inFlight) {
            //printf("not in flight\n");
            startNewField();
        } else if (!isMicrosoftStyle) {
            // If the bitfield spans more units of alignment than its type
            // and is at the alignment boundary, start a new field at the
            // next alignment boundary. This affects when offsetof reports
            // a higher number and bitoffsetof starts at zero again.
            if (fieldState.bitOffset % (memalignsize * 8) === 0 &&
                fieldState.bitOffset + bfd.fieldWidth > memsize * 8) {
                startNewField();        // the bit field is full
            } else {
                // if alignment boundary is crossed
                const start = (fieldState.fieldOffset * 8 + fieldState.bitOffset) % (memalignsize * 8);
                const end = start + bfd.fieldWidth;
                //printf("%s start: %d end: %d memalignsize: %d\n", ad.toChars(), start, end, memalignsize);
                // `uint` division of non-negative operands: `Math.floor` is D's truncation (09 §2).
                if (Math.floor(start / (memsize * 8)) !== Math.floor((end - 1) / (memsize * 8)))
                    startNewField();
            }
        } else {
            if (memsize !== fieldState.fieldSize ||
                fieldState.bitOffset + bfd.fieldWidth > fieldState.fieldSize * 8) {
                //printf("new field\n");
                startNewField();
            }
        }

        bfd.offset = fieldState.fieldOffset;
        bfd.bitOffset = fieldState.bitOffset;

        const pastField = bfd.bitOffset + bfd.fieldWidth;
        if (isMicrosoftStyle)
            fieldState.fieldSize = memsize;
        else {
            const size_ = Math.floor((pastField + 7) / 8);     // `uint` division (09 §2)
            fieldState.fieldSize = size_;
            //printf(" offset: %d, size: %d\n", offset, size);
            if (isunion) {
                const newstructsize = (bfd.offset + size_) >>> 0; // uint wrap (09 §3)
                if (newstructsize > ad.structsize)
                    ad.structsize = newstructsize;
            } else
                ad.structsize = (bfd.offset + size_) >>> 0; // uint wrap (09 §3)
        }
        //printf("at end: ad.structsize = %d\n", cast(int)ad.structsize);
        //print(fieldState);

        if (!isunion) {
            fieldState.offset = (bfd.offset + fieldState.fieldSize) >>> 0; // uint wrap (09 §3)
            fieldState.bitOffset = pastField;
        }
    }

    override visitTemplateMixin(tm: TemplateMixin): void {
        //printf("TemplateMixin.setFieldOffset() %s\n", tm.toChars());
        if (tm._scope !== null) // if fwd reference
            dsymbolSemantic(tm, null); // try to resolve it

        foreachDsymbolVoid(tm.members, (s) => { setFieldOffset(s, this.ad, this.fieldState, this.isunion); });
    }

    override visitAttribDeclaration(atd: AttribDeclaration): void {
        foreachDsymbolVoid(include(atd, null),
            (s) => setFieldOffset(s, this.ad, this.fieldState, this.isunion));
    }

    override visitAnonDeclaration(anond: AnonDeclaration): void {
        //printf("\tAnonDeclaration::setFieldOffset %s %p\n", isunion ? "union" : "struct", anond);
        if (anond.decl !== null) {
            /* This works by treating an AnonDeclaration as an aggregate 'member',
             * so in order to place that member we need to compute the member's
             * size and alignment.
             */
            const fieldstart = this.ad.fields.length;

            /* Hackishly hijack ad's structsize and alignsize fields
             * for use in our fake anon aggregate member.
             */
            const savestructsize = this.ad.structsize;
            const savealignsize = this.ad.alignsize;
            this.ad.structsize = 0;
            this.ad.alignsize = 0;
            // 11 §2.5 (paired state): D restores both fields at two different lines (the early
            // `return` and the fall-through below), so a wall throw from `setFieldOffset` is repaired
            // by catch-repair-rethrow.
            try {
                const fs = new FieldState();   // D `FieldState fs;` — default-init (03 §6.4)
                foreachDsymbolVoid(anond.decl, (s) => {
                    // D `&fs` on a struct local IS the object reference (03 §7.2) — no box.
                    setFieldOffset(s, this.ad, fs, anond.isunion);
                    if (anond.isunion)
                        fs.offset = 0;
                });
            } catch (ex) {
                this.ad.structsize = savestructsize;
                this.ad.alignsize = savealignsize;
                throw ex;
            }

            /* https://issues.dlang.org/show_bug.cgi?id=13613
             * If the fields in this.members had been already
             * added in ad.fields, just update *poffset for the subsequent
             * field offset calculation.
             */
            if (fieldstart === this.ad.fields.length) {
                this.ad.structsize = savestructsize;
                this.ad.alignsize = savealignsize;
                this.fieldState.offset = this.ad.structsize;
                return;
            }

            anond.anonstructsize = this.ad.structsize;
            anond.anonalignsize = this.ad.alignsize;
            this.ad.structsize = savestructsize;
            this.ad.alignsize = savealignsize;

            // 0 sized structs are set to 1 byte
            if (anond.anonstructsize === 0) {
                anond.anonstructsize = 1;
                anond.anonalignsize = 1;
            }

            assert(anond._scope !== null);
            const alignment = alignmentScope(anond._scope!);

            /* Given the anon 'member's size and alignment,
             * go ahead and place it.
             */
            const nextoffset = { value: this.fieldState.offset };
            const aggsize = { value: this.ad.structsize };
            const aggalignsize = { value: this.ad.alignsize };
            // by-value `structalign_t` parameter (aggregate.d:275) — copy at the call site
            // (03 §1 #2 / §3.1); the type has live mutators, so no register elision (03 §9.1).
            anond.anonoffset = placeField(anond.loc,
                nextoffset,
                anond.anonstructsize, anond.anonalignsize, alignment.copy(),
                aggsize, aggalignsize,
                this.isunion);
            this.fieldState.offset = nextoffset.value;
            this.ad.structsize = aggsize.value;
            this.ad.alignsize = aggalignsize.value;

            // Add to the anon fields the base offset of this anonymous aggregate
            //printf("anon fields, anonoffset = %d\n", anond.anonoffset);
            if (anond.anonoffset !== 0)
                foreachDsymbolVoid(anond.decl, (s) => adjustBaseOffset(s, anond.anonoffset));
        }
    }
}

/**
 * dmd/dsymbolsem.d:8935 — `private void adjustBaseOffset(Dsymbol d, uint offset)`.
 * Adds `offset` as the new base offset of all field members in `d`. D module-private.
 */
function adjustBaseOffset(d: Dsymbol, offset: number): void {
    switch (d.dsym) {
        case DSYM.nspace: {
            const ns = d.isNspace()!;
            foreachDsymbolVoid(ns.members, (s) => adjustBaseOffset(s, offset));
            break;
        }

        case DSYM.templateMixin: {
            const tm = d.isTemplateMixin()!;
            foreachDsymbolVoid(tm.members, (s) => adjustBaseOffset(s, offset));
            break;
        }

        case DSYM.anonDeclaration: {
            const ad = d.isAnonDeclaration()!;
            if (ad.decl !== null)
                foreachDsymbolVoid(ad.decl, (s) => adjustBaseOffset(s, offset));
            break;
        }

        case DSYM.bitFieldDeclaration: {
            const bfd = d.isBitFieldDeclaration()!;
            bfd.offset += offset;
            //printf("\t%s %d : %d\n", bfd.toChars(), bfd.offset, bfd.bitOffset);
            break;
        }

        default: {
            const vd = d.isVarDeclaration();
            if (vd !== null) {
                if (vd.aliasTuple !== null)
                    vd.aliasTuple.foreachVar((s) => adjustBaseOffset(s, offset));
                else if (vd.isField()) {
                    vd.offset += offset;
                    //printf("\t%s %d\n", vd.toChars(), vd.offset);
                }
            } else {
                const atd = d.isAttribDeclaration();
                if (atd !== null) {
                    foreachDsymbolVoid(include(atd, null), (s) => adjustBaseOffset(s, offset));
                }
            }
            break;
        }
    }
}

/***************************************
 * dmd/dsymbolsem.d:8980 — `extern(D) Scope* newScope(Dsymbol d, Scope* sc)`.
 * A hook point to supply scope for members; addMember, setScope, importAll, semantic, semantic2
 * and semantic3 all use it.
 *
 * RENAMED `newScopeDsymbol` (04 §1B): the `AggregateDeclaration`-receiver overload at
 * dsymbolsem.d:90 keeps the bare `newScope` (pinned by the existing tree).
 */
export function newScopeDsymbol(d: Dsymbol, sc: Scope | null): Scope | null {
    const nsv = new NewScopeVisitor(sc);
    d.accept(nsv);
    return nsv.sc;
}

/***********************************************************
 * dmd/dsymbolsem.d:8987 — `private extern(C++) class NewScopeVisitor : Visitor`.
 * 13 §1: `alias visit = typeof(super).visit;` dropped. D module-private; emitted without `private`.
 */
class NewScopeVisitor extends Visitor {
    sc: Scope | null;

    constructor(sc: Scope | null) {
        super();
        this.sc = sc;
    }

    /****************************************
     * A hook point to supply scope for members.
     * addMember, setScope, importAll, semantic, semantic2 and semantic3 will use this.
     */
    override visitAttribDeclaration(_dc: AttribDeclaration): void {}

    override visitStorageClassDeclaration(swt: StorageClassDeclaration): void {
        let scstc: STC = this.sc!.stc;
        /* These sets of storage classes are mutually exclusive,
         * so choose the innermost or most recent one.
         */
        // branded flag-enum re-casts after `&`/`~`/`|` (02 §4.2, §11.5c item 4)
        if ((swt.stc & (STC.auto_ | STC.scope_ | STC.static_ | STC.extern_ | STC.manifest)) !== 0n)
            scstc = (scstc & ~(STC.auto_ | STC.scope_ | STC.static_ | STC.extern_ | STC.manifest)) as STC;
        if ((swt.stc & (STC.auto_ | STC.scope_ | STC.static_ | STC.manifest | STC.gshared)) !== 0n)
            scstc = (scstc & ~(STC.auto_ | STC.scope_ | STC.static_ | STC.manifest | STC.gshared)) as STC;
        if ((swt.stc & (STC.const_ | STC.immutable_ | STC.manifest)) !== 0n)
            scstc = (scstc & ~(STC.const_ | STC.immutable_ | STC.manifest)) as STC;
        if ((swt.stc & (STC.gshared | STC.shared_)) !== 0n)
            scstc = (scstc & ~(STC.gshared | STC.shared_)) as STC;
        if ((swt.stc & (STC.safe | STC.trusted | STC.system)) !== 0n)
            scstc = (scstc & ~(STC.safe | STC.trusted | STC.system)) as STC;
        scstc = (scstc | swt.stc) as STC;
        //printf("scstc = x%llx\n", scstc);
        // `swt.createNewScope(...)` is a STATIC method of AttribDeclaration reached through an
        // instance in D; the TS call names the class. `visibility` is by-value (03 §3.1).
        this.sc = AttribDeclaration.createNewScope(this.sc!, scstc, this.sc!.linkage, this.sc!.cppmangle,
            this.sc!.visibility.copy(), this.sc!.explicitVisibility, this.sc!.aligndecl, this.sc!.inlining);
    }

    /**
     * Provides a new scope with `STC.deprecated_` and `Scope.depdecl` set
     *
     * Calls `StorageClassDeclaration.newScope` (as it must be called or copied
     * in any function overriding `newScope`), then set the `Scope`'s depdecl.
     *
     * Returns:
     *   Always a new scope, to use for this `DeprecatedDeclaration`'s members.
     */
    override visitDeprecatedDeclaration(dpd: DeprecatedDeclaration): void {
        const oldsc = this.sc;
        this.visitStorageClassDeclaration(dpd);
        let scx = this.sc;
        this.sc = oldsc;
        // The enclosing scope is deprecated as well
        // 11 §2.5 (paired state, not protected): the pushed scope is handed to the caller through `this.sc`, which
        // pops it in D too; only a field store follows the push.
        if (scx === this.sc)
            scx = this.sc!.push();
        scx!.depdecl = dpd;
        this.sc = scx;
    }

    override visitLinkDeclaration(lid: LinkDeclaration): void {
        this.sc = AttribDeclaration.createNewScope(this.sc!, this.sc!.stc, lid.linkage, this.sc!.cppmangle,
            this.sc!.visibility.copy(), this.sc!.explicitVisibility, this.sc!.aligndecl, this.sc!.inlining);
    }

    override visitCPPMangleDeclaration(cpmd: CPPMangleDeclaration): void {
        this.sc = AttribDeclaration.createNewScope(this.sc!, this.sc!.stc, LINK.cpp, cpmd.cppmangle,
            this.sc!.visibility.copy(), this.sc!.explicitVisibility, this.sc!.aligndecl, this.sc!.inlining);
    }

    /**
     * Returns:
     *   A copy of the parent scope, with `this` as `namespace` and C++ linkage
     */
    override visitCPPNamespaceDeclaration(scd: CPPNamespaceDeclaration): void {
        const scx = this.sc!.copy();
        scx.linkage = LINK.cpp;
        scx.namespace = scd;
        this.sc = scx;
    }

    override visitVisibilityDeclaration(atbd: VisibilityDeclaration): void {
        if (atbd.pkg_identifiers !== null)
            dsymbolSemantic(atbd, this.sc);

        // D passes the literal `1` for the `bool explicitVisibility` parameter -> `true`.
        this.sc = AttribDeclaration.createNewScope(this.sc!, this.sc!.stc, this.sc!.linkage,
            this.sc!.cppmangle, atbd.visibility.copy(), true, this.sc!.aligndecl, this.sc!.inlining);
    }

    override visitAlignDeclaration(visd: AlignDeclaration): void {
        this.sc = AttribDeclaration.createNewScope(this.sc!, this.sc!.stc, this.sc!.linkage,
            this.sc!.cppmangle, this.sc!.visibility.copy(), this.sc!.explicitVisibility, visd,
            this.sc!.inlining);
    }

    override visitPragmaDeclaration(prd: PragmaDeclaration): void {
        if (prd.ident === Id.Pinline) {
            // We keep track of this pragma inside scopes,
            // then it's evaluated on demand in function semantic
            this.sc = AttribDeclaration.createNewScope(this.sc!, this.sc!.stc, this.sc!.linkage,
                this.sc!.cppmangle, this.sc!.visibility.copy(), this.sc!.explicitVisibility,
                this.sc!.aligndecl, prd);
        } else if (IN_LLVM && prd.ident === Id.LDC_profile_instr) {
            // dropped: `import gen.dpragma : DtoCheckProfileInstrPragma;` (dmd/dsymbolsem.d:9094) —
            // module-level in TS (01 §3).

            const emitInstr = { value: true }; // `bool emitInstr` passed as `ref bool value` -> box (03 §3.2)
            if (prd.args === null || prd.args.length !== 1
                || !DtoCheckProfileInstrPragma(prd.args.opIndex(0)!, emitInstr)) {
                error(prd.loc, ds("pragma(LDC_profile_instr, true or false) expected"));
                prd.args!.opIndexAssign(ErrorExp.get(), 0); // D indexes `(*prd.args)[0]` unchecked here
            } else {
                // Only create a new scope if the emitInstrumentation flag is changed
                if (this.sc!.emitInstrumentation !== emitInstr.value) {
                    const scx = this.sc!.copy();
                    scx.emitInstrumentation = emitInstr.value;
                    this.sc = scx;
                }
            }
        }
    }

    /**************************************
     * Use the ForwardingScopeDsymbol as the parent symbol for members.
     */
    override visitForwardingAttribDeclaration(fad: ForwardingAttribDeclaration): void {
        // 11 §2.5 (paired state, not protected): the push is handed to the caller through `this.sc` and popped
        // there in D too; nothing follows it.
        this.sc = this.sc!.push(fad.sym!);
    }

    override visitUserAttributeDeclaration(uac: UserAttributeDeclaration): void {
        let sc2 = this.sc;
        if (uac.attsUda !== null && uac.attsUda.length !== 0) {
            // create new one for changes
            sc2 = this.sc!.copy();
            sc2.userAttribDecl = uac;
        }
        this.sc = sc2;
    }
}

/**
 * dmd/dsymbolsem.d:9137 — `Dsymbols* include(Dsymbol d, Scope* sc)`.
 *
 * NAME COLLISION (04 §6.1): `dmd.expressionsem.include(Condition, Scope*)` shares this spelling;
 * the port keeps OUR export bare and import-aliases the condition one (`condInclude`).
 */
export function include(d: Dsymbol, sc: Scope | null): Dsymbols | null {
    const icv = new ConditionIncludeVisitor(sc);
    d.accept(icv);
    return icv.symbols;
}

/***********************************************************
 * dmd/dsymbolsem.d:9144 — `extern(C++) class ConditionIncludeVisitor : Visitor` (NOT `private` in D,
 * so it stays exported). 13 §1: `alias visit = typeof(super).visit;` dropped.
 */
export class ConditionIncludeVisitor extends Visitor {
    sc: Scope | null;
    symbols: Dsymbols | null = null;

    constructor(sc: Scope | null) {
        super();
        this.sc = sc;
    }

    override visitAttribDeclaration(ad: AttribDeclaration): void {
        if (ad.errors) {
            this.symbols = null;
            return;
        }
        this.symbols = ad.decl;
        return;
    }

    // Decide if 'then' or 'else' code should be included
    override visitConditionalDeclaration(cdc: ConditionalDeclaration): void {
        //printf("ConditionalDeclaration::include(sc = %p) scope = %p\n", sc, _scope);

        if (cdc.errors) {
            this.symbols = null;
            return;
        }
        assert(cdc.condition !== null);
        // dmd/dsymbolsem.d:9176 — `symbols = dmd.expressionsem.include(cdc.condition,`
        // `cdc._scope ? cdc._scope : sc) ? cdc.decl : cdc.elsedecl;`; callee live at
        // dmd/expressionsem.d:19600 (`int include(Condition c, Scope* sc)`), imported as `condInclude`
        // (the alias this file's own `include` export reserves). `int` in a boolean context → `!== 0`.
        this.symbols = condInclude(cdc.condition!, cdc._scope !== null ? cdc._scope : this.sc) !== 0
            ? cdc.decl : cdc.elsedecl;
    }

    override visitStaticIfDeclaration(sif: StaticIfDeclaration): void {
        /****************************************
         * Different from other AttribDeclaration subclasses, include() call requires
         * the completion of addMember and setScope phases.
         */
        //printf("StaticIfDeclaration::include(sc = %p) scope = %p\n", sc, _scope);
        if (sif.errors || sif.onStack) {
            this.symbols = null;
            return;
        }
        sif.onStack = true;
        // D `scope(exit) sif.onStack = false;` -> try/finally over the rest of the body (06 §7.1).
        try {
            if (this.sc !== null && sif.condition!.inc === Include.notComputed) {
                assert(sif.scopesym !== null); // addMember is already done
                assert(sif._scope !== null); // setScope is already done

                const saved_scope = this.sc;
                this.sc = sif._scope;
                this.visitConditionalDeclaration(sif);
                const d = this.symbols;
                this.sc = saved_scope;

                if (d !== null && !sif.addisdone) {
                    // Add members lazily.
                    foreachDsymbolVoid(d, (s) => addMember(s, sif._scope, sif.scopesym!));

                    // Set the member scopes lazily.
                    foreachDsymbolVoid(d, (s) => setScope(s, sif._scope));

                    sif.addisdone = true;
                }
                this.symbols = d;
                return;
            } else {
                this.visitConditionalDeclaration(sif);
            }
        } finally {
            sif.onStack = false;
        }
    }

    override visitStaticForeachDeclaration(sfd: StaticForeachDeclaration): void {
        if (sfd.errors || sfd.onStack) {
            this.symbols = null;
            return;
        }
        if (sfd.cached) {
            assert(!sfd.onStack);
            this.symbols = sfd.cache;
            return;
        }
        sfd.onStack = true;
        // D `scope(exit) sfd.onStack = false;` -> try/finally (06 §7.1).
        try {
            if (sfd._scope !== null) {
                // dmd/dsymbolsem.d:9242 — `sfd.sfe.prepare(sfd._scope)` (UFCS, 04 §6). SWEPT:
                // authorised by dmd/expressionsem.d:19525 `extern(D) void prepare(StaticForeach
                // sfe, Scope* sc)`, live at expressionsem.ts:21842. (The old wall cited :19507,
                // the docblock, not the declaration.)
                prepare(sfd.sfe, sfd._scope); // lower static foreach aggregate
            }
            // dmd/dsymbolsem.d:9244 — `sfd.sfe.ready()` (UFCS, 04 §6). SWEPT: authorised by
            // dmd/statementsem.d:85 `bool ready(StaticForeach _this)`, live at statementsem.ts:141.
            if (!ready(sfd.sfe)) {
                this.symbols = null; // TODO: ok?
                return;
            }

            // expand static foreach
            // dmd/dsymbolsem.d:9251-9252 — function-local `import dmd.statementsem:
            // makeTupleForeach;` then `makeTupleForeach(sfd._scope, true, true, sfd.sfe.aggrfe,
            // sfd.decl, sfd.sfe.needExpansion).decl` (hoisted, 01 §3). SWEPT: authorised by
            // dmd/statementsem.d:4439 `public auto makeTupleForeach(Scope* sc, bool isStatic,
            // bool isDecl, ForeachStatement fs, Dsymbols* dbody, bool needExpansion)`, live at
            // statementsem.ts:4489.
            //
            // DEPENDENCY SIGNATURE (11 §1; escalated in this wave's report): statementsem.ts
            // NARROWED two D-nullable parameters to non-null — `sc: Scope` for D's `Scope* sc`
            // and `fs: ForeachStatement` for D's nullable class ref. D reaches this line with
            // `sfd._scope` possibly null (the `if (sfd._scope)` above guards only `prepare`) and
            // with `sfd.sfe.aggrfe` null whenever the `static foreach` is over a RANGE
            // (cond.ts:143-152: exactly one of aggrfe/rangefe is non-null). The closest
            // expressible call is emitted; the non-null assertions are the artifact of the
            // narrowing, not a claim about the values, and they sweep when statementsem.ts
            // restores the D-faithful nullability.
            const d: Dsymbols | null = makeTupleForeach(sfd._scope!, true, true, sfd.sfe.aggrfe!,
                                                        sfd.decl, sfd.sfe.needExpansion).decl;
            if (d !== null) { // process generated declarations
                // Add members lazily.
                foreachDsymbolVoid(d, (s) => addMember(s, sfd._scope, sfd.scopesym!));

                // Set the member scopes lazily.
                foreachDsymbolVoid(d, (s) => setScope(s, sfd._scope));
            }
            sfd.cached = true;
            sfd.cache = d;
            this.symbols = d;
        } finally {
            sfd.onStack = false;
        }
    }
}

/**
 * dmd/dsymbolsem.d:9277 — `void checkGNUABITag(Dsymbol sym, LINK linkage)`.
 *
 * Called from a symbol's semantic to check if `gnuAbiTag` UDA can be applied to them.
 * Directly emits an error if the UDA doesn't work with this symbol.
 *
 * Params:
 *   sym = symbol to check for `gnuAbiTag`
 *   linkage = Linkage of the symbol (Declaration.link or sc.link)
 *
 * RE-HOME: the rung-era tree carries a copy of this function in funcsem.ts (a deferred-body stub);
 * its D home is HERE. The duplicate export is retired by the integrator (see the escalation).
 */
export function checkGNUABITag(sym: Dsymbol, linkage: LINK): void {
    if (global.params.cplusplus < CppStdRevision.cpp11)
        return;

    foreachUdaNoSemantic(sym, (exp) => {
        if (!isGNUABITag(exp))
            return 0; // continue
        if (sym.isCPPNamespaceDeclaration() !== null || sym.isNspace() !== null) {
            error(exp.loc, ds("`@%s` cannot be applied to namespaces"), Id.udaGNUAbiTag!.toChars());
            sym.errors = true;
        } else if (linkage !== LINK.cpp) {
            error(exp.loc, ds("`@%s` can only apply to C++ symbols"), Id.udaGNUAbiTag!.toChars());
            sym.errors = true;
        }
        // Only one `@gnuAbiTag` is allowed by semantic2
        return 1; // break
    });
}

/**
 * dmd/dsymbolsem.d:9312 — `bool isGNUABITag(Expression e)`.
 * Check if the provided expression references `core.attribute.gnuAbiTag`.
 *
 * This should be called after semantic has been run on the expression.
 * Semantic on UDA happens in semantic2 (see `dmd.semantic2`).
 *
 * Params:
 *   e = Expression to check (usually from `UserAttributeDeclaration.atts`)
 *
 * Returns:
 *   `true` if the expression references the compiler-recognized `gnuAbiTag`
 */
export function isGNUABITag(e: Expression): boolean {
    if (global.params.cplusplus < CppStdRevision.cpp11)
        return false;

    const ts = e.type !== null ? e.type.isTypeStruct() : null;
    if (ts === null)
        return false;
    if (ts.sym!.ident !== Id.udaGNUAbiTag || ts.sym!.parent === null)
        return false;
    // Can only be defined in druntime
    const m = ts.sym!.parent!.isModule();
    if (m === null || !m.isCoreModule(Id.attribute!))
        return false;
    return true;
}

/******************************************
 * dmd/dsymbolsem.d:9333 — `private Expression callScopeDtor(VarDeclaration vd, Scope* sc)`.
 * If a variable has a scope destructor call, return call for it. Otherwise, return NULL.
 *
 * D module-private, but EXPORTED here: siblings across the port already import it
 * (01 §2.5 module-private convention). The class-scope `import dmd.typesem: size;` is the
 * hoisted `typeSize` alias.
 */
export function callScopeDtor(vd: VarDeclaration, sc: Scope): Expression | null {
    void sc; // D's `sc` is unused in the body (kept: it is part of the D signature, 04 §0.1)
    //printf("VarDeclaration::callScopeDtor() %s\n", toChars());

    // Destruction of STC.field's is handled by buildDtor()
    if ((vd.storage_class & (STC.nodtor | STC.ref_ | STC.out_ | STC.field)) !== 0n) {
        return null;
    }

    if (vd.iscatchvar)
        return null;    // destructor is built by `void semantic(Catch c, Scope* sc)`, not here

    let e: Expression | null = null;
    // Destructors for structs and arrays of structs
    const tv = baseElemOf(vd.type!);
    if (tv.ty === TY.Tstruct) {
        const sd = tv.isTypeStruct()!.sym!;
        if (sd.dtor === null || sd.errors)
            return null;

        const sz = typeSize(vd.type!);
        assert(sz !== SIZE_INVALID);

        if (toBasetype(vd.type!).ty === TY.Tstruct) {
            // v.__xdtor()
            e = new VarExp(vd.loc, vd);

            /* This is a hack so we can call destructors on const/immutable objects.
             * Need to add things like "const ~this()" and "immutable ~this()" to
             * fix properly.
             */
            e.type = mutableOf(e.type!);

            // Enable calling destructors on shared objects.
            // The destructor is always a single, non-overloaded function,
            // and must serve both shared and non-shared objects.
            e.type = unSharedOf(e.type!);

            e = new DotVarExp(vd.loc, e, sd.dtor, false);
            e = new CallExp(vd.loc, e);
        } else {
            // __ArrayDtor(v[0 .. n])
            e = new VarExp(vd.loc, vd);

            const sdsz = typeSize(sd.type!);
            assert(sdsz !== SIZE_INVALID && sdsz !== 0n);
            const n = sz / sdsz;                       // bigint division (09 §1/§3.1)
            const se = new SliceExp(vd.loc, e, new IntegerExp(vd.loc, 0n, Type.tsize_t),
                new IntegerExp(vd.loc, n, Type.tsize_t));

            // Prevent redundant bounds check
            se.upperIsInBounds = true;
            se.lowerIsLessThanUpper = true;

            // This is a hack so we can call destructors on const/immutable objects.
            se.type = arrayOf(sd.type!);

            // D's `(Loc, Expression, Expression)` ctor -> the port's named factory (04 §1.1(c)).
            e = CallExp.fromArg(vd.loc, new IdentifierExp(vd.loc, Id.__ArrayDtor), se);
        }
        return e;
    }
    // Destructors for classes
    // D `(stc & mask) && !(stc & STC.parameter)` — numeric operands under `&&` yield a D `bool`,
    // so both sides expand (09 §9).
    if (!((vd.storage_class & (STC.auto_ | STC.scope_)) !== 0n &&
          (vd.storage_class & STC.parameter) === 0n))
        return null;

    for (let cd: ClassDeclaration | null = vd.type!.isClassHandle(); cd !== null; cd = cd.baseClass) {
        /* We can do better if there's a way with onstack
         * classes to determine if there's no way the monitor
         * could be set.
         */
        //if (cd.isInterfaceDeclaration())
        //    error("interface `%s` cannot be scope", cd.toChars());

        if (!vd.onstack) // if any destructors
            continue;
        // delete'ing C++ classes crashes (and delete is deprecated anyway)
        if (cd.classKind === ClassKind.cpp) {
            // Don't call non-existant dtor
            if (cd.dtor === null)
                break;

            e = new VarExp(vd.loc, vd);
            e.type = unSharedOf(mutableOf(e.type!)); // Hack for mutable ctor on immutable instances
            e = new DotVarExp(vd.loc, e, cd.dtor, false);
            e = new CallExp(vd.loc, e);
            break;
        }

        // delete this;
        let ec: Expression;
        ec = new VarExp(vd.loc, vd);
        e = new DeleteExp(vd.loc, ec, true);
        break;
    }
    return e;
}

/***************************************
 * dmd/dsymbolsem.d:9444 — `bool determineSize(AggregateDeclaration ad, Loc loc)`.
 * Collect all instance fields, then determine instance size.
 * Returns:
 *      false if failed to determine the size.
 */
export function determineSize(ad: AggregateDeclaration, loc: Loc): boolean {
    //printf("AggregateDeclaration::determineSize() %s, sizeok = %d\n", toChars(), sizeok);

    // dmd/dsymbolsem.d:9483 — label `Lfail:`, reached BOTH by `goto Lfail;` (:9468, :9473) and by
    // falling through the tail. The label body only builds a diagnostic and returns — a BAIL tail
    // (06 §4), a zero-parameter nested arrow capturing `ad`/`loc`, declared before first use.
    const LfailTail = (): boolean => {
        // There's unresolvable forward reference.
        if (ad.type !== Type.terror)
            error(loc, ds("%s `%s` no size because of forward reference"), ad.kind(), ad.toPrettyChars());
        // Don't cache errors from speculative semantic, might be resolvable later.
        // https://issues.dlang.org/show_bug.cgi?id=16574
        if (global.gag === 0) {
            ad.type = Type.terror;
            ad.errors = true;
        }
        return false;
    };

    // The previous instance size finalizing had:
    // 02 §11.4: `ad.type` and `ad.sizeok` are both mutated by the dsymbolSemantic / determineFields
    // / finalizeSize calls below, so each test group reads them into freshly-declared,
    // explicitly-typed locals and tests THOSE — never narrowing the fields themselves.
    const ty0: TY = ad.type!.ty;
    if (ty0 === TY.Terror || ad.errors)
        return false;   // failed already
    const sizeok0: Sizeok = ad.sizeok;
    if (sizeok0 === Sizeok.done)
        return true;    // succeeded

    if (ad.members === null) {
        error(loc, ds("%s `%s` unknown size"), ad.kind(), ad.toPrettyChars());
        return false;
    }

    if (ad._scope !== null)
        dsymbolSemantic(ad, null);

    // Determine the instance size of base class first.
    {
        const cd0 = ad.isClassDeclaration();
        if (cd0 !== null) {
            const cd = cd0.baseClass;
            if (cd !== null && !determineSize(cd, loc))
                return LfailTail();    // goto Lfail; (dmd/dsymbolsem.d:9468)
        }
    }

    // Determine instance fields when sizeok == Sizeok.none
    if (!determineFields(ad))
        return LfailTail();            // goto Lfail; (dmd/dsymbolsem.d:9473)
    const sizeok1: Sizeok = ad.sizeok; // 02 §11.4 re-read after determineFields
    if (sizeok1 !== Sizeok.done)
        finalizeSize(ad);

    // this aggregate type has:
    const ty1: TY = ad.type!.ty;        // 02 §11.4 re-read after finalizeSize
    if (ty1 === TY.Terror)
        return false;   // marked as invalid during the finalizing.
    const sizeok2: Sizeok = ad.sizeok;  // 02 §11.4 re-read after finalizeSize
    if (sizeok2 === Sizeok.done)
        return true;    // succeeded to calculate instance size.

    return LfailTail();                // fall-through INTO Lfail:
}

/**
 * dmd/dsymbolsem.d:9497 — `void checkCtorConstInit(Dsymbol d)`.
 */
export function checkCtorConstInit(d: Dsymbol): void {
    const v = new CheckCtorConstInitVisitor();
    d.accept(v);
}

/***********************************************************
 * dmd/dsymbolsem.d:9503 — `private extern(C++) class CheckCtorConstInitVisitor : Visitor`.
 * 13 §1: `alias visit = Visitor.visit;` dropped. D module-private; emitted without `private`.
 */
class CheckCtorConstInitVisitor extends Visitor {
    override visitAttribDeclaration(ad: AttribDeclaration): void {
        foreachDsymbolVoid(include(ad, null), (s) => checkCtorConstInit(s));
    }

    override visitVarDeclaration(_vd: VarDeclaration): void {
        // dropped: version (none) { /* doesn't work if more than one static ctor */ … }
        //          (dsymbolsem.d:9514-9519) — the whole body is inside version(none), so this
        //          override is EMPTY, and that emptiness is the D behaviour (it overrides the
        //          Dsymbol arm, which is also empty here).
    }

    override visitDsymbol(_d: Dsymbol): void {}
}

/**************************************
 * dmd/dsymbolsem.d:9532 — `bool oneMember(Dsymbol d, out Dsymbol ps, Identifier ident)`.
 * Determine if this symbol is only one.
 * Returns:
 *      false, ps = null: There are 2 or more symbols
 *      true,  ps = null: There are zero symbols
 *      true,  ps = symbol: The one and only one symbol
 *
 * `out Dsymbol ps` -> the one-slot box, reset on entry (03 §3.3).
 */
export function oneMember(d: Dsymbol, ps: { value: Dsymbol | null }, ident: Identifier | null): boolean {
    ps.value = null;              // D resets an `out` parameter to `.init` on entry
    const v = new OneMemberVisitor(ps, ident);
    d.accept(v);
    return v.result;
}

/***********************************************************
 * dmd/dsymbolsem.d:9539 — `private extern(C++) class OneMemberVisitor : Visitor`.
 * The D ctor takes `out Dsymbol ps` and stores `&ps`: the box is threaded in from `oneMember`
 * (and from `oneMembers`) so every `*ps = x` writes the caller's slot (03 §3.3).
 * 13 §1: `alias visit = Visitor.visit;` dropped. D module-private; emitted without `private`.
 */
class OneMemberVisitor extends Visitor {
    ps: { value: Dsymbol | null };
    ident: Identifier | null;
    result = false;

    constructor(ps: { value: Dsymbol | null }, ident: Identifier | null) {
        super();
        ps.value = null;          // the ctor's own `out` parameter reset (dsymbolsem.d:9547)
        this.ps = ps;
        this.ident = ident;
    }

    override visitAttribDeclaration(atb: AttribDeclaration): void {
        const d: Dsymbols | null = include(atb, null);
        this.result = oneMembers(d, this.ps, this.ident);
    }

    override visitStaticForeachDeclaration(sfd: StaticForeachDeclaration): void {
        // Required to support IFTI on a template that contains a
        // `static foreach` declaration.  `super.oneMember` calls
        // include with a `null` scope.  As `static foreach` requires
        // the scope for expansion, `oneMember` can only return a
        // precise result once `static foreach` has been expanded.
        if (sfd.cached) {
            this.visitAttribDeclaration(sfd);
        } else {
            this.ps.value = null; // a `static foreach` declaration may in general expand to multiple symbols
            this.result = false;
        }
    }

    override visitStorageClassDeclaration(scd: StorageClassDeclaration): void {
        const t = oneMembers(scd.decl, this.ps, this.ident);
        if (t && this.ps.value !== null) {
            /* This is to deal with the following case:
             * struct Tick {
             *   template to(T) { const T to() { ... } }
             * }
             * For eponymous function templates, the 'const' needs to get attached to 'to'
             * before the semantic analysis of 'to', so that template overloading based on the
             * 'this' pointer can be successful.
             */
            const fd = this.ps.value.isFuncDeclaration();
            if (fd !== null) {
                /* Use storage_class2 instead of storage_class otherwise when we do .di generation
                 * we'll wind up with 'const const' rather than 'const'.
                 */
                /* Don't think we need to worry about mutually exclusive storage classes here
                 */
                fd.storage_class2 = (fd.storage_class2 | scd.stc) as STC;
            }
        }
        this.result = t;
    }

    override visitConditionalDeclaration(cd: ConditionalDeclaration): void {
        //printf("ConditionalDeclaration::oneMember(), inc = %d\n", condition.inc);
        if (cd.condition!.inc !== Include.notComputed) {
            // dmd/dsymbolsem.d:9608 — `Dsymbols* d = dmd.expressionsem.include(cd.condition, null)`
            // `? cd.decl : cd.elsedecl;`; callee live at dmd/expressionsem.d:19600
            // (`int include(Condition c, Scope* sc)`). `int` in a boolean context → `!== 0`.
            const d: Dsymbols | null = condInclude(cd.condition!, null) !== 0 ? cd.decl : cd.elsedecl;
            this.result = oneMembers(d, this.ps, this.ident);
        } else {
            const res = (oneMembers(cd.decl, this.ps, this.ident) && this.ps.value === null &&
                         oneMembers(cd.elsedecl, this.ps, this.ident) && this.ps.value === null);
            this.ps.value = null;
            this.result = res;
        }
    }

    override visitScopeDsymbol(sd: ScopeDsymbol): void {
        if (sd.isAnonymous())
            this.result = oneMembers(sd.members, this.ps, this.ident);
        else {
            // visit(Dsymbol dsym)
            this.ps.value = sd;
            this.result = true;
        }
    }

    override visitStaticAssert(_sa: StaticAssert): void {
        //printf("StaticAssert::oneMember())\n");
        this.ps.value = null;
        this.result = true;
    }

    override visitTemplateInstance(_ti: TemplateInstance): void {
        this.ps.value = null;
        this.result = true;
    }

    override visitTemplateMixin(tm: TemplateMixin): void {
        this.ps.value = tm;
        this.result = true;
    }

    override visitDsymbol(dsym: Dsymbol): void {
        this.ps.value = dsym;
        this.result = true;
    }
}

/****************************************
 * dmd/dsymbolsem.d:9660 — `bool hasStaticCtorOrDtor(Dsymbol d)`.
 * Return true if any of the members are static ctors or static dtors, or if
 * any members have members that are.
 */
export function hasStaticCtorOrDtor(d: Dsymbol): boolean {
    const v = new HasStaticCtorOrDtor();
    d.accept(v);
    return v.result;
}

/***********************************************************
 * dmd/dsymbolsem.d:9667 — `private extern(C++) class HasStaticCtorOrDtor : Visitor` (note: the D
 * class name has NO `Visitor` suffix — carried verbatim, 01 §2.1). The class-scope
 * `import dmd.mtype : Type;` is hoisted to the file's imports.
 * 13 §1: `alias visit = Visitor.visit;` dropped. D module-private; emitted without `private`.
 */
class HasStaticCtorOrDtor extends Visitor {
    result = false;

    // attrib.d
    override visitAttribDeclaration(ad: AttribDeclaration): void {
        // The D delegate returns `bool`, implicitly converted to the `int delegate` overload's
        // return (09 §9); the whole call is then compared `!= 0`.
        this.result = foreachDsymbol(include(ad, null), (s) => hasStaticCtorOrDtor(s!) ? 1 : 0) !== 0;
    }

    // dsymbol.d
    override visitDsymbol(_d: Dsymbol): void {
        //printf("Dsymbol::hasStaticCtorOrDtor() %s\n", toChars());
        this.result = false;
    }

    override visitScopeDsymbol(sd: ScopeDsymbol): void {
        if (sd.members !== null) {
            for (let i = 0; i < sd.members.length; i++) {
                const member = sd.members.opIndex(i)!;
                // UPSTREAM SHAPE CARRIED VERBATIM (dsymbolsem.d:9691-9693): the `return;` is
                // indented as if it belonged to the `if`, but D (like C) attaches only the
                // FIRST statement to a braceless `if` — so the loop always returns on its first
                // iteration, and only `result = true` is conditional. Do not "fix" it.
                if (hasStaticCtorOrDtor(member))
                    this.result = true;
                return;
            }
        }
        this.result = false;
    }

    // dtemplate.d
    override visitTemplateDeclaration(_td: TemplateDeclaration): void {
        this.result = false; // don't scan uninstantiated templates
    }

    // func.d
    override visitStaticCtorDeclaration(_scd: StaticCtorDeclaration): void {
        this.result = true;
    }

    override visitStaticDtorDeclaration(_sdd: StaticDtorDeclaration): void {
        this.result = true;
    }
}

/**
 * dmd/dsymbolsem.d:9714 — `bool isFuncHidden(ClassDeclaration cd, FuncDeclaration fd)`.
 */
export function isFuncHidden(cd: ClassDeclaration, fd: FuncDeclaration): boolean {
    // dmd/dsymbolsem.d:9716 — function-local `import dmd.funcsem : overloadApply;` (hoisted,
    // 01 §3). SWEPT (both call sites below, D:9733 and D:9742): authorised by dmd/funcsem.d:4084
    // `extern (D) int overloadApply(Dsymbol fstart, scope int delegate(Dsymbol) dg,
    // Scope* sc = null)`, live at funcsem.ts:4197.

    //printf("ClassDeclaration.isFuncHidden(class = %s, fd = %s)\n", toChars(), fd.toPrettyChars());
    let s = search(cd, Loc.initial, fd.ident!,
        SearchOpt.ignoreAmbiguous | SearchOpt.ignoreErrors);
    if (s === null) {
        //printf("not found\n");
        /* Because, due to a hack, if there are multiple definitions
            * of fd.ident, NULL is returned.
            */
        return false;
    }
    s = toAlias(s);
    const os = s.isOverloadSet();
    if (os !== null) {
        for (const sm of os.a) {
            const fm = sm!.isFuncDeclaration();
            // dsymbolsem.d:9733 — SWEPT (see the authorising cite above).
            if (overloadApply(fm, (s2) => fd === s2.isFuncDeclaration()
                    ? 1 : 0) !== 0)
                return false;
        }
        return true;
    } else {
        const f = s.isFuncDeclaration();
        //printf("%s fdstart = %p\n", s.kind(), fdstart);
        // dsymbolsem.d:9742 — SWEPT (see the authorising cite above).
        if (overloadApply(f, (s2) => fd === s2.isFuncDeclaration()
                ? 1 : 0) !== 0)
            return false;
        return fd.parent!.isTemplateMixin() === null;
    }
}

// resolved: version (IN_LLVM) { /* not needed */ } else Dsymbol vtblSymbol(ClassDeclaration cd)
// (dsymbolsem.d:9748-9762) -> IN_LLVM is ON (_config.md §1), so the WHOLE FUNCTION is elided
// (07 §1). Nothing is emitted for it.

/**
 * dmd/dsymbolsem.d:9764 — `bool isAbstract(ClassDeclaration cd)`.
 * resolved: `enum log = false` (:9766) -> every `if (log) printf(...)` guard emits nothing (07 §3).
 */
export function isAbstract(cd: ClassDeclaration): boolean {
    if (cd.isabstract !== ThreeState.none)
        return cd.isabstract === ThreeState.yes;

    // dmd/dsymbolsem.d:9772/:9773 — the two nested one-liners (their `if (log) printf` bodies drop).
    const no = (): boolean => { cd.isabstract = ThreeState.no; return false; };
    const yes = (): boolean => { cd.isabstract = ThreeState.yes; return true; };

    if ((cd.storage_class & STC.abstract_) !== 0n ||
        cd._scope !== null && (cd._scope.stc & STC.abstract_) !== 0n)
        return yes();

    if (cd.errors)
        return no();

    /* https://issues.dlang.org/show_bug.cgi?id=11169
        * Resolve forward references to all class member functions,
        * and determine whether this class is abstract.
        */
    // dmd/dsymbolsem.d:9785 — nested `static int func(Dsymbol s, void*)`; D leaves the context
    // parameter unnamed and unused, so the arrow names it `_ctx` (04 §5; `apply` keeps the
    // protocol, 04 §0.1).
    const func = (s: Dsymbol, _ctx: unknown): number => {
        const fd = s.isFuncDeclaration();
        if (fd === null)
            return 0;
        if ((fd.storage_class & STC.static_) !== 0n)
            return 0;

        if (fd.isAbstract())
            return 1;
        return 0;
    };

    // opaque class is not abstract if it is not declared abstract
    if (cd.members === null)
        return no();

    for (let i = 0; i < cd.members.length; i++) {
        const s = cd.members.opIndex(i)!;
        // D: `s.apply(&func, null)` (dsymbolsem.d:9805) — UFCS (04 §6).
        if (apply(s, func, null) !== 0) {
            return yes();
        }
    }

    /* If the base class is not abstract, then this class cannot
        * be abstract.
        */
    if (cd.isInterfaceDeclaration() === null && (cd.baseClass === null || !isAbstract(cd.baseClass)))
        return no();

    /* If any abstract functions are inherited, but not overridden,
        * then the class is abstract. Do this by checking the vtbl[].
        * Need to do semantic() on class to fill the vtbl[].
        */
    dsymbolSemantic(cd, null);

    /* The next line should work, but does not because when ClassDeclaration.dsymbolSemantic()
        * is called recursively it can set PASS.semanticdone without finishing it.
        */
    //if (semanticRun < PASS.semanticdone)
    {
        /* Could not complete semantic(). Try running semantic() on
            * each of the virtual functions,
            * which will fill in the vtbl[] overrides.
            */
        // dmd/dsymbolsem.d:9832 — nested `static int virtualSemantic(Dsymbol s, void*)`; the
        // unnamed, unused D context parameter becomes `_ctx` (04 §5).
        const virtualSemantic = (s: Dsymbol, _ctx: unknown): number => {
            const fd = s.isFuncDeclaration();
            if (fd !== null && (fd.storage_class & STC.static_) === 0n &&
                fd.isUnitTestDeclaration() === null && fd.isCtorDeclaration() === null)
                dsymbolSemantic(fd, null);
            return 0;
        };

        for (let i = 0; i < cd.members!.length; i++) {
            const s = cd.members!.opIndex(i)!;
            apply(s, virtualSemantic, null);   // D: `s.apply(&virtualSemantic, null)` (d:9843)
        }
    }

    /* Finally, check the vtbl[]
        */
    for (let i = 1; i < cd.vtbl.length; i++) {
        const fd = cd.vtbl.opIndex(i)!.isFuncDeclaration();
        //if (fd) printf("\tvtbl[%d] = [%s] %s\n", i, fd.loc.toChars(), fd.toPrettyChars());
        if (fd === null || fd.isAbstract()) {
            return yes();
        }
    }

    return no();
}

/**
 * dmd/dsymbolsem.d:9862 — `void finalizeSize(AggregateDeclaration ad)`.
 */
export function finalizeSize(ad: AggregateDeclaration): void {
    if (K.on && ad.isCsymbol()) keepSized(ad);   // the kept-module engine: the unit that finalizes a C type's size
    const v = new FinalizeSizeVisitor();
    ad.accept(v);
}

/**********************************
 * dmd/dsymbolsem.d:9875 — `bool _isZeroInit(Expression exp)`.
 * Determine if exp is all binary zeros.
 * The function-local `import dmd.typesem: size;` is the hoisted `typeSize` alias.
 * Params:
 *      exp = expression to check
 * Returns:
 *      true if it's all binary 0
 */
export function _isZeroInit(exp: Expression): boolean {
    switch (exp.op) {
        case EXP.int64:
            return toInteger(exp) === 0n;

        case EXP.null_:
            return true;

        case EXP.structLiteral: {
            const sle = exp.isStructLiteralExp()!;
            if (sle.sd!.isNested())
                return false;
            const isCstruct: boolean = sle.sd!.isCsymbol();  // C structs are default initialized to all zeros
            for (let i = 0; i < sle.sd!.fields.length; i++) {
                const field = sle.sd!.fields.opIndex(i)!;
                // `if (field.type.size(field.loc))` — a bigint in a boolean context (09 §9).
                if (typeSize(field.type!, field.loc) !== 0n) {
                    const e = sle.elements !== null && i < sle.elements.length
                        ? sle.elements.opIndex(i) : null;
                    if (e !== null ? !_isZeroInit(e)
                                   : !isCstruct && !isZeroInit(field.type!, field.loc))
                        return false;
                }
            }
            return true;
        }

        case EXP.arrayLiteral: {
            const ale = exp.isArrayLiteralExp()!;

            const dim = ale.elements !== null ? ale.elements.length : 0;

            if (toBasetype(ale.type!).ty === TY.Tarray) // if initializing a dynamic array
                return dim === 0;

            for (let i = 0; i < dim; i++) {
                // `ale[i]` — ArrayLiteralExp's `opIndex` (05 §7).
                if (!_isZeroInit(ale.opIndex(i)!))
                    return false;
            }

            /* Note that true is returned for all T[0]
             */
            return true;
        }

        case EXP.string_: {
            const se = exp.isStringExp()!;

            if (toBasetype(se.type!).ty === TY.Tarray) // if initializing a dynamic array
                return se.len === 0;

            for (let i = 0; i < se.len; i++) {
                if (se.getIndex(i) !== 0n)
                    return false;
            }
            return true;
        }

        case EXP.vector: {
            const ve = exp.isVectorExp()!;
            return _isZeroInit(ve.e1!);
        }

        case EXP.float64:
        case EXP.complex80: {
            // dmd/dsymbolsem.d:9951 — function-local `import dmd.root.ctfloat : CTFloat;`
            // (hoisted). dsymbolsem.d:9952-9953 SWEPT: authorised by dmd/expressionsem.d:150
            // `real_t toReal(Expression _this)` and dmd/expressionsem.d:137
            // `real_t toImaginary(Expression _this)`, live at expressionsem.ts:297 and :276
            // (`real_t == double == number` on this target, 09 §6).
            // D's `is` on floating-point operands is BIT-PATTERN identity, not `==`: `-0.0 is 0.0`
            // is FALSE while JS `-0 === 0` is true. `Object.is` is the JS spelling that keeps the
            // distinction (and `CTFloat.zero` is +0.0), so a `-0.0` initializer answers `false`
            // here exactly as dmd does.
            return Object.is(toReal(exp), CTFloat.zero) &&
                   Object.is(toImaginary(exp), CTFloat.zero);
        }

        default:
            return false;
    }
}

/***************************************
 * dmd/dsymbolsem.d:9967 — `private bool checkOverlappedFields(AggregateDeclaration ad)`.
 * Calculate `ad.field[i].overlapped` and `overlapUnsafe`, and check that all of explicit
 * field initializers have unique memory space on instance. D module-private.
 * Returns:
 *      true if any errors happen.
 */
function checkOverlappedFields(ad: AggregateDeclaration): boolean {
    //printf("AggregateDeclaration::checkOverlappedFields() %s\n", toChars());
    assert(ad.sizeok === Sizeok.done);
    let nfields = ad.fields.length;
    if (ad.isNested()) {
        const cd = ad.isClassDeclaration();
        if (cd === null || cd.baseClass === null ||
            !(cd.baseClass).isNested())
            nfields--;
        if (ad.vthis2 !== null && !(cd !== null && cd.baseClass !== null && cd.baseClass.vthis2 !== null))
            nfields--;
    }
    let errors = false;

    // Fill in missing any elements with default initializers
    for (let i = 0; i < nfields; i++) {
        const vd = ad.fields.opIndex(i)!;
        if (vd.errors) {
            errors = true;
            continue;
        }

        const vdIsVoidInit: boolean = vd._init !== null && vd._init.isVoidInitializer() !== null;

        // Find overlapped fields with the hole [vd.offset .. vd.offset.size()].
        for (let j = 0; j < nfields; j++) {
            if (i === j)
                continue;
            const v2 = ad.fields.opIndex(j)!;
            if (v2.errors) {
                errors = true;
                continue;
            }
            if (!isOverlappedWith(vd, v2))
                continue;

            // vd and v2 are overlapping.
            vd.overlapped = true;
            v2.overlapped = true;

            if (!MODimplicitConv(vd.type!.mod, v2.type!.mod))
                v2.overlapUnsafe = true;
            if (!MODimplicitConv(v2.type!.mod, vd.type!.mod))
                vd.overlapUnsafe = true;

            if (i > j)
                continue;

            if (v2._init === null)
                continue;

            if (v2._init.isVoidInitializer() !== null)
                continue;

            if (vd._init !== null && !vdIsVoidInit && v2._init !== null) {
                error(ad.loc, ds("overlapping default initialization for field `%s` and `%s`"),
                    v2.toChars(), vd.toChars());
                errors = true;
            } else if (v2._init !== null && i < j) {
                // dmd/dsymbolsem.d:10034 — `dmd.hdrgen.toChars(v2._init)` (hdrgen.d:212) is `initializerToChars`.
                error(v2.loc, ds("union field `%s` with default initialization `%s` must be before field `%s`"),
                    v2.toChars(), initializerToChars(v2._init), vd.toChars());
                errors = true;
            }
        }
    }
    return errors;
}

/***********************************************************
 * dmd/dsymbolsem.d:10042 — `private extern(C++) class FinalizeSizeVisitor : Visitor`.
 * The class-scope `import dmd.typesem: size;` is the hoisted `typeSize` alias.
 * 13 §1: `alias visit = Visitor.visit;` dropped. D module-private; emitted without `private`.
 */
class FinalizeSizeVisitor extends Visitor {
    override visitClassDeclaration(outerCd: ClassDeclaration): void {
        assert(outerCd.sizeok !== Sizeok.done);

        // Set the offsets of the fields and determine the size of the class
        if (outerCd.baseClass !== null) {
            assert(outerCd.baseClass.sizeok === Sizeok.done);

            outerCd.alignsize = outerCd.baseClass.alignsize;
            if (outerCd.classKind === ClassKind.cpp)
                outerCd.structsize = target.cpp.derivedClassOffset(outerCd.baseClass);   // dmd/dsymbolsem.d:10059
            else
                outerCd.structsize = outerCd.baseClass.structsize;
        } else if (outerCd.classKind === ClassKind.objc)
            outerCd.structsize = 0; // no hidden member for an Objective-C class
        else if (outerCd.isInterfaceDeclaration() !== null) {
            if (outerCd.interfaces!.length === 0) {
                outerCd.alignsize = target.ptrsize;
                outerCd.structsize = target.ptrsize;      // allow room for __vptr
            }
        } else {
            outerCd.alignsize = target.ptrsize;
            outerCd.structsize = target.ptrsize;      // allow room for __vptr
            if (outerCd.hasMonitor())
                outerCd.structsize += target.ptrsize; // allow room for __monitor
        }

        //printf("finalizeSize() %s, sizeok = %d\n", toChars(), sizeok);
        let bi = 0;                  // index into vtblInterfaces[]

        /****
            * dmd/dsymbolsem.d:10094 — nested `uint membersPlace(ClassDeclaration cd, uint baseOffset)`.
            * RECURSIVE, and it MUTATES the captured `bi` (a plain closure capture in TS — 04 §5).
            *
            * Runs through the inheritance graph to set the BaseClass.offset fields.
            * Recursive in order to account for the size of the interface classes, if they are
            * more than just interfaces.
            * Params:
            *      cd = interface to look at
            *      baseOffset = offset of where cd will be placed
            * Returns:
            *      subset of instantiated size used by cd for interfaces
            */
        const membersPlace = (cd: ClassDeclaration, baseOffset: number): number => {
            //printf("    membersPlace(%s, %d)\n", cd.toChars(), baseOffset);
            let offset = baseOffset;

            for (const b of cd.interfaces!) {
                if (b!.sym!.sizeok !== Sizeok.done)
                    finalizeSize(b!.sym!);
                assert(b!.sym!.sizeok === Sizeok.done);

                if (b!.sym!.alignsize === 0)
                    b!.sym!.alignsize = target.ptrsize;
                // `structalign_t(cast(ushort)b.sym.alignsize)` — the D field-wise struct literal;
                // the ported struct exposes `set()`, which performs the same `cast(ushort)`.
                const sa = new structalign_t();
                sa.set(b!.sym!.alignsize);
                offset = alignmember(sa, b!.sym!.alignsize, offset);
                assert(bi < outerCd.vtblInterfaces!.length);

                const bv = outerCd.vtblInterfaces!.opIndex(bi)!;
                if (b!.sym!.interfaces!.length === 0) {
                    //printf("\tvtblInterfaces[%d] b=%p b.sym = %s, offset = %d\n", bi, bv, bv.sym.toChars(), offset);
                    bv.offset = offset;
                    ++bi;
                    // All the base interfaces down the left side share the same offset
                    // `BaseClass* b2 = bv; ...; b2 = &b2.baseInterfaces[0];` — a pointer to a
                    // VALUE-struct array element IS that element's object (03 §7.2).
                    for (let b2: BaseClass = bv; b2.baseInterfaces.length !== 0; ) {
                        b2 = b2.baseInterfaces[0]!;
                        b2.offset = offset;
                        //printf("\tvtblInterfaces[%d] b=%p   sym = %s, offset = %d\n", bi, b2, b2.sym.toChars(), b2.offset);
                    }
                }
                membersPlace(b!.sym!, offset);
                //printf(" %s size = %d\n", b.sym.toChars(), b.sym.structsize);
                offset += b!.sym!.structsize;
                if (outerCd.alignsize < b!.sym!.alignsize)
                    outerCd.alignsize = b!.sym!.alignsize;
            }
            return offset - baseOffset;
        };

        outerCd.structsize += membersPlace(outerCd, outerCd.structsize);

        if (outerCd.isInterfaceDeclaration() !== null) {
            outerCd.sizeok = Sizeok.done;
            return;
        }

        // FIXME: Currently setFieldOffset functions need to increase fields
        // to calculate each variable offsets. It can be improved later.
        outerCd.fields.setDim(0);

        const fieldState = new FieldState();      // D `FieldState fieldState;` — default-init (03 §6.4)
        fieldState.offset = outerCd.structsize;
        for (const s of outerCd.members!) {
            // `&fieldState` on a struct local IS the object reference (03 §7.2) — no box.
            setFieldOffset(s!, outerCd, fieldState, false);
        }

        outerCd.sizeok = Sizeok.done;

        // Calculate fields[i].overlapped
        checkOverlappedFields(outerCd);
    }

    override visitStructDeclaration(sd: StructDeclaration): void {
        //printf("StructDeclaration::finalizeSize() %s, sizeok = %d\n", sd.toChars(), sd.sizeok);
        assert(sd.sizeok !== Sizeok.done);

        if (sd.sizeok === Sizeok.inProcess) {
            return;
        }
        sd.sizeok = Sizeok.inProcess;

        //printf("+StructDeclaration::finalizeSize() %s, fields.length = %d, sizeok = %d\n", toChars(), fields.length, sizeok);

        sd.fields.setDim(0);   // workaround

        // Set the offsets of the fields and determine the size of the struct
        const fieldState = new FieldState();
        const isunion: boolean = sd.isUnionDeclaration() !== null;
        for (let i = 0; i < sd.members!.length; i++) {
            const s = sd.members!.opIndex(i)!;
            setFieldOffset(s, sd, fieldState, isunion);
            if (sd.type!.ty === TY.Terror) {
                errorSupplemental(s.loc, ds("error on member `%s`"), s.toPrettyChars());
                sd.errors = true;
                return;
            }
        }

        if (sd.structsize === 0) {
            sd.hasNoFields = true;

            // alignsize has already been set when the struct consists only of
            // zero sized fields.
            if (sd.alignsize === 0)
                sd.alignsize = 1;

            // A fine mess of what size a zero sized struct should be
            // D `final switch (sd.classKind)` -> the 06 §3.2 exhaustive form.
            switch (sd.classKind) {
                case ClassKind.d:
                    sd.structsize = 1;
                    break;

                case ClassKind.cpp:
                    if (sd.fields.length === 0 ||
                        target.c.bitFieldStyle === TargetCBitFieldStyle.MS) {    // dmd/dsymbolsem.d:10206
                        // Give struct a size when there's no named fields
                        sd.structsize = 1;
                    } else
                        sd.structsize = 0;
                    break;

                case ClassKind.c:
                case ClassKind.objc:
                    if (target.c.bitFieldStyle === TargetCBitFieldStyle.MS) {  // dmd/dsymbolsem.d:10217
                        /* Undocumented MS behavior for:
                         *   struct S { int :0; };
                         */
                        sd.structsize = 4;
                    } else
                        sd.structsize = 0;
                    break;

                default: {
                    const _exhaustive: never = sd.classKind;
                    throw new Error(`SwitchError: unhandled ClassKind ${String(_exhaustive)}`);
                }
            }
        }

        // Round struct size up to next alignsize boundary.
        // This will ensure that arrays of structs will get their internals
        // aligned properly.
        if (sd.alignment.isDefault() || sd.alignment.isPack())
            sd.structsize = ((sd.structsize + sd.alignsize - 1) & ~(sd.alignsize - 1)) >>> 0;
        else
            sd.structsize = ((sd.structsize + sd.alignment.get() - 1) & ~(sd.alignment.get() - 1)) >>> 0;

        sd.sizeok = Sizeok.done;

        //printf("-StructDeclaration::finalizeSize() %s, fields.length = %d, structsize = %d\n", toChars(), cast(int)fields.length, cast(int)structsize);

        if (sd.errors)
            return;

        // Calculate fields[i].overlapped
        if (checkOverlappedFields(sd)) {
            sd.errors = true;
            return;
        }

        // Determine if struct is all zeros or not
        sd.zeroInit = true;
        let lastOffset = -1;
        for (const vd of sd.fields) {
            // First skip zero sized fields
            if (typeSize(vd!.type!, vd!.loc) === 0n)
                continue;

            // only consider first sized member of an (anonymous) union
            if (vd!.overlapped && vd!.offset === lastOffset)
                continue;
            lastOffset = vd!.offset;

            if (vd!._init !== null) {
                if (vd!._init.isVoidInitializer() !== null)
                    /* Treat as 0 for the purposes of putting the initializer
                     * in the BSS segment, or doing a mass set to 0
                     */
                    continue;

                // Examine init to see if it is all 0s.
                // dmd/dsymbolsem.d:10275 — `vd.getConstInitializer()` (UFCS, 04 §6). SWEPT:
                // authorised by dmd/expressionsem.d:18998 `Expression getConstInitializer(
                // VarDeclaration vd, bool needFullType = true)`, live at
                // expressionsem.ts:21292; D passes no second argument, so the default holds.
                const exp = getConstInitializer(vd!);
                if (exp === null || !_isZeroInit(exp)) {
                    sd.zeroInit = false;
                    break;
                }
            } else if (!isZeroInit(vd!.type!, sd.loc)) {
                sd.zeroInit = false;
                break;
            }
        }

        // dmd/dsymbolsem.d:10290
        sd.argTypes = target.toArgTypes(sd.type!);
    }
}

/*****************************************
 * dmd/dsymbolsem.d:10297 — `bool hasPointers(Dsymbol d)`. Is Dsymbol a variable that contains
 * pointers?
 *
 * RENAMED `hasPointersDsymbol` (04 §1B / §6.1): typesem.ts owns the `Type`-receiver `hasPointers`,
 * and typesem.ts:3028/:8886 already import THIS spelling — the name is PINNED.
 */
export function hasPointersDsymbol(d: Dsymbol): boolean {
    const v = new HasPointersVisitor();
    d.accept(v);
    return v.result;
}

/***********************************************************
 * dmd/dsymbolsem.d:10304 — `private extern(C++) class HasPointersVisitor : Visitor`. The
 * class-scope `import dmd.mtype : Type;` is hoisted. 13 §1: `alias visit = Visitor.visit;` dropped.
 * D module-private; emitted without `private`.
 */
class HasPointersVisitor extends Visitor {
    result = false;

    override visitAttribDeclaration(ad: AttribDeclaration): void {
        this.result = foreachDsymbol(include(ad, null), (s) => hasPointersDsymbol(s!) ? 1 : 0) !== 0;
    }

    override visitVarDeclaration(vd: VarDeclaration): void {
        // dmd/dsymbolsem.d:10318 — function-local `import dmd.typesem : hasPointers;` (hoisted):
        // the `Type` arm of the overload set, which keeps the bare name (ours is renamed).
        this.result = (!vd.isDataseg() && hasPointers(vd.type!));
    }

    override visitDsymbol(_d: Dsymbol): void {
        //printf("Dsymbol::hasPointers() %s\n", toChars());
        this.result = false;
    }

    override visitTemplateMixin(tm: TemplateMixin): void {
        //printf("TemplateMixin.hasPointers() %s\n", toChars());
        this.result = foreachDsymbol(tm.members, (s) => hasPointersDsymbol(s!) ? 1 : 0) !== 0;
    }

    override visitNspace(ns: Nspace): void {
        //printf("Nspace::hasPointers() %s\n", toChars());
        this.result = foreachDsymbol(ns.members, (s) => hasPointersDsymbol(s!) ? 1 : 0) !== 0;
    }
}

/***************************************
 * dmd/dsymbolsem.d:10351 — `int _foreach(Scope* sc, Dsymbols* members, scope ForeachDg dg,`
 * `size_t* pn = null)`.
 *
 * Expands attribute declarations in members in depth first order. Calls dg(size_t symidx,
 * Dsymbol *sym) for each member. If dg returns !=0, stops and returns that value else returns 0.
 * Use this function to avoid the O(N + N^2/2) complexity of calculating dim and calling N times
 * getNth.
 *
 * `size_t* pn` is a pointer to the caller's index counter — the one-slot box (03 §7.2); `null`
 * means "no shared counter", so the parameter is `{ value: number } | null`.
 *
 * Returns:
 *  last value returned by dg()
 */
export function _foreach(sc: Scope | null, members: Dsymbols | null, dg: ForeachDg,
                         pn: { value: number } | null = null): number {
    assert(dg !== null);
    if (members === null)
        return 0;
    const n = { value: pn !== null ? pn.value : 0 }; // take over index
    let result = 0;
    for (let i = 0; i < members.length; i++) {
        // dmd/dsymbolsem.d:10360-10361 — function-local imports of AttribDeclaration/TemplateMixin
        // (hoisted to the file's imports, 01 §3).
        const s = members.opIndex(i)!;
        const a = s.isAttribDeclaration();
        const tm = s.isTemplateMixin();
        if (a !== null)
            result = _foreach(sc, include(a, sc), dg, n);
        else if (tm !== null)
            result = _foreach(sc, tm.members, dg, n);
        else if (s.isTemplateInstance() !== null) {
        } else if (s.isUnitTestDeclaration() !== null) {
        } else
            result = dg(n.value++, s);
        if (result !== 0)
            break;
    }
    if (pn !== null)
        pn.value = n.value; // update index
    return result;
}

/****************************************
 * dmd/dsymbolsem.d:10392 — `void getLocalClasses(Module mod, ref ClassDeclarations aclasses)`.
 * Create array of the local classes in the Module, suitable for inclusion in ModuleInfo.
 *
 * `ref ClassDeclarations aclasses` is a by-reference container: the object itself, never a copy
 * (03 §3.2).
 *
 * Params:
 *      mod = the Module
 *      aclasses = array to fill in
 */
export function getLocalClasses(mod: Module, aclasses: ClassDeclarations): void {
    //printf("members.length = %d\n", mod.members.length);
    // dmd/dsymbolsem.d:10395 — nested `int pushAddClassDg(size_t n, Dsymbol sm)`.
    const pushAddClassDg = (_n: number, sm: Dsymbol | null): number => {
        if (sm === null)
            return 0;

        const cd = sm.isClassDeclaration();
        if (cd !== null) {
            // compatibility with previous algorithm
            if (cd.parent !== null && cd.parent.isTemplateMixin() !== null)
                return 0;

            if (cd.classKind !== ClassKind.objc)
                aclasses.push(cd);
        }
        return 0;
    };

    _foreach(null, mod.members, pushAddClassDg);
}

/*****************************************
 * dmd/dsymbolsem.d:10418 — `extern (D) bool oneMembers(Dsymbols* members, out Dsymbol ps,`
 * `Identifier ident)`. Same as `oneMember`, but look at an array of Dsymbols.
 * `out Dsymbol ps` -> the one-slot box, reset on entry (03 §3.3).
 */
export function oneMembers(members: Dsymbols | null, ps: { value: Dsymbol | null },
                           ident: Identifier | null): boolean {
    //printf("Dsymbol::oneMembers() %d\n", members ? members.length : 0);
    // D resets an `out` parameter to `.init` on entry. 02 §11.4: the reset is written through a
    // freshly-declared alias so that it does NOT narrow `ps.value`'s flow type for the reads in the
    // loop below — `oneMember` re-writes the slot on every iteration and TS cannot see that through
    // the call.
    const psReset: { value: Dsymbol | null } = ps;
    psReset.value = null;
    let s: Dsymbol | null = null;
    if (members === null) {
        ps.value = null;
        return true;
    }

    for (let i = 0; i < members.length; i++) {
        const sx = members.opIndex(i)!;
        const x = oneMember(sx, ps, ident);
        //printf("\t[%d] kind %s = %d, s = %p\n", i, sx.kind(), x, *ps);
        if (!x) {
            //printf("\tfalse 1\n");
            assert(ps.value === null);
            return false;
        }
        // 02 §11.4: `oneMember` above WRITES `ps.value`; read it into a freshly-declared,
        // explicitly-typed local and test THAT (nothing mutates it again in this iteration).
        const psv: Dsymbol | null = ps.value;
        if (psv === null)
            continue;

        assert(ident !== null);
        if (psv.ident === null || !psv.ident.equals(ident))
            continue;
        if (s === null)
            s = psv;
        else if (s.isOverloadable() && psv.isOverloadable()) {
            // keep head of overload set
            let f1 = s.isFuncDeclaration();
            const f2 = psv.isFuncDeclaration();
            if (f1 !== null && f2 !== null) {
                assert(f1.isFuncAliasDeclaration() === null);
                assert(f2.isFuncAliasDeclaration() === null);
                for (; f1 !== f2; f1 = f1!.overnext0) {
                    if (f1!.overnext0 === null) {
                        f1!.overnext0 = f2;
                        break;
                    }
                }
            }
        } else { // more than one symbol
            ps.value = null;
            //printf("\tfalse 2\n");
            return false;
        }
    }
    ps.value = s; // s is the one symbol, null if none
    //printf("\ttrue\n");
    return true;
}

/***********************************************************
 * djs-local driver, NO D COUNTERPART in dmd/dsymbolsem.d. The sema test suites (`sema.*.test.ts` and
 * the unit suites that analyse a parsed source) import it as the module-level entry point.
 *
 * THE MINIMAL SEMA DRIVER. Faithful port of the per-module semantic sequence in dmd/main.d:700-770
 * (the pass-0 / pass-1 / pass-2 / pass-3 tail of `mars_mainBody`), reduced to a single root module:
 * pass 0 (`importAll`), pass 1 (`dsymbolSemantic`) + its deferral drain + the unresolved
 * forward-reference report, pass 2 (`semantic2`) + its drain, pass 3 (`semantic3`) + its drain, in
 * main.d's order.
 *
 * PASS 2 RUNS (main.d:740-742): module-scope var initializers (semantic2.d:249), `static assert`s, and
 * the rest of pass 2 are analysed here.
 *
 * THE DRIVER STOPS WHERE main.d STOPS. main.d checks `global.errors` after pass 0 (:707), after
 * pass 2 (:743) and after pass 3 (:768), and on errors calls `removeHdrFilesAndFail`, which ends in
 * `fatal()` (process exit). A driver running inside a test process cannot exit it, so each check
 * becomes a `return`: no later pass runs, exactly the set of passes ldc2 runs. There is NO check
 * after pass 1 (main.d:722-723 is commented out upstream), so a pass-1 error still reaches pass 2;
 * pass 3 then never runs. ldc2 agrees: a module with an undefined type in a struct field and a bad
 * initializer in a function body reports only the first.
 *
 * PASS 0 IS NOT OPTIONAL, whatever its name suggests. `ImportAllVisitor.visitModule` is what builds
 * `m.symtab` and `addMember`s the members into it, and `addMember` is what sets each member's
 * `parent`. Skip it and every member reaches pass 1 with a null `parent`, where the faithful
 * `assert(sc.parent && sc.func)` in `visitStructDeclaration` (D:4712) fires at module scope — one
 * assert standing in for the whole missing pass.
 *
 * Omitted from main.d's sequence, each driver-only: the `-v` progress `message`s, the time-trace
 * events, the non-LDC `backend_init` (main.d:710-713), the `includeImports` loop (main.d:753-766, no
 * compiled imports in a single-module driver), and the hdr-file removal inside `removeHdrFilesAndFail`.
 * Omitted as well, and not driver-only: LDC's `extraLDCSpecificSemanticAnalysis(modules)` (main.d:771-774,
 * ported in src/gen/semantic.ts), which runs after pass 3's check — DCompute sema for `@compute` modules, then the
 * semantic-analysis plugins (gen/semantic.d:20-34). It can report diagnostics in ldc2; this driver does not call it.
 *
 * Preconditions: `m.members` is set (built from the parser output — see `moduleFromParse`), and the
 * caller has run compiler startup far enough for pass 0 to resolve the implicit `import object;`
 * that `ImportAllVisitor` injects into every module: `Module._init()` plus a module named `object`
 * in `Module.modules` (the suites get both from `initSemaHarness`, src/sema-harness.ts). Without
 * them pass 0 falls through to `Module.load()`: real file IO, which needs `global._init()`'s `fileManager`
 * and an import path holding `object.d` (the driver path pinned in dmodule.test.ts).
 * Postconditions: with `global.errors == 0` on return, `m.semanticRun == PASS.semantic3done`; with
 * errors, the driver stopped at the first failing check above and `m.semanticRun` names the last
 * pass that ran. `global.errors` reflects every diagnostic reported.
 */
export function runSemantic(m: Module): void {
    m.importedFrom = m;             // promote to a root module (main.d's modules[] are all roots)
    // `m` IS-A Dsymbol; the upcast is needed only because Module.errors (uint) is an audited
    // field-shadow of Dsymbol.errors (bool) (dmodule.ts:168) that breaks clean structural subtyping.
    // upcast cascade: Module.errors (uint) shadows Dsymbol.errors (bool)
    const md = m as unknown as Dsymbol;
    importAll(md, null);            // pass 0: `m.importAll(null)` (main.d:705) — symtab + member parents
    if (global.errors !== 0)        // main.d:707 — `removeHdrFilesAndFail`: stop (see header)
        return;

    dsymbolSemantic(md, null);      // pass 1: `m.dsymbolSemantic(null)` (main.d:720)
    runDeferredSemantic();          // drain pass-1 deferrals (main.d:724)
    // main.d:725-733 — whatever is still deferred never resolved. No stop here: `//fatal();` upstream.
    for (let i = 0; i < Module.deferred.length; i++) {
        const sd = Module.deferred.opIndex(i)!; // slot `Dsymbol | null` (08 §3); main.d:729 has no null test
        error(sd.loc, ds("%s `%s` unable to resolve forward reference in definition"), sd.kind(), sd.toPrettyChars());
    }

    semantic2(md, null);            // pass 2: `m.semantic2(null)` (main.d:740) — initializers, static asserts
    runDeferredSemantic2();         // drain pass-2 deferrals (main.d:742)
    if (global.errors !== 0)        // main.d:743 — `removeHdrFilesAndFail`: stop (see header)
        return;

    semantic3(md, null);            // pass 3: `m.semantic3(null)` (main.d:751) — analyze function bodies
    runDeferredSemantic3();         // drain pass-3 deferrals (main.d:767)
    // main.d:768's check follows; LDC's main.d:771-774 extra sema is not ported (see header).
}
