// Ported from dmd/importc.d (module dmd.importc).
//
// Contains semantic routines specific to ImportC. Specification: C11.
//
// INVENTORY. importc.d declares ten top-level functions and no unittest block; all ten are translated here in D
// source order: `cAdjustParamType` (:48), `arrayFuncConv` (:83), `fieldLookup` (:124), `carraySemantic` (:167),
// `addDefaultCInitializer` (:204), `cFuncEquivalence` (:237), `cTypeEquivalence` (:294), `handleTagSymbols` (:353),
// `handleSymbolRedeclarations` (:465), `cEnumSemantic` (:623). No wall, no escalation marker.
//
// DROPPED (07 audit convention): `import core.stdc.stdio` (importc.d:16) serves only tracing. In
// `handleTagSymbols` and `handleSymbolRedeclarations`, `enum log = false;` (importc.d:355/:467) makes every
// `if (log) printf(...)` a dead statement, and `static if (log) void print(EnumDeclaration)` (importc.d:361-368)
// resolves to nothing; all of them are dropped, each site marked `dropped:`. The nested functions themselves
// (`collision`, `mangleWrangle`, `emSemantic`, `errorReturn`) are kept as local arrows in their D position.
//
// IMPORTS (01 §3.1, §4.8). The whole-module imports at importc.d:18-37 become named imports of the symbols used;
// `dmd.denum`, `dmd.declaration`, `dmd.dscope`, `dmd.identifier` and `dmd.intrange` are used in type position only
// (`import type`, 01 §4.2). An AST-node module (`expression.ts`) comes first and the sema modules (typesem, dcast,
// dsymbolsem, expressionsem, optimize, dinterpret) last (01 §4.8). UFCS calls (`t.pointerTo()`, `e.castTo(sc, t)`,
// `e.expressionSemantic(sc)`, `ts.sym.search(...)`, ...) are calls of the free functions of their home modules,
// receiver first (04 §6).
//
// TYPE MODEL. `Scope*` and `ref Scope` are the `Scope` class reference: `ref Scope sc` (handleTagSymbols,
// handleSymbolRedeclarations) receives the caller's object, so mutations of `sc._module.tagSymTab` alias exactly as
// in D (03 §3.2). The tag table `Dsymbol[void*] tagSymTab` is `Map<object, Dsymbol>` keyed by the symbol object
// (dmodule.ts, 02 §9); `cast(void*)s in tab` is `tab.get(s)`. `ulong` enum values are `bigint` (09 §0).
//
// DECLARED READINGS (each also stated at its site):
//  - importc.d:316 compares `tf` with ITSELF (`cFuncEquivalence(tf, tf.isTypeFunction())`), so two function
//    types with equal `ty`/`mod` are always equivalent here. Reproduced: ldc2 accepts both
//    `extern int (*fp)(int); int (*fp)(long);` and `extern int (*fq)(int); long (*fq)(int);` without a diagnostic.
//  - importc.d:387 `sd.kind() != sd2.kind()` compares two `const(char)*` string-literal ADDRESSES. ldc2 pools
//    identical literals, and the C tag kinds are the three distinct literals "struct", "union", "enum", so address
//    identity coincides with content equality; the port compares contents (`dsEquals`). A `!==` on the two fresh
//    `DString`s would always differ and turn every tag redeclaration (`struct S; struct S { int x; };`, accepted
//    by ldc2) into a conflict.
//  - importc.d:689 passes `null` as the `Scope*` of `getProperty`, whose TS parameter is typed non-null
//    (typesem.ts:5173); a `dependency signature` defect of the callee, passed as `null!` with the site comment.
//  - importc.d:636 `void emSemantic(EnumMember em, ref ulong nextValue)` takes the outer `nextValue` by `ref`: the
//    D local is a `Ref<bigint>` box (03 §3.2/§7.2), so the nested function's writes reach the caller's variable as
//    the D reference does.

import {
    AddExp, AddrExp, DotVarExp, ErrorExp, IndexExp, IntegerExp, PtrExp, WANTvalue,
} from "./expression.js";
import { Type } from "./mtype.js";
import { LINK, STC } from "./astenums.js";
import { PASS, foreachDsymbolVoid } from "./dsymbol.js";
import { error } from "./errors.js";
import { Id } from "./id.js";
import { ExpInitializer, VoidInitializer } from "./init.js";
import { DYNCAST } from "./rootobject.js";
import { EXP } from "./tokens.js";
import { assert } from "../assert.js";
import { ds, dsEquals } from "../dstring.js";

import type { ArrayExp, Expression } from "./expression.js";
import type { Parameter, TypeFunction } from "./mtype.js";
import type { EnumDeclaration, EnumMember } from "./denum.js";
import type { Declaration, VarDeclaration } from "./declaration.js";
import type { Scope } from "./dscope.js";
import type { Dsymbol, ScopeDsymbol } from "./dsymbol.js";
import type { Identifier } from "./identifier.js";
import type { IntRange } from "./intrange.js";

// last (01 §4.8): the sema modules of the core SCC. typesem, dcast, dsymbolsem and expressionsem each gain a value
// import of this module when their ImportC call sites are swept, which closes a cycle through here; every binding
// below is read inside function bodies only, never at module evaluation.
import { defaultInit, getProperty, mutableOf, nextOf, pointerTo, toBasetype } from "./typesem.js";
import { castTo, getIntRange, integralPromotions, intRangeFromType } from "./dcast.js";
import { overloadInsert, search } from "./dsymbolsem.js";
import { checkAddressable, expressionSemantic, resolveProperties, toInteger } from "./expressionsem.js";
import { optimize } from "./optimize.js";
import { ctfeInterpret } from "./dinterpret.js";

/** The ref-cell for a D `ref` scalar parameter (03 §3.2/§7.2): the callee writes `.value`, the caller reads it. */
interface Ref<T> {
    value: T;
}

/**************************************
 * dmd/importc.d:48 — `Type cAdjustParamType(Type t, Scope* sc)`.
 * C11 does not allow array or function parameters.
 * Hence, adjust those types per C11 6.7.6.3 rules.
 *
 * The identity outside a C file (`!sc.inCfile`), so a D call site may call it unconditionally.
 * Params:
 *      t = parameter type to adjust
 *      sc = context; dereferenced unconditionally, so non-null (02 §10.1)
 * Returns:
 *      adjusted type: `T*` for `T[]`/`T[n]`, a function pointer for a function type, `t` otherwise
 */
export function cAdjustParamType(t: Type, sc: Scope): Type {
    if (!sc.inCfile)
        return t;

    const tb = toBasetype(t);

    /* C11 6.7.6.3-7 array of T is converted to pointer to T
     */
    const ta = tb.isTypeDArray();
    if (ta !== null) {
        t = pointerTo(ta.next!);
    } else {
        const ts = tb.isTypeSArray();
        if (ts !== null) {
            t = pointerTo(ts.next!);
        }
        /* C11 6.7.6.3-8 function is converted to pointer to function
         */
        else if (tb.isTypeFunction() !== null) {
            t = pointerTo(tb);
        }
    }
    return t;
}

/***********************************************
 * dmd/importc.d:83 — `Expression arrayFuncConv(Expression e, Scope* sc)`.
 * C11 6.3.2.1-3 Convert expression that is an array of type to a pointer to type.
 * C11 6.3.2.1-4 Convert expression that is a function to a pointer to a function.
 *
 * The identity outside a C file, and for an operand that is neither an array nor a function; otherwise the
 * converted expression has had `expressionSemantic` run on it.
 * Params:
 *  e = ImportC expression to possibly convert; its `type` is set (semantic already ran on it)
 *  sc = context
 * Returns:
 *  converted expression, or `ErrorExp` when the array operand is not addressable (diagnosed by
 *  `checkAddressable`)
 */
export function arrayFuncConv(e: Expression, sc: Scope): Expression {
    if (!sc.inCfile)
        return e;

    const t = toBasetype(e.type!);
    const ta = t.isTypeDArray();
    if (ta !== null) {
        if (!checkAddressable(e, sc, ds("take address of")))
            return ErrorExp.get();
        e = castTo(e, sc, pointerTo(ta.next!));
    } else {
        const ts = t.isTypeSArray();
        if (ts !== null) {
            if (!checkAddressable(e, sc, ds("take address of")))
                return ErrorExp.get();
            e = castTo(e, sc, pointerTo(ts.next!));
        } else if (t.isTypeFunction() !== null) {
            e = new AddrExp(e.loc, e);
        } else
            return e;
    }
    return expressionSemantic(e, sc);
}

/****************************************
 * dmd/importc.d:124 — `Expression fieldLookup(Expression e, Scope* sc, Identifier id, bool arrow)`.
 * Run semantic on `e`.
 * Expression `e` evaluates to an instance of a struct.
 * Look up `ident` as a field of that struct.
 * Params:
 *   e = evaluates to an instance of a struct
 *   sc = context
 *   id = identifier of a field in that struct
 *   arrow = -> was used
 * Returns:
 *   if successful `e.ident`
 *   if not then `ErrorExp` and message is printed
 */
export function fieldLookup(e: Expression, sc: Scope, id: Identifier, arrow: boolean): Expression {
    e = expressionSemantic(e, sc);
    if (e.isErrorExp() !== null)
        return e;
    if (arrow) {
        e = arrayFuncConv(e, sc);
        if (e.isErrorExp() !== null)
            return e;
    }

    let t = e.type!;
    if (t.isTypePointer() !== null) {
        t = t.isTypePointer()!.next!;
        const pe = e.toChars();
        if (!arrow)
            error(e.loc, ds("since `%s` is a pointer, use `%s->%s` instead of `%s.%s`"),
                pe, pe, id.toChars(), pe, id.toChars());
        e = new PtrExp(e.loc, e);
    }
    let s: Dsymbol | null = null;
    const ts = t.isTypeStruct();
    if (ts !== null)
        s = search(ts.sym!, e.loc, id, 0);
    if (s === null) {
        error(e.loc, ds("`%s` is not a member of `%s`"), id.toChars(), t.toChars());
        return ErrorExp.get();
    }
    // D hands `s.isDeclaration()` unchecked to DotVarExp, whose constructor dereferences it (expression.d:2261):
    // the `!` marks that same fault point (02 §10.1).
    const ef: Expression = new DotVarExp(e.loc, e, s.isDeclaration()!);
    return expressionSemantic(ef, sc);
}

/****************************************
 * dmd/importc.d:167 — `Expression carraySemantic(ArrayExp ae, Scope* sc)`.
 * C11 6.5.2.1-2
 * Apply C semantics to `E[I]` expression.
 * E1[E2] is lowered to *(E1 + E2)
 * Params:
 *      ae = ArrayExp to run semantics on; carries exactly one argument in a C file (asserted)
 *      sc = context
 * Returns:
 *      Expression if this was a C expression with completed semantic, null if not
 */
export function carraySemantic(ae: ArrayExp, sc: Scope): Expression | null {
    if (!sc.inCfile)
        return null;

    let e1 = expressionSemantic(ae.e1!, sc);

    assert(ae.arguments_!.length === 1);
    let e2: Expression = ae.arguments_!.opIndex(0)!;

    /* CTFE cannot do pointer arithmetic, but it can index arrays.
     * So, rewrite as an IndexExp if we can.
     */
    const t1 = toBasetype(e1.type!);
    if (t1.isStaticOrDynamicArray()) {
        e2 = arrayFuncConv(expressionSemantic(e2, sc), sc);
        // C doesn't do array bounds checking, so `true` turns it off
        return expressionSemantic(new IndexExp(ae.loc, e1, e2, true), sc);
    }

    e1 = arrayFuncConv(e1, sc);   // e1 might still be a function call
    e2 = expressionSemantic(e2, sc);
    const t2 = toBasetype(e2.type!);
    if (t2.isStaticOrDynamicArray()) {
        return expressionSemantic(new IndexExp(ae.loc, e2, e1, true), sc); // swap operands
    }

    e2 = arrayFuncConv(e2, sc);
    const ep = new PtrExp(ae.loc, new AddExp(ae.loc, e1, e2));
    return expressionSemantic(ep, sc);
}

/******************************************
 * dmd/importc.d:204 — `void addDefaultCInitializer(VarDeclaration dsym)`.
 * Determine default initializer for const global symbol.
 *
 * Acts only on a `static`/`__gshared` variable that is not `extern`, a field, a parameter, a `foreach` or `in`
 * variable or a result: an incomplete static array gets a `VoidInitializer` (diagnosed later), an immutable or
 * const one gets an `ExpInitializer` over its type's C default value. Mutable variables are left alone.
 */
export function addDefaultCInitializer(dsym: VarDeclaration): void {
    if ((dsym.storage_class & (STC.static_ | STC.gshared)) === 0n)
        return;
    if ((dsym.storage_class & (STC.extern_ | STC.field | STC.in_ | STC.foreach_ | STC.parameter | STC.result)) !== 0n)
        return;

    const t = dsym.type!;
    if (t.isTypeSArray() !== null && t.isTypeSArray()!.isIncomplete()) {
        dsym._init = new VoidInitializer(dsym.loc);
        return; // incomplete arrays will be diagnosed later
    }

    if (t.isMutable())
        return;

    const e = defaultInit(dsym.type!, dsym.loc, true);
    dsym._init = new ExpInitializer(dsym.loc, e);
}

/********************************************
 * dmd/importc.d:237 — `bool cFuncEquivalence(TypeFunction tf1, TypeFunction tf2)`.
 * Implement the C11 notion of function equivalence,
 * which allows prototyped functions to match K+R functions,
 * even though they are different.
 *
 * Parameters are compared with head const stripped; varargs are compared only when both are prototyped.
 * Params:
 *      tf1 = type of first function
 *      tf2 = type of second function
 * Returns:
 *      true if C11 considers them equivalent
 */
export function cFuncEquivalence(tf1: TypeFunction, tf2: TypeFunction): boolean {
    if (tf1.equals(tf2))
        return true;

    if (tf1.linkage !== tf2.linkage)
        return false;

    // Allow func(void) to match func()
    if (tf1.parameterList.length() === 0 && tf2.parameterList.length() === 0)
        return true;

    if (!cTypeEquivalence(tf1.next!, tf2.next!))
        return false;   // function return types don't match

    if (tf1.parameterList.length() !== tf2.parameterList.length())
        return false;

    if (!tf1.parameterList.hasIdentifierList && !tf2.parameterList.hasIdentifierList) { // if both are prototyped
        if (tf1.parameterList.varargs !== tf2.parameterList.varargs)
            return false;
    }

    // `foreach (i, fparam; tf1.parameterList)` over `ParameterList.opApply` (05 §11): the `return false` inside
    // the body is the non-zero control code that stops the walk, tested after it.
    const r = tf1.parameterList.opApply((i: number, fparam: Parameter): number => {
        let t1 = fparam.type!;
        let t2 = tf2.parameterList.opIndex(i)!.type!;

        /* Strip off head const.
         * Not sure if this is C11, but other compilers treat
         * `void fn(int)` and `fn(const int x)`
         * as equivalent.
         */
        t1 = mutableOf(t1);
        t2 = mutableOf(t2);

        if (!t1.equals(t2))
            return 1;
        return 0;
    });
    if (r !== 0)
        return false;

    return true;
}

/*******************************
 * dmd/importc.d:294 — `bool cTypeEquivalence(Type t1, Type t2)`.
 * Types haven't been merged yet, because we haven't done
 * semantic() yet.
 * But we still need to see if t1 and t2 are the same type.
 *
 * Two function types of equal `ty` and `mod` are always equivalent: D compares the first with itself
 * (importc.d:316), reproduced below.
 * Params:
 *      t1 = first type
 *      t2 = second type
 * Returns:
 *      true if they are equivalent types
 */
export function cTypeEquivalence(t1: Type, t2: Type): boolean {
    if (t1.equals(t2))
        return true;    // that was easy

    if (t1.ty !== t2.ty || t1.mod !== t2.mod)
        return false;

    const tp = t1.isTypePointer();
    if (tp !== null)
        return cTypeEquivalence(tp.next!, nextOf(t2)!);

    const ta = t1.isTypeSArray();
    if (ta !== null)
        // Bug: should check array dimension
        return cTypeEquivalence(ta.next!, nextOf(t2)!);

    // `t1.ty == t2.ty` was tested above, so D's unchecked `t2.isTypeStruct()` / `t2.isTypeEnum()` are non-null.
    const ts = t1.isTypeStruct();
    if (ts !== null)
        return ts.sym === t2.isTypeStruct()!.sym;

    const te = t1.isTypeEnum();
    if (te !== null)
        return te.sym === t2.isTypeEnum()!.sym;

    // D passes `tf.isTypeFunction()`, i.e. `tf` itself, not `t2`: the comparison is of `tf` with itself and is
    // reproduced as written (ldc2 accepts `extern int (*fp)(int); int (*fp)(long);`).
    const tf = t1.isTypeFunction();
    if (tf !== null)
        return cFuncEquivalence(tf, tf.isTypeFunction()!);

    return false;
}

/**********************************************
 * dmd/importc.d:353 — `Dsymbol handleTagSymbols(ref Scope sc, Dsymbol s, Dsymbol s2, ScopeDsymbol sds)`.
 * ImportC tag symbols sit in a parallel symbol table,
 * so that this C code works:
 * ---
 * struct S { a; };
 * int S;
 * struct S s;
 * ---
 * But there are relatively few such tag symbols, so that would be
 * a waste of memory and complexity. An additional problem is we'd like the D side
 * to find the tag symbols with ordinary lookup, not lookup in both
 * tables, if the tag symbol is not conflicting with an ordinary symbol.
 * The solution is to put the tag symbols that conflict into an associative
 * array, indexed by the address of the ordinary symbol that conflicts with it.
 * C has no modules, so this associative array is tagSymTab[] in ModuleDeclaration.
 * A side effect of our approach is that D code cannot access a tag symbol that is
 * hidden by an ordinary symbol. This is more of a theoretical problem, as nobody
 * has mentioned it when importing C headers. If someone wants to do it,
 * too bad so sad. Change the C code.
 * This function fixes up the symbol table when faced with adding a new symbol
 * `s` when there is an existing symbol `s2` with the same name.
 * C also allows forward and prototype declarations of tag symbols,
 * this function merges those.
 *
 * Side effects: may move `members` from `s` to the first declaration, rebind the members of a merged enum, write
 * `sc._module.tagSymTab`, and replace the entry of `sds.symtab`. `sc._module` is dereferenced on the tag-table
 * paths, so the scope must belong to a module.
 * Params:
 *      sc = context
 *      s = symbol to add to symbol table
 *      s2 = existing declaration
 *      sds = symbol table
 * Returns:
 *      if s and s2 are successfully put in symbol table then return the merged symbol,
 *      null if they conflict
 */
export function handleTagSymbols(sc: Scope, s: Dsymbol, s2: Dsymbol, sds: ScopeDsymbol): Dsymbol | null {
    // dropped: `enum log = false;` and the `if (log) printf(...)` traces it gates (importc.d:355-357)
    const sd = s.isScopeDsymbol(); // new declaration
    let sd2 = s2.isScopeDsymbol(); // existing declaration

    // dropped: `static if (log) void print(EnumDeclaration sd)` (importc.d:361-368), resolved to nothing

    if (sd2 === null) {
        /* Look in tag table
         */
        // dropped: `if (log)` trace (importc.d:374)
        const p = sc._module!.tagSymTab.get(s2);
        if (p !== undefined) {
            const s2tag = p;
            sd2 = s2tag.isScopeDsymbol();
            assert(sd2 !== null);        // only tags allowed in tag symbol table
        }
    }

    if (sd !== null && sd2 !== null) { // `s` is a tag, `sd2` is the same tag
        // dropped: `if (log)` trace (importc.d:385)

        // D compares the two `const(char)*` literal addresses; ldc2 pools identical literals and the C tag kinds
        // ("struct", "union", "enum") are distinct literals, so content equality is the same test (file header).
        if (!dsEquals(sd.kind(), sd2.kind()))  // being enum/struct/union must match
            return null;              // conflict

        /* Not a redeclaration if one is a forward declaration.
         * Move members to the first declared type, which is sd2.
         */
        if (sd2.members !== null) {
            if (sd.members === null)
                return sd2;  // ignore the sd redeclaration
        } else if (sd.members !== null) {
            sd2.members = sd.members; // transfer definition to sd2
            sd.members = null;
            const ed2 = sd2.isEnumDeclaration();
            if (ed2 !== null) {
                // `sd.kind()` equals `sd2.kind()` above, so D's unchecked `sd.isEnumDeclaration()` is non-null.
                const ed = sd.isEnumDeclaration()!;
                if (ed.memtype !== ed2.memtype)
                    return null;        // conflict

                // transfer ed's members to sd2
                foreachDsymbolVoid(ed2.members, (s: Dsymbol): void => {
                    const em = s.isEnumMember();
                    if (em !== null)
                        em.ed = ed2;
                });

                ed2.type = ed.type;
                ed2.memtype = ed.memtype;
                ed2.added = false;
            }
            return sd2;
        } else
            return sd2; // ignore redeclaration
    } else if (sd !== null) { // `s` is a tag, `s2` is not
        // dropped: `if (log)` trace (importc.d:426)
        /* add `s` as tag indexed by s2
         */
        sc._module!.tagSymTab.set(s2, s);
        return s;
    } else if (s2 === sd2) { // `s2` is a tag, `s` is not
        // dropped: `if (log)` trace (importc.d:434)
        /* replace `s2` in symbol table with `s`,
         * then add `s2` as tag indexed by `s`
         */
        sds.symtab!.update(s);
        sc._module!.tagSymTab.set(s, s2);
        return s;
    }
    // neither s2 nor s is a tag
    // dropped: `if (log)` trace (importc.d:443)
    return null;
}

/**********************************************
 * dmd/importc.d:465 — `Dsymbol handleSymbolRedeclarations(ref Scope sc, Dsymbol s, Dsymbol s2, ScopeDsymbol sds)`.
 * ImportC allows redeclarations of C variables, functions and typedefs.
 *    extern int x;
 *    int x = 3;
 * and:
 *    extern void f();
 *    void f() { }
 * Attempt to merge them.
 *
 * Side effects: may set `extern` on one of two variables, copy `mangleOverride`, replace the entry of
 * `sds.symtab`, link `overnext`/insert an overload, write `sc._module.tagSymTab`, and print the "different type"
 * diagnostics.
 * Params:
 *      sc = context
 *      s = symbol to add to symbol table
 *      s2 = existing declaration
 *      sds = symbol table
 * Returns:
 *      if s and s2 are successfully put in symbol table then return the merged symbol,
 *      null if they conflict
 */
export function handleSymbolRedeclarations(sc: Scope, s: Dsymbol, s2: Dsymbol, sds: ScopeDsymbol): Dsymbol | null {
    // dropped: `enum log = false;` and the `if (log) printf(...)` traces it gates (importc.d:467-469)

    const collision = (): Dsymbol | null => {
        // dropped: `if (log)` trace (importc.d:473)
        return null;
    };
    /*
    Handle merging declarations with asm("foo") and their definitions
    */
    const mangleWrangle = (oldDecl: Declaration | null, newDecl: Declaration | null): void => {
        if (oldDecl !== null && newDecl !== null) {
            // `mangleOverride` is a slice: its truthiness tests the pointer (06 §2.8).
            newDecl.mangleOverride = oldDecl.mangleOverride !== null ? oldDecl.mangleOverride : null;
        }
    };

    // Don't let macros shadow real symbols
    {
        // the block keeps D's condition scope: a second `td` is declared at importc.d:607
        const td = s.isTemplateDeclaration();
        if (td !== null) {
            if (td.isCmacro) return s2;
        }
    }

    const vd = s.isVarDeclaration(); // new declaration
    const vd2 = s2.isVarDeclaration(); // existing declaration

    if (vd !== null && vd.isCmacro)
        return s2;

    assert(!(vd2 !== null && vd2.isCmacro));

    if (vd !== null && vd2 !== null) {
        /* if one is `static` and the other isn't, the result is undefined
         * behavior, C11 6.2.2.7
         */
        if (((vd.storage_class ^ vd2.storage_class) & STC.static_) !== 0n)
            return collision();

        const i1 =  vd._init !== null && vd._init.isVoidInitializer() === null;
        const i2 = vd2._init !== null && vd2._init.isVoidInitializer() === null;

        if (i1 && i2)
            return collision();         // can't both have initializers

        mangleWrangle(vd2, vd);

        if (i1) {                       // vd is the definition
            vd2.storage_class = (vd2.storage_class | STC.extern_) as STC;  // so toObjFile() won't emit it
            sds.symtab!.update(vd);      // replace vd2 with the definition
            return vd;
        } else if (!i1 && (vd2.storage_class & STC.extern_) === 0n) { /* incoming has void void definition */
            vd.storage_class = (vd.storage_class | STC.extern_) as STC;
        }

        /* BUG: the types should match, which needs semantic() to be run on it
         *    extern int x;
         *    int x;  // match
         *    typedef int INT;
         *    INT x;  // match
         *    long x; // collision
         * We incorrectly ignore these collisions
         * when their types are not matching, err on type differences
         */

        if (!cTypeEquivalence(vd.type!, vd2.type!)) {
            error(vd.loc, ds("redefinition of `%s` with different type: `%s` vs `%s`"),
                vd2.ident!.toChars(), vd2.type!.toChars(), vd.type!.toChars());
        }
        return vd2;
    }

    const fd = s.isFuncDeclaration(); // new declaration
    const fd2 = s2.isFuncDeclaration(); // existing declaration
    if (fd !== null && fd2 !== null) {
        /* if one is `static` and the other isn't, the result is undefined
         * behavior, C11 6.2.2.7
         * However, match what gcc allows:
         *    static int sun1(); int sun1() { return 0; }
         * and:
         *    static int sun2() { return 0; } int sun2();
         * Both produce a static function.
         *
         * Both of these should fail:
         *    int sun3(); static int sun3() { return 0; }
         * and:
         *    int sun4() { return 0; } static int sun4();
         */
        // if adding `static`
        if (   (fd.storage_class & STC.static_) !== 0n &&
            (fd2.storage_class & STC.static_) === 0n) {
            return collision();
        }

        if (fd.fbody !== null && fd2.fbody !== null)
            return collision();         // can't both have bodies

        mangleWrangle(fd2, fd);

        if (fd.fbody !== null) {        // fd is the definition
            // dropped: `if (log)` trace (importc.d:577)
            sds.symtab!.update(fd);  // replace fd2 in symbol table with fd
            fd.overnext = fd2;

            /* If fd2 is covering a tag symbol, then fd has to cover the same one
             */
            const ps = sc._module!.tagSymTab.get(fd2);
            if (ps !== undefined)
                sc._module!.tagSymTab.set(fd, ps);

            return fd;
        }

        /* Just like with VarDeclaration, the types should match, which needs semantic() to be run on it.
         * FuncDeclaration::semantic() detects this, but it relies on .overnext being set.
         */
        overloadInsert(fd2, fd);

        //for the sake of functions declared in function scope.
        // check for return type equivalence also
        // D reads `tf1.next`/`tf2.next` unchecked: a FuncDeclaration's type is a TypeFunction (02 §10.1).
        const tf1 = fd.type!.isTypeFunction()!;
        const tf2 = fd2.type!.isTypeFunction()!;
        if (sc.func !== null &&  !cTypeEquivalence(tf1.next!, tf2.next!) ) {
            error(fd.loc, ds("%s `%s` redeclaration with different type"), fd.kind(), fd.toPrettyChars());
        }

        return fd2;
    }

    const td  = s.isAliasDeclaration();  // new declaration
    const td2 = s2.isAliasDeclaration(); // existing declaration
    if (td !== null && td2 !== null) {
        /* BUG: just like with variables and functions, the types should match, which needs semantic() to be run on it.
         * FuncDeclaration::semantic2() can detect this, but it relies overnext being set.
         */
        return td2;
    }

    return collision();
}

/*********************************
 * dmd/importc.d:623 — `void cEnumSemantic(Scope* sc, EnumDeclaration ed)`.
 * ImportC-specific semantic analysis on enum declaration `ed`
 *
 * C11 6.7.2.2: every member gets an integer value of the common type (`ed.memtype`, else `int` widened by the
 * initializers), consecutive members count up from the previous one, and overflow or an out-of-range value is
 * diagnosed on the member (`errors` set, value an `ErrorExp`). Postconditions: `ed.memtype` is the common type and
 * `ed.semanticRun` is `PASS.semantic2done`.
 */
export function cEnumSemantic(sc: Scope, ed: EnumDeclaration): void {
    // C11 6.7.2.2
    let commonType: Type | null = ed.memtype;
    if (commonType === null)
        commonType = Type.tint32;
    const nextValue: Ref<bigint> = { value: 0n };        // C11 6.7.2.2-3 first member value defaults to 0

    // C11 6.7.2.2-2 value must be representable as an int.
    // The sizemask represents all values that int will fit into,
    // from 0..uint.max.  We want to cover int.min..uint.max.
    const ir: IntRange = intRangeFromType(commonType);

    // `commonType` is non-null from here on (set above, and reassigned only from a semantic'd `e.type`); the
    // closures cannot see the narrowing, hence `commonType!` inside them.
    const emSemantic = (em: EnumMember, nextValue: Ref<bigint>): void => {
        const errorReturn = (em: EnumMember): void => {
            em.value = ErrorExp.get();
            em.errors = true;
            em.semanticRun = PASS.semanticdone;
        };

        em.semanticRun = PASS.semantic;
        em.type = commonType;
        em._linkage = LINK.c;
        em.storage_class = (em.storage_class | STC.manifest) as STC;
        if (em.value !== null) {
            let e: Expression = em.value;
            assert(e.dyncast() === DYNCAST.expression);

            /* To merge the type of e with commonType, add 0 of type commonType
                */
            if (ed.memtype === null)
                e = new AddExp(em.loc, e, new IntegerExp(em.loc, 0n, commonType!));

            e = expressionSemantic(e, sc);
            e = resolveProperties(sc, e);
            e = integralPromotions(e, sc);
            e = ctfeInterpret(e);
            if (e.op === EXP.error)
                return errorReturn(em);
            const ie = e.isIntegerExp();
            if (ie === null) {
                // C11 6.7.2.2-2
                error(em.loc, ds("%s `%s` enum member must be an integral constant expression, not `%s` of type `%s`"),
                    em.kind(), em.toPrettyChars(), e.toChars(), e.type!.toChars());
                return errorReturn(em);
            }
            if (ed.memtype !== null && !ir.contains(getIntRange(ie))) {
                // C11 6.7.2.2-2
                error(em.loc, ds("%s `%s` enum member value `%s` does not fit in `%s`"),
                    em.kind(), em.toPrettyChars(), e.toChars(), commonType!.toChars());
                return errorReturn(em);
            }
            nextValue.value = toInteger(ie);
            if (ed.memtype === null)
                commonType = e.type;
            em.value = new IntegerExp(em.loc, nextValue.value, commonType!);
        } else {
            // C11 6.7.2.2-3 add 1 to value of previous enumeration constant
            const first = (em === em.ed!.members!.opIndex(0));
            if (!first) {
                // D passes `null` for `Scope* scope_`; the TS parameter is typed non-null (typesem.ts:5173), a
                // `dependency signature` defect of the callee: `null!` passes the same null D passes. On a basic
                // type the `max` property never reads the scope.
                const max = getProperty(commonType!, null!, em.loc, Id.max!, 0)!;
                if (nextValue.value === toInteger(max)) {
                    error(em.loc, ds("%s `%s` initialization with `%s+1` causes overflow for type `%s`"),
                        em.kind(), em.toPrettyChars(), max.toChars(), commonType!.toChars());
                    return errorReturn(em);
                }
                // `ulong += 1` (09 §3). The test above stops at the type's maximum, so the wrap never fires; the
                // only uses of the value are `==` against a non-negative maximum and the IntegerExp ctor, which
                // normalizes, so the unsigned re-truncation agrees with the signed carrier on every reachable value.
                nextValue.value = BigInt.asUintN(64, nextValue.value + 1n);
            }
            em.value = new IntegerExp(em.loc, nextValue.value, commonType!);
        }
        em.type = commonType;
        em.semanticRun = PASS.semanticdone;
    };

    foreachDsymbolVoid(ed.members, (s: Dsymbol): void => {
        const em = s.isEnumMember();
        if (em !== null)
            emSemantic(em, nextValue);
    });

    if (ed.memtype === null) {
        // cast all members to commonType
        foreachDsymbolVoid(ed.members, (s: Dsymbol): void => {
            const em = s.isEnumMember();
            if (em !== null) {
                em.type = commonType;
                // optimize out the cast so that other parts of the compiler can
                // assume that an integral enum's members are `IntegerExp`s.
                // https://issues.dlang.org/show_bug.cgi?id=24504
                em.value = optimize(castTo(em.value!, sc, commonType!), WANTvalue);
            }
        });
    }

    ed.memtype = commonType;
    // Set semantic2done to mark C enums as fully processed
    // Prevents issues with final switch statements that reference C enums
    ed.semanticRun = PASS.semantic2done;
    return;
}
