// Ported from dmd/expression.d (module dmd.expression), ldc-1.43.0-beta1 / DMD 2.113.
//
// "Defines the bulk of the classes which represent the AST at the expression level."
//
// SURFACE NOTE (1.42 -> 1.43-beta1 delta, load-bearing for consumers): DMD 2.113 MOVED a large
// group of `Expression` methods OUT of expression.d and into `expressionsem.d` as UFCS free
// functions — `toInteger`, `toUInteger`, `toReal`, `toImaginary`, `toComplex`, `toStringExp`,
// `toBool`, `isLvalue`, `checkType` (RENAMED **hasValidType** in 2.113 AND its polarity INVERTED — a mechanical rename of a `checkType` call silently inverts the branch), and `calledFunctionType` (expressionsem.d:192/:315/:425/
// :499/:681). They are therefore ABSENT here. This file is the faithful 1.43 surface; consumers
// still calling them as `Expression` methods are listed in the translation report for the wave
// reconciler and are NOT edited from here (14 §2.1 single-writer).
//
// Resolved compile-time constructs (07-compile-time.md audit convention):
//   - `mixin(generateBitFields!(BitFields, ubyte))` x3 (expression.d:137, :1458, :2754):
//     `Has_Bitfields` is OFF (_config.md §1), so the mixin expands to shift/mask getter/setter
//     pairs over one packed `ubyte`. Nothing in the frontend reads the packed integer or its
//     `.sizeof`, so per 11-escalate.md §3.6 the packing is discarded and each BitFields member
//     becomes a plain field. The `BitFields` structs themselves emit nothing.
//   - `debug { fprintf(stderr, ...) }` (expression.d:183): OFF (_config.md §3) — dropped. The
//     `assert(0)` it guards goes with it: both live inside `if (!size)`, and `size` is itself
//     dropped (the `expSize` entry below), so the whole guard has no subject. See `copy()`.
//   - `version (IN_LLVM)` x2 (expression.d:325, :1469): ON (_config.md §1) — see each site.
//   - `private immutable ubyte[EXP.max+1] expSize` (expression.d:4137) and `Expression.size()`
//     (expression.d:147): the table is a `__traits(classInstanceSize, X)` layout table.
//     07-compile-time.md §7.1 elides `classInstanceSize` (no manual memory) and drops the table;
//     `copy()` becomes the field-wise shallow clone. Its only other frontend reader is
//     `ctfeexpr.d`'s `assert(e.size <= u.sizeof)` storage check, which 02-types.md §11.1 also
//     drops. So `expSize` and `size()` are DROPPED here.
//
// Unions (11-escalate.md §3.5), both closed: the `StringExp` payload union (expression.d:919-925) is ported
// as one byte buffer per its ruling, and the `StructLiteralExp` union (expression.d:1467-1483) has a single
// live member under IN_LLVM, a plain field. See the comments at those sites.
//
// DMD.DTEMPLATE IS A PLAIN VALUE IMPORT. Three bodies here need dtemplate's VALUES
// (`objectSyntaxCopy` at expression.d:1913, `TemplateInstance` + its static `arraySyntaxCopy` at
// :1939/:2292/:2297) and all four read the binding only at CALL time, which 01 §4.3 sanctions
// across a cycle. The edge was blocked for one wave because dtemplate.ts evaluated
// `class TypeDeduced extends Type` at its module top level, so importing it while `mtype.js` was an
// ancestor on the load stack threw `TypeError: Class extends value undefined`; dtemplate.ts now
// defers that class into `initDtemplate()` (01 §4.1 lazy-class shape), which removes its last
// top-level SCC read and makes the import ordinary. The four sites are the faithful D calls.

import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import { maskUnsignedN, normalizeInteger, toInt32, toUint64 } from "../numeric.js";

import { ASTNode } from "./ast_node.js";
import { toDString } from "./root/string.js";
import { utf_codeLength, utf_decodeChar, utf_decodeWchar } from "./root/utf.js";
import { Array as DArray } from "./root/array.js";
import { EXP } from "./tokens.js";
import type { TOK, InterpolatedSet } from "./tokens.js";
import { DYNCAST } from "./rootobject.js";
import type { RootObject } from "./rootobject.js";
import { Loc } from "./location.js";
import { STC, TY, TFlags } from "./astenums.js";
import { global } from "./globals.js";
import type { dinteger_t } from "./globals.js";
import { error } from "./errors.js";
import { K, keepString } from "../keep.js";
import { Id } from "./id.js";
import type { Identifier } from "./identifier.js";
// Value imports read only INSIDE method bodies (never at module-evaluation time), so the
// expression <-> mtype / dsymbol / dtemplate load cycles stay safe (01-conventions.md §4.3).
import { Type, toBaseTypeNonSemantic } from "./mtype.js";
import type { TypeVector } from "./mtype.js";
// dmd.dtemplate carries VALUES three bodies here need (`objectSyntaxCopy`, `TemplateInstance` and
// its static `arraySyntaxCopy`); both bindings are read only inside method bodies, and dtemplate.js
// itself no longer reads an SCC value at load (01 §4.1 lazy class), so the edge is an ordinary
// value import (01 §4.3).
import { TemplateInstance, objectSyntaxCopy } from "./dtemplate.js";
import type { TemplateDeclaration, TemplateParameter } from "./dtemplate.js";
import { PASS } from "./dsymbol.js";
import type { Dsymbol, ScopeDsymbol, OverloadSet } from "./dsymbol.js";
import type { Declaration, VarDeclaration, TupleDeclaration } from "./declaration.js";
import type { FuncDeclaration, FuncLiteralDeclaration, CtorDeclaration } from "./func.js";
import type { StructDeclaration } from "./dstruct.js";
import type { ClassDeclaration } from "./dclass.js";
import type { Initializer } from "./init.js";
import type { complex_t } from "./root/complex.js";
import type { real_t } from "./root/ctfloat.js";
import type { Expressions, ArgumentLabels, Objects, Types, TemplateParameters } from "./arraytypes.js";
import type { Visitor } from "./visitor/index.js";
// dmd/expression.d:31 — `import dmd.hdrgen : toChars;`, a MODULE-LEVEL D import: the Expression
// overload of that set is `expressionToChars` (04 §6.1 name), read only inside `Expression.toChars`.
// Last (01 §4.8): hdrgen.js value-imports this module back, and entering it earlier would evaluate
// hdrgen's own SCC edges (dsymbol, dtemplate, …) before this module's classes exist. Measured
// load-safe here: full-suite collect clean, and the expression/dsymbol/mtype/hdrgen/parse entries
// all load.
import { expressionToChars } from "./hdrgen.js";

/// dmd/expression.d:46 — `enum LOGSEMANTIC = false;` (manifest constant, 02-types.md §4.1).
/// Module-scope and NOT `private` in D, so it is exported.
export const LOGSEMANTIC = false;

/****************************************
 * dmd/expression.d:56 — `inout(Expression) lastComma(inout Expression e)`.
 * Find the last non-comma expression.
 *
 * A module-level FREE function in D — kept free here (04-functions.md §6: never re-home a free
 * function onto a class).
 * Params:
 *      e = Expressions connected by commas
 * Returns:
 *      right-most non-comma expression
 */
export function lastComma(e: Expression): Expression {
    // `inout`/`cast()`/`cast(inout)` are const-transfer qualifiers only — erased (04 attributes).
    let ex: Expression = e;
    while (ex.op === EXP.comma)
        ex = (ex as unknown as CommaExp).e2!; // D: `(cast(CommaExp)ex).e2` — op-guarded downcast
    return ex;
}

/****************************************
 * dmd/expression.d:73 — `TemplateDeclaration getFuncTemplateDecl(Dsymbol s)`.
 * If `s` is a function template, i.e. the only member of a template and that member is a
 * function, return that template.
 * Params:
 *      s = symbol that might be a function template
 * Returns:
 *      template for that function, otherwise null
 */
export function getFuncTemplateDecl(s: Dsymbol): TemplateDeclaration | null {
    const f: FuncDeclaration | null = s.isFuncDeclaration();
    if (f !== null && f.parent !== null) {
        const ti = f.parent.isTemplateInstance();
        if (ti !== null) {
            if (ti.isTemplateMixin() === null && ti.tempdecl !== null) {
                const td = ti.tempdecl.isTemplateDeclaration();
                // D dereferences `td` unconditionally here (no null test) — `!` marks the same
                // fault point (02-types.md §10.1).
                if (td!.onemember !== null && td!.ident === f.ident) {
                    return td;
                }
            }
        }
    }
    return null;
}

/************************ TypeDotIdExp ************************************/
/* dmd/expression.d:100 — Things like:
 *      int.size
 *      foo.size
 *      (foo).size
 *      cast(foo).size
 */
export function typeDotIdExp(loc: Loc, type: Type, ident: Identifier): DotIdExp {
    return new DotIdExp(loc, new TypeExp(loc, type), ident);
}

/// dmd/expression.d:105 — `enum OwnedBy : ubyte` (named enumeration, 02-types.md §4.2).
export enum OwnedBy {
    code, // normal code expression in AST
    ctfe, // value expression for CTFE
    cache, // constant value cached for CTFE
}

/// dmd/expression.d:112-113 — manifest constants (02-types.md §4.1).
export const WANTvalue = 0; // default
export const WANTexpand = 1; // expand const/immutable variables if possible

/***********************************************************
 * dmd/expression.d:119 — `extern (C++) /* IN_LLVM abstract *​/ class Expression : ASTNode`.
 * https://dlang.org/spec/expression.html#expression
 *
 * REFERENCE type (02-types.md §2). The `abstract` is commented out in the D source under
 * IN_LLVM (`gen/asm-x86.h` instantiates `Expression` directly), so the class is concrete here.
 */
export class Expression extends ASTNode {
    /// Usually, this starts out as `null` and gets set to the final expression type by
    /// `expressionSemantic`. However, for some expressions (such as `TypeExp`,`RealExp`,
    /// `VarExp`), the field can get set to an assigned type before running semantic.
    /// See `expressionSemanticDone` (dmd/expression.d:125)
    type: Type | null = null;

    loc: Loc; // file location (dmd/expression.d:127)
    readonly op: EXP; // to minimize use of dynamic_cast (dmd/expression.d:128, `const EXP op`)

    // dmd/expression.d:130-137 — `static struct BitFields { bool parens, rvalue, gcPassDone; }`
    // packed by `mixin(generateBitFields!(BitFields, ubyte))`. Resolved to plain fields (see the
    // file header); their `.init` is `false` (09-numerics.md §1.0).
    parens = false; // if this is a parenthesized expression
    rvalue = false; // true if this is considered to be an rvalue, even if it is an lvalue
    gcPassDone = false; // `checkGC` has been run on this expression

    // dmd/expression.d:139 — `extern (D) this(Loc loc, EXP op) scope @safe`.
    constructor(loc: Loc, op: EXP) {
        super();
        this.loc = loc;
        this.op = op;
    }

    // dmd/expression.d:147 — `final size_t size()` (`expSize[op]`): DROPPED with the `expSize`
    // layout table (07-compile-time.md §7.1) — see the file header.

    /// dmd/expression.d:149 — `static void _init()`. Builds the CTFEExp sentinel singletons.
    static _init(): void {
        CTFEExp.cantexp = new CTFEExp(EXP.cantExpression);
        CTFEExp.voidexp = new CTFEExp(EXP.voidExpression);
        CTFEExp.breakexp = new CTFEExp(EXP.break_);
        CTFEExp.continueexp = new CTFEExp(EXP.continue_);
        CTFEExp.gotoexp = new CTFEExp(EXP.goto_);
        CTFEExp.showcontext = new CTFEExp(EXP.showCtfeContext);
    }

    /**
     * dmd/expression.d:165 — Deinitializes the global state of the compiler.
     *
     * This can be used to restore the state set by `_init` to its original state.
     * (`CTFEExp.cantexp.init` on a class reference is `null` — 09-numerics.md §1.0.)
     */
    static deinitialize(): void {
        CTFEExp.cantexp = null;
        CTFEExp.voidexp = null;
        CTFEExp.breakexp = null;
        CTFEExp.continueexp = null;
        CTFEExp.gotoexp = null;
        CTFEExp.showcontext = null;
    }

    /*********************************
     * dmd/expression.d:178 — `extern (D) final Expression copy()`.
     * Does *not* do a deep copy.
     *
     * D bump-allocates `size` bytes and `memcpy`s the instance. Under the JS GC there is no
     * manual allocation (03-value-semantics.md §8) and no fixed layout, so this is the
     * field-wise shallow clone (07-compile-time.md §7.1): `Object.create` preserves the
     * prototype (the clone keeps its concrete subclass, `accept`, the `isXxx` set), and
     * `Object.assign` copies every own field by reference exactly like the memcpy.
     * dropped: `if (!size) { debug {...} assert(0); }` — the layout sanity check went with the
     * `expSize` table; `allocmemory(size)` erased (JS GC).
     */
    copy(): Expression {
        const e = Object.create(Object.getPrototypeOf(this) as object) as Expression;
        Object.assign(e, this);
        return e;
    }

    /// dmd/expression.d:197 — `Expression syntaxCopy()`.
    syntaxCopy(): Expression {
        return this.copy();
    }

    /// dmd/expression.d:205 — kludge for template.isExpression().
    override dyncast(): DYNCAST {
        return DYNCAST.expression;
    }

    /// dmd/expression.d:210 — `final override const(char)* toChars() const`.
    override toChars(): DString {
        // FIXME: mangling (see runnable/mangle.d) relies on toChars outputting __lambdaXXX here
        const fe = this.isFuncExp();
        if (fe !== null)
            return fe.fd!.toChars();

        // D: `return .toChars(this);` — the module-scope `dmd.hdrgen.toChars(const Expression)`
        // (hdrgen.d:204), not this method.
        return expressionToChars(this); // dmd/expression.d:216
    }

    /**********************************
     * dmd/expression.d:222/237/242 — `static Expression combine(...)`, three arities.
     * Combine e1 and e2 by CommaExp if both are not NULL.
     *
     * Overload set collapsed by ARITY (04-functions.md §1 Form A): the 3- and 4-argument forms
     * are literally the 2-argument one applied twice.
     */
    static combine(e1: Expression | null, e2: Expression | null): Expression | null;
    static combine(e1: Expression | null, e2: Expression | null, e3: Expression | null): Expression | null;
    static combine(
        e1: Expression | null,
        e2: Expression | null,
        e3: Expression | null,
        e4: Expression | null,
    ): Expression | null;
    static combine(
        e1: Expression | null,
        e2: Expression | null,
        e3?: Expression | null,
        e4?: Expression | null,
    ): Expression | null {
        if (e4 !== undefined) {
            // dmd/expression.d:242 — `combine(combine(e1, e2), combine(e3, e4))`
            return Expression.combine(Expression.combine(e1, e2), Expression.combine(e3!, e4));
        }
        if (e3 !== undefined) {
            // dmd/expression.d:237 — `combine(combine(e1, e2), e3)`
            return Expression.combine(Expression.combine(e1, e2), e3);
        }
        // dmd/expression.d:222 — the two-argument base form.
        let r1 = e1;
        if (r1 !== null) {
            if (e2 !== null) {
                const ce: Expression = new CommaExp(r1.loc, r1, e2);
                ce.type = e2.type;
                r1 = ce;
            }
        } else
            r1 = e2;
        return r1;
    }

    /**********************************
     * dmd/expression.d:253 — `static Expression extractLast(Expression e, out Expression e0)`.
     * If 'e' is a tree of commas, returns the rightmost expression by stripping it off the tree.
     * The remaining part of the tree is returned via e0. Otherwise 'e' is directly returned and
     * e0 is set to NULL.
     *
     * `out Expression e0` -> single-slot box, RESET on entry (03-value-semantics.md §3.3).
     */
    static extractLast(e: Expression, e0: { value: Expression | null }): Expression {
        e0.value = null; // D default-initializes the `out` parameter on entry
        if (e.op !== EXP.comma) {
            return e;
        }

        let ce = e as unknown as CommaExp; // op-guarded downcast (D: `cast(CommaExp)e`)
        if (ce.e2!.op !== EXP.comma) {
            e0.value = ce.e1;
            return ce.e2!;
        } else {
            e0.value = e;

            // D: `Expression* pce = &ce.e2;` — a pointer to the `e2` SLOT of a CommaExp node.
            // JS has no interior pointers, so the slot is modelled by its owning node
            // (03-value-semantics.md §7.2); `*pce = ce.e1` becomes a write to `pceOwner.e2`.
            let pceOwner: CommaExp = ce;
            while ((pceOwner.e2 as unknown as CommaExp).e2!.op === EXP.comma) {
                pceOwner = pceOwner.e2 as unknown as CommaExp;
            }
            assert(pceOwner.e2!.op === EXP.comma);
            ce = pceOwner.e2 as unknown as CommaExp;
            pceOwner.e2 = ce.e1; // `*pce = ce.e1;`

            return ce.e2!;
        }
    }

    /// dmd/expression.d:283 — `static Expressions* arraySyntaxCopy(Expressions* exps)`.
    static arraySyntaxCopy(exps: Expressions | null): Expressions | null {
        let a: Expressions | null = null;
        if (exps !== null) {
            a = new DArray<Expression | null>(exps.length);
            for (let i = 0; i < exps.length; i++) {
                const e = exps.opIndex(i);
                a.opIndexAssign(e !== null ? e.syntaxCopy() : null, i);
            }
        }
        return a;
    }

    /******************************
     * dmd/expression.d:300 — `final Expression deref()`.
     * If this is a reference, dereference it.
     */
    deref(): Expression {
        // type could be null if forward referencing an 'auto' variable
        if (this.type !== null) {
            const tr = this.type.isTypeReference();
            if (tr !== null) {
                const e: Expression = new PtrExp(this.loc, this, tr.next);
                return e;
            }
        }
        return this;
    }

    /// dmd/expression.d:313 — `final int isConst()`.
    isConst(): number {
        switch (this.op) {
            case EXP.int64:
            case EXP.float64:
            case EXP.complex80:
                return 1;
            case EXP.null_:
                return 0;
            case EXP.symbolOffset:
                // resolved: `version (IN_LLVM)` is ON (_config.md §1), so its block is live; the
                // RUNTIME leg inside it is dropped as statically false (07 audit convention). The leg is
                // `soe.var.llvmInternal == LDCPragma.LLVMextern_weak && !soe.offset` (dmd/expression.d:333),
                // and `LDCPragma` is gen/dpragma.d's D binding, where `LLVMextern_weak` is 24; gen/pragma.cpp
                // stores the C++ numbering, where a weak extern is 25 and 24 is `LLVMconvertvector`
                // (gen/dpragma.ts header). 24 lands only on a convertvector template and, through
                // templatesem.d:1273, on its instance's function, whose address expressionsem.d:10380 refuses
                // (a magic intrinsic). So the leg matches nothing ldc2 accepts: ldc2 folds `&x` of a
                // `pragma(LDC_extern_weak)` extern to non-zero, as this port does. dropped: the weak-symbol
                // leg, with its `import gen.dpragma : LDCPragma;` (:327): that value import, even at the last
                // import position, breaks module load for 10 test files (Class extends value undefined).
                return 2;
            default:
                return 0;
        }
        // D has an unreachable `assert(0)` after the switch (dmd/expression.d:342); every arm
        // above returns, so TS reports it as unreachable code — dropped.
    }

    /// dmd/expression.d:345 — `bool hasCode()`.
    hasCode(): boolean {
        return true;
    }

    // ── dmd/expression.d:350-495 — the `isXxx()` downcast block ────────────────────────────────
    //
    // Each member is D's `op == EXP.x ? cast(typeof(return))this : null` — an op-guarded checked
    // downcast to a subclass. TS cannot narrow `this` to a subclass, so every arm uses the
    // audited two-step cascade `this as unknown as X` (02-types.md §11.5 shape). The guard that
    // makes each cast sound is the `op` test on the same line — the runtime object IS the
    // subclass, nothing is reinterpreted. `final pure inout nothrow @nogc @trusted` erased
    // (04-functions.md §8).
    isIntegerExp(): IntegerExp | null { return this.op === EXP.int64 ? (this as unknown as IntegerExp) : null; }
    isErrorExp(): ErrorExp | null { return this.op === EXP.error ? (this as unknown as ErrorExp) : null; }
    isVoidInitExp(): VoidInitExp | null { return this.op === EXP.void_ ? (this as unknown as VoidInitExp) : null; }
    isRealExp(): RealExp | null { return this.op === EXP.float64 ? (this as unknown as RealExp) : null; }
    isComplexExp(): ComplexExp | null { return this.op === EXP.complex80 ? (this as unknown as ComplexExp) : null; }
    isIdentifierExp(): IdentifierExp | null { return this.op === EXP.identifier ? (this as unknown as IdentifierExp) : null; }
    isDollarExp(): DollarExp | null { return this.op === EXP.dollar ? (this as unknown as DollarExp) : null; }
    isDsymbolExp(): DsymbolExp | null { return this.op === EXP.dSymbol ? (this as unknown as DsymbolExp) : null; }
    isThisExp(): ThisExp | null { return this.op === EXP.this_ ? (this as unknown as ThisExp) : null; }
    isSuperExp(): SuperExp | null { return this.op === EXP.super_ ? (this as unknown as SuperExp) : null; }
    isNullExp(): NullExp | null { return this.op === EXP.null_ ? (this as unknown as NullExp) : null; }
    isStringExp(): StringExp | null { return this.op === EXP.string_ ? (this as unknown as StringExp) : null; }
    isInterpExp(): InterpExp | null { return this.op === EXP.interpolated ? (this as unknown as InterpExp) : null; }
    isTupleExp(): TupleExp | null { return this.op === EXP.tuple ? (this as unknown as TupleExp) : null; }
    isArrayLiteralExp(): ArrayLiteralExp | null { return this.op === EXP.arrayLiteral ? (this as unknown as ArrayLiteralExp) : null; }
    isAssocArrayLiteralExp(): AssocArrayLiteralExp | null { return this.op === EXP.assocArrayLiteral ? (this as unknown as AssocArrayLiteralExp) : null; }
    isStructLiteralExp(): StructLiteralExp | null { return this.op === EXP.structLiteral ? (this as unknown as StructLiteralExp) : null; }
    isCompoundLiteralExp(): CompoundLiteralExp | null { return this.op === EXP.compoundLiteral ? (this as unknown as CompoundLiteralExp) : null; }
    isTypeExp(): TypeExp | null { return this.op === EXP.type ? (this as unknown as TypeExp) : null; }
    isScopeExp(): ScopeExp | null { return this.op === EXP.scope_ ? (this as unknown as ScopeExp) : null; }
    isTemplateExp(): TemplateExp | null { return this.op === EXP.template_ ? (this as unknown as TemplateExp) : null; }
    isNewExp(): NewExp | null { return this.op === EXP.new_ ? (this as unknown as NewExp) : null; }
    isNewAnonClassExp(): NewAnonClassExp | null { return this.op === EXP.newAnonymousClass ? (this as unknown as NewAnonClassExp) : null; }
    isSymOffExp(): SymOffExp | null { return this.op === EXP.symbolOffset ? (this as unknown as SymOffExp) : null; }
    isVarExp(): VarExp | null { return this.op === EXP.variable ? (this as unknown as VarExp) : null; }
    isOverExp(): OverExp | null { return this.op === EXP.overloadSet ? (this as unknown as OverExp) : null; }
    isFuncExp(): FuncExp | null { return this.op === EXP.function_ ? (this as unknown as FuncExp) : null; }
    isDeclarationExp(): DeclarationExp | null { return this.op === EXP.declaration ? (this as unknown as DeclarationExp) : null; }
    isTypeidExp(): TypeidExp | null { return this.op === EXP.typeid_ ? (this as unknown as TypeidExp) : null; }
    isTraitsExp(): TraitsExp | null { return this.op === EXP.traits ? (this as unknown as TraitsExp) : null; }
    isHaltExp(): HaltExp | null { return this.op === EXP.halt ? (this as unknown as HaltExp) : null; }
    isIsExp(): IsExp | null { return this.op === EXP.is_ ? (this as unknown as IsExp) : null; }
    isMixinExp(): MixinExp | null { return this.op === EXP.mixin_ ? (this as unknown as MixinExp) : null; }
    isImportExp(): ImportExp | null { return this.op === EXP.import_ ? (this as unknown as ImportExp) : null; }
    isAssertExp(): AssertExp | null { return this.op === EXP.assert_ ? (this as unknown as AssertExp) : null; }
    isThrowExp(): ThrowExp | null { return this.op === EXP.throw_ ? (this as unknown as ThrowExp) : null; }
    isDotIdExp(): DotIdExp | null { return this.op === EXP.dotIdentifier ? (this as unknown as DotIdExp) : null; }
    isDotTemplateExp(): DotTemplateExp | null { return this.op === EXP.dotTemplateDeclaration ? (this as unknown as DotTemplateExp) : null; }
    isDotVarExp(): DotVarExp | null { return this.op === EXP.dotVariable ? (this as unknown as DotVarExp) : null; }
    isDotTemplateInstanceExp(): DotTemplateInstanceExp | null { return this.op === EXP.dotTemplateInstance ? (this as unknown as DotTemplateInstanceExp) : null; }
    isDelegateExp(): DelegateExp | null { return this.op === EXP.delegate_ ? (this as unknown as DelegateExp) : null; }
    isDotTypeExp(): DotTypeExp | null { return this.op === EXP.dotType ? (this as unknown as DotTypeExp) : null; }
    isCallExp(): CallExp | null { return this.op === EXP.call ? (this as unknown as CallExp) : null; }
    isAddrExp(): AddrExp | null { return this.op === EXP.address ? (this as unknown as AddrExp) : null; }
    isPtrExp(): PtrExp | null { return this.op === EXP.star ? (this as unknown as PtrExp) : null; }
    isNegExp(): NegExp | null { return this.op === EXP.negate ? (this as unknown as NegExp) : null; }
    isUAddExp(): UAddExp | null { return this.op === EXP.uadd ? (this as unknown as UAddExp) : null; }
    isComExp(): ComExp | null { return this.op === EXP.tilde ? (this as unknown as ComExp) : null; }
    isNotExp(): NotExp | null { return this.op === EXP.not ? (this as unknown as NotExp) : null; }
    isDeleteExp(): DeleteExp | null { return this.op === EXP.delete_ ? (this as unknown as DeleteExp) : null; }
    isCastExp(): CastExp | null { return this.op === EXP.cast_ ? (this as unknown as CastExp) : null; }
    isVectorExp(): VectorExp | null { return this.op === EXP.vector ? (this as unknown as VectorExp) : null; }
    isVectorArrayExp(): VectorArrayExp | null { return this.op === EXP.vectorArray ? (this as unknown as VectorArrayExp) : null; }
    isSliceExp(): SliceExp | null { return this.op === EXP.slice ? (this as unknown as SliceExp) : null; }
    isArrayLengthExp(): ArrayLengthExp | null { return this.op === EXP.arrayLength ? (this as unknown as ArrayLengthExp) : null; }
    isArrayExp(): ArrayExp | null { return this.op === EXP.array ? (this as unknown as ArrayExp) : null; }
    isDotExp(): DotExp | null { return this.op === EXP.dot ? (this as unknown as DotExp) : null; }
    isCommaExp(): CommaExp | null { return this.op === EXP.comma ? (this as unknown as CommaExp) : null; }
    isIntervalExp(): IntervalExp | null { return this.op === EXP.interval ? (this as unknown as IntervalExp) : null; }
    isDelegatePtrExp(): DelegatePtrExp | null { return this.op === EXP.delegatePointer ? (this as unknown as DelegatePtrExp) : null; }
    isDelegateFuncptrExp(): DelegateFuncptrExp | null { return this.op === EXP.delegateFunctionPointer ? (this as unknown as DelegateFuncptrExp) : null; }
    isIndexExp(): IndexExp | null { return this.op === EXP.index ? (this as unknown as IndexExp) : null; }
    isPostExp(): PostExp | null { return (this.op === EXP.plusPlus || this.op === EXP.minusMinus) ? (this as unknown as PostExp) : null; }
    isPreExp(): PreExp | null { return (this.op === EXP.prePlusPlus || this.op === EXP.preMinusMinus) ? (this as unknown as PreExp) : null; }
    isAssignExp(): AssignExp | null { return this.op === EXP.assign ? (this as unknown as AssignExp) : null; }
    isLoweredAssignExp(): LoweredAssignExp | null { return this.op === EXP.loweredAssignExp ? (this as unknown as LoweredAssignExp) : null; }
    isConstructExp(): ConstructExp | null { return this.op === EXP.construct ? (this as unknown as ConstructExp) : null; }
    isBlitExp(): BlitExp | null { return this.op === EXP.blit ? (this as unknown as BlitExp) : null; }
    isAddAssignExp(): AddAssignExp | null { return this.op === EXP.addAssign ? (this as unknown as AddAssignExp) : null; }
    isMinAssignExp(): MinAssignExp | null { return this.op === EXP.minAssign ? (this as unknown as MinAssignExp) : null; }
    isMulAssignExp(): MulAssignExp | null { return this.op === EXP.mulAssign ? (this as unknown as MulAssignExp) : null; }
    isDivAssignExp(): DivAssignExp | null { return this.op === EXP.divAssign ? (this as unknown as DivAssignExp) : null; }
    isModAssignExp(): ModAssignExp | null { return this.op === EXP.modAssign ? (this as unknown as ModAssignExp) : null; }
    isAndAssignExp(): AndAssignExp | null { return this.op === EXP.andAssign ? (this as unknown as AndAssignExp) : null; }
    isOrAssignExp(): OrAssignExp | null { return this.op === EXP.orAssign ? (this as unknown as OrAssignExp) : null; }
    isXorAssignExp(): XorAssignExp | null { return this.op === EXP.xorAssign ? (this as unknown as XorAssignExp) : null; }
    isPowAssignExp(): PowAssignExp | null { return this.op === EXP.powAssign ? (this as unknown as PowAssignExp) : null; }
    isShlAssignExp(): ShlAssignExp | null { return this.op === EXP.leftShiftAssign ? (this as unknown as ShlAssignExp) : null; }
    isShrAssignExp(): ShrAssignExp | null { return this.op === EXP.rightShiftAssign ? (this as unknown as ShrAssignExp) : null; }
    isUshrAssignExp(): UshrAssignExp | null { return this.op === EXP.unsignedRightShiftAssign ? (this as unknown as UshrAssignExp) : null; }
    isCatAssignExp(): CatAssignExp | null { return this.op === EXP.concatenateAssign ? (this as unknown as CatAssignExp) : null; }
    isCatElemAssignExp(): CatElemAssignExp | null { return this.op === EXP.concatenateElemAssign ? (this as unknown as CatElemAssignExp) : null; }
    isCatDcharAssignExp(): CatDcharAssignExp | null { return this.op === EXP.concatenateDcharAssign ? (this as unknown as CatDcharAssignExp) : null; }
    isAddExp(): AddExp | null { return this.op === EXP.add ? (this as unknown as AddExp) : null; }
    isMinExp(): MinExp | null { return this.op === EXP.min ? (this as unknown as MinExp) : null; }
    isCatExp(): CatExp | null { return this.op === EXP.concatenate ? (this as unknown as CatExp) : null; }
    isMulExp(): MulExp | null { return this.op === EXP.mul ? (this as unknown as MulExp) : null; }
    isDivExp(): DivExp | null { return this.op === EXP.div ? (this as unknown as DivExp) : null; }
    isModExp(): ModExp | null { return this.op === EXP.mod ? (this as unknown as ModExp) : null; }
    isPowExp(): PowExp | null { return this.op === EXP.pow ? (this as unknown as PowExp) : null; }
    isShlExp(): ShlExp | null { return this.op === EXP.leftShift ? (this as unknown as ShlExp) : null; }
    isShrExp(): ShrExp | null { return this.op === EXP.rightShift ? (this as unknown as ShrExp) : null; }
    isUshrExp(): UshrExp | null { return this.op === EXP.unsignedRightShift ? (this as unknown as UshrExp) : null; }
    isAndExp(): AndExp | null { return this.op === EXP.and ? (this as unknown as AndExp) : null; }
    isOrExp(): OrExp | null { return this.op === EXP.or ? (this as unknown as OrExp) : null; }
    isXorExp(): XorExp | null { return this.op === EXP.xor ? (this as unknown as XorExp) : null; }
    isLogicalExp(): LogicalExp | null { return (this.op === EXP.andAnd || this.op === EXP.orOr) ? (this as unknown as LogicalExp) : null; }
    // dmd/expression.d:461 — `isCmpExp` is commented out upstream (no single EXP): kept absent.
    isInExp(): InExp | null { return this.op === EXP.in_ ? (this as unknown as InExp) : null; }
    isRemoveExp(): RemoveExp | null { return this.op === EXP.remove ? (this as unknown as RemoveExp) : null; }
    isEqualExp(): EqualExp | null { return (this.op === EXP.equal || this.op === EXP.notEqual) ? (this as unknown as EqualExp) : null; }
    isIdentityExp(): IdentityExp | null { return (this.op === EXP.identity || this.op === EXP.notIdentity) ? (this as unknown as IdentityExp) : null; }
    isCondExp(): CondExp | null { return this.op === EXP.question ? (this as unknown as CondExp) : null; }
    isGenericExp(): GenericExp | null { return this.op === EXP._Generic ? (this as unknown as GenericExp) : null; }
    isDefaultInitExp(): DefaultInitExp | null {
        return (this.op === EXP.prettyFunction || this.op === EXP.functionString ||
            this.op === EXP.line || this.op === EXP.moduleString ||
            this.op === EXP.file || this.op === EXP.fileFullPath) ? (this as unknown as DefaultInitExp) : null;
    }
    isFileInitExp(): FileInitExp | null { return (this.op === EXP.file || this.op === EXP.fileFullPath) ? (this as unknown as FileInitExp) : null; }
    isLineInitExp(): LineInitExp | null { return this.op === EXP.line ? (this as unknown as LineInitExp) : null; }
    isModuleInitExp(): ModuleInitExp | null { return this.op === EXP.moduleString ? (this as unknown as ModuleInitExp) : null; }
    isFuncInitExp(): FuncInitExp | null { return this.op === EXP.functionString ? (this as unknown as FuncInitExp) : null; }
    isPrettyFuncInitExp(): PrettyFuncInitExp | null { return this.op === EXP.prettyFunction ? (this as unknown as PrettyFuncInitExp) : null; }
    isObjcClassReferenceExp(): ObjcClassReferenceExp | null { return this.op === EXP.objcClassReference ? (this as unknown as ObjcClassReferenceExp) : null; }
    isClassReferenceExp(): ClassReferenceExp | null { return this.op === EXP.classReference ? (this as unknown as ClassReferenceExp) : null; }
    isThrownExceptionExp(): ThrownExceptionExp | null { return this.op === EXP.thrownException ? (this as unknown as ThrownExceptionExp) : null; }

    /// dmd/expression.d:481 — flag lookup in the `exptab` table (built at the bottom of the file).
    isUnaExp(): UnaExp | null {
        return (exptab[this.op] & EXPFLAGS.unary) !== 0 ? (this as unknown as UnaExp) : null;
    }
    /// dmd/expression.d:486.
    isBinExp(): BinExp | null {
        return (exptab[this.op] & EXPFLAGS.binary) !== 0 ? (this as unknown as BinExp) : null;
    }
    /// dmd/expression.d:491.
    isBinAssignExp(): BinAssignExp | null {
        return (exptab[this.op] & EXPFLAGS.binaryAssign) !== 0 ? (this as unknown as BinAssignExp) : null;
    }

    /// dmd/expression.d:497 — `override void accept(Visitor v) { v.visit(this); }` (13 §2).
    override accept(v: Visitor): void {
        v.visitExpression(this);
    }
}

/// dmd/expression.d:504 — `bool _isRoughlyScalar(Type _this)`.
/// Approximate non-semantic version of the `Type.isScalar` function in `typesem`.
/// NOTE (faithful): D's `tb.flags & TFlags.integral | TFlags.floating` parses as
/// `(tb.flags & TFlags.integral) | TFlags.floating`, so for ANY basic type the result is
/// non-zero — the function returns true for every `TypeBasic`. The TS operator precedence is
/// identical, so the expression is carried over verbatim rather than "fixed".
export function _isRoughlyScalar(_this: Type): boolean {
    const tb = _this.isTypeBasic();
    if (tb !== null)
        return (tb.flags & TFlags.integral | TFlags.floating) !== 0;
    else if (_this.ty === TY.Tenum || _this.ty === TY.Tpointer) // the enum is possibly scalar
        return true;
    return false;
}

/***********************************************************
 * dmd/expression.d:516 — `extern (C++) final class IntegerExp : Expression`.
 * A compile-time known integer value.
 */
export class IntegerExp extends Expression {
    value: dinteger_t; // `dinteger_t = ulong` -> bigint carrier (09-numerics.md §0)

    /**
     * dmd/expression.d:520 — `extern (D) this(Loc loc, dinteger_t value, Type type)`.
     *
     * The D overload set is Form B (04-functions.md §1.1(c)): `this(Loc, dinteger_t, Type)` and
     * `this(dinteger_t)` cannot both be constructors (their first parameters have different
     * types). This — the form every TS dependent already constructs — keeps the constructor; the
     * value-only form is `IntegerExp.fromValue` below.
     *
     * Preconditions (asserted, faithful): `type` is non-null and is roughly scalar (or `Terror`).
     */
    constructor(loc: Loc, value: dinteger_t, type: Type) {
        super(loc, EXP.int64);
        assert(type);

        /* Verify no path to the following assert failure.
         * Weirdly, the isScalar() includes floats - see enumsem.enumMemberSemantic() for the
         * base type. This is possibly a bug.
         */
        assert(_isRoughlyScalar(type) || type.ty === TY.Terror);

        this.type = type;
        this.value = IntegerExp.normalize(toBaseTypeNonSemantic(type).ty, value);
    }

    /**
     * dmd/expression.d:536 — `extern (D) this(dinteger_t value)`.
     * Form-B sibling of the constructor above (04-functions.md §1.1(c)): promoted to a named
     * static factory. `cast(int)value` stored into a `dinteger_t` (ulong) field is a 32-bit
     * mask + sign-extend, which is exactly `normalize(Tint32, value)` (09-numerics.md §2).
     */
    static fromValue(value: dinteger_t): IntegerExp {
        // The D body is `super(Loc.initial, EXP.int64); this.type = Type.tint32;
        // this.value = cast(int)value;`. Routing through the 3-arg constructor with
        // `Type.tint32` reproduces it EXACTLY: `toBaseTypeNonSemantic(tint32).ty == Tint32`, and
        // `normalize(Tint32, v)` is `maskSignedN(32, v)` which IS `cast(int)v` (09 §2). The two
        // extra asserts both hold for `tint32` (non-null, `_isRoughlyScalar` true).
        return new IntegerExp(Loc.initial, value, Type.tint32);
    }

    /// dmd/expression.d:543 — `static IntegerExp create(Loc loc, dinteger_t value, Type type)`.
    static create(loc: Loc, value: dinteger_t, type: Type): IntegerExp {
        return new IntegerExp(loc, value, type);
    }

    /// dmd/expression.d:548.
    override accept(v: Visitor): void {
        v.visitIntegerExp(this);
    }

    /// dmd/expression.d:553.
    getInteger(): dinteger_t {
        return this.value;
    }

    /// dmd/expression.d:558 — `extern (D) void setInteger(dinteger_t value)`.
    setInteger(value: dinteger_t): void {
        this.value = IntegerExp.normalize(toBaseTypeNonSemantic(this.type!).ty, value);
    }

    /**
     * dmd/expression.d:563 — `extern (D) static dinteger_t normalize(TY ty, dinteger_t value)`.
     * 'Normalize' the value of the integer to be in range of the type.
     *
     * The listed arms are exactly `normalizeInteger` (09-numerics.md §2.2), so the truncation
     * has ONE source of truth. The `default:` arm is NOT: D declares `dinteger_t result;`
     * (default-initialized to 0) and its `default: break;` falls out returning **0**, not the
     * input. `numeric.ts`'s `normalizeInteger` returns `value` there — that divergence is
     * reported to the integrator; this method reproduces D.
     */
    static normalize(ty: TY, value: dinteger_t): dinteger_t {
        let ty2: TY = ty;
        if (ty2 === TY.Tpointer)
            ty2 = Type.tsize_t.ty;
        switch (ty2) {
            case TY.Tbool:
            case TY.Tint8:
            case TY.Tchar:
            case TY.Tuns8:
            case TY.Tint16:
            case TY.Twchar:
            case TY.Tuns16:
            case TY.Tint32:
            case TY.Tdchar:
            case TY.Tuns32:
            case TY.Tint64:
            case TY.Tuns64:
                return normalizeInteger(ty2, value);
            default:
                return 0n; // `dinteger_t result;` (== 0) + `default: break;`
        }
    }

    /// dmd/expression.d:617 — `override IntegerExp syntaxCopy()`.
    override syntaxCopy(): IntegerExp {
        return this;
    }

    /**
     * dmd/expression.d:631 — `static IntegerExp literal(int v)()`.
     * Use this instead of creating new instances for commonly used literals such as 0 or 1.
     *
     * Each D template instantiation carries its OWN `__gshared theConstant`, so the port keys a
     * static cache by `v` (01-conventions.md §5.5).
     *
     * CONTRACT: the returned instance is a CACHED, SHARED singleton — every caller for the same
     * `v` gets the SAME object, and downstream code compares by identity. Callers MUST NOT
     * mutate it (loc/type/value); a type or location is painted on the PARENT node instead
     * (e.g. the zeroInit `BlitExp`, dmd/dsymbolsem.d:2212).
     *
     * Parameters:
     *      v = The value of the expression
     * Returns:
     *      A static instance of the expression, typed as `Tint32`.
     */
    private static literalCache = new Map<number, IntegerExp>();
    static literal(v: number): IntegerExp {
        let theConstant = IntegerExp.literalCache.get(v);
        if (theConstant === undefined) {
            theConstant = IntegerExp.fromValue(BigInt(v));
            IntegerExp.literalCache.set(v, theConstant);
        }
        return theConstant;
    }

    /**
     * dmd/expression.d:647 — `static IntegerExp createBool(bool b)`.
     * Use this instead of creating new instances for commonly used bools.
     * The two `__gshared` locals become statics of the same lifetime (01-conventions.md §5.5).
     *
     * Parameters:
     *      b = The value of the expression
     * Returns:
     *      A static instance of the expression, typed as `Type.tbool`.
     */
    private static trueExp: IntegerExp | null = null;
    private static falseExp: IntegerExp | null = null;
    static createBool(b: boolean): IntegerExp {
        if (IntegerExp.trueExp === null) {
            IntegerExp.trueExp = new IntegerExp(Loc.initial, 1n, Type.tbool);
            IntegerExp.falseExp = new IntegerExp(Loc.initial, 0n, Type.tbool);
        }
        return b ? IntegerExp.trueExp : IntegerExp.falseExp!;
    }

    /**
     * No D counterpart: called by the test harness and by the djs driver between two compiles
     * (src/djs.ts `deinitializeFrontend`), never by frontend code. D is a one-shot process; a second
     * `Type._init()` in one process would otherwise leave these caches holding literals typed with a
     * STALE `Type.tint32`/`tbool` — a state impossible in D. Call it next to `Type._init()` (01 §5.5).
     */
    static _resetLiteralCache(): void {
        IntegerExp.literalCache.clear();
        IntegerExp.trueExp = null;
        IntegerExp.falseExp = null;
    }
}

/***********************************************************
 * dmd/expression.d:664 — `extern (C++) final class ErrorExp : Expression`.
 * Use this expression for error recovery.
 *
 * It should behave as a 'sink' to prevent further cascaded error messages.
 */
export class ErrorExp extends Expression {
    // dmd/expression.d:666.
    constructor() {
        super(Loc.initial, EXP.error);
        this.type = Type.terror;
    }

    /// dmd/expression.d:672 — `static ErrorExp get()`.
    static get(): ErrorExp {
        if (ErrorExp.errorexp === null)
            ErrorExp.errorexp = new ErrorExp();

        if (global.errors === 0 && global.gaggedErrors === 0) {
            /* Unfortunately, errors can still leak out of gagged errors,
             * and we need to set the error count to prevent bogus code
             * generation. At least give a message.
             */
            error(Loc.initial, ds("unknown, please file report at https://github.com/dlang/dmd/issues/new"));
        }

        return ErrorExp.errorexp;
    }

    /// dmd/expression.d:689.
    override accept(v: Visitor): void {
        v.visitErrorExp(this);
    }

    /// dmd/expression.d:694 — `extern (C++) __gshared ErrorExp errorexp;` (handy shared value).
    static errorexp: ErrorExp | null = null;
}

/***********************************************************
 * dmd/expression.d:704 — `extern (C++) final class VoidInitExp : Expression`.
 * An uninitialized value, generated from void initializers.
 *
 * https://dlang.org/spec/declaration.html#void_init
 */
export class VoidInitExp extends Expression {
    var_: VarDeclaration; /// ported: D field `var` (JS-reserved, 01-conventions.md §2.3) -> var_.
    /// The variable from where the void value came from, null if not known.
    /// Useful for error messages.

    // dmd/expression.d:709.
    constructor(var_: VarDeclaration) {
        super(var_.loc, EXP.void_);
        this.var_ = var_;
        this.type = var_.type;
    }

    /// dmd/expression.d:716.
    override accept(v: Visitor): void {
        v.visitVoidInitExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:726 — `extern (C++) final class RealExp : Expression`.
 * A compile-time known floating point number.
 */
export class RealExp extends Expression {
    value: real_t; // real_t == double == number on this target (09-numerics.md §6)

    // dmd/expression.d:730.
    constructor(loc: Loc, value: real_t, type: Type | null) {
        super(loc, EXP.float64);
        this.value = value;
        this.type = type;
    }

    /// dmd/expression.d:738.
    static create(loc: Loc, value: real_t, type: Type | null): RealExp {
        return new RealExp(loc, value, type);
    }

    /// dmd/expression.d:743.
    override accept(v: Visitor): void {
        v.visitRealExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:752 — `extern (C++) final class ComplexExp : Expression`.
 * A compile-time known complex number (deprecated).
 */
export class ComplexExp extends Expression {
    value: complex_t; // VALUE struct (03-value-semantics.md)

    // dmd/expression.d:756.
    constructor(loc: Loc, value: complex_t, type: Type | null) {
        super(loc, EXP.complex80);
        // D: `this.value = value;` — a by-value struct field store (03-value-semantics.md §1 #5).
        this.value = value.copy();
        this.type = type;
    }

    /// dmd/expression.d:764.
    static create(loc: Loc, value: complex_t, type: Type | null): ComplexExp {
        // D passes `value` BY VALUE into the ctor; the ctor's field store already copies, and the
        // parameter itself is not mutated here — copy elided (03 §9), one copy total as in D.
        return new ComplexExp(loc, value, type);
    }

    /// dmd/expression.d:769.
    override accept(v: Visitor): void {
        v.visitComplexExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:783 — `extern (C++) class IdentifierExp : Expression`.
 * An identifier in the context of an expression (as opposed to a declaration).
 *
 * ---
 * int x; // VarDeclaration with Identifier
 * x++; // PostExp with IdentifierExp
 * ---
 */
export class IdentifierExp extends Expression {
    ident: Identifier | null = null;

    // dmd/expression.d:787.
    constructor(loc: Loc, ident: Identifier | null) {
        super(loc, EXP.identifier);
        this.ident = ident;
    }

    /// dmd/expression.d:793.
    static create(loc: Loc, ident: Identifier | null): IdentifierExp {
        return new IdentifierExp(loc, ident);
    }

    /// dmd/expression.d:798.
    override accept(v: Visitor): void {
        v.visitIdentifierExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:809 — `extern (C++) final class DollarExp : IdentifierExp`.
 * The dollar operator used when indexing or slicing an array. E.g `a[$]`, `a[1 .. $]` etc.
 *
 * https://dlang.org/spec/arrays.html#array-length
 */
export class DollarExp extends IdentifierExp {
    // dmd/expression.d:811.
    constructor(loc: Loc) {
        super(loc, Id.dollar);
    }

    /// dmd/expression.d:816.
    override accept(v: Visitor): void {
        v.visitDollarExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:825 — `extern (C++) final class DsymbolExp : Expression`.
 * Won't be generated by parser.
 */
export class DsymbolExp extends Expression {
    s: Dsymbol | null = null;
    hasOverloads: boolean;

    // dmd/expression.d:830.
    constructor(loc: Loc, s: Dsymbol | null, hasOverloads = true) {
        super(loc, EXP.dSymbol);
        this.s = s;
        this.hasOverloads = hasOverloads;
    }

    /// dmd/expression.d:837.
    override accept(v: Visitor): void {
        v.visitDsymbolExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:846 — `extern (C++) class ThisExp : Expression`.
 * https://dlang.org/spec/expression.html#this
 */
export class ThisExp extends Expression {
    var_: VarDeclaration | null = null; // ported: D field `var` -> var_ (01 §2.3)

    // dmd/expression.d:850 (`this(Loc)`) and :856 (`this(Loc, const EXP tok)`) — arity dispatch
    // (04-functions.md §1 Form A): the 1-arg form is the 2-arg one with `tok = EXP.this_`.
    constructor(loc: Loc, tok: EXP = EXP.this_) {
        super(loc, tok);
    }

    /// dmd/expression.d:862 — `override ThisExp syntaxCopy()`.
    override syntaxCopy(): ThisExp {
        const r = super.syntaxCopy() as unknown as ThisExp; // D: `cast(ThisExp) super.syntaxCopy()`
        // require new semantic (possibly new `var` etc.)
        r.type = null;
        r.var_ = null;
        return r;
    }

    /// dmd/expression.d:871.
    override accept(v: Visitor): void {
        v.visitThisExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:880 — `extern (C++) final class SuperExp : ThisExp`.
 * https://dlang.org/spec/expression.html#super
 */
export class SuperExp extends ThisExp {
    // dmd/expression.d:882.
    constructor(loc: Loc) {
        super(loc, EXP.super_);
    }

    /// dmd/expression.d:887.
    override accept(v: Visitor): void {
        v.visitSuperExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:898 — `extern (C++) final class NullExp : Expression`.
 * A compile-time known `null` value.
 *
 * https://dlang.org/spec/expression.html#null
 */
export class NullExp extends Expression {
    // dmd/expression.d:900.
    constructor(loc: Loc, type: Type | null = null) {
        super(loc, EXP.null_);
        this.type = type;
    }

    /// dmd/expression.d:906.
    override accept(v: Visitor): void {
        v.visitNullExp(this);
    }
}

// dmd/expression.d:944 — `enum char NoPostfix = 0;`, a StringExp-scoped manifest enum. Hoisted to
// a module const (02-types.md §4.1); prefixed because InterpExp declares its own (:1261).
// EXPORTED because it is read from ANOTHER module as `StringExp.NoPostfix` — dinterpret.d:5813
// and :5831 — which 02-types.md §4.1 handles by re-exporting the module const and rewriting the
// foreign reference to the (here prefixed) bare name. `InterpExp_NoPostfix` has no such reader
// (tree-wide grep: `NoPostfix` occurs only in expression.d and dinterpret.d) and stays private.
export const StringExp_NoPostfix = 0;

// INVARIANT: the host stores typed-array elements little-endian. StringExp's width views
// (`peekWstring`/`peekDstring` and the width-8 view) read its byte payload in host order, which the ruling
// fixes as little-endian (arm64); a big-endian host would silently byte-swap every w/d string.
assert(new Uint8Array(new Uint16Array([1]).buffer)[0] === 1, "StringExp payload requires a little-endian host");

// D's `null[0 .. 0]`: the view of a null payload. ONE shared empty buffer, so two null payloads compare
// equal by buffer identity, as two null pointers do (`peekString().ptr ==` at dmd/ctfeexpr.d:756).
const NULL_PAYLOAD = new Uint8Array(0);

/***********************************************************
 * dmd/expression.d:915 — `extern (C++) final class StringExp : Expression`.
 * https://dlang.org/spec/expression.html#string_literals
 *
 * The payload union at dmd/expression.d:919-925
 *     private union { char* string; wchar* wstring; dchar* dstring; ulong* lstring; }
 * is ported per the ratified model (11-escalate.md §3.5): ONE byte buffer, `string`, holding the `len * sz`
 * bytes of the code units, little-endian as on arm64, plus the terminator where the D code allocates one
 * past `len * sz`. `sz` (1, 2, 4, or 8 for a `ulong[]` payload) selects the width at every access: a D read
 * or write through `wstring`/`dstring`/`lstring` (or a `cast(wchar*)string`) is a width-`sz` read or write
 * over those bytes. `peekData`/`borrowData` expose the bytes; `peekString`/`peekWstring`/`peekDstring` are
 * the width views.
 *
 * Aliasing: the buffer is shared exactly where D shares the pointer — `copy()` is a shallow clone, so a
 * copied node and its source see each other's in-place writes (`borrowData`, `setIndex`), as in D. The
 * constructor and `setData` take a `number[]` and store a fresh buffer, so the width views are always
 * aligned (byte offset 0); every in-tree caller hands over a fresh array, which is D's ownership transfer.
 */
export class StringExp extends Expression {
    postfix: number = StringExp_NoPostfix; // 'c', 'w', 'd' (dmd/expression.d:917)
    ownedByCtfe: OwnedBy = OwnedBy.code;

    // dmd/expression.d:919-925 — the payload union as one byte buffer (see the class doc): `len * sz` bytes of
    // little-endian code units of width `sz`, plus any terminator (never fewer: `peekData` asserts it).
    // `null` is D's null pointer, legal with len 0.
    // (const if ownedByCtfe == OwnedBy.code)
    string: Uint8Array | null = null;

    len = 0; // number of code units (dmd/expression.d:926)
    sz = 1; // 1: char, 2: wchar, 4: dchar (dmd/expression.d:927)

    /**
     *  dmd/expression.d:937 — Whether the string literal's type is fixed
     *  Example:
     *  ---
     *  wstring x = "abc"; // OK, string literal is flexible
     *  wstring y = cast(string) "abc"; // Error: type was committed after cast
     *  ---
     */
    committed = false;

    /// If the string is parsed from a hex string literal (dmd/expression.d:940)
    hexString = false;
    /// If the string is from a collected C macro (dmd/expression.d:942)
    cMacro = false;

    // dmd/expression.d:946 (`this(Loc, const(void)[])`) and :954 (the full form) — arity dispatch
    // (04-functions.md §1 Form A): the 2-arg form IS the long one with the defaults filled in
    // (`len = string.length`, `sz = 1`, `postfix = NoPostfix`, `cMacro = false`), so the §1
    // decision test is satisfied and no branch is needed. `len`'s default reads the earlier
    // parameter, which TS evaluates left-to-right — that keeps every intermediate arity a
    // DEFINED shape (a 3-argument call gets `sz = 1`, D's own default) instead of leaving `sz`
    // `undefined` and letting `getIndex`'s switch fall to `SwitchError`.
    // `string_` is the payload's BYTES (`len * sz` of them, plus any terminator the caller allocated); they
    // are copied into a fresh buffer (see the class doc).
    constructor(loc: Loc, string_: number[] | null, len: number = (string_ !== null ? string_.length : 0),
                sz = 1, // work around LDC bug #1286
                postfix: number = StringExp_NoPostfix, cMacro = false) {
        super(loc, EXP.string_);
        // note that this.string should be const
        this.string = string_ !== null ? Uint8Array.from(string_) : null;
        this.len = len;
        this.sz = sz;
        this.postfix = postfix;
        this.cMacro = cMacro;
        if (K.on && this.string !== null) keepString(this.string);   // the kept-module engine: a generated name?
    }

    /// dmd/expression.d:964 — `static StringExp create(Loc loc, const(char)* s)`.
    /// Form-B rename (04-functions.md §1 Form B, the doc's own worked example for this very
    /// pair): the C-string form becomes `createFromCStr`, the ptr+len form `createFromBuf`.
    /// `s` is a C string: its logical content stops at the first NUL (`toDString`, root/string.d).
    static createFromCStr(loc: Loc, s: DString): StringExp {
        return new StringExp(loc, [...toDString(s)!]);
    }

    /// dmd/expression.d:969 — `static StringExp create(Loc loc, const(void)* string, size_t len)`.
    static createFromBuf(loc: Loc, string_: number[], len: number): StringExp {
        return new StringExp(loc, string_.slice(0, len)); // `string[0 .. len]`
    }

    /**
     * D's `lstring[0 .. len]`: the payload as `len` 64-bit code units, a view sharing the byte buffer (the
     * width-8 counterpart of `peekWstring`/`peekDstring`, which D spells inline). Precondition: `sz == 8`.
     */
    private lstringView(): BigUint64Array {
        const bytes = this.peekData();
        return new BigUint64Array(bytes.buffer, bytes.byteOffset, this.len);
    }

    /**********************************
     * dmd/expression.d:983 — `extern (D) size_t numberOfCodeUnits(int tynto, out .string s) const`.
     * Return the number of code units the string would be if it were re-encoded as tynto.
     * Params:
     *      tynto = code unit type of the target encoding
     *      s = set to error message on invalid string (`out`: reset to null on entry, 03 §3.3)
     * Returns:
     *      number of code units
     */
    numberOfCodeUnits(tynto: number, s: { value: DString | null }): number {
        s.value = null;
        let encSize: number;
        switch (tynto) {
            case 0: return this.len;
            case TY.Tchar: encSize = 1; break;
            case TY.Twchar: encSize = 2; break;
            case TY.Tdchar: encSize = 4; break;
            default:
                assertUnreachable();
        }
        if (this.sz === encSize)
            return this.len;

        let result = 0;

        switch (this.sz) {
            case 1: {
                const string_ = this.peekData(); // `string[0 .. len]`
                for (let u = 0; u < this.len;) {
                    const r = utf_decodeChar(string_, u); // `ref u` and `out c` come back in the result (08 §7.2)
                    u = r.nextIdx;
                    s.value = r.error;
                    if (s.value !== null)
                        return 0;
                    result += utf_codeLength(encSize, r.dchar);
                }
                break;
            }
            case 2: {
                const wstring = this.peekWstring(); // `wstring[0 .. len]`
                for (let u = 0; u < this.len;) {
                    const r = utf_decodeWchar(wstring, u);
                    u = r.nextIdx;
                    s.value = r.error;
                    if (s.value !== null)
                        return 0;
                    result += utf_codeLength(encSize, r.dchar);
                }
                break;
            }
            case 4: {
                const dstring = this.peekDstring();
                for (let u = 0; u < this.len; u++)
                    result += utf_codeLength(encSize, dstring[u]!);
                break;
            }
            default:
                assertUnreachable();
        }
        return result;
    }

    /**********************************************
     * dmd/expression.d:1044 — `void writeTo(void* dest, bool zero, int tyto = 0) const`.
     * Write the contents of the string to dest.
     * Use numberOfCodeUnits() to determine size of result.
     * Params:
     *  dest = destination, at least `len * sz` bytes (plus `sz` when `zero`)
     *  tyto = encoding type of the result
     *  zero = add terminating 0
     */
    writeTo(dest: Uint8Array, zero: boolean, tyto = 0): void {
        let encSize: number;
        switch (tyto) {
            case 0: encSize = this.sz; break;
            case TY.Tchar: encSize = 1; break;
            case TY.Twchar: encSize = 2; break;
            case TY.Tdchar: encSize = 4; break;
            default:
                assertUnreachable();
        }
        if (this.sz === encSize) {
            dest.set(this.peekData(), 0); // `memcpy(dest, string, len * sz)`
            if (zero)
                dest.fill(0, this.len * this.sz, this.len * this.sz + this.sz); // `memset(dest + len * sz, 0, sz)`
        } else
            assertUnreachable();
    }

    /*********************************************
     * dmd/expression.d:1073 — `dchar getCodeUnit(size_t i) const pure`.
     * Get the code unit at index i
     * Params:
     *  i = index
     * Returns:
     *  code unit at index i
     */
    getCodeUnit(i: number): number {
        assert(this.sz <= 4); // D: `assert(this.sz <= dchar.sizeof)` (dchar.sizeof == 4)
        // `cast(dchar) getIndex(i)`: a 32-bit unsigned truncation of the `dinteger_t` carrier
        // (09-numerics.md §2.1) — masked FIRST, so the `number` the dchar domain wants is
        // provably < 2^32 and the bigint -> number step is exact.
        return Number(maskUnsignedN(32, this.getIndex(i)));
    }

    /// dmd/expression.d:1080 — `dinteger_t getIndex(size_t i) const pure`. Integer at index `i`.
    getIndex(i: number): dinteger_t {
        assert(i < this.len);
        // D: `final switch (sz) { case 1: string[i]; case 2: wstring[i]; case 4: dstring[i];
        //     case 8: lstring[i]; }` — each arm reads one code unit of width `sz`, unsigned.
        switch (this.sz) {
            case 1:
                return BigInt(this.peekData()[i]!);
            case 2:
                return BigInt(this.peekWstring()[i]!);
            case 4:
                return BigInt(this.peekDstring()[i]!);
            case 8:
                return this.lstringView()[i]!;
            default:
                // D `final switch (sz)` — an unlisted subject throws `SwitchError` (06 §3.2).
                throw new SwitchError();
        }
    }

    /*********************************************
     * dmd/expression.d:1102 — `extern (D) void setCodeUnit(size_t i, dchar c)`.
     * Set the code unit at index i to c
     * Params:
     *  i = index
     *  c = code unit to set it to
     */
    setCodeUnit(i: number, c: number): void {
        this.setIndex(i, BigInt(c));
    }

    /// dmd/expression.d:1107 — `extern (D) void setIndex(size_t i, long c)`.
    setIndex(i: number, c: bigint): void {
        assert(i < this.len);
        switch (this.sz) {
            case 1:
                // `string[i] = cast(char)c;` — 8-bit unsigned truncation (09 §2.1), masked in the
                // bigint domain first so the stored `number` is provably a byte.
                this.peekData()[i] = Number(maskUnsignedN(8, c));
                break;
            case 2:
                this.peekWstring()[i] = Number(maskUnsignedN(16, c)); // `wstring[i] = cast(wchar)c;`
                break;
            case 4:
                this.peekDstring()[i] = Number(maskUnsignedN(32, c)); // `dstring[i] = cast(dchar) c;`
                break;
            case 8:
                this.lstringView()[i] = toUint64(c); // `lstring[i] = c;`: the long's 64 bits
                break;
            default:
                // D `final switch (sz)` — an unlisted subject throws `SwitchError` (06 §3.2).
                throw new SwitchError();
        }
    }

    /**
     * dmd/expression.d:1148 — `int compare(const StringExp se2) const`.
     * Compare two `StringExp` by length, then value.
     *
     * The comparison is not the usual C-style comparison as seen with `strcmp` or `memcmp`, but
     * instead first compares based on the length. This allows both faster lookup and sorting
     * when comparing sparse data. This ordering scheme is relied on by the string-switching
     * feature; code in Druntime's `core.internal.switch_` relies on it when doing a binary
     * search among case statements. Both `StringExp` should be of the same encoding.
     *
     * Params:
     *   se2 = String expression to compare `this` to
     * Returns:
     *   `0` when `this` is equal to se2, a value greater than `0` if `this` should be considered
     *   greater than `se2`, and a value less than `0` if `this` is lesser than `se2`.
     */
    compare(se2: StringExp): number {
        const len1 = this.len;
        const len2 = se2.len;

        assert(this.sz === se2.sz, "Comparing string expressions of different sizes");
        if (len1 !== len2)
            return toInt32(len1 - len2); // D `cast(int)(len1 - len2)`
        switch (this.sz) {
            case 1: {
                // D `return memcmp(string, se2.string, len1);` — only the SIGN of memcmp is
                // specified, and the class doc above states the contract as sign-only ("a value
                // greater than 0 / less than 0"). The byte loop reproduces that sign; the payload
                // is unsigned bytes for sz == 1, so the difference needs no widening.
                const b1 = this.peekData();
                const b2 = se2.peekData();
                for (let u = 0; u < len1; ++u) {
                    if (b1[u] !== b2[u])
                        return b1[u]! - b2[u]!;
                }
                return 0;
            }
            case 2: {
                const s1 = this.peekWstring(); // `cast(wchar*)string`
                const s2 = se2.peekWstring();
                for (let u = 0; u < this.len; u++) {
                    if (s1[u] !== s2[u])
                        return s1[u]! - s2[u]!; // wchar operands promote to int: the difference is exact
                }
                break;
            }
            case 4: {
                const s1 = this.peekDstring(); // `cast(dchar*)string`
                const s2 = se2.peekDstring();
                for (let u = 0; u < this.len; u++) {
                    if (s1[u] !== s2[u])
                        return toInt32(s1[u]! - s2[u]!); // `dchar - dchar` wraps as uint, returned as int
                }
                break;
            }
            default:
                // D `default: assert(0);` (dmd/expression.d:1186) — a faithful assert(0), not a wall.
                assertUnreachable();
        }
        return 0;
    }

    /********************************
     * dmd/expression.d:1195 — `extern (D) const(char)[] toStringz() const`.
     * Convert string contents to a 0 terminated string, allocated by mem.xmalloc().
     * Returns the `len * sz` payload bytes; the `sz` zero bytes of the terminator sit past the returned
     * view in the same buffer, as in D.
     */
    toStringz(): DString {
        const nbytes = this.len * this.sz;
        const s = new Uint8Array(nbytes + this.sz); // `mem.xmalloc(nbytes + sz)` (08 §13)
        this.writeTo(s, true);
        return s.subarray(0, nbytes);
    }

    /// dmd/expression.d:1203 — `extern (D) const(char)[] peekString() const`.
    peekString(): DString {
        assert(this.sz === 1);
        return this.peekData(); // `this.string[0 .. len]`
    }

    /// dmd/expression.d:1209 — `extern (D) const(wchar)[] peekWstring() const`.
    peekWstring(): Uint16Array {
        assert(this.sz === 2);
        const bytes = this.peekData();
        return new Uint16Array(bytes.buffer, bytes.byteOffset, this.len); // `this.wstring[0 .. len]`
    }

    /// dmd/expression.d:1215 — `extern (D) const(dchar)[] peekDstring() const`.
    peekDstring(): Uint32Array {
        assert(this.sz === 4);
        const bytes = this.peekData();
        return new Uint32Array(bytes.buffer, bytes.byteOffset, this.len); // `this.dstring[0 .. len]`
    }

    /*******************
     * dmd/expression.d:1224 — `extern (D) const(ubyte)[] peekData() const`.
     * Get a slice of the data: a VIEW of the `len * sz` payload bytes, sharing the buffer.
     *
     * INVARIANT: the buffer holds at least `len * sz` bytes (a null payload has `len` 0). D slices the
     * pointer with no bounds check, so a node whose `len * sz` passes its allocation reads past it there
     * (UB: `cast(char[5])("a"w ~ "b"w)[4]` prints a garbage byte in ldc2); here that is an AssertError.
     * The one D caller that slices past on purpose, dcast.d:2459-2479, reads the source node instead
     * (see dcast.ts).
     */
    peekData(): Uint8Array {
        assert(this.string === null ? this.len === 0 : this.len * this.sz <= this.string.length);
        return this.string === null ? NULL_PAYLOAD : this.string.subarray(0, this.len * this.sz);
    }

    /*******************
     * dmd/expression.d:1233 — `extern (D) ubyte[] borrowData()`.
     * Borrow a slice of the data, so the caller can modify it in-place (!)
     */
    borrowData(): Uint8Array {
        return this.peekData(); // `cast(ubyte[])this.string[0 .. len * sz]`: the same shared view
    }

    /***********************
     * dmd/expression.d:1242 — `extern (D) void setData(void* s, size_t len, ubyte sz)`.
     * Set new string data. `this` becomes the new owner of the data: `s` holds the `len * sz` payload
     * bytes, stored as a fresh buffer.
     */
    setData(s: number[], len: number, sz: number): void {
        this.string = Uint8Array.from(s);
        this.len = len;
        this.sz = sz;
    }

    /// dmd/expression.d:1249.
    override accept(v: Visitor): void {
        v.visitStringExp(this);
    }
}

// dmd/expression.d:1261 — `enum char NoPostfix = 0;` (InterpExp-scoped manifest enum, 02 §4.1).
const InterpExp_NoPostfix = 0;

/***********************************************************
 * dmd/expression.d:1255 — `extern (C++) final class InterpExp : Expression`.
 */
export class InterpExp extends Expression {
    postfix: number = InterpExp_NoPostfix; // 'c', 'w', 'd'
    ownedByCtfe: OwnedBy = OwnedBy.code;
    interpolatedSet: InterpolatedSet | null = null;

    // dmd/expression.d:1263.
    constructor(loc: Loc, set: InterpolatedSet | null, postfix: number = InterpExp_NoPostfix) {
        super(loc, EXP.interpolated);
        this.interpolatedSet = set;
        this.postfix = postfix;
    }

    /// dmd/expression.d:1270.
    override accept(v: Visitor): void {
        v.visitInterpExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1285 — `extern (C++) final class TupleExp : Expression`.
 * A sequence of expressions
 *
 * ---
 * alias AliasSeq(T...) = T;
 * alias Tup = AliasSeq!(3, int, "abc");
 * ---
 */
export class TupleExp extends Expression {
    /* Tuple-field access may need to take out its side effect part.
     * For example:
     *      foo().tupleof
     * is rewritten as:
     *      (ref __tup = foo(); tuple(__tup.field0, __tup.field1, ...))
     * The declaration of temporary variable __tup will be stored in TupleExp.e0.
     */
    e0: Expression | null = null;

    exps: Expressions | null = null;

    // dmd/expression.d:1298 — `this(Loc loc, Expression e0, Expressions* exps)`.
    // This is the widest form and the one `syntaxCopy` builds, so it keeps the constructor; the
    // two same-arity-2 forms below are Form-B static factories (04-functions.md §1.1(c)).
    constructor(loc: Loc, e0: Expression | null, exps: Expressions | null) {
        super(loc, EXP.tuple);
        this.e0 = e0;
        this.exps = exps;
    }

    /// dmd/expression.d:1306 — `this(Loc loc, Expressions* exps)` (leaves `e0` null).
    static fromExps(loc: Loc, exps: Expressions | null): TupleExp {
        return new TupleExp(loc, null, exps);
    }

    /// dmd/expression.d:1313 — `this(Loc loc, TupleDeclaration tup)`.
    /// "the rest of the constructor is moved to expressionsem.d in fillTupleExpExps function".
    static fromTupleDeclaration(loc: Loc, _tup: TupleDeclaration): TupleExp {
        return new TupleExp(loc, null, new DArray<Expression | null>());
    }

    /// dmd/expression.d:1320 — `static TupleExp create(Loc loc, Expressions* exps)`.
    static create(loc: Loc, exps: Expressions | null): TupleExp {
        return TupleExp.fromExps(loc, exps);
    }

    /// dmd/expression.d:1325.
    override syntaxCopy(): TupleExp {
        return new TupleExp(this.loc, this.e0 !== null ? this.e0.syntaxCopy() : null,
            Expression.arraySyntaxCopy(this.exps));
    }

    /// dmd/expression.d:1330.
    override accept(v: Visitor): void {
        v.visitTupleExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1341 — `extern (C++) final class ArrayLiteralExp : Expression`.
 * [ e1, e2, e3, ... ]
 *
 * https://dlang.org/spec/expression.html#array_literals
 */
export class ArrayLiteralExp extends Expression {
    ownedByCtfe: OwnedBy = OwnedBy.code;
    onstack = false;

    /** If !is null, elements[] can be sparse and basis is used for the
     * "default" element value. In other words, non-null elements[i] overrides
     * this 'basis' value.
     */
    basis: Expression | null = null;

    elements: Expressions | null = null;

    lowering: Expression | null = null;

    // aaLiteral is set if this is an array of values of an AA literal
    // only used during CTFE to show the original AA in error messages instead
    aaLiteral: AssocArrayLiteralExp | null = null;

    // dmd/expression.d:1360 — `this(Loc loc, Type type, Expressions* elements)`. Keeps the
    // constructor (it is what every TS dependent already builds); the same-arity `Expression e`
    // form and the 4-arg `basis` form are Form-B static factories (04-functions.md §1.1(c)).
    constructor(loc: Loc, type: Type | null, elements: Expressions | null) {
        super(loc, EXP.arrayLiteral);
        this.type = type;
        this.elements = elements;
    }

    /// dmd/expression.d:1367 — `this(Loc loc, Type type, Expression e)` (single-element form).
    static fromExp(loc: Loc, type: Type | null, e: Expression | null): ArrayLiteralExp {
        return new ArrayLiteralExp(loc, type, DArray.from<Expression | null>(e)); // `new Expressions(e)`
    }

    /// dmd/expression.d:1374 — `this(Loc loc, Type type, Expression basis, Expressions* elements)`.
    static fromBasis(loc: Loc, type: Type | null, basis: Expression | null,
                     elements: Expressions | null): ArrayLiteralExp {
        const ale = new ArrayLiteralExp(loc, type, elements);
        ale.basis = basis;
        return ale;
    }

    /// dmd/expression.d:1382 — `static ArrayLiteralExp create(Loc loc, Expressions* elements)`.
    static create(loc: Loc, elements: Expressions | null): ArrayLiteralExp {
        return new ArrayLiteralExp(loc, null, elements);
    }

    /// dmd/expression.d:1387.
    override syntaxCopy(): ArrayLiteralExp {
        return ArrayLiteralExp.fromBasis(this.loc,
            null,
            this.basis !== null ? this.basis.syntaxCopy() : null,
            Expression.arraySyntaxCopy(this.elements));
    }

    /// dmd/expression.d:1395 — `Expression getElement(size_t i)` ("use opIndex instead").
    getElement(i: number): Expression | null {
        return this.opIndex(i); // D: `return this[i];` -> the opIndex overload (05 §7)
    }

    /// dmd/expression.d:1400 — `extern (D) Expression opIndex(size_t i)` (05-operators.md §7).
    opIndex(i: number): Expression | null {
        const el = this.elements!.opIndex(i);
        return el !== null ? el : this.basis;
    }

    /// dmd/expression.d:1406.
    override accept(v: Visitor): void {
        v.visitArrayLiteralExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1417 — `extern (C++) final class AssocArrayLiteralExp : Expression`.
 * [ key0 : value0, key1 : value1, ... ]
 *
 * https://dlang.org/spec/expression.html#associative_array_literals
 */
export class AssocArrayLiteralExp extends Expression {
    ownedByCtfe: OwnedBy = OwnedBy.code;

    keys: Expressions | null = null;
    values: Expressions | null = null;

    lowering: Expression | null = null; // call to _d_assocarrayliteralTX()
    loweringCtfe: Expression | null = null; // result of interpreting lowering for static initializaton

    // dmd/expression.d:1427.
    constructor(loc: Loc, keys: Expressions | null, values: Expressions | null) {
        super(loc, EXP.assocArrayLiteral);
        assert(keys!.length === values!.length);
        this.keys = keys;
        this.values = values;
    }

    /// dmd/expression.d:1435.
    override syntaxCopy(): AssocArrayLiteralExp {
        return new AssocArrayLiteralExp(this.loc, Expression.arraySyntaxCopy(this.keys),
            Expression.arraySyntaxCopy(this.values));
    }

    /// dmd/expression.d:1440.
    override accept(v: Visitor): void {
        v.visitAssocArrayLiteralExp(this);
    }
}

/**
 * dmd/expression.d:1498 — `enum StageFlags : ubyte`, declared inside `StructLiteralExp`.
 * Hoisted to module scope (02-types.md §4.1/§4.2: a TS class cannot carry a nested enum); the
 * class-qualified spelling is preserved in the exported name.
 *
 * Anytime a recursive function is calling, 'stageflags' marks with a bit flag of the current
 * stage and unmarks before returning from this function. 'inlinecopy' uses similar 'stageflags'
 * and from multiple evaluation 'doInline' (with infinite recursion) of this expression.
 */
export enum StructLiteralExpStageFlags {
    none = 0x0,
    scrub = 0x1, /// scrubReturnValue is running
    searchPointers = 0x2, /// hasNonConstPointers is running
    optimize = 0x4, /// optimize is running
    apply = 0x8, /// apply is running
    inlineScan = 0x10, /// inlineScan is running
    toCBuffer = 0x20, /// toCBuffer is running
}

/***********************************************************
 * dmd/expression.d:1449 — `extern (C++) final class StructLiteralExp : Expression`.
 * sd( e1, e2, e3, ... )
 *
 * The union at dmd/expression.d:1467-1483 (`union { version(IN_LLVM) void* inProgressMemory; else
 * void* sym; StructLiteralExp inlinecopy; }`) is closed (11-escalate.md §3.5): `version (IN_LLVM)` is
 * ON (_config.md §1), so the `sym` arm does not exist here; the surviving `void* inProgressMemory` is an
 * `llvm::Value*`, an AST field holding an LLVM pointer, which _config.md §2 drops (no codegen). Exactly
 * ONE live member remains, `inlinecopy`, so the union is a plain field.
 */
export class StructLiteralExp extends Expression {
    // dmd/expression.d:1451-1458 — `struct BitFields { bool useStaticInit; bool isOriginal = false;
    // OwnedBy ownedByCtfe = OwnedBy.code; }` + generateBitFields -> plain fields (file header).
    useStaticInit = false; /// if this is true, use the StructDeclaration's init symbol
    isOriginal = false; /// used when moving instances to indicate `this is this.origin`
    ownedByCtfe: OwnedBy = OwnedBy.code;

    /// dmd/expression.d:1459 — `.init` of a named enum is its FIRST member (09 §1.0).
    stageflags: StructLiteralExpStageFlags = StructLiteralExpStageFlags.none;

    sd: StructDeclaration | null = null; /// which aggregate this is for
    elements: Expressions | null = null; /// parallels sd.fields[] with null entries for fields to skip
    stype: Type | null = null; /// final type of result (can be different from sd's type)

    // dmd/expression.d:1467-1483 — the union, a plain field under IN_LLVM (see the class doc).
    // dropped: `void* inProgressMemory` — IN_LLVM codegen field, `llvm::Value*` (_config.md §2).
    /// those fields need to prevent a infinite recursion when one field of struct initialized
    /// with 'this' pointer.
    inlinecopy: StructLiteralExp | null = null;

    /** dmd/expression.d:1490 — pointer to the origin instance of the expression.
     * once a new expression is created, origin is set to 'this'.
     * anytime when an expression copy is created, 'origin' pointer is set to
     * 'origin' pointer value of the original expression.
     */
    origin: StructLiteralExp | null = null;

    // dmd/expression.d:1509.
    constructor(loc: Loc, sd: StructDeclaration | null, elements: Expressions | null,
                stype: Type | null = null) {
        super(loc, EXP.structLiteral);
        this.sd = sd;
        let els = elements;
        if (els === null)
            els = new DArray<Expression | null>();
        this.elements = els;
        this.stype = stype;
        this.origin = this;
    }

    /// dmd/expression.d:1521 — `static StructLiteralExp create(Loc, StructDeclaration, void*, Type)`.
    /// D's `void* elements` is an erased `Expressions*`; the `cast(Expressions*)` is a no-op here.
    static create(loc: Loc, sd: StructDeclaration | null, elements: Expressions | null,
                  stype: Type | null = null): StructLiteralExp {
        return new StructLiteralExp(loc, sd, elements, stype);
    }

    /// dmd/expression.d:1526.
    override syntaxCopy(): StructLiteralExp {
        const exp = new StructLiteralExp(this.loc, this.sd, Expression.arraySyntaxCopy(this.elements),
            this.type !== null ? this.type : this.stype);
        exp.origin = this;
        return exp;
    }

    /// dmd/expression.d:1533.
    override accept(v: Visitor): void {
        v.visitStructLiteralExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1543 — `extern (C++) final class CompoundLiteralExp : Expression`.
 * C11 6.5.2.5
 * ( type-name ) { initializer-list }
 */
export class CompoundLiteralExp extends Expression {
    initializer: Initializer | null = null; /// initializer-list

    // dmd/expression.d:1547.
    constructor(loc: Loc, type_name: Type | null, initializer: Initializer | null) {
        super(loc, EXP.compoundLiteral);
        this.type = type_name; // D: `super.type = type_name;`
        this.initializer = initializer;
    }

    /// dmd/expression.d:1555.
    override accept(v: Visitor): void {
        v.visitCompoundLiteralExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1564 — `extern (C++) final class TypeExp : Expression`.
 * Mainly just a placeholder.
 */
export class TypeExp extends Expression {
    // dmd/expression.d:1566.
    constructor(loc: Loc, type: Type | null) {
        super(loc, EXP.type);
        this.type = type;
    }

    /// dmd/expression.d:1573.
    override syntaxCopy(): TypeExp {
        return new TypeExp(this.loc, this.type!.syntaxCopy());
    }

    /// dmd/expression.d:1578.
    override accept(v: Visitor): void {
        v.visitTypeExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1592 — `extern (C++) final class ScopeExp : Expression`.
 * Mainly just a placeholder of Package, Module, Nspace, and TemplateInstance (including
 * TemplateMixin).
 *
 * A template instance that requires IFTI:
 *      foo!tiargs(fargs)       // foo!tiargs
 * is left until CallExp::semantic() or resolveProperties()
 */
export class ScopeExp extends Expression {
    sds: ScopeDsymbol | null = null;

    // dmd/expression.d:1596.
    constructor(loc: Loc, sds: ScopeDsymbol) {
        super(loc, EXP.scope_);
        this.sds = sds;
        assert(sds.isTemplateDeclaration() === null); // instead, you should use TemplateExp
    }

    /// dmd/expression.d:1605.
    override syntaxCopy(): ScopeExp {
        return new ScopeExp(this.loc, this.sds!.syntaxCopy(null));
    }

    /// dmd/expression.d:1610.
    override accept(v: Visitor): void {
        v.visitScopeExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1619 — `extern (C++) final class TemplateExp : Expression`.
 * Mainly just a placeholder.
 */
export class TemplateExp extends Expression {
    td: TemplateDeclaration | null = null;
    fd: FuncDeclaration | null = null;

    // dmd/expression.d:1624.
    constructor(loc: Loc, td: TemplateDeclaration | null, fd: FuncDeclaration | null = null) {
        super(loc, EXP.template_);
        this.td = td;
        this.fd = fd;
    }

    /// dmd/expression.d:1632.
    override accept(v: Visitor): void {
        v.visitTemplateExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1641 — `extern (C++) final class NewExp : Expression`.
 * newtype(arguments)
 */
export class NewExp extends Expression {
    thisexp: Expression | null = null; // if !=null, 'this' for class being allocated
    newtype: Type | null = null;
    arguments_: Expressions | null = null; // ported: D field `arguments` (JS-reserved) -> arguments_
    names: ArgumentLabels | null = null; // Array of names(name and location of name) corresponding to expressions
    placement: Expression | null = null; // if !=null, then PlacementExpression

    argprefix: Expression | null = null; // expression to be evaluated just before arguments[]
    member: CtorDeclaration | null = null; // constructor function
    onstack = false; // allocate on stack
    thrownew = false; // this NewExp is the expression of a ThrowStatement

    lowering: Expression | null = null; // lowered druntime hook: `_d_new{class,itemT}`

    /// dmd/expression.d:1659 — Puts the `arguments` and `names` into an `ArgumentList` for easily
    /// passing them around. The fields are still separate for backwards compatibility.
    argumentList(): ArgumentList {
        return new ArgumentList(this.arguments_, this.names);
    }

    // dmd/expression.d:1661.
    constructor(loc: Loc, placement: Expression | null, thisexp: Expression | null, newtype: Type | null,
                arguments_: Expressions | null, names: ArgumentLabels | null = null) {
        super(loc, EXP.new_);
        this.placement = placement;
        this.thisexp = thisexp;
        this.newtype = newtype;
        this.arguments_ = arguments_;
        this.names = names;
    }

    /// dmd/expression.d:1671.
    static create(loc: Loc, placement: Expression | null, thisexp: Expression | null, newtype: Type | null,
                  arguments_: Expressions | null): NewExp {
        return new NewExp(loc, placement, thisexp, newtype, arguments_);
    }

    /// dmd/expression.d:1676.
    override syntaxCopy(): NewExp {
        return new NewExp(this.loc,
            this.placement !== null ? this.placement.syntaxCopy() : null,
            this.thisexp !== null ? this.thisexp.syntaxCopy() : null,
            this.newtype!.syntaxCopy(),
            Expression.arraySyntaxCopy(this.arguments_),
            // D `names.copy()` copies the ArgumentLabel VALUES (root/array.d:329) — see
            // `argumentLabelsCopy` below.
            this.names !== null ? argumentLabelsCopy(this.names) : null);
    }

    /// dmd/expression.d:1686.
    override accept(v: Visitor): void {
        v.visitNewExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1695 — `extern (C++) final class NewAnonClassExp : Expression`.
 * class baseclasses { } (arguments)
 */
export class NewAnonClassExp extends Expression {
    thisexp: Expression | null = null; // if !=null, 'this' for class being allocated
    cd: ClassDeclaration | null = null; // class being instantiated
    arguments_: Expressions | null = null; // ported: D field `arguments` -> arguments_ (01 §2.3)
    placement: Expression | null = null; // if !=null, then PlacementExpression

    // dmd/expression.d:1702.
    constructor(loc: Loc, placement: Expression | null, thisexp: Expression | null,
                cd: ClassDeclaration | null, arguments_: Expressions | null) {
        super(loc, EXP.newAnonymousClass);
        this.placement = placement;
        this.thisexp = thisexp;
        this.cd = cd;
        this.arguments_ = arguments_;
    }

    /// dmd/expression.d:1711.
    override syntaxCopy(): NewAnonClassExp {
        return new NewAnonClassExp(this.loc,
            this.placement !== null ? this.placement.syntaxCopy() : null,
            this.thisexp !== null ? this.thisexp.syntaxCopy() : null,
            this.cd!.syntaxCopy(null), Expression.arraySyntaxCopy(this.arguments_));
    }

    /// dmd/expression.d:1718.
    override accept(v: Visitor): void {
        v.visitNewAnonClassExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1726 — `extern (C++) class SymbolExp : Expression`.
 */
export class SymbolExp extends Expression {
    var_: Declaration; // ported: D field `var` (JS-reserved) -> var_ (01 §2.3)
    originalScope: Dsymbol | null = null; // original scope before inlining
    hasOverloads: boolean;

    // dmd/expression.d:1732.
    constructor(loc: Loc, op: EXP, var_: Declaration, hasOverloads: boolean) {
        super(loc, op);
        assert(var_);
        this.var_ = var_;
        this.hasOverloads = hasOverloads;
    }

    /// dmd/expression.d:1740.
    override accept(v: Visitor): void {
        v.visitSymbolExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1749 — `extern (C++) final class SymOffExp : SymbolExp`.
 * Offset from symbol.
 */
export class SymOffExp extends SymbolExp {
    offset: dinteger_t;

    // dmd/expression.d:1753.
    constructor(loc: Loc, var_: Declaration, offset: dinteger_t, hasOverloads = true) {
        // D: `if (auto v = var.isVarDeclaration()) { assert(!v.needThis()); hasOverloads = false; }`
        // — ported verbatim, statements and all. TS allows statements BEFORE `super()` as long as
        // they do not touch `this`, and these do not (06 §"Declaration in a condition": the decl
        // is hoisted and the value tested).
        const v = var_.isVarDeclaration();
        if (v !== null) {
            assert(!v.needThis()); // make sure the error message is no longer necessary
            hasOverloads = false;
        }
        super(loc, EXP.symbolOffset, var_, hasOverloads);
        this.offset = offset;
    }

    /// dmd/expression.d:1764.
    override accept(v: Visitor): void {
        v.visitSymOffExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1773 — `extern (C++) final class VarExp : SymbolExp`.
 * Variable.
 */
export class VarExp extends SymbolExp {
    delegateWasExtracted = false;

    // dmd/expression.d:1776.
    constructor(loc: Loc, var_: Declaration, hasOverloads = true) {
        // D: `if (var.isVarDeclaration()) hasOverloads = false;` — inlined into the super() call.
        super(loc, EXP.variable, var_, var_.isVarDeclaration() !== null ? false : hasOverloads);
        this.type = var_.type;
    }

    /// dmd/expression.d:1787.
    static create(loc: Loc, var_: Declaration, hasOverloads = true): VarExp {
        return new VarExp(loc, var_, hasOverloads);
    }

    /// dmd/expression.d:1792.
    override accept(v: Visitor): void {
        v.visitVarExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1801 — `extern (C++) final class OverExp : Expression`.
 * Overload Set.
 */
export class OverExp extends Expression {
    vars: OverloadSet | null = null;

    // dmd/expression.d:1805.
    constructor(loc: Loc, s: OverloadSet) {
        super(loc, EXP.overloadSet);
        this.vars = s;
        this.type = Type.tvoid;
    }

    /// dmd/expression.d:1813.
    override accept(v: Visitor): void {
        v.visitOverExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1823 — `extern (C++) final class FuncExp : Expression`.
 * Function/Delegate literal.
 */
export class FuncExp extends Expression {
    fd: FuncLiteralDeclaration | null = null;
    td: TemplateDeclaration | null = null;
    tok: TOK; // TOK.reserved, TOK.delegate_, TOK.function_

    // dmd/expression.d:1829.
    constructor(loc: Loc, s: Dsymbol) {
        super(loc, EXP.function_);
        this.td = s.isTemplateDeclaration();
        this.fd = s.isFuncLiteralDeclaration();
        if (this.td !== null) {
            assert(this.td.literal);
            assert(this.td.members !== null && this.td.members.length === 1);
            this.fd = this.td.members.opIndex(0)!.isFuncLiteralDeclaration();
        }
        this.tok = this.fd!.tok; // save original kind of function/delegate/(infer)
        assert(this.fd!.fbody);
    }

    /// dmd/expression.d:1844.
    override syntaxCopy(): FuncExp {
        if (this.td !== null)
            return new FuncExp(this.loc, this.td.syntaxCopy(null));
        if (this.fd!.semanticRun === PASS.initial)
            return new FuncExp(this.loc, this.fd!.syntaxCopy(null));
        // https://issues.dlang.org/show_bug.cgi?id=13481
        // Prevent multiple semantic analysis of lambda body.
        return new FuncExp(this.loc, this.fd!);
    }

    /// dmd/expression.d:1855.
    override accept(v: Visitor): void {
        v.visitFuncExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1868 — `extern (C++) final class DeclarationExp : Expression`.
 * Declaration of a symbol.
 *
 * D grammar allows declarations only as statements. However in AST representation
 * it can be part of any expression. This is used, for example, during internal
 * syntax re-writes to inject hidden symbols.
 */
export class DeclarationExp extends Expression {
    declaration: Dsymbol | null = null;

    // dmd/expression.d:1872.
    constructor(loc: Loc, declaration: Dsymbol | null) {
        super(loc, EXP.declaration);
        this.declaration = declaration;
    }

    /// dmd/expression.d:1878.
    override syntaxCopy(): DeclarationExp {
        return new DeclarationExp(this.loc, this.declaration!.syntaxCopy(null));
    }

    /// dmd/expression.d:1883.
    override hasCode(): boolean {
        const vd = this.declaration!.isVarDeclaration();
        if (vd !== null) {
            return (vd.storage_class & (STC.manifest | STC.static_)) === 0n;
        }
        return false;
    }

    /// dmd/expression.d:1892.
    override accept(v: Visitor): void {
        v.visitDeclarationExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1901 — `extern (C++) final class TypeidExp : Expression`.
 * typeid(int)
 */
export class TypeidExp extends Expression {
    obj: RootObject | null = null;

    // dmd/expression.d:1905.
    constructor(loc: Loc, o: RootObject | null) {
        super(loc, EXP.typeid_);
        this.obj = o;
    }

    /// dmd/expression.d:1911.
    override syntaxCopy(): TypeidExp {
        return new TypeidExp(this.loc, objectSyntaxCopy(this.obj));
    }

    /// dmd/expression.d:1916.
    override accept(v: Visitor): void {
        v.visitTypeidExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1925 — `extern (C++) final class TraitsExp : Expression`.
 * __traits(identifier, args...)
 */
export class TraitsExp extends Expression {
    ident: Identifier | null = null;
    args: Objects | null = null;

    // dmd/expression.d:1930.
    constructor(loc: Loc, ident: Identifier | null, args: Objects | null) {
        super(loc, EXP.traits);
        this.ident = ident;
        this.args = args;
    }

    /// dmd/expression.d:1937.
    override syntaxCopy(): TraitsExp {
        return new TraitsExp(this.loc, this.ident, TemplateInstance.arraySyntaxCopy(this.args));
    }

    /// dmd/expression.d:1942.
    override accept(v: Visitor): void {
        v.visitTraitsExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1953 — `extern (C++) final class HaltExp : Expression`.
 * Generates a halt instruction.
 *
 * `assert(0)` gets rewritten to this with `CHECKACTION.halt`
 */
export class HaltExp extends Expression {
    // dmd/expression.d:1955.
    constructor(loc: Loc) {
        super(loc, EXP.halt);
    }

    /// dmd/expression.d:1960.
    override accept(v: Visitor): void {
        v.visitHaltExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:1970 — `extern (C++) final class IsExp : Expression`.
 * is(targ id tok tspec)
 * is(targ id == tok2)
 */
export class IsExp extends Expression {
    targ: Type | null = null;
    id: Identifier | null = null; // can be null
    tspec: Type | null = null; // can be null
    parameters: TemplateParameters | null = null;
    tok: TOK; // ':' or '=='
    tok2: TOK; // 'struct', 'union', etc.

    // dmd/expression.d:1979.
    constructor(loc: Loc, targ: Type | null, id: Identifier | null, tok: TOK, tspec: Type | null,
                tok2: TOK, parameters: TemplateParameters | null) {
        super(loc, EXP.is_);
        this.targ = targ;
        this.id = id;
        this.tok = tok;
        this.tspec = tspec;
        this.tok2 = tok2;
        this.parameters = parameters;
    }

    /// dmd/expression.d:1990.
    override syntaxCopy(): IsExp {
        // This section is identical to that in TemplateDeclaration::syntaxCopy()
        let p: TemplateParameters | null = null;
        if (this.parameters !== null) {
            p = new DArray<TemplateParameter | null>(this.parameters.length);
            for (let i = 0; i < this.parameters.length; i++) {
                const el = this.parameters.opIndex(i);
                p.opIndexAssign(el!.syntaxCopy(), i);
            }
        }
        return new IsExp(this.loc, this.targ!.syntaxCopy(), this.id, this.tok,
            this.tspec !== null ? this.tspec.syntaxCopy() : null, this.tok2, p);
    }

    /// dmd/expression.d:2003.
    override accept(v: Visitor): void {
        v.visitIsExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2014 — `extern (C++) abstract class UnaExp : Expression`.
 * Base class for unary operators.
 *
 * https://dlang.org/spec/expression.html#unary-expression
 */
export abstract class UnaExp extends Expression {
    e1: Expression | null = null;

    // dmd/expression.d:2018.
    constructor(loc: Loc, op: EXP, e1: Expression | null) {
        super(loc, op);
        this.e1 = e1;
    }

    /// dmd/expression.d:2024.
    override syntaxCopy(): UnaExp {
        const e = this.copy() as unknown as UnaExp; // D: `cast(UnaExp)copy()`
        e.type = null;
        e.e1 = e.e1!.syntaxCopy();
        return e;
    }

    /*********************
     * dmd/expression.d:2037 — `final void setNoderefOperand()`.
     * Mark the operand as will never be dereferenced, which is useful info for @safe checks.
     * Do before semantic() on operands rewrites them.
     */
    setNoderefOperand(): void {
        const edi = this.e1!.isDotIdExp();
        if (edi !== null)
            edi.noderef = true;
    }

    /// dmd/expression.d:2044.
    override accept(v: Visitor): void {
        v.visitUnaExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2053 — `extern (C++) abstract class BinExp : Expression`.
 * Base class for binary operators.
 */
export abstract class BinExp extends Expression {
    e1: Expression | null = null;
    e2: Expression | null = null;

    // dmd/expression.d:2058.
    constructor(loc: Loc, op: EXP, e1: Expression | null, e2: Expression | null) {
        super(loc, op);
        this.e1 = e1;
        this.e2 = e2;
    }

    /// dmd/expression.d:2065.
    override syntaxCopy(): BinExp {
        const e = this.copy() as unknown as BinExp; // D: `cast(BinExp)copy()`
        e.type = null;
        e.e1 = e.e1!.syntaxCopy();
        e.e2 = e.e2!.syntaxCopy();
        return e;
    }

    /*********************
     * dmd/expression.d:2079 — `final void setNoderefOperands()`.
     * Mark the operands as will never be dereferenced, which is useful info for @safe checks.
     * Do before semantic() on operands rewrites them.
     */
    setNoderefOperands(): void {
        const edi1 = this.e1!.isDotIdExp();
        if (edi1 !== null)
            edi1.noderef = true;
        const edi2 = this.e2!.isDotIdExp();
        if (edi2 !== null)
            edi2.noderef = true;
    }

    /// dmd/expression.d:2088.
    override accept(v: Visitor): void {
        v.visitBinExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2097 — `extern (C++) class BinAssignExp : BinExp`.
 * Binary operator assignment, `+=` `-=` `*=` etc.
 */
export class BinAssignExp extends BinExp {
    // dmd/expression.d:2099.
    constructor(loc: Loc, op: EXP, e1: Expression | null, e2: Expression | null) {
        super(loc, op, e1, e2);
    }

    /// dmd/expression.d:2104.
    override accept(v: Visitor): void {
        v.visitBinAssignExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2115 — `extern (C++) final class MixinExp : Expression`.
 * A string mixin, `mixin("x")`
 *
 * https://dlang.org/spec/expression.html#mixin_expressions
 */
export class MixinExp extends Expression {
    exps: Expressions | null = null;

    // dmd/expression.d:2119.
    constructor(loc: Loc, exps: Expressions | null) {
        super(loc, EXP.mixin_);
        this.exps = exps;
    }

    /// dmd/expression.d:2125.
    override syntaxCopy(): MixinExp {
        return new MixinExp(this.loc, Expression.arraySyntaxCopy(this.exps));
    }

    /// dmd/expression.d:2130.
    override accept(v: Visitor): void {
        v.visitMixinExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2143 — `extern (C++) final class ImportExp : UnaExp`.
 * An import expression, `import("file.txt")`
 *
 * Not to be confused with module imports, `import std.stdio`, which is an `ImportStatement`
 *
 * https://dlang.org/spec/expression.html#import_expressions
 */
export class ImportExp extends UnaExp {
    // dmd/expression.d:2145.
    constructor(loc: Loc, e: Expression | null) {
        super(loc, EXP.import_, e);
    }

    /// dmd/expression.d:2150.
    override accept(v: Visitor): void {
        v.visitImportExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2161 — `extern (C++) final class AssertExp : UnaExp`.
 * An assert expression, `assert(x == y)`
 *
 * https://dlang.org/spec/expression.html#assert_expressions
 */
export class AssertExp extends UnaExp {
    msg: Expression | null = null;
    loweredFrom: Expression | null = null;

    // dmd/expression.d:2166.
    constructor(loc: Loc, e: Expression | null, msg: Expression | null = null) {
        super(loc, EXP.assert_, e);
        this.msg = msg;
    }

    /// dmd/expression.d:2172.
    override syntaxCopy(): AssertExp {
        return new AssertExp(this.loc, this.e1!.syntaxCopy(),
            this.msg !== null ? this.msg.syntaxCopy() : null);
    }

    /// dmd/expression.d:2177.
    override accept(v: Visitor): void {
        v.visitAssertExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2189 — `extern (C++) final class ThrowExp : UnaExp`.
 * `throw <e1>` as proposed by DIP 1034.
 *
 * Replacement for the deprecated `ThrowStatement` that can be nested in other expression.
 */
export class ThrowExp extends UnaExp {
    // dmd/expression.d:2191.
    constructor(loc: Loc, e: Expression | null) {
        super(loc, EXP.throw_, e);
    }

    /// dmd/expression.d:2196.
    override syntaxCopy(): ThrowExp {
        return new ThrowExp(this.loc, this.e1!.syntaxCopy());
    }

    /// dmd/expression.d:2201.
    override accept(v: Visitor): void {
        v.visitThrowExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2209 — `extern (C++) final class DotIdExp : UnaExp`.
 */
export class DotIdExp extends UnaExp {
    ident: Identifier | null = null;
    noderef = false; // true if the result of the expression will never be dereferenced
    wantsym = false; // do not replace Symbol with its initializer during semantic()
    arrow = false; // ImportC: if -> instead of .

    // dmd/expression.d:2216.
    constructor(loc: Loc, e: Expression | null, ident: Identifier | null) {
        super(loc, EXP.dotIdentifier, e);
        this.ident = ident;
    }

    /// dmd/expression.d:2222.
    static create(loc: Loc, e: Expression | null, ident: Identifier | null): DotIdExp {
        return new DotIdExp(loc, e, ident);
    }

    /// dmd/expression.d:2227.
    override accept(v: Visitor): void {
        v.visitDotIdExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2236 — `extern (C++) final class DotTemplateExp : UnaExp`.
 * Mainly just a placeholder.
 */
export class DotTemplateExp extends UnaExp {
    td: TemplateDeclaration | null = null;

    // dmd/expression.d:2240.
    constructor(loc: Loc, e: Expression | null, td: TemplateDeclaration | null) {
        super(loc, EXP.dotTemplateDeclaration, e);
        this.td = td;
    }

    /// dmd/expression.d:2246.
    override accept(v: Visitor): void {
        v.visitDotTemplateExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2254 — `extern (C++) final class DotVarExp : UnaExp`.
 */
export class DotVarExp extends UnaExp {
    var_: Declaration; // ported: D field `var` (JS-reserved) -> var_ (01 §2.3)
    hasOverloads: boolean;

    // dmd/expression.d:2259.
    constructor(loc: Loc, e: Expression | null, var_: Declaration, hasOverloads = true) {
        // D: `if (var.isVarDeclaration()) hasOverloads = false;` — evaluated before super() in D;
        // inlined into the field store below so no statement precedes super().
        super(loc, EXP.dotVariable, e);
        this.var_ = var_;
        this.hasOverloads = var_.isVarDeclaration() !== null ? false : hasOverloads;
    }

    /// dmd/expression.d:2270.
    override accept(v: Visitor): void {
        v.visitDotVarExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2279 — `extern (C++) final class DotTemplateInstanceExp : UnaExp`.
 * foo.bar!(args)
 */
export class DotTemplateInstanceExp extends UnaExp {
    ti: TemplateInstance | null = null;

    // dmd/expression.d:2283 — `this(Loc loc, Expression e, TemplateInstance ti)`. The two D ctors
    // have the same arity at the disambiguating position but different types, so only one can be
    // the TS constructor (04-functions.md §1.1(c)). The FIELD ctor (this one, which stores `ti`
    // verbatim) keeps it; the `(name, tiargs)` form becomes `fromName`, mirroring D exactly —
    // there the name ctor merely delegates here after building the TemplateInstance.
    constructor(loc: Loc, e: Expression | null, ti: TemplateInstance | null) {
        super(loc, EXP.dotTemplateInstance, e);
        this.ti = ti;
    }

    /// dmd/expression.d:2289 — `this(Loc loc, Expression e, Identifier name, Objects* tiargs)`.
    /// The D body is a delegating ctor call (`this(loc, e, new TemplateInstance(loc, name, tiargs))`);
    /// as a factory it constructs through the sibling `constructor` instead, same two steps.
    static fromName(loc: Loc, e: Expression | null, name: Identifier | null,
                    tiargs: Objects | null): DotTemplateInstanceExp {
        return new DotTemplateInstanceExp(loc, e, new TemplateInstance(loc, name, tiargs));
    }

    /// dmd/expression.d:2295.
    override syntaxCopy(): DotTemplateInstanceExp {
        return DotTemplateInstanceExp.fromName(this.loc, this.e1!.syntaxCopy(), this.ti!.name,
            TemplateInstance.arraySyntaxCopy(this.ti!.tiargs));
    }

    /// dmd/expression.d:2300.
    override accept(v: Visitor): void {
        v.visitDotTemplateInstanceExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2308 — `extern (C++) final class DelegateExp : UnaExp`.
 */
export class DelegateExp extends UnaExp {
    func: FuncDeclaration | null = null;
    hasOverloads: boolean;
    vthis2: VarDeclaration | null = null; // container for multi-context

    // dmd/expression.d:2314.
    constructor(loc: Loc, e: Expression | null, f: FuncDeclaration | null, hasOverloads = true,
                vthis2: VarDeclaration | null = null) {
        super(loc, EXP.delegate_, e);
        this.func = f;
        this.hasOverloads = hasOverloads;
        this.vthis2 = vthis2;
    }

    /// dmd/expression.d:2322.
    override accept(v: Visitor): void {
        v.visitDelegateExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2330 — `extern (C++) final class DotTypeExp : UnaExp`.
 */
export class DotTypeExp extends UnaExp {
    sym: Dsymbol | null = null; // symbol that represents a type

    // dmd/expression.d:2334.
    constructor(loc: Loc, e: Expression | null, s: Dsymbol | null) {
        super(loc, EXP.dotType, e);
        this.sym = s;
    }

    /// dmd/expression.d:2340.
    override accept(v: Visitor): void {
        v.visitDotTypeExp(this);
    }
}

/**
 * dmd/expression.d:2352 — `struct ArgumentList`.
 * The arguments of a function call.
 *
 * Contains a list of expressions. If it is a named argument, the `names` list has a non-null
 * entry at the same index.
 *
 * VALUE type (02-types.md §2 / 03-value-semantics.md): plain struct, field-wise `.copy()`.
 */
export class ArgumentList {
    arguments_: Expressions | null; // ported: D field `arguments` (JS-reserved) -> arguments_
    names: ArgumentLabels | null; // named argument labels

    constructor(arguments_: Expressions | null = null, names: ArgumentLabels | null = null) {
        this.arguments_ = arguments_;
        this.names = names;
    }

    /// dmd/expression.d:2357.
    length(): number {
        return this.arguments_ !== null ? this.arguments_.length : 0;
    }

    /// dmd/expression.d:2360 — Returns: whether this argument list contains any named arguments.
    hasArgNames(): boolean {
        if (this.names === null)
            return false;
        for (const argLabel of this.names)
            if (argLabel.name !== null)
                return true;

        return false;
    }

    /// Value-struct copy (03-value-semantics.md §2): both fields are `Array!T` POINTERS
    /// (`Expressions*` / `ArgumentLabels*`), i.e. references — shared, not cloned.
    copy(): ArgumentList {
        return new ArgumentList(this.arguments_, this.names);
    }
}

/**
 * dmd/expression.d:2373 — `struct ArgumentLabel`.
 * Contains both `name` and `location of the name` for an expression.
 * VALUE type held BY VALUE in `ArgumentLabels` (08-runtime-lib.md §3).
 */
export class ArgumentLabel {
    name: Identifier | null; // name of the argument
    loc: Loc; // location of the name

    constructor(name: Identifier | null, loc: Loc) {
        this.name = name;
        this.loc = loc; // `Loc` is an alias-safe register member (03-value-semantics.md §9.1)
    }

    copy(): ArgumentLabel {
        return new ArgumentLabel(this.name, this.loc);
    }
}

/**
 * The VALUE-element half of `names.copy()` on an `ArgumentLabels` (D `Array!(ArgumentLabel)`).
 *
 * D's `Array!T.copy()` is `memcpy(a.data.ptr, data.ptr, length * T.sizeof)` (dmd/root/array.d:329):
 * for a by-value element like `ArgumentLabel` that bit-copies each element, so every slot of the
 * clone is an INDEPENDENT value. The TS container `copy()` clones only the slots and leaves the
 * elements aliased on purpose (src/dmd/root/array.ts:247 states the value-element copy is owed by
 * the call site), so each element takes its own `.copy()` here — 03-value-semantics.md §1#4.
 * NOT an elision candidate: `ArgumentLabel` is not in the §9.1 alias-safe register (only `Loc` is)
 * and its `name`/`loc` fields are plain mutable slots.
 *
 * Cost: O(n), one fresh `ArgumentLabel` per element. Used by the two D `names ? names.copy() : null`
 * sites (dmd/expression.d:1683, :2469); the null test stays at the call site, as in D.
 */
function argumentLabelsCopy(names: ArgumentLabels): ArgumentLabels {
    const a: ArgumentLabels = new DArray<ArgumentLabel>();
    a.setDim(names.length);
    for (let i = 0; i < names.length; ++i)
        a.opIndexAssign(names.opIndex(i).copy(), i);
    return a;
}

/***********************************************************
 * dmd/expression.d:2381 — `extern (C++) final class CallExp : UnaExp`.
 */
export class CallExp extends UnaExp {
    arguments_: Expressions | null = null; // ported: D field `arguments` (JS-reserved) -> arguments_
    names: ArgumentLabels | null = null; // named argument labels
    f: FuncDeclaration | null = null; // symbol to call
    directcall = false; // true if a virtual call is devirtualized
    inDebugStatement = false; /// true if this was in a debug statement
    ignoreAttributes = false; /// don't enforce attributes (e.g. call @gc function in @nogc code)
    isUfcsRewrite = false; /// the first argument was pushed in here by a UFCS rewrite
    fromOpAssignment = false; // set when operator overload method call from assignment (2024 edition)
    vthis2: VarDeclaration | null = null; // container for multi-context
    loweredFrom: Expression | null = null; // set if this is the result of a lowering

    /// dmd/expression.d:2396 — Puts the `arguments` and `names` into an `ArgumentList` for easily
    /// passing them around. The fields are still separate for backwards compatibility.
    argumentList(): ArgumentList {
        return new ArgumentList(this.arguments_, this.names);
    }

    // dmd/expression.d:2398 (`this(loc, e, exps, names = null)`) and :2405 (`this(loc, e)`) —
    // arity dispatch (04-functions.md §1 Form A). The three remaining D ctors are same-arity
    // Form-B siblings and become the named factories below (:2410, :2418, :2434).
    constructor(loc: Loc, e: Expression | null, exps: Expressions | null = null,
                names: ArgumentLabels | null = null) {
        super(loc, EXP.call, e);
        this.arguments_ = exps;
        this.names = names;
    }

    /// dmd/expression.d:2410 — `this(Loc loc, Expression e, Expression earg1)`.
    static fromArg(loc: Loc, e: Expression | null, earg1: Expression | null): CallExp {
        const ce = new CallExp(loc, e);
        ce.arguments_ = new DArray<Expression | null>();
        if (earg1 !== null)
            ce.arguments_.push(earg1);
        return ce;
    }

    /// dmd/expression.d:2418 — `this(Loc loc, Expression e, Expression earg1, Expression earg2)`.
    static fromArgs(loc: Loc, e: Expression | null, earg1: Expression | null,
                    earg2: Expression | null): CallExp {
        const ce = new CallExp(loc, e);
        const arguments_ = new DArray<Expression | null>(2);
        arguments_.opIndexAssign(earg1, 0);
        arguments_.opIndexAssign(earg2, 1);
        ce.arguments_ = arguments_;
        return ce;
    }

    /***********************************************************
    * dmd/expression.d:2434 — `this(Loc loc, FuncDeclaration fd, Expression earg1)`.
    * Instatiates a new function call expression
    * Params:
    *       loc   = location
    *       fd    = the declaration of the function to call
    *       earg1 = the function argument
    */
    static fromFunc(loc: Loc, fd: FuncDeclaration, earg1: Expression | null): CallExp {
        const ce = CallExp.fromArg(loc, new VarExp(loc, fd, false), earg1);
        ce.f = fd;
        return ce;
    }

    /// dmd/expression.d:2440 (`create(loc, e, exps)`) and :2445 (`create(loc, e)`) — arity dispatch.
    static create(loc: Loc, e: Expression | null, exps: Expressions | null = null): CallExp {
        return new CallExp(loc, e, exps);
    }

    /// dmd/expression.d:2450 — `static CallExp create(Loc loc, Expression e, Expression earg1)`.
    /// Form-B sibling of `create(loc, e, exps)` (same arity, different 3rd-param type).
    static createFromArg(loc: Loc, e: Expression | null, earg1: Expression | null): CallExp {
        return CallExp.fromArg(loc, e, earg1);
    }

    /***********************************************************
    * dmd/expression.d:2462 — `static CallExp create(Loc loc, FuncDeclaration fd, Expression earg1)`.
    * Creates a new function call expression
    * Params:
    *       loc   = location
    *       fd    = the declaration of the function to call
    *       earg1 = the function argument
    */
    static createFromFunc(loc: Loc, fd: FuncDeclaration, earg1: Expression | null): CallExp {
        return CallExp.fromFunc(loc, fd, earg1);
    }

    /// dmd/expression.d:2467.
    override syntaxCopy(): CallExp {
        return new CallExp(this.loc, this.e1!.syntaxCopy(), Expression.arraySyntaxCopy(this.arguments_),
            // D `names.copy()` copies the ArgumentLabel VALUES (root/array.d:329) — see
            // `argumentLabelsCopy`.
            this.names !== null ? argumentLabelsCopy(this.names) : null);
    }

    /// dmd/expression.d:2472.
    override accept(v: Visitor): void {
        v.visitCallExp(this);
    }
}

/// dmd/expression.d:2478 — `FuncDeclaration isFuncAddress(Expression e, bool* hasOverloads = null)`.
/// `bool* hasOverloads` is a single out-parameter pointer -> a `Ref`-style box, nullable exactly
/// like the D pointer (03-value-semantics.md §7.2, 04-functions.md).
export function isFuncAddress(e: Expression, hasOverloads: { value: boolean } | null = null): FuncDeclaration | null {
    const ae = e.isAddrExp();
    if (ae !== null) {
        const ae1 = ae.e1!;
        const ve = ae1.isVarExp();
        if (ve !== null) {
            if (hasOverloads !== null)
                hasOverloads.value = ve.hasOverloads;
            return ve.var_.isFuncDeclaration();
        }
        const dve = ae1.isDotVarExp();
        if (dve !== null) {
            if (hasOverloads !== null)
                hasOverloads.value = dve.hasOverloads;
            return dve.var_.isFuncDeclaration();
        }
    } else {
        const soe = e.isSymOffExp();
        if (soe !== null) {
            if (hasOverloads !== null)
                hasOverloads.value = soe.hasOverloads;
            return soe.var_.isFuncDeclaration();
        }
        const dge = e.isDelegateExp();
        if (dge !== null) {
            if (hasOverloads !== null)
                hasOverloads.value = dge.hasOverloads;
            return dge.func!.isFuncDeclaration();
        }
    }
    return null;
}

/***********************************************************
 * dmd/expression.d:2517 — `extern (C++) final class AddrExp : UnaExp`.
 * The 'address of' operator, `&p`
 */
export class AddrExp extends UnaExp {
    // dmd/expression.d:2519 (`this(Loc, Expression)`) and :2524 (`this(Loc, Expression, Type)`) —
    // arity dispatch (04-functions.md §1 Form A): the 3-arg form delegates then paints `type`.
    constructor(loc: Loc, e: Expression | null, t?: Type | null) {
        super(loc, EXP.address, e);
        if (t !== undefined)
            this.type = t;
    }

    /// dmd/expression.d:2530.
    override accept(v: Visitor): void {
        v.visitAddrExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2539 — `extern (C++) final class PtrExp : UnaExp`.
 * The pointer dereference operator, `*p`
 */
export class PtrExp extends UnaExp {
    // dmd/expression.d:2541 / :2548 — arity dispatch (04-functions.md §1 Form A).
    constructor(loc: Loc, e: Expression | null, t?: Type | null) {
        super(loc, EXP.star, e);
        //if (e.type)
        //  type = ((TypePointer *)e.type).next;
        if (t !== undefined)
            this.type = t;
    }

    /// dmd/expression.d:2554.
    override accept(v: Visitor): void {
        v.visitPtrExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2563 — `extern (C++) final class NegExp : UnaExp`.
 * The negation operator, `-x`
 */
export class NegExp extends UnaExp {
    // dmd/expression.d:2565.
    constructor(loc: Loc, e: Expression | null) {
        super(loc, EXP.negate, e);
    }

    /// dmd/expression.d:2570.
    override accept(v: Visitor): void {
        v.visitNegExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2579 — `extern (C++) final class UAddExp : UnaExp`.
 * The unary add operator, `+x`
 */
export class UAddExp extends UnaExp {
    // dmd/expression.d:2581.
    constructor(loc: Loc, e: Expression | null) {
        super(loc, EXP.uadd, e);
    }

    /// dmd/expression.d:2586.
    override accept(v: Visitor): void {
        v.visitUAddExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2595 — `extern (C++) final class ComExp : UnaExp`.
 * The bitwise complement operator, `~x`
 */
export class ComExp extends UnaExp {
    // dmd/expression.d:2597.
    constructor(loc: Loc, e: Expression | null) {
        super(loc, EXP.tilde, e);
    }

    /// dmd/expression.d:2602.
    override accept(v: Visitor): void {
        v.visitComExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2611 — `extern (C++) final class NotExp : UnaExp`.
 * The logical not operator, `!x`
 */
export class NotExp extends UnaExp {
    loweredFrom: Expression | null = null; // for lowering of `aa1 != aa2` to `!_d_aaEqual(aa1, aa2)`

    // dmd/expression.d:2615.
    constructor(loc: Loc, e: Expression | null) {
        super(loc, EXP.not, e);
    }

    /// dmd/expression.d:2620.
    override accept(v: Visitor): void {
        v.visitNotExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2631 — `extern (C++) final class DeleteExp : UnaExp`.
 * The delete operator, `delete x` (deprecated)
 *
 * https://dlang.org/spec/expression.html#delete_expressions
 */
export class DeleteExp extends UnaExp {
    isRAII: boolean; // true if called automatically as a result of scoped destruction

    // dmd/expression.d:2635.
    constructor(loc: Loc, e: Expression | null, isRAII: boolean) {
        super(loc, EXP.delete_, e);
        this.isRAII = isRAII;
    }

    /// dmd/expression.d:2641.
    override accept(v: Visitor): void {
        v.visitDeleteExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2654 — `extern (C++) final class CastExp : UnaExp`.
 * The type cast operator, `cast(T) x`
 *
 * It's possible to cast to one type while painting to another type
 *
 * https://dlang.org/spec/expression.html#cast_expressions
 */
export class CastExp extends UnaExp {
    to: Type | null = null; // type to cast to
    mod: number = 0xff; // MODxxxxx — D: `ubyte mod = cast(ubyte)~0` (09-numerics.md §4.1)
    trusted = false; // assume cast is safe
    lowering: Expression | null = null;

    // dmd/expression.d:2661 — `this(Loc loc, Expression e, Type t)`. Same arity as the `ubyte mod`
    // ctor at :2669, so only one can be the TS constructor (04-functions.md §1.1(c)); the `Type`
    // form keeps it (it is the primary/field form and what `syntaxCopy` prefers), the
    // `cast(const)`/`cast(immutable)` form becomes `fromMod`.
    constructor(loc: Loc, e: Expression | null, t: Type | null) {
        super(loc, EXP.cast_, e);
        this.to = t;
    }

    /* dmd/expression.d:2669 — For cast(const) and cast(immutable)
     */
    static fromMod(loc: Loc, e: Expression | null, mod: number): CastExp {
        const ce = new CastExp(loc, e, null);
        ce.to = null; // the `to` field is NOT set by this D ctor (stays at its `null` .init)
        ce.mod = mod;
        return ce;
    }

    /// dmd/expression.d:2675.
    override syntaxCopy(): CastExp {
        return this.to !== null
            ? new CastExp(this.loc, this.e1!.syntaxCopy(), this.to.syntaxCopy())
            : CastExp.fromMod(this.loc, this.e1!.syntaxCopy(), this.mod);
    }

    /// dmd/expression.d:2680.
    override accept(v: Visitor): void {
        v.visitCastExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2688 — `extern (C++) final class VectorExp : UnaExp`.
 */
export class VectorExp extends UnaExp {
    to: TypeVector | null = null; // the target vector type before semantic()
    dim = 0xffffffff; // number of elements in the vector — D: `uint dim = ~0` (09 §4.1)
    ownedByCtfe: OwnedBy = OwnedBy.code;

    // dmd/expression.d:2694.
    constructor(loc: Loc, e: Expression | null, t: Type) {
        super(loc, EXP.vector, e);
        assert(t.ty === TY.Tvector);
        this.to = t as unknown as TypeVector; // D: `cast(TypeVector)t`, guarded by the assert above
    }

    /// dmd/expression.d:2701.
    static create(loc: Loc, e: Expression | null, t: Type): VectorExp {
        return new VectorExp(loc, e, t);
    }

    /// dmd/expression.d:2706.
    override syntaxCopy(): VectorExp {
        return new VectorExp(this.loc, this.e1!.syntaxCopy(), this.to!.syntaxCopy());
    }

    /// dmd/expression.d:2711.
    override accept(v: Visitor): void {
        v.visitVectorExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2722 — `extern (C++) final class VectorArrayExp : UnaExp`.
 * e1.array property for vectors.
 *
 * https://dlang.org/spec/simd.html#properties
 */
export class VectorArrayExp extends UnaExp {
    // dmd/expression.d:2724.
    constructor(loc: Loc, e1: Expression | null) {
        super(loc, EXP.vectorArray, e1);
    }

    /// dmd/expression.d:2729.
    override accept(v: Visitor): void {
        v.visitVectorArrayExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2740 — `extern (C++) final class SliceExp : UnaExp`.
 * e1 [lwr .. upr]
 *
 * https://dlang.org/spec/expression.html#slice_expressions
 */
export class SliceExp extends UnaExp {
    upr: Expression | null = null; // null if implicit 0
    lwr: Expression | null = null; // null if implicit [length - 1]

    lengthVar: VarDeclaration | null = null;

    // dmd/expression.d:2747-2754 — `private static struct BitFields { bool upperIsInBounds;
    // bool lowerIsLessThanUpper; bool arrayop; }` + generateBitFields -> plain fields (header).
    upperIsInBounds = false; // true if upr <= e1.length
    lowerIsLessThanUpper = false; // true if lwr <= upr
    arrayop = false; // an array operation, rather than a slice

    // dmd/expression.d:2764 — `this(Loc loc, Expression e1, Expression lwr, Expression upr)`.
    // The 4-argument form keeps the TS constructor (it is what `syntaxCopy` builds and the wider
    // of the two); the `IntervalExp` form becomes `fromInterval` (04-functions.md §1.1(c)).
    constructor(loc: Loc, e1: Expression | null, lwr: Expression | null, upr: Expression | null) {
        super(loc, EXP.slice, e1);
        this.upr = upr;
        this.lwr = lwr;
    }

    /************************************************************/
    /// dmd/expression.d:2757 — `this(Loc loc, Expression e1, IntervalExp ie)`.
    static fromInterval(loc: Loc, e1: Expression | null, ie: IntervalExp | null): SliceExp {
        return new SliceExp(loc, e1, ie !== null ? ie.lwr : null, ie !== null ? ie.upr : null);
    }

    /// dmd/expression.d:2771.
    override syntaxCopy(): SliceExp {
        const se = new SliceExp(this.loc, this.e1!.syntaxCopy(),
            this.lwr !== null ? this.lwr.syntaxCopy() : null,
            this.upr !== null ? this.upr.syntaxCopy() : null);
        se.lengthVar = this.lengthVar; // bug7871
        return se;
    }

    /// dmd/expression.d:2778.
    override accept(v: Visitor): void {
        v.visitSliceExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2787 — `extern (C++) final class ArrayLengthExp : UnaExp`.
 * The `.length` property of an array.
 */
export class ArrayLengthExp extends UnaExp {
    // dmd/expression.d:2789.
    constructor(loc: Loc, e1: Expression | null) {
        super(loc, EXP.arrayLength, e1);
    }

    /// dmd/expression.d:2794.
    override accept(v: Visitor): void {
        v.visitArrayLengthExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2805 — `extern (C++) final class ArrayExp : UnaExp`.
 * e1 [ a0, a1, a2, a3 ,... ]
 *
 * https://dlang.org/spec/expression.html#index_expressions
 */
export class ArrayExp extends UnaExp {
    arguments_: Expressions | null = null; // ported: D field `arguments` -> arguments_ (01 §2.3)

    currentDimension = 0; // for opDollar
    lengthVar: VarDeclaration | null = null;
    modifiable = false; // is this expected to be an lvalue in an AssignExp? propagate to IndexExp

    // dmd/expression.d:2813 — `this(Loc loc, Expression e1, Expression index = null)`. Same arity
    // as the `Expressions* args` ctor at :2821, so only one can be the TS constructor
    // (04-functions.md §1.1(c)); the single-index form keeps it (it carries the D default and is
    // the form the type-resolution paths build), the array form becomes `fromArgs`.
    constructor(loc: Loc, e1: Expression | null, index: Expression | null = null) {
        super(loc, EXP.array, e1);
        this.arguments_ = new DArray<Expression | null>();
        if (index !== null)
            this.arguments_.push(index);
    }

    /// dmd/expression.d:2821 — `this(Loc loc, Expression e1, Expressions* args)`.
    static fromArgs(loc: Loc, e1: Expression | null, args: Expressions | null): ArrayExp {
        const ae = new ArrayExp(loc, e1);
        ae.arguments_ = args;
        return ae;
    }

    /// dmd/expression.d:2827.
    override syntaxCopy(): ArrayExp {
        const ae = ArrayExp.fromArgs(this.loc, this.e1!.syntaxCopy(),
            Expression.arraySyntaxCopy(this.arguments_));
        ae.lengthVar = this.lengthVar; // bug7871
        return ae;
    }

    /// dmd/expression.d:2834.
    override accept(v: Visitor): void {
        v.visitArrayExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2842 — `extern (C++) final class DotExp : BinExp`.
 */
export class DotExp extends BinExp {
    // dmd/expression.d:2844.
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.dot, e1, e2);
    }

    /// dmd/expression.d:2849.
    override accept(v: Visitor): void {
        v.visitDotExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2857 — `extern (C++) final class CommaExp : BinExp`.
 */
export class CommaExp extends BinExp {
    /// This is needed because AssignExp rewrites CommaExp, hence it needs
    /// to trigger the deprecation. (D: `const bool isGenerated;`)
    readonly isGenerated: boolean;

    /// Temporary variable to enable / disable deprecation of comma expression
    /// depending on the context.
    /// Since most constructor calls are rewritting, the only place where
    /// false will be passed will be from the parser.
    allowCommaExp: boolean;

    /// The original expression before any rewriting occurs.
    /// This is used in error messages.
    originalExp: Expression | null = null;

    // dmd/expression.d:2873 — `this(Loc loc, Expression e1, Expression e2, bool generated = true)`.
    // Same arity as the `Expression oe` ctor at :2879, so only one can be the TS constructor
    // (04-functions.md §1.1(c)); this one keeps it (it is what every dependent builds and what
    // the `oe` form delegates to), the other becomes `fromOriginalExp`.
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null, generated = true) {
        super(loc, EXP.comma, e1, e2);
        this.allowCommaExp = this.isGenerated = generated;
    }

    /// dmd/expression.d:2879 — `this(Loc loc, Expression e1, Expression e2, Expression oe)`.
    static fromOriginalExp(loc: Loc, e1: Expression | null, e2: Expression | null,
                           oe: Expression | null): CommaExp {
        const ce = new CommaExp(loc, e1, e2);
        ce.originalExp = oe;
        return ce;
    }

    /// dmd/expression.d:2885.
    override accept(v: Visitor): void {
        v.visitCommaExp(this);
    }

    /**
     * dmd/expression.d:2904 — `static void allow(Expression exp)`.
     * If the argument is a CommaExp, set a flag to prevent deprecation messages
     *
     * It's impossible to know from CommaExp.semantic if the result will
     * be used, hence when there is a result (type != void), a deprecation
     * message is always emitted.
     * However, some construct can produce a result but won't use it
     * (ExpStatement and for loop increment).  Those should call this function
     * to prevent unwanted deprecations to be emitted.
     *
     * Params:
     *   exp = An expression that discards its result.
     *         If the argument is null or not a CommaExp, nothing happens.
     */
    static allow(exp: Expression | null): void {
        if (exp !== null) {
            const ce = exp.isCommaExp();
            if (ce !== null)
                ce.allowCommaExp = true;
        }
    }
}

/***********************************************************
 * dmd/expression.d:2915 — `extern (C++) final class IntervalExp : Expression`.
 * Mainly just a placeholder.
 */
export class IntervalExp extends Expression {
    lwr: Expression | null = null;
    upr: Expression | null = null;

    // dmd/expression.d:2920.
    constructor(loc: Loc, lwr: Expression | null, upr: Expression | null) {
        super(loc, EXP.interval);
        this.lwr = lwr;
        this.upr = upr;
    }

    /// dmd/expression.d:2927 — D returns `Expression` (not `IntervalExp`) here; kept verbatim.
    override syntaxCopy(): Expression {
        return new IntervalExp(this.loc, this.lwr!.syntaxCopy(), this.upr!.syntaxCopy());
    }

    /// dmd/expression.d:2932.
    override accept(v: Visitor): void {
        v.visitIntervalExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2943 — `extern (C++) final class DelegatePtrExp : UnaExp`.
 * The `dg.ptr` property, pointing to the delegate's 'context'
 *
 * c.f.`DelegateFuncptrExp` for the delegate's function pointer `dg.funcptr`
 */
export class DelegatePtrExp extends UnaExp {
    // dmd/expression.d:2945.
    constructor(loc: Loc, e1: Expression | null) {
        super(loc, EXP.delegatePointer, e1);
    }

    /// dmd/expression.d:2950.
    override accept(v: Visitor): void {
        v.visitDelegatePtrExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2961 — `extern (C++) final class DelegateFuncptrExp : UnaExp`.
 * The `dg.funcptr` property, pointing to the delegate's function
 *
 * c.f.`DelegatePtrExp` for the delegate's function pointer `dg.ptr`
 */
export class DelegateFuncptrExp extends UnaExp {
    // dmd/expression.d:2963.
    constructor(loc: Loc, e1: Expression | null) {
        super(loc, EXP.delegateFunctionPointer, e1);
    }

    /// dmd/expression.d:2968.
    override accept(v: Visitor): void {
        v.visitDelegateFuncptrExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:2977 — `extern (C++) final class IndexExp : BinExp`.
 * e1 [ e2 ]
 */
export class IndexExp extends BinExp {
    lengthVar: VarDeclaration | null = null;
    loweredFrom: Expression | null = null; // for associative array lowering to _d_aaGetY or _d_aaGetRvalueX
    modifiable = false; // assume it is an rvalue
    indexIsInBounds = false; // true if 0 <= e2 && e2 <= e1.length - 1

    // dmd/expression.d:2984 / :2990 — arity dispatch (04-functions.md §1 Form A): the 3-arg form
    // leaves `indexIsInBounds` at its `false` .init, which the default reproduces.
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null, indexIsInBounds = false) {
        super(loc, EXP.index, e1, e2);
        this.indexIsInBounds = indexIsInBounds;
    }

    /// dmd/expression.d:2997.
    override syntaxCopy(): IndexExp {
        const ie = new IndexExp(this.loc, this.e1!.syntaxCopy(), this.e2!.syntaxCopy());
        ie.lengthVar = this.lengthVar; // bug7871
        return ie;
    }

    /// dmd/expression.d:3004.
    override accept(v: Visitor): void {
        v.visitIndexExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3013 — `extern (C++) final class PostExp : BinExp`.
 * The postfix increment/decrement operator, `i++` / `i--`
 */
export class PostExp extends BinExp {
    // dmd/expression.d:3015.
    constructor(op: EXP, loc: Loc, e: Expression | null) {
        super(loc, op, e, IntegerExp.literal(1));
        assert(op === EXP.minusMinus || op === EXP.plusPlus);
    }

    /// dmd/expression.d:3021.
    override accept(v: Visitor): void {
        v.visitPostExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3030 — `extern (C++) final class PreExp : UnaExp`.
 * The prefix increment/decrement operator, `++i` / `--i`
 */
export class PreExp extends UnaExp {
    // dmd/expression.d:3032.
    constructor(op: EXP, loc: Loc, e: Expression | null) {
        super(loc, op, e);
        assert(op === EXP.preMinusMinus || op === EXP.prePlusPlus);
    }

    /// dmd/expression.d:3038.
    override accept(v: Visitor): void {
        v.visitPreExp(this);
    }
}

/// dmd/expression.d:3044 — `enum MemorySet` (named enumeration, 02-types.md §4.2).
export enum MemorySet {
    none = 0, // simple assignment
    blockAssign = 1, // setting the contents of an array
    referenceInit = 2, // setting the reference of STC.ref_ variable
}

/***********************************************************
 * dmd/expression.d:3056 — `extern (C++) class AssignExp : BinExp`.
 * The assignment / initialization operator, `=`
 *
 * Note: operator assignment `op=` has a different base class, `BinAssignExp`
 */
export class AssignExp extends BinExp {
    memset: MemorySet = MemorySet.none; // `.init` of a named enum is its FIRST member (09 §1.0)

    /************************************************************/
    /* op can be EXP.assign, EXP.construct, or EXP.blit */
    // dmd/expression.d:3062 (`this(Loc, Expression, Expression)`) and :3067
    // (`this(Loc, EXP tok, Expression, Expression)`) collapse by ARITY (04-functions.md §1
    // Form A): 3 arguments is the `EXP.assign` form, 4 is the explicit-tok form.
    // SIGNATURE NOTE: the two D overloads disagree on the MEANING of parameter 2, so "optional
    // trailing params in D-declaration order" cannot hold both. `tok` is therefore the TRAILING
    // optional parameter here — `new AssignExp(loc, e1, e2)` is D's 3-arg ctor and
    // `super(loc, e1, e2, EXP.construct)` (used by the three subclasses below, which in D call
    // the 4-arg ctor) is D's 4-arg one. No runtime type test is involved; this is pure arity
    // dispatch, and a subclass cannot route a `super(...)` through a static factory.
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null, tok: EXP = EXP.assign) {
        super(loc, tok, e1, e2);
    }

    /// dmd/expression.d:3072.
    override accept(v: Visitor): void {
        v.visitAssignExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3085 — `extern (C++) final class LoweredAssignExp : AssignExp`.
 * When an assignment expression is lowered to a druntime call
 * this class is used to store the lowering.
 * It essentially behaves the same as an AssignExp, but it is
 * used to not waste space for other AssignExp that are not
 * lowered to anything.
 */
export class LoweredAssignExp extends AssignExp {
    lowering: Expression | null = null;

    // dmd/expression.d:3088.
    constructor(exp: AssignExp, lowering: Expression | null) {
        super(exp.loc, exp.e1, exp.e2, EXP.loweredAssignExp);
        this.lowering = lowering;
    }

    /// dmd/expression.d:3094.
    override accept(v: Visitor): void {
        v.visitLoweredAssignExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3102 — `extern (C++) final class ConstructExp : AssignExp`.
 */
export class ConstructExp extends AssignExp {
    lowering: Expression | null = null;

    // dmd/expression.d:3106.
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, e1, e2, EXP.construct);
    }

    // dmd/expression.d:3113 — `this(Loc loc, VarDeclaration v, Expression e2)`.
    // Internal use only. If `v` is a reference variable, the assignment will become a reference
    // initialization automatically. Same-arity Form-B sibling with a DIFFERENT side effect
    // (`memset = referenceInit`), so it is a named factory, never a runtime-discriminated
    // collapse (04-functions.md §1.1(c) "side-effect-divergent ctor overloads").
    static fromVar(loc: Loc, v: VarDeclaration, e2: Expression | null): ConstructExp {
        const ve = new VarExp(loc, v);
        assert(v.type && ve.type);

        const ce = new ConstructExp(loc, ve, e2);

        if (v.isReference())
            ce.memset = MemorySet.referenceInit;
        return ce;
    }

    /// dmd/expression.d:3124.
    override accept(v: Visitor): void {
        v.visitConstructExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3133 — `extern (C++) final class BlitExp : AssignExp`.
 * A bit-for-bit copy from `e2` to `e1`
 */
export class BlitExp extends AssignExp {
    // dmd/expression.d:3135.
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, e1, e2, EXP.blit);
    }

    // dmd/expression.d:3142 — `this(Loc loc, VarDeclaration v, Expression e2)`.
    // Internal use only. If `v` is a reference variable, the assinment will become a reference
    // rebinding automatically. Same-arity Form-B sibling with a divergent side effect -> factory.
    static fromVar(loc: Loc, v: VarDeclaration, e2: Expression | null): BlitExp {
        const ve = new VarExp(loc, v);
        assert(v.type && ve.type);

        const be = new BlitExp(loc, ve, e2);

        if (v.isReference())
            be.memset = MemorySet.referenceInit;
        return be;
    }

    /// dmd/expression.d:3153.
    override accept(v: Visitor): void {
        v.visitBlitExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3162 — `extern (C++) final class AddAssignExp : BinAssignExp`. `x += y`
 */
export class AddAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.addAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitAddAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3178 — `extern (C++) final class MinAssignExp : BinAssignExp`. `x -= y`
 */
export class MinAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.minAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitMinAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3194 — `extern (C++) final class MulAssignExp : BinAssignExp`. `x *= y`
 */
export class MulAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.mulAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitMulAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3210 — `extern (C++) final class DivAssignExp : BinAssignExp`. `x /= y`
 */
export class DivAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.divAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitDivAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3226 — `extern (C++) final class ModAssignExp : BinAssignExp`. `x %= y`
 */
export class ModAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.modAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitModAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3242 — `extern (C++) final class AndAssignExp : BinAssignExp`. `x &= y`
 */
export class AndAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.andAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitAndAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3258 — `extern (C++) final class OrAssignExp : BinAssignExp`. `x |= y`
 */
export class OrAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.orAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitOrAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3274 — `extern (C++) final class XorAssignExp : BinAssignExp`. `x ^= y`
 */
export class XorAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.xorAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitXorAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3290 — `extern (C++) final class PowAssignExp : BinAssignExp`. `x ^^= y`
 */
export class PowAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.powAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitPowAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3306 — `extern (C++) final class ShlAssignExp : BinAssignExp`. `x <<= y`
 */
export class ShlAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.leftShiftAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitShlAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3322 — `extern (C++) final class ShrAssignExp : BinAssignExp`. `x >>= y`
 */
export class ShrAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.rightShiftAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitShrAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3338 — `extern (C++) final class UshrAssignExp : BinAssignExp`. `x >>>= y`
 */
export class UshrAssignExp extends BinAssignExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.unsignedRightShiftAssign, e1, e2);
    }
    override accept(v: Visitor): void { v.visitUshrAssignExp(this); }
}

/***********************************************************
 * dmd/expression.d:3363 — `extern (C++) class CatAssignExp : BinAssignExp`.
 * The `~=` operator.
 *
 * It can have one of the following operators:
 *
 * EXP.concatenateAssign      - appending T[] to T[]
 * EXP.concatenateElemAssign  - appending T to T[]
 * EXP.concatenateDcharAssign - appending dchar to T[]
 *
 * The parser initially sets it to EXP.concatenateAssign, and semantic() later decides which
 * of the three it will be set to.
 */
export class CatAssignExp extends BinAssignExp {
    lowering: Expression | null = null; // lowered druntime hook `_d_arrayappend{cTX,T}`

    // dmd/expression.d:3367 / :3372 — same ARITY collapse as `AssignExp` above (see its
    // SIGNATURE NOTE): `tok` is the trailing optional parameter so both D ctors are expressible
    // and the two subclasses can still reach the tok form through `super(...)`.
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null,
                tok: EXP = EXP.concatenateAssign) {
        super(loc, tok, e1, e2);
    }

    /// dmd/expression.d:3377.
    override accept(v: Visitor): void {
        v.visitCatAssignExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3386 — `extern (C++) final class CatElemAssignExp : CatAssignExp`.
 * The `~=` operator when appending a single element.
 */
export class CatElemAssignExp extends CatAssignExp {
    // dmd/expression.d:3388.
    constructor(loc: Loc, type: Type | null, e1: Expression | null, e2: Expression | null) {
        super(loc, e1, e2, EXP.concatenateElemAssign);
        this.type = type;
    }

    /// dmd/expression.d:3394.
    override accept(v: Visitor): void {
        v.visitCatElemAssignExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3403 — `extern (C++) final class CatDcharAssignExp : CatAssignExp`.
 * The `~=` operator when appending a single `dchar`.
 */
export class CatDcharAssignExp extends CatAssignExp {
    // dmd/expression.d:3405.
    constructor(loc: Loc, type: Type | null, e1: Expression | null, e2: Expression | null) {
        super(loc, e1, e2, EXP.concatenateDcharAssign);
        this.type = type;
    }

    /// dmd/expression.d:3411.
    override accept(v: Visitor): void {
        v.visitCatDcharAssignExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3422 — `extern (C++) final class AddExp : BinExp`.
 * The addition operator, `x + y`
 *
 * https://dlang.org/spec/expression.html#add_expressions
 */
export class AddExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.add, e1, e2);
    }
    override accept(v: Visitor): void { v.visitAddExp(this); }
}

/***********************************************************
 * dmd/expression.d:3440 — `extern (C++) final class MinExp : BinExp`.
 * The minus operator, `x - y`
 *
 * https://dlang.org/spec/expression.html#add_expressions
 */
export class MinExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.min, e1, e2);
    }
    override accept(v: Visitor): void { v.visitMinExp(this); }
}

/***********************************************************
 * dmd/expression.d:3458 — `extern (C++) final class CatExp : BinExp`.
 * The concatenation operator, `x ~ y`
 *
 * https://dlang.org/spec/expression.html#cat_expressions
 */
export class CatExp extends BinExp {
    lowering: Expression | null = null; // call to druntime hook `_d_arraycatnTX`

    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.concatenate, e1, e2);
    }
    override accept(v: Visitor): void { v.visitCatExp(this); }
}

/***********************************************************
 * dmd/expression.d:3478 — `extern (C++) final class MulExp : BinExp`.
 * The multiplication operator, `x * y`
 *
 * https://dlang.org/spec/expression.html#mul_expressions
 */
export class MulExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.mul, e1, e2);
    }
    override accept(v: Visitor): void { v.visitMulExp(this); }
}

/***********************************************************
 * dmd/expression.d:3496 — `extern (C++) final class DivExp : BinExp`.
 * The division operator, `x / y`
 *
 * https://dlang.org/spec/expression.html#mul_expressions
 */
export class DivExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.div, e1, e2);
    }
    override accept(v: Visitor): void { v.visitDivExp(this); }
}

/***********************************************************
 * dmd/expression.d:3514 — `extern (C++) final class ModExp : BinExp`.
 * The modulo operator, `x % y`
 *
 * https://dlang.org/spec/expression.html#mul_expressions
 */
export class ModExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.mod, e1, e2);
    }
    override accept(v: Visitor): void { v.visitModExp(this); }
}

/***********************************************************
 * dmd/expression.d:3532 — `extern (C++) final class PowExp : BinExp`.
 * The 'power' operator, `x ^^ y`
 *
 * https://dlang.org/spec/expression.html#pow_expressions
 */
export class PowExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.pow, e1, e2);
    }
    override accept(v: Visitor): void { v.visitPowExp(this); }
}

/***********************************************************
 * dmd/expression.d:3550 — `extern (C++) final class ShlExp : BinExp`.
 * The 'shift left' operator, `x << y`
 *
 * https://dlang.org/spec/expression.html#shift_expressions
 */
export class ShlExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.leftShift, e1, e2);
    }
    override accept(v: Visitor): void { v.visitShlExp(this); }
}

/***********************************************************
 * dmd/expression.d:3568 — `extern (C++) final class ShrExp : BinExp`.
 * The 'shift right' operator, `x >> y`
 *
 * https://dlang.org/spec/expression.html#shift_expressions
 */
export class ShrExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.rightShift, e1, e2);
    }
    override accept(v: Visitor): void { v.visitShrExp(this); }
}

/***********************************************************
 * dmd/expression.d:3586 — `extern (C++) final class UshrExp : BinExp`.
 * The 'unsigned shift right' operator, `x >>> y`
 *
 * https://dlang.org/spec/expression.html#shift_expressions
 */
export class UshrExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.unsignedRightShift, e1, e2);
    }
    override accept(v: Visitor): void { v.visitUshrExp(this); }
}

/***********************************************************
 * dmd/expression.d:3604 — `extern (C++) final class AndExp : BinExp`.
 * The bitwise 'and' operator, `x & y`
 *
 * https://dlang.org/spec/expression.html#and_expressions
 */
export class AndExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.and, e1, e2);
    }
    override accept(v: Visitor): void { v.visitAndExp(this); }
}

/***********************************************************
 * dmd/expression.d:3622 — `extern (C++) final class OrExp : BinExp`.
 * The bitwise 'or' operator, `x | y`
 *
 * https://dlang.org/spec/expression.html#or_expressions
 */
export class OrExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.or, e1, e2);
    }
    override accept(v: Visitor): void { v.visitOrExp(this); }
}

/***********************************************************
 * dmd/expression.d:3640 — `extern (C++) final class XorExp : BinExp`.
 * The bitwise 'xor' operator, `x ^ y`
 *
 * https://dlang.org/spec/expression.html#xor_expressions
 */
export class XorExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.xor, e1, e2);
    }
    override accept(v: Visitor): void { v.visitXorExp(this); }
}

/***********************************************************
 * dmd/expression.d:3659 — `extern (C++) final class LogicalExp : BinExp`.
 * The logical 'and' / 'or' operator, `X && Y` / `X || Y`
 *
 * https://dlang.org/spec/expression.html#andand_expressions
 * https://dlang.org/spec/expression.html#oror_expressions
 */
export class LogicalExp extends BinExp {
    // dmd/expression.d:3661.
    constructor(loc: Loc, op: EXP, e1: Expression | null, e2: Expression | null) {
        super(loc, op, e1, e2);
        assert(op === EXP.andAnd || op === EXP.orOr);
    }
    override accept(v: Visitor): void { v.visitLogicalExp(this); }
}

/***********************************************************
 * dmd/expression.d:3681 — `extern (C++) final class CmpExp : BinExp`.
 * A comparison operator, `<` `<=` `>` `>=`
 *
 * `op` is one of:
 *      EXP.lessThan, EXP.lessOrEqual, EXP.greaterThan, EXP.greaterOrEqual
 *
 * https://dlang.org/spec/expression.html#relation_expressions
 */
export class CmpExp extends BinExp {
    // dmd/expression.d:3683 — note `op` comes FIRST in D here; kept verbatim.
    constructor(op: EXP, loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, op, e1, e2);
        assert(op === EXP.lessThan || op === EXP.lessOrEqual || op === EXP.greaterThan
            || op === EXP.greaterOrEqual);
    }
    override accept(v: Visitor): void { v.visitCmpExp(this); }
}

/***********************************************************
 * dmd/expression.d:3702 — `extern (C++) final class InExp : BinExp`.
 * The `in` operator, `"a" in ["a": 1]`
 *
 * Note: `x !in y` is rewritten to `!(x in y)` in the parser
 *
 * https://dlang.org/spec/expression.html#in_expressions
 */
export class InExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.in_, e1, e2);
    }
    override accept(v: Visitor): void { v.visitInExp(this); }
}

/***********************************************************
 * dmd/expression.d:3720 — `extern (C++) final class RemoveExp : BinExp`.
 * Associative array removal, `aa.remove(arg)`
 *
 * This deletes the key e1 from the associative array e2
 */
export class RemoveExp extends BinExp {
    constructor(loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.remove, e1, e2);
    }
    override accept(v: Visitor): void { v.visitRemoveExp(this); }
}

/***********************************************************
 * dmd/expression.d:3740 — `extern (C++) final class EqualExp : BinExp`.
 * `==` and `!=`
 *
 * EXP.equal and EXP.notEqual
 *
 * https://dlang.org/spec/expression.html#equality_expressions
 */
export class EqualExp extends BinExp {
    lowering: Expression | null = null;

    // dmd/expression.d:3743 — `op` first (verbatim).
    constructor(op: EXP, loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, op, e1, e2);
        assert(op === EXP.equal || op === EXP.notEqual);
    }
    override accept(v: Visitor): void { v.visitEqualExp(this); }
}

/***********************************************************
 * dmd/expression.d:3762 — `extern (C++) final class IdentityExp : BinExp`.
 * `is` and `!is`
 *
 * EXP.identity and EXP.notIdentity
 *
 *  https://dlang.org/spec/expression.html#identity_expressions
 */
export class IdentityExp extends BinExp {
    // dmd/expression.d:3764 — `op` first (verbatim).
    constructor(op: EXP, loc: Loc, e1: Expression | null, e2: Expression | null) {
        super(loc, op, e1, e2);
        assert(op === EXP.identity || op === EXP.notIdentity);
    }
    override accept(v: Visitor): void { v.visitIdentityExp(this); }
}

/***********************************************************
 * dmd/expression.d:3781 — `extern (C++) final class CondExp : BinExp`.
 * The ternary operator, `econd ? e1 : e2`
 *
 * https://dlang.org/spec/expression.html#conditional_expressions
 */
export class CondExp extends BinExp {
    econd: Expression | null = null;

    // dmd/expression.d:3785.
    constructor(loc: Loc, econd: Expression | null, e1: Expression | null, e2: Expression | null) {
        super(loc, EXP.question, e1, e2);
        this.econd = econd;
    }

    /// dmd/expression.d:3791.
    override syntaxCopy(): CondExp {
        return new CondExp(this.loc, this.econd!.syntaxCopy(), this.e1!.syntaxCopy(),
            this.e2!.syntaxCopy());
    }

    /// dmd/expression.d:3796.
    override accept(v: Visitor): void {
        v.visitCondExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3816 — `extern (C++) class DefaultInitExp : Expression`.
 * A special keyword when used as a function's default argument
 *
 * When possible, special keywords are resolved in the parser, but when
 * appearing as a default argument, they result in an expression deriving
 * from this base class that is resolved for each function call.
 *
 * ---
 * const x = __LINE__; // resolved in the parser
 * void foo(string file = __FILE__, int line = __LINE__); // DefaultInitExp
 * ---
 *
 * https://dlang.org/spec/expression.html#specialkeywords
 */
export class DefaultInitExp extends Expression {
    /*************************
     * dmd/expression.d:3824
     * Params:
     *  loc = location
     *  op = EXP.prettyFunction, EXP.functionString, EXP.moduleString,
     *       EXP.line, EXP.file, EXP.fileFullPath
     */
    constructor(loc: Loc, op: EXP) {
        super(loc, op);
    }

    /// dmd/expression.d:3829.
    override accept(v: Visitor): void {
        v.visitDefaultInitExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3838 — `extern (C++) final class FileInitExp : DefaultInitExp`.
 * The `__FILE__` token as a default argument.
 */
export class FileInitExp extends DefaultInitExp {
    constructor(loc: Loc, tok: EXP) {
        super(loc, tok);
    }
    override accept(v: Visitor): void { v.visitFileInitExp(this); }
}

/***********************************************************
 * dmd/expression.d:3854 — `extern (C++) final class LineInitExp : DefaultInitExp`.
 * The `__LINE__` token as a default argument.
 */
export class LineInitExp extends DefaultInitExp {
    constructor(loc: Loc) {
        super(loc, EXP.line);
    }
    override accept(v: Visitor): void { v.visitLineInitExp(this); }
}

/***********************************************************
 * dmd/expression.d:3870 — `extern (C++) final class ModuleInitExp : DefaultInitExp`.
 * The `__MODULE__` token as a default argument.
 */
export class ModuleInitExp extends DefaultInitExp {
    constructor(loc: Loc) {
        super(loc, EXP.moduleString);
    }
    override accept(v: Visitor): void { v.visitModuleInitExp(this); }
}

/***********************************************************
 * dmd/expression.d:3886 — `extern (C++) final class FuncInitExp : DefaultInitExp`.
 * The `__FUNCTION__` token as a default argument.
 */
export class FuncInitExp extends DefaultInitExp {
    constructor(loc: Loc) {
        super(loc, EXP.functionString);
    }
    override accept(v: Visitor): void { v.visitFuncInitExp(this); }
}

/***********************************************************
 * dmd/expression.d:3902 — `extern (C++) final class PrettyFuncInitExp : DefaultInitExp`.
 * The `__PRETTY_FUNCTION__` token as a default argument.
 */
export class PrettyFuncInitExp extends DefaultInitExp {
    constructor(loc: Loc) {
        super(loc, EXP.prettyFunction);
    }
    override accept(v: Visitor): void { v.visitPrettyFuncInitExp(this); }
}

/***********************************************************
 * dmd/expression.d:3919 — `extern (C++) final class ClassReferenceExp : Expression`.
 * A reference to a class, or an interface. We need this when we
 * point to a base class (we must record what the type is).
 */
export class ClassReferenceExp extends Expression {
    value: StructLiteralExp | null = null;

    // dmd/expression.d:3923.
    constructor(loc: Loc, lit: StructLiteralExp, type: Type | null) {
        super(loc, EXP.classReference);
        assert(lit && lit.sd && lit.sd.isClassDeclaration());
        this.value = lit;
        this.type = type;
    }

    /// dmd/expression.d:3931.
    originalClass(): ClassDeclaration | null {
        return this.value!.sd!.isClassDeclaration();
    }

    // dmd/expression.d:3938 — Return index of the field, or -1 if not found.
    // Same as getFieldIndex, but checks for a direct match with the VarDeclaration.
    findFieldIndexByName(v: VarDeclaration): number {
        let cd: ClassDeclaration = this.originalClass()!;
        let fieldsSoFar = 0;
        for (let j = 0; j < this.value!.elements!.length; j++) {
            while (j - fieldsSoFar >= cd.fields.length) {
                fieldsSoFar += cd.fields.length;
                cd = cd.baseClass!;
            }
            const v2 = cd.fields.opIndex(j - fieldsSoFar);
            if (v === v2) {
                return toInt32(this.value!.elements!.length - fieldsSoFar - cd.fields.length
                    + (j - fieldsSoFar));
            }
        }
        return -1;
    }

    /// dmd/expression.d:3958.
    override accept(v: Visitor): void {
        v.visitClassReferenceExp(this);
    }
}

/***********************************************************
 * dmd/expression.d:3967 — `extern (C++) final class CTFEExp : Expression`.
 * This type is only used by the interpreter.
 */
export class CTFEExp extends Expression {
    // dmd/expression.d:3969.
    constructor(tok: EXP) {
        super(Loc.initial, tok);
        this.type = Type.tvoid;
    }

    // dmd/expression.d:3975-3983 — `extern (D) __gshared CTFEExp ...` sentinels, created by
    // `Expression._init()` and cleared by `Expression.deinitialize()`.
    static cantexp: CTFEExp | null = null;
    static voidexp: CTFEExp | null = null;
    static breakexp: CTFEExp | null = null;
    static continueexp: CTFEExp | null = null;
    static gotoexp: CTFEExp | null = null;
    /* Used when additional information is needed regarding
     * a ctfe error.
     */
    static showcontext: CTFEExp | null = null;

    /// dmd/expression.d:3985.
    static isCantExp(e: Expression | null): boolean {
        return e !== null && e.op === EXP.cantExpression;
    }

    /// dmd/expression.d:3990.
    static isGotoExp(e: Expression | null): boolean {
        return e !== null && e.op === EXP.goto_;
    }
}

/***********************************************************
 * dmd/expression.d:4000 — `extern (C++) final class ThrownExceptionExp : Expression`.
 * Fake class which holds the thrown exception.
 * Used for implementing exception handling.
 */
export class ThrownExceptionExp extends Expression {
    thrown: ClassReferenceExp | null = null; // the thing being tossed

    // dmd/expression.d:4004.
    constructor(loc: Loc, victim: ClassReferenceExp) {
        super(loc, EXP.thrownException);
        this.thrown = victim;
        this.type = victim.type;
    }

    /// dmd/expression.d:4011.
    override accept(v: Visitor): void {
        v.visitThrownExceptionExp(this);
    }
}

/**
 * dmd/expression.d:4022 — `extern (C++) final class ObjcClassReferenceExp : Expression`.
 * Objective-C class reference expression.
 *
 * Used to get the metaclass of an Objective-C class, `NSObject.Class`.
 */
export class ObjcClassReferenceExp extends Expression {
    classDeclaration: ClassDeclaration | null = null;

    // dmd/expression.d:4026.
    constructor(loc: Loc, classDeclaration: ClassDeclaration | null) {
        super(loc, EXP.objcClassReference);
        this.classDeclaration = classDeclaration;
    }

    /// dmd/expression.d:4032.
    override accept(v: Visitor): void {
        v.visitObjcClassReferenceExp(this);
    }
}

/*******************
 * dmd/expression.d:4042 — `extern (C++) final class GenericExp : Expression`.
 * C11 6.5.1.1 Generic Selection
 * For ImportC
 */
export class GenericExp extends Expression {
    cntlExp: Expression | null = null; /// controlling expression of a generic selection (not evaluated)
    types: Types | null = null; /// type-names for generic associations (null entry for `default`)
    exps: Expressions | null = null; /// 1:1 mapping of typeNames to exps

    // dmd/expression.d:4048.
    constructor(loc: Loc, cntlExp: Expression | null, types: Types | null, exps: Expressions | null) {
        super(loc, EXP._Generic);
        this.cntlExp = cntlExp;
        this.types = types;
        this.exps = exps;
        assert(types!.length === exps!.length); // must be the same and >=1
    }

    /// dmd/expression.d:4057.
    override syntaxCopy(): GenericExp {
        return new GenericExp(this.loc, this.cntlExp!.syntaxCopy(), Type.arraySyntaxCopy(this.types),
            Expression.arraySyntaxCopy(this.exps));
    }

    /// dmd/expression.d:4062.
    override accept(v: Visitor): void {
        v.visitGenericExp(this);
    }
}

/**
 * dmd/expression.d:4078 — `bool isArrayConstruction(const Identifier id)`.
 * Verify if the given identifier is _d_array{,set}ctor.
 *
 * Params:
 *  id = the identifier to verify
 *
 * Returns:
 *  `true` if the identifier corresponds to a construction runtime hook,
 *  `false` otherwise.
 */
export function isArrayConstruction(id: Identifier | null): boolean {
    // `Identifier` is interned, so D's class `==` (identity for a type without opEquals) is `===`.
    return id === Id._d_arrayctor || id === Id._d_arraysetctor;
}

// ── dmd/expression.d:4088-4133 — the `exptab` flag table ──────────────────────────────────────
// D declares `exptab` FIRST and the `EXPFLAGS`/`Eunary`/`Ebinary`/`EbinaryAssign` manifest enums
// after it (order is irrelevant for D manifest constants). A TS `const` is in its temporal dead
// zone until evaluated, and `exptab`'s initializer READS the three lists, so the declarations are
// emitted in dependency order here. Nothing else about them changes.

/// dmd/expression.d:4100 — `private enum EXPFLAGS : ubyte`.
const enum EXPFLAGS {
    unary = 1,
    binary = 2,
    binaryAssign = 4,
}

/// dmd/expression.d:4107 — `private enum Eunary = [...]` (manifest constant, 02-types.md §4.1).
const Eunary: readonly EXP[] = [
    EXP.import_, EXP.assert_, EXP.throw_, EXP.dotIdentifier, EXP.dotTemplateDeclaration,
    EXP.dotVariable, EXP.dotTemplateInstance, EXP.delegate_, EXP.dotType, EXP.call,
    EXP.address, EXP.star, EXP.negate, EXP.uadd, EXP.tilde, EXP.not, EXP.delete_, EXP.cast_,
    EXP.vector, EXP.vectorArray, EXP.slice, EXP.arrayLength, EXP.array, EXP.delegatePointer,
    EXP.delegateFunctionPointer, EXP.preMinusMinus, EXP.prePlusPlus,
];

/// dmd/expression.d:4116 — `private enum Ebinary = [...]`.
const Ebinary: readonly EXP[] = [
    EXP.dot, EXP.comma, EXP.index, EXP.minusMinus, EXP.plusPlus, EXP.assign,
    EXP.add, EXP.min, EXP.concatenate, EXP.mul, EXP.div, EXP.mod, EXP.pow, EXP.leftShift,
    EXP.rightShift, EXP.unsignedRightShift, EXP.and, EXP.or, EXP.xor, EXP.andAnd, EXP.orOr,
    EXP.lessThan, EXP.lessOrEqual, EXP.greaterThan, EXP.greaterOrEqual,
    EXP.in_, EXP.remove, EXP.equal, EXP.notEqual, EXP.identity, EXP.notIdentity,
    EXP.question,
    EXP.construct, EXP.blit,
];

/// dmd/expression.d:4127 — `private enum EbinaryAssign = [...]`.
const EbinaryAssign: readonly EXP[] = [
    EXP.addAssign, EXP.minAssign, EXP.mulAssign, EXP.divAssign, EXP.modAssign,
    EXP.andAssign, EXP.orAssign, EXP.xorAssign, EXP.powAssign,
    EXP.leftShiftAssign, EXP.rightShiftAssign, EXP.unsignedRightShiftAssign,
    EXP.concatenateAssign, EXP.concatenateElemAssign, EXP.concatenateDcharAssign,
];

/******************************
 * dmd/expression.d:4088 — `private immutable ubyte[EXP.max + 1] exptab = () { ... } ();`
 * Provide efficient way to implement isUnaExp(), isBinExp(), isBinAssignExp().
 *
 * `EXP.max` is the LAST member of the (purely auto-incrementing) `EXP` enum — `EXP.rvalue`.
 */
const exptab: readonly number[] = (() => {
    const tab: number[] = [];
    for (let i = 0; i <= (EXP.rvalue as number); i++)
        tab[i] = 0;
    // D: `with (EXPFLAGS) { foreach (i; Eunary) { tab[i] |= unary; } ... }` (06-control-flow.md §5)
    for (const i of Eunary) { tab[i] |= EXPFLAGS.unary; }
    for (const i of Ebinary) { tab[i] |= EXPFLAGS.unary | EXPFLAGS.binary; }
    for (const i of EbinaryAssign) { tab[i] |= EXPFLAGS.unary | EXPFLAGS.binary | EXPFLAGS.binaryAssign; }
    return tab;
})();

// dmd/expression.d:4137 — `private immutable ubyte[EXP.max+1] expSize = [ ... __traits(
// classInstanceSize, X) ... ];` — DROPPED with `Expression.size()`, see the file header
// (07-compile-time.md §7.1: `classInstanceSize` is elided; the only frontend readers are
// `Expression.copy()`, now a field-wise clone, and `ctfeexpr.d`'s storage assert, which
// 02-types.md §11.1 also drops).
