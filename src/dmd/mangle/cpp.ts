// Ported from dmd/mangle/cpp.d (module dmd.mangle.cpp).
//
// Do mangling for C++ linkage: the POSIX (Itanium C++ ABI 1.86 §5.1) side. No supported triple is MSVC
// (10 §4.8), so `isTargetWindowsMSVC()` (target.d:1734/:1764) is false and every C++ symbol of the
// frontend reaches this module through `target.cpp.toMangle` / `target.cpp.typeInfoMangle`; mangle/cppwin.d
// (MSVC) is unreachable and not ported.
//
// TRANSLATION DECISIONS (one line each, with the guide rule):
//   - CppMangleVisitor, ComponentVisitor and LeftoverVisitor are Idiom-A visitor classes (13 §7): each
//     `visit(X)` overload is `visitX`; every `alias visit = Visitor.visit;` is dropped (13 §1).
//   - `visit(Tuple)` is not a Visitor slot (Tuple has no `accept`); D reaches it only by static dispatch from
//     `visitObject`, so it is the plain method `visitTuple` and `visitObject` requires it of its visitor (07 §3.5(a):
//     both instantiations, CppMangleVisitor and ComponentVisitor, declare it).
//   - `visitObject(V : Visitor)` is one generic function: its only use of `V` is that static `visit(Tuple)` call.
//   - `isStd` (cpp.d:393/:407) and `isNamespaceEqual` (cpp.d:2347/:2355/:2361/:2376) are same-arity overload sets
//     renamed per 04 §1 Form B; every call site is rewritten to the overload D resolved by the argument's
//     DECLARED type (`Dsymbol ns = ti.tempdecl.cppnamespace` at cpp.d:676 binds the Dsymbol form).
//   - `Context.push(lazy RootObject next)` takes a thunk: D evaluates a `lazy` argument only when the callee
//     reads it, and `push` reads it only when `res` is non-null. No guide section covers `lazy` (doc feedback).
//   - `Context` is copyable (only `opAssign` is `@disable`d), so it carries `copy()` (03 §6.3 checklist); the one D
//     copy, `auto prev = this.context;` (cpp.d:2040), calls it. `ABITagContainer` holds an `Array!StringExp` by
//     value, and `Array` is `@disable this(this)` (root/array.d:50), so the container is not copyable: no `copy()`.
//   - `scope (exit) this.context.pop(prev)` is `try { … } finally { this.context.pop(prev); }` (11 §2.5).
//   - `out bool` parameters (`needsTa`, `exact`) are `{ value: boolean }` boxes reset on entry (03 §3.3).
//   - `foreach (n, fparam; parameterList)` is `ParameterList.opApply` (05 §11); the `return` from inside it is the
//     OPAPPLY-BAIL shape (06 §4): a captured flag, `return 1`, and the function returns after the loop.
//   - The jumps to `continue_template:` (cpp.d:1277-1314, label :1320): its tail is `firstTemplateArg = 1;` then the
//     `break` out of `switch (whichOp)`. Each jump site calls the zero-param tail arrow and breaks the labelled
//     `whichOp` switch: the BAIL shape (06 §4) with a `break` exit instead of a `return` (doc feedback).
//   - The `switch` over `str.peekString()` bytes uses a module-private Latin-1 `keyOf` (06 §3.4).
//   - `version (none)` in `source_name` (cpp.d:646) is dropped (07 §1.4).
//   - D-private module members the unittest reaches (`closestIndex`) are exported with a `// D module-private`
//     note (10 §1.7); the other private classes and helpers stay unexported.
//   - Strings the D source writes as literals (`"St"`, `"_Z"`) are DString byte literals (`ds`), the OutBuffer type.
//   - One declared divergence, in `ABITagContainer.forSymbol` (cpp.d:2439): D dereferences `isStructLiteralExp()`
//     unchecked, which reads through null while the UDA is not yet CTFE-evaluated (a `.mangleof` during semantic1);
//     the port reproduces ldc2's binary there, which reads CallExp.arguments (same offset), as the site's comment
//     states. Every other path is translated whole.

import { TY, LINK, STC, VarArg } from "../astenums.js";
import { DYNCAST } from "../rootobject.js";
import type { RootObject } from "../rootobject.js";
import { Id } from "../id.js";
import type { Identifier } from "../identifier.js";
import type { Loc } from "../location.js";
import { OutBuffer } from "../common/outbuffer.js";
import { Array as DArray } from "../root/array.js";
import type { TemplateParameters } from "../arraytypes.js";
import { ds, dsEmpty, dsToJs } from "../../dstring.js";
import type { DString } from "../../dstring.js";
import { assert, assertUnreachable, SwitchError } from "../../assert.js";
import { toInt64, toUint64 } from "../../numeric.js";
import { Visitor } from "../visitor/index.js";
// AST-node modules before the *sem modules (01 §4.8).
import { Type, TypeFunction, TypeDelegate, ParameterList } from "../mtype.js";
import type {
    TypeBasic,
    TypeClass,
    TypeEnum,
    TypeIdentifier,
    TypeInstance,
    TypeNoreturn,
    TypeNull,
    TypePointer,
    TypeReference,
    TypeSArray,
    TypeStruct,
    TypeVector,
    Parameter,
} from "../mtype.js";
import { getFuncTemplateDecl } from "../expression.js";
import type { Expression, IntegerExp, StringExp, ArrayLiteralExp } from "../expression.js";
import type { Dsymbol } from "../dsymbol.js";
import type { FuncDeclaration } from "../func.js";
import type { VarDeclaration } from "../declaration.js";
import type { Nspace } from "../nspace.js";
import type { CPPNamespaceDeclaration } from "../attrib.js";
import { isType, isExpression, isDsymbol, isTuple, isTemplateParameter, getType } from "../dtemplate.js";
import type { Tuple, TemplateInstance, TemplateDeclaration, TemplateParameter } from "../dtemplate.js";
import { global, CppStdRevision } from "../globals.js";
import { error, fatal } from "../errors.js";
import { dstrcmp } from "../root/string.js";
import {
    nextOf,
    referenceTo,
    mutableOf,
    unSharedOf,
    toDsymbol,
    isIntegral,
    isUnsigned,
    isString,
    isReal,
    isImaginary,
    isComplex,
    memType,
    merge,
    merge2,
} from "../typesem.js";
import { isGNUABITag, toAlias, equals } from "../dsymbolsem.js";
import { toStringExp, toInteger, toUInteger } from "../expressionsem.js";
import { computeOneMember } from "../templatesem.js";
// last: target.ts value-imports this module (its `toMangle`/`typeInfoMangle`), so the edge back is read only
// inside method bodies, never at load (01 §4.3; last per 01 §4.8).
import { target } from "../target.js";

/// dmd/mangle/cpp.d:52 — `enum CppOperator`. C++ operators.
export enum CppOperator { Unknown, Cast, Assign, Eq, Index, Call, Unary, Binary, OpAssign }

/**************
 * Check if id is a C++ operator
 *
 * dmd/mangle/cpp.d:61 — `package CppOperator isCppOperator(const scope Identifier id)`. `package` visibility
 * (cppwin.d's import) is an export here. The `with (Id) with (CppOperator)` scopes are re-qualified (06 §3.3).
 *
 * Params:
 *      id = identifier to be checked
 * Returns:
 *      CppOperator, or Unknown if not a C++ operator
 */
export function isCppOperator(id: Identifier | null): CppOperator {
    return (id === Id.opCast)     ? CppOperator.Cast     :
           (id === Id.opAssign)   ? CppOperator.Assign   :
           (id === Id.opEquals)   ? CppOperator.Eq       :
           (id === Id.opIndex)    ? CppOperator.Index    :
           (id === Id.opCall)     ? CppOperator.Call     :
           (id === Id.opUnary)    ? CppOperator.Unary    :
           (id === Id.opBinary)   ? CppOperator.Binary   :
           (id === Id.opOpAssign) ? CppOperator.OpAssign :
                                    CppOperator.Unknown  ;
}

/**
 * dmd/mangle/cpp.d:78 — `const(char)* toCppMangleItanium(Dsymbol s)`. The Itanium C++ mangling of a variable
 * or function declaration `s` (`target.cpp.toMangle`, target.d:1737).
 *
 * Precondition: `s` is a VarDeclaration or a FuncDeclaration (anything else is D's `assert(0)`, cpp.d:214).
 * Returns the NUL-terminated bytes (`extractChars`: the DString includes the NUL), which the caller reads as a
 * C string (mangle/package.d:1390 `p.toDString()`).
 * On a mangling error the visitor has printed the diagnostic, and `fatal()` ends the compilation.
 */
export function toCppMangleItanium(s: Dsymbol): DString {
    //printf("toCppMangleItanium(%s)\n", s.toChars());
    const buf = new OutBuffer();
    const v = new CppMangleVisitor(buf, s.loc);
    v.mangleOf(s);
    if (v.errors)
        fatal();
    return buf.extractChars();
}

/**
 * dmd/mangle/cpp.d:90 — `const(char)* cppTypeInfoMangleItanium(Dsymbol s)`. The mangled name of the C++
 * `typeinfo` object of the class `s`: `_ZTI` + its name (`target.cpp.typeInfoMangle`, target.d:1767). Only LDC's
 * C++ code generator calls it (gen/trycatchfinally.cpp:179, :355), for catching C++ exceptions.
 *
 * Returns the NUL-terminated bytes, as `toCppMangleItanium`. On a mangling error, `fatal()`.
 */
export function cppTypeInfoMangleItanium(s: Dsymbol): DString {
    //printf("cppTypeInfoMangle(%s)\n", s.toChars());
    const buf = new OutBuffer();
    buf.writestring(ds("_ZTI"));    // "TI" means typeinfo structure
    const v = new CppMangleVisitor(buf, s.loc);
    v.cpp_mangle_name(s, false);
    if (v.errors)
        fatal();
    return buf.extractChars();
}

/**
 * dmd/mangle/cpp.d:103 — `const(char)* cppThunkMangleItanium(FuncDeclaration fd, int offset)`. The mangled name
 * of the this-adjusting thunk of the virtual function `fd`: `_ZThn<offset>_` + its encoding. Only LDC's C++ glue
 * calls it (through cxxfrontend.d:68); no frontend path reaches it.
 *
 * `offset` is printed with `%u`, so a negative int prints as its unsigned 32-bit value.
 * Returns the NUL-terminated bytes, as `toCppMangleItanium`. On a mangling error, `fatal()`.
 */
export function cppThunkMangleItanium(fd: FuncDeclaration, offset: number): DString {
    //printf("cppThunkMangleItanium(%s)\n", fd.toChars());
    const buf = new OutBuffer();
    // C's %u reads the int argument as unsigned int: >>> 0 is that conversion (dmdformat wraps a negative %u at
    // 64 bits).
    buf.printf(ds("_ZThn%u_"), offset >>> 0);  // "Th" means thunk, "n%u" is the call offset
    const v = new CppMangleVisitor(buf, fd.loc);
    v.mangle_function_encoding(fd);
    if (v.errors)
        fatal();
    return buf.extractChars();
}

/******************************
 * Determine if sym is a full aggregate destructor.
 *
 * dmd/mangle/cpp.d:122 — `bool isAggregateDtor(const Dsymbol sym)`. Precondition: a destructor `sym` is a member
 * of an aggregate (`assert(ad)`, cpp.d:128).
 *
 * Params:
 *      sym = Dsymbol
 * Returns:
 *      true if sym is an aggregate destructor
 */
export function isAggregateDtor(sym: Dsymbol): boolean {
    const dtor = sym.isDtorDeclaration();
    if (!dtor)
        return false;
    const ad = dtor.isMember();
    assert(ad);
    return dtor === ad.aggrDtor;
}

/**
 * Context used when processing pre-semantic AST
 *
 * dmd/mangle/cpp.d:133 — `private struct Context`. `opAssign` is `@disable`d (cpp.d:142-143), so a Context is
 * never assigned whole; it is copied once (`auto prev = this.context;`, cpp.d:2040) through `copy()`.
 */
class Context {
    /// Template instance of the function being mangled
    ti: TemplateInstance | null;
    /// Function declaration we're mangling
    fd: FuncDeclaration | null;
    /// Current type / expression being processed (semantically analyzed)
    res: RootObject | null;

    constructor(ti: TemplateInstance | null = null, fd: FuncDeclaration | null = null, res: RootObject | null = null) {
        this.ti = ti;
        this.fd = fd;
        this.res = res;
    }

    /// Field-wise copy: the three fields are class references, shared (03 §2).
    copy(): Context {
        return new Context(this.ti, this.fd, this.res);
    }

    /**
     * Helper function to track `res`
     *
     * dmd/mangle/cpp.d:156 — `private Context push(lazy RootObject next) @safe`. `next` is D's `lazy` argument:
     * the thunk runs only when `res` is non-null.
     *
     * Params:
     *   next = Value to set `this.res` to.
     *          If `this.res` is `null`, the expression is not evalutated.
     *          This allow this code to be used even when no context is needed.
     *
     * Returns:
     *   The previous state of this `Context` object
     */
    push(next: () => RootObject | null): Context {
        const r = this.res;
        if (r !== null)
            this.res = next();
        return new Context(this.ti, this.fd, r);
    }

    /**
     * Reset the context to a previous one, making any adjustment necessary
     *
     * dmd/mangle/cpp.d:167 — `private void pop(ref Context prev) @safe`.
     */
    pop(prev: Context): void {
        this.res = prev.res;
    }
}

/**
 * dmd/mangle/cpp.d:173 — `private final class CppMangleVisitor : Visitor`. Writes the Itanium mangling of one
 * symbol into `buf`, keeping the substitution candidates (`components`) and the ABI tags already written.
 * One instance per mangled symbol; `errors` is set when a construct cannot be mapped to C++ (the diagnostic is
 * already printed).
 */
class CppMangleVisitor extends Visitor {
    /// Context used when processing pre-semantic AST
    context: Context = new Context();

    abiTags: ABITagContainer = new ABITagContainer();    /// Container for already-written ABI tags
    components: DArray<RootObject | null> = new DArray<RootObject | null>(); /// substitution candidates
    buf: OutBuffer;             /// append the mangling to buf[]
    loc: Loc;                   /// location for use in error messages
    errors = false;             /// failed to mangle properly

    /**
     * Constructor
     *
     * Params:
     *   buf = `OutBuffer` to write the mangling to
     *   loc = `Loc` of the symbol being mangled
     */
    constructor(buf: OutBuffer, loc: Loc) {
        super();
        this.buf = buf;
        this.loc = loc;
    }

    /*****
     * Entry point. Append mangling to buf[]
     * Params:
     *  s = symbol to mangle
     */
    mangleOf(s: Dsymbol): void {
        const vd = s.isVarDeclaration();
        if (vd !== null) {
            this.mangle_variable(vd, vd.cppnamespace() !== null);
        } else {
            const fd = s.isFuncDeclaration();
            if (fd !== null) {
                this.mangle_function(fd);
            } else {
                assertUnreachable();
            }
        }
    }

    /**
     * Mangle the return type of a function
     *
     * This is called on a templated function type.
     * Context is set to the `FuncDeclaration`.
     *
     * Params:
     *   preSemantic = the `FuncDeclaration`'s `originalType`
     */
    mangleReturnType(preSemantic: TypeFunction): void {
        const tf = asFuncDecl(this.context.res).type!.isTypeFunction()!;
        let rt = nextOf(preSemantic);
        // https://issues.dlang.org/show_bug.cgi?id=22739
        // auto return type means that rt is null.
        // if so, just pick up the type from the instance
        if (!rt)
            rt = nextOf(tf);
        if (tf.isRef)
            rt = referenceTo(rt!);
        const prev = this.context.push(() => nextOf(tf));
        try {
            this.headOfType(rt!);
        } finally {
            this.context.pop(prev);
        }
    }

    /**
     * Write a seq-id from an index number, excluding the terminating '_'
     *
     * Params:
     *   idx = the index in a substitution list.
     *         Note that index 0 has no value, and `S0_` would be the
     *         substitution at index 1 in the list.
     *
     * See-Also:
     *  https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangle.seq-id
     */
    writeSequenceFromIndex(idx: number): void {
        if (idx) {
            const write_seq_id = (i: number): void => {
                if (i >= 36) {
                    write_seq_id(Math.floor(i / 36));
                    i %= 36;
                }
                i += (i < 10) ? 0x30 /* '0' */ : 0x41 /* 'A' */ - 10;
                this.buf.writeByte(i);
            };

            write_seq_id(idx - 1);
        }
    }

    /**
     * Attempt to perform substitution on `p`
     *
     * If `p` already appeared in the mangling, it is stored as
     * a 'part', and short references in the form of `SX_` can be used.
     * Note that `p` can be anything: template declaration, struct declaration,
     * class declaration, namespace...
     *
     * Params:
     *   p = The object to attempt to substitute
     *   nested = Whether or not `p` is to be considered nested.
     *            When `true`, `N` will be prepended before the substitution.
     *
     * Returns:
     *   Whether `p` already appeared in the mangling,
     *   and substitution has been written to `this.buf`.
     */
    substitute(p: RootObject, nested = false): boolean {
        //printf("substitute %s\n", p ? p.toChars() : null);
        const i = this.find(p);
        if (i < 0)
            return false;

        //printf("\tmatch\n");
        /* Sequence is S_, S0_, .., S9_, SA_, ..., SZ_, S10_, ...
         */
        if (nested)
            this.buf.writeByte(0x4E /* 'N' */);
        this.buf.writeByte(0x53 /* 'S' */);
        this.writeSequenceFromIndex(i);
        this.buf.writeByte(0x5F /* '_' */);
        return true;
    }

    /******
     * See if `p` exists in components[]
     *
     * Note that components can contain `null` entries,
     * as the index used in mangling is based on the index in the array.
     *
     * If called with an object whose dynamic type is `Nspace`,
     * calls the `find(Nspace)` overload.
     *
     * Returns:
     *  index if found, -1 if not
     */
    find(p: RootObject): number {
        //printf("find %p %d %s\n", p, p.dyncast(), p ? p.toChars() : null);
        const v = new ComponentVisitor(p);
        for (let i = 0; i < this.components.length; i++) {
            const component = this.components.opIndex(i);
            if (component)
                visitObject(component, v);
            if (v.result)
                return i;
        }
        return -1;
    }

    /*********************
     * Append p to components[]
     */
    append(p: RootObject | null): void {
        //printf("append %p %d %s\n", p, p.dyncast(), p ? p.toChars() : "null");
        this.components.push(p);
    }

    /**
     * Write an identifier preceded by its length
     *
     * Params:
     *   ident = `Identifier` to write to `this.buf`
     */
    writeIdentifier(ident: Identifier): void {
        const name = ident.toString();
        this.buf.print(BigInt(name.length));
        this.buf.writestring(name);
    }

    /**
     * Insert the leftover ABI tags to the buffer
     *
     * This inset ABI tags that hasn't already been written
     * after the mangled name of the function.
     * For more details, see the `abiTags` variable.
     *
     * Params:
     *   off  = Offset to insert at
     *   tf   = Type of the function to mangle the return type of
     */
    writeRemainingTags(off: number, tf: TypeFunction): void {
        const toWrite = new DArray<StringExp>();
        leftOver(tf, this.abiTags.written, toWrite);
        const b2 = new OutBuffer();
        for (const se of toWrite) {
            const tag = se.peekString();
            // We can only insert a slice, and each insert is a memmove,
            // so use a temporary buffer to keep it efficient.
            b2.reset();
            b2.writestring(ds("B"));
            b2.print(BigInt(tag.length));
            b2.writestring(tag);
            this.buf.insert(off, b2.opSliceAll());
            off += b2.length();
        }
    }

    /************************
     * Determine if symbol is indeed the global ::std namespace.
     *
     * dmd/mangle/cpp.d:393 — `static bool isStd(Dsymbol s)`. The Dsymbol form of the overload set keeps the bare
     * name; the CPPNamespaceDeclaration form (cpp.d:407) is `isStdCPPNamespaceDeclaration` (04 §1 Form B rule 2).
     *
     * Params:
     *  s = symbol to check
     * Returns:
     *  true if it is ::std
     */
    static isStd(s: Dsymbol | null): boolean {
        if (!s)
            return false;

        const cnd = s.isCPPNamespaceDeclaration();
        if (cnd !== null)
            return CppMangleVisitor.isStdCPPNamespaceDeclaration(cnd);

        return (s.ident === Id.std &&    // the right name
                s.isNspace() !== null && // g++ disallows global "std" for other than a namespace
                !CppMangleVisitor.getQualifier(s));      // at global level
    }

    /// Ditto
    ///
    /// dmd/mangle/cpp.d:407 — `static bool isStd(CPPNamespaceDeclaration s)` (renamed, see `isStd`).
    static isStdCPPNamespaceDeclaration(s: CPPNamespaceDeclaration | null): boolean {
        return s !== null && s.cppnamespace() === null && s.ident === Id.std;
    }

    /************************
     * Determine if type is a C++ fundamental type.
     * Params:
     *  t = type to check
     * Returns:
     *  true if it is a fundamental type
     */
    static isFundamentalType(t: Type): boolean {
        // First check the target whether some specific ABI is being followed.
        const isFundamental = { value: false }; // D `= void`; written by fundamentalType before any read
        if (target.cpp.fundamentalType(t, isFundamental))
            return isFundamental.value;

        const te = t.isTypeEnum();
        if (te !== null) {
            // Peel off enum type from special types.
            if (te.sym!.isSpecial())
                t = memType(te);
        }

        // Fundamental arithmetic types:
        // 1. integral types: bool, char, int, ...
        // 2. floating point types: float, double, real
        // 3. void
        // 4. null pointer: std::nullptr_t (since C++11)
        if (t.ty === TY.Tvoid || t.ty === TY.Tbool)
            return true;
        if (t.ty === TY.Tnull && global.params.cplusplus >= CppStdRevision.cpp11)
            return true;

        return t.isTypeBasic() !== null && (isIntegral(t) || isReal(t));
    }

    /******************************
     * Write the mangled representation of a template argument.
     * Params:
     *  ti  = the template instance
     *  arg = the template argument index
     */
    template_arg(ti: TemplateInstance, arg: number): void {
        const td = ti.tempdecl!.isTemplateDeclaration();
        assert(td);
        const tp = td.parameters!.opIndex(arg)!;
        const o = ti.tiargs!.opIndex(arg);

        const prev = this.context.push(() => {
            let parentti: TemplateInstance | null;
            if (this.context.res!.dyncast() === DYNCAST.dsymbol)
                parentti = asFuncDecl(this.context.res).parent!.isTemplateInstance();
            else {
                const parent = toDsymbol(asType(this.context.res), null)!.parent!;
                parentti = parent.isTemplateInstance();
                // https://issues.dlang.org/show_bug.cgi?id=22760
                // The template instance may sometimes have the form
                // S1!int.S1, therefore the above instruction might yield null
                if (parentti === null && parent.parent)
                    parentti = parent.parent.isTemplateInstance();
            }
            return parentti!.tiargs!.opIndex(arg);
        });
        try {
            if (tp.isTemplateTypeParameter()) {
                const t = isType(o);
                assert(t);
                t.accept(this);
            } else {
                const tv = tp.isTemplateValueParameter();
                if (tv !== null) {
                    // <expr-primary> ::= L <type> <value number> E  # integer literal
                    if (isIntegral(tv.valType!)) {
                        const e = isExpression(o);
                        assert(e);
                        this.buf.writeByte(0x4C /* 'L' */);
                        tv.valType!.accept(this);
                        let val = toUInteger(e);
                        if (!isUnsigned(tv.valType!) && toInt64(val) < 0n) {
                            val = toUint64(-val);
                            this.buf.writeByte(0x6E /* 'n' */);
                        }
                        this.buf.print(val);
                        this.buf.writeByte(0x45 /* 'E' */);
                    } else {
                        error(ti.loc,
                            ds("%s `%s` internal compiler error: C++ `%s` template value parameter is not supported"),
                            ti.kind(), ti.toPrettyChars(), tv.valType!.toChars());
                        this.errors = true;
                        return;
                    }
                } else if (tp.isTemplateAliasParameter()) {
                    // Passing a function as alias parameter is the same as passing
                    // `&function`
                    const d = isDsymbol(o);
                    const e = isExpression(o);

                    if (d && d.isTemplateDeclaration())
                        computeOneMember(d.isTemplateDeclaration());

                    if (d && d.isFuncDeclaration()) {
                        // X .. E => template parameter is an expression
                        // 'ad'   => unary operator ('&')
                        // L .. E => is a <expr-primary>
                        this.buf.writestring(ds("XadL"));
                        this.mangle_function(d.isFuncDeclaration()!);
                        this.buf.writestring(ds("EE"));
                    } else if (e && e.isVarExp() && e.isVarExp()!.var_!.isVarDeclaration()) {
                        const vd = e.isVarExp()!.var_!.isVarDeclaration()!;
                        this.buf.writeByte(0x4C /* 'L' */);
                        this.mangle_variable(vd, true);
                        this.buf.writeByte(0x45 /* 'E' */);
                    } else if (d && d.isTemplateDeclaration() && d.isTemplateDeclaration()!.onemember) {
                        if (!this.substitute(d)) {
                            this.cpp_mangle_name(d, false);
                        }
                    } else {
                        error(ti.loc,
                            ds("%s `%s` internal compiler error: C++ `%s` template alias parameter is not supported"),
                            ti.kind(), ti.toPrettyChars(), o!.toChars());
                        this.errors = true;
                    }
                } else if (tp.isTemplateThisParameter()) {
                    error(ti.loc,
                        ds("%s `%s` internal compiler error: C++ `%s` template this parameter is not supported"),
                        ti.kind(), ti.toPrettyChars(), o!.toChars());
                    this.errors = true;
                } else {
                    assertUnreachable();
                }
            }
        } finally {
            this.context.pop(prev);
        }
    }

    /******************************
     * Write the mangled representation of the template arguments.
     * Params:
     *  ti = the template instance
     *  firstArg = index of the first template argument to mangle
     *             (used for operator overloading)
     * Returns:
     *  true if any arguments were written
     */
    template_args(ti: TemplateInstance | null, firstArg = 0): boolean {
        /* <template-args> ::= I <template-arg>+ E
         */
        if (!ti || ti.tiargs!.length <= firstArg)   // could happen if std::basic_string is not a template
            return false;
        this.buf.writeByte(0x49 /* 'I' */);
        for (let i = firstArg; i < ti.tiargs!.length; i++) {
            const td = ti.tempdecl!.isTemplateDeclaration();
            assert(td);
            const tp = td.parameters!.opIndex(i)!;

            /*
             * <template-arg> ::= <type>               # type or template
             *                ::= X <expression> E     # expression
             *                ::= <expr-primary>       # simple expressions
             *                ::= J <template-arg>* E  # argument pack
             *
             * Reference: https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangle.template-arg
             */
            const tt = tp.isTemplateTupleParameter();
            if (tt !== null) {
                this.buf.writeByte(0x4A /* 'J' */);     // argument pack

                // mangle the rest of the arguments as types
                for (let j = i; j < ti.tiargs!.length; j++) {
                    const t = isType(ti.tiargs!.opIndex(j));
                    if (t === null) {
                        error(ti.loc,
                            ds("%s `%s` internal compiler error: C++ `%s` template value parameter is not supported"),
                            ti.kind(), ti.toPrettyChars(), ti.tiargs!.opIndex(j)!.toChars());
                        this.errors = true;
                        return false;
                    }
                    t.accept(this);
                }

                this.buf.writeByte(0x45 /* 'E' */);
                break;
            }

            this.template_arg(ti, i);
        }
        this.buf.writeByte(0x45 /* 'E' */);
        return true;
    }

    /**
     * Write the symbol `p` if not null, then execute the delegate
     *
     * Params:
     *   p = Symbol to write
     *   dg = Delegate to execute
     */
    writeChained(p: Dsymbol | null, dg: () => void): void {
        if (p && !p.isModule()) {
            this.buf.writestring(ds("N"));
            this.source_name(p, true);
            dg();
            this.buf.writestring(ds("E"));
        } else
            dg();
    }

    /**
     * Write the name of `s` to the buffer
     *
     * Params:
     *   s = Symbol to write the name of
     *   haveNE = Whether `N..E` is already part of the mangling
     *            Because `Nspace` and `CPPNamespaceAttribute` can be
     *            mixed, this is a mandatory hack.
     */
    source_name(s: Dsymbol, haveNE = false): void {
        // dropped: `version (none)` debug block (cpp.d:646-651), 07 §1.4
        const ti = s.isTemplateInstance();

        if (!ti) {
            const ag = s.isAggregateDeclaration();
            const ident = (ag && ag.pMangleOverride) ? ag.pMangleOverride.id : s.ident;
            this.writeNamespace(s.cppnamespace(), () => {
                this.writeIdentifier(ident!);
                this.abiTags.writeSymbol(s, this);
            }, haveNE);
            return;
        }

        const needsTa = { value: false };

        // https://issues.dlang.org/show_bug.cgi?id=20413
        // N..E is not needed when substituting members of the std namespace.
        // This is observed in the GCC and Clang implementations.
        // The Itanium specification is not clear enough on this specific case.
        // References:
        //   https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangle.name
        //   https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling-compression
        const q = CppMangleVisitor.getQualifier(ti.tempdecl!);
        // D declares `ns` as `Dsymbol`, so `isStd(ns)` binds the Dsymbol overload.
        const ns: Dsymbol | null = ti.tempdecl!.cppnamespace();
        const inStd = (ns !== null && CppMangleVisitor.isStd(ns)) || (q !== null && CppMangleVisitor.isStd(q));
        const isNested = !inStd && (ns !== null || q !== null);

        if (this.substitute(ti.tempdecl!, !haveNE && isNested)) {
            this.template_args(ti);
            if (!haveNE && isNested)
                this.buf.writeByte(0x45 /* 'E' */);
            return;
        } else if (this.writeStdSubstitution(ti, needsTa)) {
            this.abiTags.writeSymbol(ti, this);
            if (needsTa.value)
                this.template_args(ti);
            return;
        }

        const ag = ti.aliasdecl ? ti.aliasdecl.isAggregateDeclaration() : null;
        if (ag && ag.pMangleOverride) {
            this.writeNamespace(
                toAlias(ti).cppnamespace(), () => {
                    this.writeIdentifier(ag.pMangleOverride!.id!);
                    if (ag.pMangleOverride!.agg && ag.pMangleOverride!.agg.isInstantiated()) {
                        const to = ag.pMangleOverride!.agg.isInstantiated()!;
                        this.append(to);
                        this.abiTags.writeSymbol(to.tempdecl!, this);
                        this.template_args(to);
                    }
                }, haveNE);
        } else {
            this.writeNamespace(
                s.cppnamespace(), () => {
                    this.writeIdentifier(toAlias(ti.tempdecl!).ident!);
                    this.append(ti.tempdecl);
                    this.abiTags.writeSymbol(ti.tempdecl!, this);
                    this.template_args(ti);
                }, haveNE);
        }
    }

    /********
     * See if s is actually an instance of a template
     * Params:
     *  s = symbol
     * Returns:
     *  if s is instance of a template, return the instance, otherwise return s
     */
    static getInstance(s: Dsymbol): Dsymbol {
        const p = s.toParent();
        if (p) {
            const ti = p.isTemplateInstance();
            if (ti)
                return ti;
        }
        return s;
    }

    /// Get the namespace of a template instance
    getTiNamespace(ti: TemplateInstance): CPPNamespaceDeclaration | null {
        // If we receive a pre-semantic `TemplateInstance`,
        // `cppnamespace` is always `null`
        return ti.tempdecl ? ti.cppnamespace()
            : toDsymbol(asType(this.context.res), null)!.cppnamespace();
    }

    /********
     * Get qualifier for `s`, meaning the symbol
     * that s is in the symbol table of.
     * The module does not count as a qualifier, because C++
     * does not have modules.
     * Params:
     *  s = symbol that may have a qualifier
     *      s is rewritten to be TemplateInstance if s is one
     * Returns:
     *  qualifier, null if none
     */
    static getQualifier(s: Dsymbol): Dsymbol | null {
        const p = s.toParent();
        return (p && !p.isModule()) ? p : null;
    }

    // Detect type char
    static isChar(o: RootObject | null): boolean {
        const t = isType(o);
        return (t !== null && t.equals(Type.tchar));
    }

    // Detect type ::std::char_traits<char>
    isChar_traits_char(o: RootObject | null): boolean {
        return this.isIdent_char(Id.char_traits!, o);
    }

    // Detect type ::std::allocator<char>
    isAllocator_char(o: RootObject | null): boolean {
        return this.isIdent_char(Id.allocator!, o);
    }

    // Detect type ::std::ident<char>
    isIdent_char(ident: Identifier, o: RootObject | null): boolean {
        const t = isType(o);
        if (!t || !t.isTypeStruct())
            return false;
        const s = toDsymbol(t, null)!;
        if (s.ident !== ident)
            return false;
        const p = s.toParent();
        if (!p)
            return false;
        const ti = p.isTemplateInstance();
        if (!ti)
            return false;
        const q = CppMangleVisitor.getQualifier(ti);
        const inStd = CppMangleVisitor.isStd(q) ||
            CppMangleVisitor.isStdCPPNamespaceDeclaration(this.getTiNamespace(ti));
        return inStd && ti.tiargs!.length === 1 && CppMangleVisitor.isChar(ti.tiargs!.opIndex(0));
    }

    /***
     * Detect template args <char, ::std::char_traits<char>>
     * and write st if found.
     * Returns:
     *  true if found
     */
    char_std_char_traits_char(ti: TemplateInstance, st: string): boolean {
        if (ti.tiargs!.length === 2 &&
            CppMangleVisitor.isChar(ti.tiargs!.opIndex(0)) &&
            this.isChar_traits_char(ti.tiargs!.opIndex(1))) {
            this.buf.writestring(ds(st));
            return true;
        }
        return false;
    }


    prefix_name(s: Dsymbol): void {
        //printf("prefix_name(%s)\n", s.toChars());
        if (this.substitute(s))
            return;
        if (CppMangleVisitor.isStd(s))
            return this.buf.writestring(ds("St"));

        const si = CppMangleVisitor.getInstance(s);
        const p = CppMangleVisitor.getQualifier(si);
        if (p) {
            if (CppMangleVisitor.isStd(p)) {
                const needsTa = { value: false };
                const ti = si.isTemplateInstance();
                if (this.writeStdSubstitution(ti, needsTa)) {
                    this.abiTags.writeSymbol(ti!, this);
                    if (needsTa.value) {
                        this.template_args(ti);
                        this.append(ti);
                    }
                    return;
                }
                this.buf.writestring(ds("St"));
            } else
                this.prefix_name(p);
        }
        this.source_name(si, true);
        if (!CppMangleVisitor.isStd(si))
            /* Do this after the source_name() call to keep components[]
             * in the right order.
             * https://issues.dlang.org/show_bug.cgi?id=17947
             */
            this.append(si);
    }

    /**
     * Write common substitution for standard types, such as std::allocator
     *
     * This function assumes that the symbol `ti` is in the namespace `std`.
     *
     * Params:
     *   ti = Template instance to consider
     *   needsTa = If this function returns `true`, this value indicates
     *             if additional template argument mangling is needed
     *             (D `out bool`: reset to false on entry)
     *
     * Returns:
     *   `true` if a special std symbol was found
     */
    writeStdSubstitution(ti: TemplateInstance | null, needsTa: { value: boolean }): boolean {
        needsTa.value = false;
        if (!ti)
            return false;
        if (!CppMangleVisitor.isStdCPPNamespaceDeclaration(this.getTiNamespace(ti)) &&
            !CppMangleVisitor.isStd(CppMangleVisitor.getQualifier(ti)))
            return false;

        if (ti.name === Id.allocator) {
            this.buf.writestring(ds("Sa"));
            needsTa.value = true;
            return true;
        }
        if (ti.name === Id.basic_string) {
            // ::std::basic_string<char, ::std::char_traits<char>, ::std::allocator<char>>
            if (ti.tiargs!.length === 3 &&
                CppMangleVisitor.isChar(ti.tiargs!.opIndex(0)) &&
                this.isChar_traits_char(ti.tiargs!.opIndex(1)) &&
                this.isAllocator_char(ti.tiargs!.opIndex(2))) {
                this.buf.writestring(ds("Ss"));
                return true;
            }
            this.buf.writestring(ds("Sb"));      // ::std::basic_string
            needsTa.value = true;
            return true;
        }

        // ::std::basic_istream<char, ::std::char_traits<char>>
        if (ti.name === Id.basic_istream &&
            this.char_std_char_traits_char(ti, "Si"))
            return true;

        // ::std::basic_ostream<char, ::std::char_traits<char>>
        if (ti.name === Id.basic_ostream &&
            this.char_std_char_traits_char(ti, "So"))
            return true;

        // ::std::basic_iostream<char, ::std::char_traits<char>>
        if (ti.name === Id.basic_iostream &&
            this.char_std_char_traits_char(ti, "Sd"))
            return true;

        return false;
    }

    cpp_mangle_name(s: Dsymbol, qualified: boolean): void {
        //printf("cpp_mangle_name(%s, %d)\n", s.toChars(), qualified);
        let p = s.toParent();
        let se = s;
        let write_prefix = true;
        if (p && p.isTemplateInstance()) {
            se = p;
            if (this.find(p.isTemplateInstance()!.tempdecl!) >= 0)
                write_prefix = false;
            p = p.toParent();
        }
        if (!p || p.isModule()) {
            this.source_name(se, false);
            this.append(s);
            return;
        }

        if (!CppMangleVisitor.isStd(p) || qualified) {
            this.buf.writeByte(0x4E /* 'N' */);
            if (write_prefix) {
                if (CppMangleVisitor.isStd(p))
                    this.buf.writestring(ds("St"));
                else
                    this.prefix_name(p);
            }
            this.source_name(se, true);
            this.buf.writeByte(0x45 /* 'E' */);
            this.append(s);
            return;
        }
        /* The N..E is not required if:
         * 1. the parent is 'std'
         * 2. 'std' is the initial qualifier
         * 3. there is no CV-qualifier or a ref-qualifier for a member function
         * ABI 5.1.8
         */
        const ti = se.isTemplateInstance();
        if (s.ident === Id.allocator) {
            this.buf.writestring(ds("Sa")); // "Sa" is short for ::std::allocator
            this.template_args(ti);
        } else if (s.ident === Id.basic_string) {
            // ::std::basic_string<char, ::std::char_traits<char>, ::std::allocator<char>>
            if (ti!.tiargs!.length === 3 &&
                CppMangleVisitor.isChar(ti!.tiargs!.opIndex(0)) &&
                this.isChar_traits_char(ti!.tiargs!.opIndex(1)) &&
                this.isAllocator_char(ti!.tiargs!.opIndex(2))) {
                this.buf.writestring(ds("Ss"));
                return;
            }
            this.buf.writestring(ds("Sb"));      // ::std::basic_string
            this.template_args(ti);
        } else {
            // ::std::basic_istream<char, ::std::char_traits<char>>
            if (s.ident === Id.basic_istream) {
                if (this.char_std_char_traits_char(ti!, "Si"))
                    return;
            } else if (s.ident === Id.basic_ostream) {
                if (this.char_std_char_traits_char(ti!, "So"))
                    return;
            } else if (s.ident === Id.basic_iostream) {
                if (this.char_std_char_traits_char(ti!, "Sd"))
                    return;
            }
            this.buf.writestring(ds("St"));
            this.source_name(se, true);
        }
        this.append(s);
    }

    /**
     * Write CV-qualifiers to the buffer
     *
     * CV-qualifiers are 'r': restrict (unused in D), 'V': volatile, 'K': const
     *
     * See_Also:
     *   https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangle.CV-qualifiers
     */
    CV_qualifiers(t: Type): void {
        if (t.isConst())
            this.buf.writeByte(0x4B /* 'K' */);
    }

    /**
     * Mangles a variable
     *
     * Params:
     *   d = Variable declaration to mangle
     *   isNested = Whether this variable is nested, e.g. a template parameter
     *              or within a namespace
     */
    mangle_variable(d: VarDeclaration, isNested: boolean): void {
        // fake mangling for fields to fix https://issues.dlang.org/show_bug.cgi?id=16525
        if (!(d.storage_class & (STC.extern_ | STC.field | STC.gshared))) {
            error(d.loc,
                ds("%s `%s` internal compiler error: C++ static non-`__gshared` non-`extern` variables not " +
                    "supported"),
                d.kind(), d.toPrettyChars());
            this.errors = true;
            return;
        }
        const p = d.toParent();
        if (p && !p.isModule()) { //for example: char Namespace1::beta[6] should be mangled as "_ZN10Namespace14betaE"
            this.buf.writestring(ds("_ZN"));
            this.prefix_name(p);
            this.source_name(d, true);
            this.buf.writeByte(0x45 /* 'E' */);
        } else if (isNested) {
            this.buf.writestring(ds("_Z"));
            this.source_name(d, false);
        } else {
            const varTags = ABITagContainer.forSymbol(d);
            if (varTags) {
                this.buf.writestring(ds("_Z"));
                this.source_name(d, false);
                return;
            }
            const typeTags = ABITagContainer.forSymbol(toDsymbol(d.type!, null));
            if (typeTags) {
                this.buf.writestring(ds("_Z"));
                this.source_name(d, false);
                this.abiTags.write(this.buf, typeTags);
                return;
            }
            //char beta[6] should mangle as "beta"
            this.buf.writestring(d.ident!.toString());
        }
    }

    mangle_function(d: FuncDeclaration): void {
        //printf("mangle_function(%s)\n", d.toChars());
        /*
         * <mangled-name> ::= _Z <encoding>
         */
        this.buf.writestring(ds("_Z"));
        this.mangle_function_encoding(d);
    }

    mangle_function_encoding(d: FuncDeclaration): void {
        //printf("mangle_function_encoding(%s)\n", d.toChars());
        /*
         * <encoding> ::= <function name> <bare-function-type>
         *            ::= <data name>
         *            ::= <special-name>
         */
        const tf = d.type!.isTypeFunction()!;

        const ftd = getFuncTemplateDecl(d);
        if (ftd) {
            /* It's an instance of a function template
             */
            const ti = d.parent!.isTemplateInstance();
            assert(ti);
            this.mangleTemplatedFunction(d, tf, ftd, ti);
            return;
        }

        const p = d.toParent();
        if (p && !p.isModule() && tf.linkage === LINK.cpp) {
            this.mangleNestedFuncPrefix(tf, p);

            const ctor = d.isCtorDeclaration();
            if (ctor)
                this.buf.writestring(ctor.isCpCtor ? ds("C2") : ds("C1"));
            else if (isAggregateDtor(d))
                this.buf.writestring(ds("D1"));
            else if (d.ident && d.ident === Id.opAssign)
                this.buf.writestring(ds("aS"));
            else if (d.ident && d.ident === Id.opEquals)
                this.buf.writestring(ds("eq"));
            else if (d.ident && d.ident === Id.opIndex)
                this.buf.writestring(ds("ix"));
            else if (d.ident && d.ident === Id.opCall)
                this.buf.writestring(ds("cl"));
            else
                this.source_name(d, true);
            this.buf.writeByte(0x45 /* 'E' */);
        } else {
            this.source_name(d, false);
        }

        // Save offset for potentially writing tags
        const off = this.buf.length();

        // Template args accept extern "C" symbols with special mangling
        if (tf.linkage === LINK.cpp)
            this.mangleFunctionParameters(tf.parameterList);

        if (!tf.next!.isTypeBasic())
            this.writeRemainingTags(off, tf);
    }

    /**
     * Recursively mangles a non-scoped namespace
     *
     * Parameters:
     *   ns = Namespace to mangle
     *   dg = A delegate to write the identifier in this namespace
     *   haveNE = When `false` (the default), surround the namespace / dg
     *            call with nested name qualifier (`N..E`).
     *            Otherwise, they are already present (e.g. `Nspace` was used).
     */
    writeNamespace(ns: CPPNamespaceDeclaration | null, dg: (() => void) | null, haveNE = false): void {
        const runDg = (): void => { if (dg !== null) dg(); };

        if (ns === null || ns.ident === null)
            return runDg();

        if (CppMangleVisitor.isStdCPPNamespaceDeclaration(ns)) {
            if (!this.substitute(ns))
                this.buf.writestring(ds("St"));
            runDg();
        } else if (dg !== null) {
            if (!haveNE)
                this.buf.writestring(ds("N"));
            if (!this.substitute(ns)) {
                this.writeNamespace(ns.cppnamespace(), null);
                this.writeIdentifier(ns.ident);
                this.append(ns);
            }
            dg();
            if (!haveNE)
                this.buf.writestring(ds("E"));
        } else if (!this.substitute(ns)) {
            this.writeNamespace(ns.cppnamespace(), null);
            this.writeIdentifier(ns.ident);
            this.append(ns);
        }
    }

    /**
     * Mangles a function template to C++
     *
     * Params:
     *   d = Function declaration
     *   tf = Function type (casted d.type)
     *   ftd = Template declaration (ti.templdecl); unread, as in D
     *   ti = Template instance (d.parent)
     */
    mangleTemplatedFunction(d: FuncDeclaration, tf: TypeFunction, _ftd: TemplateDeclaration,
                            ti: TemplateInstance): void {
        const p = ti.toParent();
        // Check if this function is *not* nested
        if (!p || p.isModule() || tf.linkage !== LINK.cpp) {
            this.context.ti = ti;
            this.context.fd = d;
            this.context.res = d;
            const preSemantic = d.originalType!.isTypeFunction()!;
            const nspace = ti.toParent();
            if (nspace && nspace.isNspace())
                this.writeChained(ti.toParent(), () => this.source_name(ti, true));
            else
                this.source_name(ti, false);
            this.mangleReturnType(preSemantic);
            this.mangleFunctionParameters(
                new ParameterList(preSemantic.parameterList.parameters, tf.parameterList.varargs));
            return;
        }

        // It's a nested function (e.g. a member of an aggregate)
        this.mangleNestedFuncPrefix(tf, p);

        if (d.isCtorDeclaration()) {
            this.buf.writestring(ds("C1"));
            this.mangleFunctionParameters(tf.parameterList);
            return;
        } else if (isAggregateDtor(d)) {
            this.buf.writestring(ds("D1"));
            this.mangleFunctionParameters(tf.parameterList);
            return;
        }

        let firstTemplateArg = 0;
        let appendReturnType = true;
        let isConvertFunc = false;
        let symName: DString = dsEmpty;

        // continue_template: (dmd/mangle/cpp.d:1320) — the label's tail; every jump site calls it and then
        // breaks `switchWhichOp`, as D's `break;` after the label does. BAIL shape (06 §4), see the header.
        const continue_templateTail = (): void => {
            firstTemplateArg = 1;
        };

        // test for special symbols
        const whichOp = isCppOperator(ti.name);
        // D `final switch (whichOp)`: exhaustive over CppOperator (06 §3.2).
        switch (whichOp) {
        case CppOperator.Unknown:
            break;
        case CppOperator.Cast:
            symName = ds("cv");
            firstTemplateArg = 1;
            isConvertFunc = true;
            appendReturnType = false;
            break;
        case CppOperator.Assign:
            symName = ds("aS");
            break;
        case CppOperator.Eq:
            symName = ds("eq");
            break;
        case CppOperator.Index:
            symName = ds("ix");
            break;
        case CppOperator.Call:
            symName = ds("cl");
            break;
        case CppOperator.Unary:
        case CppOperator.Binary:
        case CppOperator.OpAssign: {
            const td = ti.tempdecl!.isTemplateDeclaration();
            assert(td);
            assert(ti.tiargs!.length >= 1);
            const tp = td.parameters!.opIndex(0)!;
            const tv = tp.isTemplateValueParameter();
            if (!tv || !isString(tv.valType!))
                break; // expecting a string argument to operators!
            const exp = isExpression(ti.tiargs!.opIndex(0));
            const str = toStringExp(exp!)!;
            switchWhichOp: switch (whichOp) {
            case CppOperator.Unary:
                switch (keyOf(str.peekString())) {
                case "*":   symName = ds("de");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1277)
                case "++":  symName = ds("pp");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1278)
                case "--":  symName = ds("mm");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1279)
                case "-":   symName = ds("ng");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1280)
                case "+":   symName = ds("ps");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1281)
                case "~":   symName = ds("co");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1282)
                default:    break;
                }
                break;
            case CppOperator.Binary:
                switch (keyOf(str.peekString())) {
                case ">>":  symName = ds("rs");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1289)
                case "<<":  symName = ds("ls");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1290)
                case "*":   symName = ds("ml");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1291)
                case "-":   symName = ds("mi");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1292)
                case "+":   symName = ds("pl");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1293)
                case "&":   symName = ds("an");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1294)
                case "/":   symName = ds("dv");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1295)
                case "%":   symName = ds("rm");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1296)
                case "^":   symName = ds("eo");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1297)
                case "|":   symName = ds("or");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1298)
                default:    break;
                }
                break;
            case CppOperator.OpAssign:
                switch (keyOf(str.peekString())) {
                case "*":   symName = ds("mL");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1305)
                case "+":   symName = ds("pL");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1306)
                case "-":   symName = ds("mI");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1307)
                case "/":   symName = ds("dV");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1308)
                case "%":   symName = ds("rM");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1309)
                case ">>":  symName = ds("rS");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1310)
                case "<<":  symName = ds("lS");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1311)
                case "&":   symName = ds("aN");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1312)
                case "|":   symName = ds("oR");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1313)
                case "^":   symName = ds("eO");
                    continue_templateTail(); break switchWhichOp; // goto continue_template (dmd/mangle/cpp.d:1314)
                default:    break;
                }
                break;
            default:
                assertUnreachable();
                // continue_template: the label (dmd/mangle/cpp.d:1320) is reached only by its jumps, through
                // `continue_templateTail` above.
            }
            break;
        }
        default: {
            // final switch: D throws SwitchError on an unhandled value
            const _exhaustive: never = whichOp; void _exhaustive;
            throw new SwitchError();
        }
        }
        if (symName.length === 0)
            this.source_name(ti, true);
        else {
            this.buf.writestring(symName);
            if (isConvertFunc)
                this.template_arg(ti, 0);
            appendReturnType = this.template_args(ti, firstTemplateArg) && appendReturnType;
        }
        this.buf.writeByte(0x45 /* 'E' */);
        if (appendReturnType)
            this.headOfType(nextOf(tf)!);  // mangle return type
        this.mangleFunctionParameters(tf.parameterList);
    }

    /**
     * Mangle the parameters of a function
     *
     * For templated functions, `context.res` is set to the `FuncDeclaration`
     *
     * Params:
     *   parameters = Array of `Parameter` to mangle
     *   varargs = if != 0, this function has varargs parameters
     */
    mangleFunctionParameters(parameterList: ParameterList): void {
        let numparams = 0;

        // OPAPPLY-BAIL (06 §4): D's `return;` inside the foreach (dmd/mangle/cpp.d:1374) leaves the function.
        let bail = false;
        parameterList.opApply((n: number, fparam: Parameter): number => {
            let t = merge2(fparam.type!);
            if (fparam.isReference())
                t = referenceTo(t);
            else if (fparam.isLazy()) {
                // Mangle as delegate
                const tf = new TypeFunction(new ParameterList(null), t, LINK.d);
                const td = new TypeDelegate(tf);
                t = merge(td);
            } else {
                const cpptype = target.cpp.parameterType(t);
                if (cpptype)
                    t = cpptype;
            }
            if (t.ty === TY.Tsarray) {
                // Static arrays in D are passed by value; no counterpart in C++
                error(this.loc,
                    ds("internal compiler error: unable to pass static array `%s` to extern(C++) function, use " +
                        "pointer instead"),
                    t.toChars());
                this.errors = true;
                bail = true;
                return 1;
            }
            const prev = this.context.push(() => {
                    let tf: TypeFunction | null;
                    if (isDsymbol(this.context.res))
                        tf = asFuncDecl(this.context.res).type!.isTypeFunction();
                    else
                        tf = asType(this.context.res).isTypeFunction();
                    assert(tf);
                    return tf.parameterList.parameters!.opIndex(n)!.type;
                });
            try {
                if (this.context.ti && global.params.cplusplus >= CppStdRevision.cpp11)
                    this.handleParamPack(t, this.context.ti.tempdecl!.isTemplateDeclaration()!.parameters!);

                this.headOfType(t);
                ++numparams;
            } finally {
                this.context.pop(prev);
            }
            return 0;
        });
        if (bail)
            return;

        if (parameterList.varargs === VarArg.variadic)
            this.buf.writeByte(0x7A /* 'z' */);
        else if (!numparams)
            this.buf.writeByte(0x76 /* 'v' */); // encode (void) parameters
    }

    /****** The rest is type mangling ************/

    /// dmd/mangle/cpp.d:1402 — `void error(Type t)`: the "cannot be mapped to C++" diagnostic; sets `errors`.
    error(t: Type): void {
        let p: string;
        if (t.isImmutable())
            p = "`immutable` ";
        else if (t.isShared())
            p = "`shared` ";
        else
            p = "";
        error(this.loc, ds("internal compiler error: %stype `%s` cannot be mapped to C++\n"), ds(p), t.toChars());
        this.errors = true; //Fatal, because this error should be handled in frontend
    }

    /****************************
     * Mangle a type,
     * treating it as a Head followed by a Tail.
     * Params:
     *  t = Head of a type
     */
    headOfType(t: Type): void {
        const tc = t.isTypeClass();
        if (tc !== null) {
            this.mangleTypeClass(tc, true);
        } else {
            // For value types, strip const/immutable/shared from the head of the type
            const prev = this.context.push(() => unSharedOf(mutableOf(asType(this.context.res))));
            try {
                unSharedOf(mutableOf(t)).accept(this);
            } finally {
                this.context.pop(prev);
            }
        }
    }

    /******
     * Write out 1 or 2 character basic type mangling.
     * Handle const and substitutions.
     * Params:
     *  t = type to mangle
     *  p = if not 0, then character prefix
     *  c = mangling character
     */
    writeBasicType(t: Type, p: number, c: number): void {
        // Only do substitutions for non-fundamental types.
        if (!CppMangleVisitor.isFundamentalType(t) || t.isConst()) {
            if (this.substitute(t))
                return;
            else
                this.append(t);
        }
        this.CV_qualifiers(t);
        if (p)
            this.buf.writeByte(p);
        this.buf.writeByte(c);
    }


    /****************
     * Write structs and enums.
     * Params:
     *  t = TypeStruct or TypeEnum
     */
    doSymbol(t: Type): void {
        if (this.substitute(t))
            return;
        this.CV_qualifiers(t);

        // Handle any target-specific struct types.
        const tm = target.cpp.typeMangle(t);
        if (tm) {
            this.buf.writestring(tm);
        } else {
            const s = toDsymbol(t, null)!;
            const p = s.toParent();
            if (p && p.isTemplateInstance()) {
                 /* https://issues.dlang.org/show_bug.cgi?id=17947
                  * Substitute the template instance symbol, not the struct/enum symbol
                  */
                if (this.substitute(p))
                    return;
            }
            if (!this.substitute(s))
                this.cpp_mangle_name(s, false);
        }
        if (t.isConst())
            this.append(t);
    }



    /************************
     * Mangle a class type.
     * If it's the head, treat the initial pointer as a value type.
     * Params:
     *  t = class type
     *  head = true for head of a type
     */
    mangleTypeClass(t: TypeClass, head: boolean): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);

        /* Mangle as a <pointer to><struct>
         */
        if (this.substitute(t))
            return;
        if (!head)
            this.CV_qualifiers(t);
        this.buf.writeByte(0x50 /* 'P' */);

        this.CV_qualifiers(t);

        {
            const s = toDsymbol(t, null)!;
            const p = s.toParent();
            if (p && p.isTemplateInstance()) {
                 /* https://issues.dlang.org/show_bug.cgi?id=17947
                  * Substitute the template instance symbol, not the class symbol
                  */
                if (this.substitute(p))
                    return;
            }
        }

        if (!this.substitute(t.sym!)) {
            this.cpp_mangle_name(t.sym!, false);
        }
        if (t.isConst())
            this.append(null);  // C++ would have an extra type here
        this.append(t);
    }

    /**
     * Mangle the prefix of a nested (e.g. member) function
     *
     * Params:
     *   tf = Type of the nested function
     *   parent = Parent in which the function is nested
     */
    mangleNestedFuncPrefix(tf: TypeFunction, parent: Dsymbol): void {
        /* <nested-name> ::= N [<CV-qualifiers>] <prefix> <unqualified-name> E
         *               ::= N [<CV-qualifiers>] <template-prefix> <template-args> E
         */
        this.buf.writeByte(0x4E /* 'N' */);
        this.CV_qualifiers(tf);

        /* <prefix> ::= <prefix> <unqualified-name>
         *          ::= <template-prefix> <template-args>
         *          ::= <template-param>
         *          ::= # empty
         *          ::= <substitution>
         *          ::= <prefix> <data-member-prefix>
         */
        this.prefix_name(parent);
    }

    /**
     * Write `Dp` (C++11 function parameter pack prefix) if 't' is a TemplateSequenceParameter (T...).
     *
     * Params:
     *   t      = Parameter type
     *   params = Template parameters of the function
     */
    handleParamPack(t: Type, params: TemplateParameters): void {
        if (t.isTypeReference())
            t = nextOf(t)!;
        const ti = t.isTypeIdentifier();
        if (!ti)
            return;

        const idx = CppMangleVisitor.templateParamIndex(ti.ident, params);
        if (idx < params.length && params.opIndex(idx)!.isTemplateTupleParameter())
            this.buf.writestring(ds("Dp"));
    }

    /**
     * Helper function to write a `T..._` template index.
     *
     * Params:
     *   idx   = Index of `param` in the template argument list
     *   param = Template parameter to mangle
     */
    writeTemplateArgIndex(idx: number, param: TemplateParameter): void {
        // expressions are mangled in <X..E>
        if (param.isTemplateValueParameter())
            this.buf.writeByte(0x58 /* 'X' */);
        this.buf.writeByte(0x54 /* 'T' */);
        this.writeSequenceFromIndex(idx);
        this.buf.writeByte(0x5F /* '_' */);
        if (param.isTemplateValueParameter())
            this.buf.writeByte(0x45 /* 'E' */);
    }

    /**
     * Given an array of template parameters and an identifier,
     * returns the index of the identifier in that array.
     *
     * Params:
     *   ident = Identifier for which substitution is attempted
     *           (e.g. `void func(T)(T param)` => `T` from `T param`)
     *   params = `TemplateParameters` of the enclosing symbol
     *           (in the previous example, `func`'s template parameters)
     *
     * Returns:
     *   The index of the identifier match in `params`,
     *   or `params.length` if there wasn't any match.
     */
    static templateParamIndex(ident: Identifier | null, params: TemplateParameters): number {
        for (let idx = 0; idx < params.length; idx++)
            if (params.opIndex(idx)!.ident === ident)
                return idx;
        return params.length;
    }

    /**
     * Given a template instance `t`, write its qualified name
     * without the template parameter list
     *
     * Params:
     *   t = Post-parsing `TemplateInstance` pointing to the symbol
     *       to mangle (one level deep)
     *   dg = Delegate to execute after writing the qualified symbol
     *
     */
    writeQualified(t: TemplateInstance, dg: () => void): void {
        const type = isType(this.context.res);
        if (!type) {
            this.writeIdentifier(t.name!);
            return dg();
        }
        const sym1 = toDsymbol(type, null);
        if (!sym1) {
            this.writeIdentifier(t.name!);
            return dg();
        }
        // Get the template instance
        const sym = CppMangleVisitor.getQualifier(sym1);
        const sym2 = CppMangleVisitor.getQualifier(sym!);
        if (sym2 && CppMangleVisitor.isStd(sym2)) { // Nspace path
            const unused = { value: false };
            assert(sym!.isTemplateInstance());
            if (this.writeStdSubstitution(sym!.isTemplateInstance(), unused))
                return dg();
            // std names don't require `N..E`
            this.buf.writestring(ds("St"));
            this.writeIdentifier(t.name!);
            this.append(t);
            return dg();
        } else if (sym2) {
            this.buf.writestring(ds("N"));
            if (!this.substitute(sym2))
                sym2.accept(this);
        }
        this.writeNamespace(
            sym1.cppnamespace(), () => {
                this.writeIdentifier(t.name!);
                this.append(t);
                dg();
            });
        if (sym2)
            this.buf.writestring(ds("E"));
    }

    // dropped: `extern(C++):` (cpp.d:1684), a linkage attribute; and `alias visit = Visitor.visit;` (cpp.d:1686) —
    // no overload hiding in TS (13 §1).

    override visitTypeNull(t: TypeNull): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);

        this.writeBasicType(t, 0x44 /* 'D' */, 0x6E /* 'n' */);
    }

    override visitTypeNoreturn(t: TypeNoreturn): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);

        this.writeBasicType(t, 0, 0x76 /* 'v' */);      // mangle like `void`
    }

    override visitTypeBasic(t: TypeBasic): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);

        // Handle any target-specific basic types.
        const tm = target.cpp.typeMangle(t);
        if (tm) {
            // Only do substitutions for non-fundamental types.
            if (!CppMangleVisitor.isFundamentalType(t) || t.isConst()) {
                if (this.substitute(t))
                    return;
                else
                    this.append(t);
            }
            this.CV_qualifiers(t);
            this.buf.writestring(tm);
            return;
        }

        /* <builtin-type>:
         * v        void
         * w        wchar_t
         * b        bool
         * c        char
         * a        signed char
         * h        unsigned char
         * s        short
         * t        unsigned short
         * i        int
         * j        unsigned int
         * l        long
         * m        unsigned long
         * x        long long, __int64
         * y        unsigned long long, __int64
         * n        __int128
         * o        unsigned __int128
         * f        float
         * d        double
         * e        long double, __float80
         * g        __float128
         * z        ellipsis
         * Dd       64 bit IEEE 754r decimal floating point
         * De       128 bit IEEE 754r decimal floating point
         * Df       32 bit IEEE 754r decimal floating point
         * Dh       16 bit IEEE 754r half-precision floating point
         * Di       char32_t
         * Ds       char16_t
         * u <source-name>  # vendor extended type
         */
        if (isImaginary(t) || isComplex(t)) {
            // https://issues.dlang.org/show_bug.cgi?id=22806
            // Complex and imaginary types are represented in the same way as
            // arrays or vectors in C++.  First substitute the outer type, then
            // write out the mangle string of the underlying type.
            if (this.substitute(t))
                return;
            this.append(t);
            this.CV_qualifiers(t);

            if (isImaginary(t))
                this.buf.writeByte(0x47 /* 'G' */); // 'G' means imaginary
            else
                this.buf.writeByte(0x43 /* 'C' */); // 'C' means complex

            switch (t.ty) {
                case TY.Timaginary32:
                case TY.Tcomplex32:
                    return Type.tfloat32.accept(this);
                case TY.Timaginary64:
                case TY.Tcomplex64:
                    return Type.tfloat64.accept(this);
                case TY.Timaginary80:
                case TY.Tcomplex80:
                    return Type.tfloat80.accept(this);
                default:
                    assertUnreachable();
            }
        }

        let c: number;
        let p = 0;
        switch (t.ty) {
            case TY.Tvoid:                 c = 0x76 /* 'v' */;        break;
            case TY.Tint8:                 c = 0x61 /* 'a' */;        break;
            case TY.Tuns8:                 c = 0x68 /* 'h' */;        break;
            case TY.Tint16:                c = 0x73 /* 's' */;        break;
            case TY.Tuns16:                c = 0x74 /* 't' */;        break;
            case TY.Tint32:                c = 0x69 /* 'i' */;        break;
            case TY.Tuns32:                c = 0x6A /* 'j' */;        break;
            case TY.Tfloat32:              c = 0x66 /* 'f' */;        break;
            case TY.Tint64:
                c = target.c.longsize === 8 ? 0x6C /* 'l' */ : 0x78 /* 'x' */;
                break;
            case TY.Tuns64:
                c = target.c.longsize === 8 ? 0x6D /* 'm' */ : 0x79 /* 'y' */;
                break;
            case TY.Tint128:                c = 0x6E /* 'n' */;       break;
            case TY.Tuns128:                c = 0x6F /* 'o' */;       break;
            case TY.Tfloat64:               c = 0x64 /* 'd' */;       break;
            case TY.Tfloat80:               c = 0x65 /* 'e' */;       break;
            case TY.Tbool:                  c = 0x62 /* 'b' */;       break;
            case TY.Tchar:                  c = 0x63 /* 'c' */;       break;
            case TY.Twchar:        p = 0x44 /* 'D' */; c = 0x73 /* 's' */;       break;  // since C++11
            case TY.Tdchar:        p = 0x44 /* 'D' */; c = 0x69 /* 'i' */;       break;  // since C++11

            default:
                return this.error(t);
        }
        this.writeBasicType(t, p, c);
    }

    override visitTypeVector(t: TypeVector): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);

        if (this.substitute(t))
            return;
        this.append(t);
        this.CV_qualifiers(t);

        // Handle any target-specific vector types.
        const tm = target.cpp.typeMangle(t);
        if (tm) {
            this.buf.writestring(tm);
        } else {
            assert(t.basetype && t.basetype.ty === TY.Tsarray);
            const tsa = t.basetype.isTypeSArray()!;
            assert(tsa.dim);
            this.buf.writestring(ds("Dv"));          // -- Gnu ABI v.4
            this.buf.print(toInteger(tsa.dim));
            this.buf.writeByte(0x5F /* '_' */);
            nextOf(t.basetype)!.accept(this);
        }
    }

    override visitTypeSArray(t: TypeSArray): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);

        if (!this.substitute(t))
            this.append(t);
        this.CV_qualifiers(t);
        this.buf.writeByte(0x41 /* 'A' */);
        this.buf.print(t.dim ? toInteger(t.dim) : 0n);
        this.buf.writeByte(0x5F /* '_' */);
        t.next!.accept(this);
    }

    override visitTypePointer(t: TypePointer): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);

        // Check for const - Since we cannot represent C++'s `char* const`,
        // and `const char* const` (a.k.a `const(char*)` in D) is mangled
        // the same as `const char*` (`const(char)*` in D), we need to add
        // an extra `K` if `nextOf()` is `const`, before substitution
        this.CV_qualifiers(t);
        if (this.substitute(t))
            return;
        this.buf.writeByte(0x50 /* 'P' */);
        const prev = this.context.push(() => nextOf(asType(this.context.res)));
        try {
            t.next!.accept(this);
            this.append(t);
        } finally {
            this.context.pop(prev);
        }
    }

    override visitTypeReference(t: TypeReference): void {
        if (this.substitute(t))
            return;
        this.buf.writeByte(0x52 /* 'R' */);
        this.CV_qualifiers(nextOf(t)!);
        this.headOfType(nextOf(t)!);
        if (nextOf(t)!.isConst())
            this.append(nextOf(t));
        this.append(t);
    }

    override visitTypeFunction(t: TypeFunction): void {
        /*
         *  <function-type> ::= F [Y] <bare-function-type> E
         *  <bare-function-type> ::= <signature type>+
         *  # types are possible return type, then parameter types
         */
        /* ABI says:
            "The type of a non-static member function is considered to be different,
            for the purposes of substitution, from the type of a namespace-scope or
            static member function whose type appears similar. The types of two
            non-static member functions are considered to be different, for the
            purposes of substitution, if the functions are members of different
            classes. In other words, for the purposes of substitution, the class of
            which the function is a member is considered part of the type of
            function."

            BUG: Right now, types of functions are never merged, so our simplistic
            component matcher always finds them to be different.
            We should use Type.equals on these, and use different
            TypeFunctions for non-static member functions, and non-static
            member functions of different classes.
         */
        if (this.substitute(t))
            return;
        this.buf.writeByte(0x46 /* 'F' */);
        if (t.linkage === LINK.c)
            this.buf.writeByte(0x59 /* 'Y' */);
        let tn = t.next!;
        if (t.isRef)
            tn = referenceTo(tn);
        tn.accept(this);
        this.mangleFunctionParameters(t.parameterList);
        this.buf.writeByte(0x45 /* 'E' */);
        this.append(t);
    }

    override visitTypeStruct(t: TypeStruct): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);
        //printf("TypeStruct %s\n", t.toChars());
        this.doSymbol(t);
    }

    override visitTypeEnum(t: TypeEnum): void {
        if (t.isImmutable() || t.isShared())
            return this.error(t);

        /* __c_(u)long(long) and others get special mangling
         */
        const id = t.sym!.ident;
        //printf("enum id = '%s'\n", id.toChars());
        if (id === Id.__c_long)
            return this.writeBasicType(t, 0, 0x6C /* 'l' */);
        if (id === Id.__c_ulong)
            return this.writeBasicType(t, 0, 0x6D /* 'm' */);
        if (id === Id.__c_char)
            return this.writeBasicType(t, 0, 0x63 /* 'c' */);
        if (id === Id.__c_wchar_t)
            return this.writeBasicType(t, 0, 0x77 /* 'w' */);
        if (id === Id.__c_longlong)
            return this.writeBasicType(t, 0, 0x78 /* 'x' */);
        if (id === Id.__c_ulonglong)
            return this.writeBasicType(t, 0, 0x79 /* 'y' */);
        if (id === Id.__c_complex_float)
            return Type.tcomplex32.accept(this);
        if (id === Id.__c_complex_double)
            return Type.tcomplex64.accept(this);
        if (id === Id.__c_complex_real)
            return Type.tcomplex80.accept(this);

        this.doSymbol(t);
    }

    override visitTypeClass(t: TypeClass): void {
        this.mangleTypeClass(t, false);
    }

    /**
     * Performs template parameter substitution
     *
     * Mangling is performed on a copy of the post-parsing AST before
     * any semantic pass is run.
     * There is no easy way to link a type to the template parameters
     * once semantic has run, because:
     * - the `TemplateInstance` installs aliases in its scope to its params
     * - `AliasDeclaration`s are resolved in many places
     * - semantic passes are destructive, so the `TypeIdentifier` gets lost
     *
     * As a result, the best approach with the current architecture is to:
     * - Run the visitor on the `originalType` of the function,
     *   looking up any `TypeIdentifier` at the template scope when found.
     * - Fallback to the post-semantic `TypeFunction` when the identifier is
     *   not a template parameter.
     */
    override visitTypeIdentifier(t: TypeIdentifier): void {
        const decl = this.context.ti!.tempdecl!.isTemplateDeclaration()!;
        assert(decl.parameters !== null);
        const idx = CppMangleVisitor.templateParamIndex(t.ident, decl.parameters);
        // If not found, default to the post-semantic type
        if (idx >= decl.parameters.length)
            return visitObject(this.context.res, this);

        const param = decl.parameters.opIndex(idx)!;
        const type = isType(this.context.res);
        if (type)
            this.CV_qualifiers(type);
        // Otherwise, attempt substitution (`S_` takes precedence on `T_`)
        if (this.substitute(param))
            return;

        // If substitution failed, write `TX_` where `X` is the index
        this.writeTemplateArgIndex(idx, param);
        this.append(param);
        // Write the ABI tags, if any
        const sym = isDsymbol(this.context.res);
        if (sym)
            this.abiTags.writeSymbol(sym, this);
    }

    /// Ditto
    override visitTypeInstance(t: TypeInstance): void {
        assert(t.tempinst !== null);
        t.tempinst.accept(this);
    }

    /**
     * Mangles a `TemplateInstance`
     *
     * A `TemplateInstance` can be found either in the parameter,
     * or the return value.
     * Arguments to the template instance needs to be mangled but the template
     * can be partially substituted, so for example the following:
     * `Container!(T, Val) func16479_12 (alias Container, T, int Val) ()`
     * will mangle the return value part to "T_IT0_XT1_EE"
     */
    override visitTemplateInstance(t: TemplateInstance): void {
        // Template names are substituted, but args still need to be written
        const writeArgs = (): void => {
            this.buf.writeByte(0x49 /* 'I' */);
            // When visiting the arguments, the context will be set to the
            // resolved type
            const analyzed_ti = toDsymbol(asType(this.context.res), null)!.isInstantiated()!;
            const prev = this.context.copy();
            try {
                for (let idx = 0; idx < t.tiargs!.length; idx++) {
                    const o = t.tiargs!.opIndex(idx);
                    this.context.res = analyzed_ti.tiargs!.opIndex(idx);
                    visitObject(o, this);
                }
                if (analyzed_ti.tiargs!.length > t.tiargs!.length) {
                    // If the resolved AST has more args than the parse one,
                    // we have default arguments
                    const oparams = analyzed_ti.tempdecl!.isTemplateDeclaration()!.origParameters!;
                    const rest = oparams.opSlice(t.tiargs!.length, oparams.length);
                    for (let idx = 0; idx < rest.length; idx++) {
                        const arg = rest[idx]!;
                        this.context.res = analyzed_ti.tiargs!.opIndex(idx + t.tiargs!.length);

                        const ttp = arg.isTemplateTypeParameter();
                        if (ttp) {
                            ttp.defaultType!.accept(this);
                            continue;
                        }
                        const tvp = arg.isTemplateValueParameter();
                        if (tvp) {
                            tvp.defaultValue!.accept(this);
                            continue;
                        }
                        const tthis = arg.isTemplateThisParameter();
                        if (tthis) {
                            tthis.defaultType!.accept(this);
                            continue;
                        }
                        const tap = arg.isTemplateAliasParameter();
                        if (tap) {
                            visitObject(tap.defaultAlias, this);
                            continue;
                        }
                        assertUnreachable(dsToJs(arg.toString()));
                    }
                }
                this.buf.writeByte(0x45 /* 'E' */);
            } finally {
                this.context.pop(prev);
            }
        };

        // `name` is used, not `ident`
        assert(t.name !== null);
        assert(t.tiargs !== null);

        const needsTa = { value: false };
        const decl = this.context.ti!.tempdecl!.isTemplateDeclaration()!;
        // Attempt to substitute the template itself
        const idx = CppMangleVisitor.templateParamIndex(t.name, decl.parameters!);
        if (idx < decl.parameters!.length) {
            const param = decl.parameters!.opIndex(idx)!;
            // dtemplate.d's `getType(RootObject)` (UFCS): dsymbolsem's `getType(Dsymbol)` is not imported here.
            const type = getType(t);
            if (type)
                this.CV_qualifiers(type);
            if (this.substitute(param))
                return;
            this.writeTemplateArgIndex(idx, param);
            this.append(param);
            writeArgs();
        } else if (this.writeStdSubstitution(t, needsTa)) {
            if (needsTa.value)
                writeArgs();
        } else if (!this.substitute(t))
            this.writeQualified(t, writeArgs);
    }

    /// Ditto
    override visitIntegerExp(t: IntegerExp): void {
        this.buf.writeByte(0x4C /* 'L' */);
        t.type!.accept(this);
        this.buf.print(t.getInteger());
        this.buf.writeByte(0x45 /* 'E' */);
    }

    override visitNspace(t: Nspace): void {
        const p = CppMangleVisitor.getQualifier(t);
        if (p)
            p.accept(this);

        if (CppMangleVisitor.isStd(t))
            this.buf.writestring(ds("St"));
        else {
            this.writeIdentifier(t.ident!);
            this.append(t);
        }
    }

    override visitType(t: Type): void {
        this.error(t);
    }

    /// dmd/mangle/cpp.d:2127 — `void visit(Tuple t)`: reached only through `visitObject`'s static dispatch.
    visitTuple(_t: Tuple): void {
        assertUnreachable();
    }
}

/// Helper code to visit `RootObject`, as it doesn't define `accept`,
/// only its direct subtypes do.
///
/// dmd/mangle/cpp.d:2135 — `private void visitObject(V : Visitor)(RootObject o, V this_)`. `V` is used only for the
/// static `this_.visit(Tuple)` call, so the TS generic requires `visitTuple` of it (header).
function visitObject<V extends Visitor & { visitTuple(t: Tuple): void }>(o: RootObject | null, this_: V): void {
    assert(o !== null);
    const ta = isType(o);
    if (ta) {
        ta.accept(this_);
        return;
    }
    const ea = isExpression(o);
    if (ea) {
        ea.accept(this_);
        return;
    }
    const sa = isDsymbol(o);
    if (sa) {
        sa.accept(this_);
        return;
    }
    const tp = isTemplateParameter(o);
    if (tp) {
        tp.accept(this_);
        return;
    }
    const t = isTuple(o);
    if (t) {
        // `Tuple` inherits `RootObject` and does not define accept
        // For this reason, this uses static dispatch on the visitor
        this_.visitTuple(t);
        return;
    }
    assertUnreachable(dsToJs(o.toString()));
}

/// Helper function to safely get a type out of a `RootObject`
///
/// dmd/mangle/cpp.d:2155 — `private Type asType(RootObject o) @safe`.
function asType(o: RootObject | null): Type {
    const ta = isType(o);
    if (ta)
        return ta;

    // When called with context.res as argument, it can be `FuncDeclaration`
    const fd = asFuncDecl(o);
    if (fd)
        return fd.type!;
    assertUnreachable();
}

/// Helper function to safely get a `FuncDeclaration` out of a `RootObject`
///
/// dmd/mangle/cpp.d:2167 — `private FuncDeclaration asFuncDecl(RootObject o) @safe`.
function asFuncDecl(o: RootObject | null): FuncDeclaration {
    const d = isDsymbol(o);
    assert(d !== null);
    const fd = d.isFuncDeclaration();
    assert(fd !== null);
    return fd;
}

/// Helper class to compare entries in components
///
/// dmd/mangle/cpp.d:2177 — `private extern(C++) final class ComponentVisitor : Visitor`.
class ComponentVisitor extends Visitor {
    /// Only one of the following is not `null`, it's always
    /// the most specialized type, set from the ctor
    namespace: Nspace | null = null;

    /// Ditto
    namespace2: CPPNamespaceDeclaration | null = null;

    /// Ditto
    tpointer: TypePointer | null = null;

    /// Ditto
    tref: TypeReference | null = null;

    /// Ditto
    tident: TypeIdentifier | null = null;

    /// Least specialized type
    object: RootObject | null = null;

    /// Set to the result of the comparison
    result = false;

    constructor(base: RootObject) {
        super();
        // The two jumps to `default:` (cpp.d:2211, :2223) reach a non-adjacent arm: its body is extracted, each
        // jump site calls it and breaks (06 §3.6).
        const _default = (): void => {
            this.object = base;
        };
        switch (base.dyncast()) {
        case DYNCAST.dsymbol: {
            // 02 §11.5c #3: the DYNCAST.dsymbol tag proves `base` is a Dsymbol (D `cast(Dsymbol)base`).
            const ns = (base as unknown as Dsymbol).isNspace();
            if (ns)
                this.namespace = ns;
            else {
                const ns2 = (base as unknown as Dsymbol).isCPPNamespaceDeclaration();
                if (ns2)
                    this.namespace2 = ns2;
                else {
                    _default(); // goto default (dmd/mangle/cpp.d:2211)
                    break;
                }
            }
            break;
        }

        case DYNCAST.type: {
            // 02 §11.5c #3: the DYNCAST.type tag proves `base` is a Type (D `cast(Type)base`).
            const t = base as unknown as Type;
            const tp = t.isTypePointer();
            if (tp)
                this.tpointer = tp;
            else {
                const tr = t.isTypeReference();
                if (tr)
                    this.tref = tr;
                else {
                    const ti = t.isTypeIdentifier();
                    if (ti)
                        this.tident = ti;
                    else {
                        _default(); // goto default (dmd/mangle/cpp.d:2223)
                        break;
                    }
                }
            }
            break;
        }

        // Note: ABI tags are also handled here (they are TupleExp of StringExp)
        default:
            _default();
        }
    }

    // dropped: `alias visit = Visitor.visit;` (cpp.d:2233) — no overload hiding in TS (13 §1).

    /// Least specialized overload of each direct child of `RootObject`
    override visitDsymbol(o: Dsymbol): void {
        this.result = this.object !== null && this.object === o;
    }

    /// Ditto
    override visitExpression(o: Expression): void {
        this.result = this.object !== null && this.object === o;
    }

    /// Ditto
    ///
    /// dmd/mangle/cpp.d:2248 — `public void visit(Tuple o)`, reached through `visitObject`.
    visitTuple(o: Tuple): void {
        this.result = this.object !== null && this.object === o;
    }

    /// Ditto
    override visitType(o: Type): void {
        this.result = this.object !== null && this.object === o;
    }

    /// Ditto
    override visitTemplateParameter(o: TemplateParameter): void {
        this.result = this.object !== null && this.object === o;
    }

    /**
     * This overload handles composed types including template parameters
     *
     * Components for substitutions include "next" type.
     * For example, if `ref T` is present, `ref T` and `T` will be present
     * in the substitution array.
     * But since we don't have the final/merged type, we cannot rely on
     * object comparison, and need to recurse instead.
     */
    override visitTypeReference(o: TypeReference): void {
        if (!this.tref)
            return;
        if (this.tref === o)
            this.result = true;
        else {
            // It might be a reference to a template parameter that we already
            // saw, so we need to recurse
            const v = new ComponentVisitor(this.tref.next!);
            visitObject(o.next, v);
            this.result = v.result;
        }
    }

    /// Ditto
    override visitTypePointer(o: TypePointer): void {
        if (!this.tpointer)
            return;
        if (this.tpointer === o)
            this.result = true;
        else {
            // It might be a pointer to a template parameter that we already
            // saw, so we need to recurse
            const v = new ComponentVisitor(this.tpointer.next!);
            visitObject(o.next, v);
            this.result = v.result;
        }
    }

    /// Ditto
    override visitTypeIdentifier(o: TypeIdentifier): void {
        /// Since we know they are at the same level, scope resolution will
        /// give us the same symbol, thus we can just compare ident.
        this.result = (this.tident !== null && (this.tident.ident === o.ident));
    }

    /**
     * Overload which accepts a Namespace
     *
     * It is very common for large C++ projects to have multiple files sharing
     * the same `namespace`. If any D project adopts the same approach
     * (e.g. separating data structures from functions), it will lead to two
     * `Nspace` objects being instantiated, with different addresses.
     * At the same time, we cannot compare just any Dsymbol via identifier,
     * because it messes with templates.
     *
     * See_Also:
     *  https://issues.dlang.org/show_bug.cgi?id=18922
     *
     * Params:
     *   ns = C++ namespace to do substitution for
     */
    override visitNspace(ns: Nspace): void {
        this.result = isNamespaceEqual(this.namespace, ns)
            || isNamespaceEqualCPPNamespaceDeclaration(this.namespace2, ns);
    }

    /// Ditto
    override visitCPPNamespaceDeclaration(ns: CPPNamespaceDeclaration): void {
        this.result = isNamespaceEqualFromCPPNamespaceDeclaration(this.namespace, ns)
            || isNamespaceEqualCPPNamespaceDeclarationFromCPPNamespaceDeclaration(this.namespace2, ns);
    }
}

/// Transitional functions for `CPPNamespaceDeclaration` / `Nspace`
/// Remove when `Nspace` is removed.
///
/// dmd/mangle/cpp.d:2347 — `private bool isNamespaceEqual (Nspace a, Nspace b)`. The overload set (cpp.d:2347,
/// :2355, :2361, :2376) is renamed per 04 §1 Form B: this first-declared form keeps the bare name; a different
/// first parameter takes its type as suffix (rule 2), a different later one `From<Type>` (rule 3).
function isNamespaceEqual(a: Nspace | null, b: Nspace | null): boolean {
    if (a === null || b === null)
        return false;
    return equals(a, b);
}

/// Ditto
///
/// dmd/mangle/cpp.d:2355 — `private bool isNamespaceEqual (Nspace a, CPPNamespaceDeclaration b)`.
function isNamespaceEqualFromCPPNamespaceDeclaration(a: Nspace | null, b: CPPNamespaceDeclaration | null): boolean {
    return isNamespaceEqualCPPNamespaceDeclaration(b, a);
}

/// Ditto
///
/// dmd/mangle/cpp.d:2361 — `private bool isNamespaceEqual (CPPNamespaceDeclaration a, Nspace b, size_t idx = 0)`.
/// `idx` is unread. Both null is a D null dereference at `a.ident` (no caller passes it).
function isNamespaceEqualCPPNamespaceDeclaration(a: CPPNamespaceDeclaration | null, b: Nspace | null,
                                                 _idx = 0): boolean {
    if ((a === null) !== (b === null))
        return false;
    if (!a!.ident!.equals(b!.ident))
        return false;

    // We need to see if there's more ident enclosing
    const pb = b!.toParent()!.isNspace();
    if (pb)
        return isNamespaceEqualCPPNamespaceDeclaration(a!.cppnamespace(), pb);
    return a!.cppnamespace() === null;
}

/// Returns:
///   Whether  two `CPPNamespaceDeclaration` are equals
///
/// dmd/mangle/cpp.d:2376 — `private bool isNamespaceEqual (CPPNamespaceDeclaration a, CPPNamespaceDeclaration b)`.
function isNamespaceEqualCPPNamespaceDeclarationFromCPPNamespaceDeclaration(
    a: CPPNamespaceDeclaration | null, b: CPPNamespaceDeclaration | null): boolean {
    if (a === null || b === null)
        return false;

    if ((a.cppnamespace() === null) !== (b.cppnamespace() === null))
        return false;
    if (a.ident !== b.ident)
        return false;
    return a.cppnamespace() === null ? true :
        isNamespaceEqualCPPNamespaceDeclarationFromCPPNamespaceDeclaration(a.cppnamespace(), b.cppnamespace());
}

/**
 * A container for ABI tags
 *
 * At its hearth, there is a sorted array of ABI tags having been written
 * already. ABI tags can be present on parameters, template parameters,
 * return value, and varaible. ABI tags for a given type needs to be written
 * sorted. When a function returns a type that has ABI tags, only the tags that
 * haven't been printed as part of the mangling (e.g. arguments) are written
 * directly after the function name.
 *
 * This means that:
 * ---
 * /++ C++ type definitions:
 * struct [[gnu::abi_tag("tag1")]] Struct1 {};
 * struct [[gnu::abi_tag("tag2")]] Struct2 {};
 * // Can also be: "tag2", "tag1", since tags are sorted.
 * struct [[gnu::abi_tag("tag1", "tag2")]] Struct3 {};
 * +/
 * // Functions definitions:
 * Struct3 func1 (Struct1);
 * Struct3 func2 (Struct2);
 * Struct3 func3 (Struct2, Struct1);
 * ---
 * Will be respectively pseudo-mangled (part of interest between stars) as:
 * "_Z4 func1 *B4tag2* ParamsMangling" (ParamsMangling includes tag1),
 * "_Z4 func2 *B4tag1* ParamsMangling" (ParamsMangling includes tag2),
 * "_Z4 func2 *B4tag1* ParamsMangling" (ParamsMangling includes both).
 *
 * This is why why need to keep a list of tags that were written,
 * and insert the missing one after parameter mangling has been written.
 * Since there's a lot of operations that are not easily doable in DMD
 * (since we can't use Phobos), this special container is implemented.
 *
 * dmd/mangle/cpp.d:2421 — `private struct ABITagContainer`. Not copyable (its `Array` field is `@disable this(this)`),
 * so it is a class held by its one owner, CppMangleVisitor, with no `copy()` (header).
 */
class ABITagContainer {
    written: DArray<StringExp> = new DArray<StringExp>();

    /// dmd/mangle/cpp.d:2425 — `static ArrayLiteralExp forSymbol (Dsymbol s)`: the tag list of the
    /// `@gnuAbiTag` UDA on `s` (on the template declaration for an instance), or null.
    static forSymbol(s: Dsymbol | null): ArrayLiteralExp | null {
        if (!s)
            return null;
        // If this is a template instance, we want the declaration,
        // as that's where the UDAs are
        const ti = s.isTemplateInstance();
        if (ti)
            s = ti.tempdecl!;
        // `userAttribDecl.atts` is UserAttributeDeclaration's own `atts`, the `attsUda` slot (attrib.ts).
        if (!s.userAttribDecl() || !s.userAttribDecl()!.attsUda)
            return null;

        for (const exp of s.userAttribDecl()!.attsUda!) {
            if (isGNUABITag(exp!)) {
                // dmd/mangle/cpp.d:2439 — `return (*exp.isStructLiteralExp().elements)[0]`. DIVERGENCE FROM THE D
                // SOURCE, reproducing ldc2's binary. isGNUABITag tests only the UDA's type, so before semantic2 has
                // CTFE-evaluated the UDA (dmd/semantic2.d:635 — `e = e.ctfeInterpret();`), as for a `.mangleof` at
                // module scope, `exp` is still the analysed constructor CallExp and D dereferences a null
                // StructLiteralExp. ldc2's optimised build drops the null check and reads the field at
                // StructLiteralExp.elements' offset straight from the CallExp; `.offsetof` on dmd.expression gives
                // StructLiteralExp.elements and CallExp.arguments both at offset 32, so ldc2 reads
                // `(*callExp.arguments)[0].isArrayLiteralExp()`. The port reads the same field by name: a
                // `gnuAbiTag("x")` call's argument is the typesafe-variadic slice of a static array literal (no
                // tags), a `gnuAbiTag(["x"])` call's is the array literal itself (tags). A UDA of any other class
                // has no such field at offset 32 to agree on, and fails the assert.
                const sle = exp!.isStructLiteralExp();
                const ce = exp!.isCallExp();
                assert(sle !== null || ce !== null, "gnuAbiTag UDA is neither a StructLiteralExp nor a CallExp");
                const fields = sle !== null ? sle.elements! : ce!.arguments_!;
                return fields.opIndex(0)!
                    .isArrayLiteralExp();
            }
        }
        return null;
    }

    /// dmd/mangle/cpp.d:2445 — `void writeSymbol(Dsymbol s, CppMangleVisitor self)`: the ABI tags of `s`, written
    /// (or substituted) into `self.buf`.
    writeSymbol(s: Dsymbol, self: CppMangleVisitor): void {
        const tale = ABITagContainer.forSymbol(s);
        if (!tale) return;
        if (self.substitute(tale))
            return;
        this.write(self.buf, tale);
    }

    /**
     * Write an ArrayLiteralExp (expected to be an ABI tag) to the buffer
     *
     * Params:
     *   buf = Buffer to write mangling to
     *   ale = GNU ABI tag array literal expression, semantically analyzed
     */
    write(buf: OutBuffer, ale: ArrayLiteralExp, skipKnown = false): void {
        const writeElem = (exp: StringExp): void => {
            const tag = exp.peekString();
            buf.writestring(ds("B"));
            buf.print(BigInt(tag.length));
            buf.writestring(tag);
        };

        const match = { value: false };
        for (const exp of ale.elements!) {
            const elem = toStringExp(exp!)!;
            const idx = closestIndex(this.written.opSlice(), elem, match);
            if (!match.value) {
                writeElem(elem);
                this.written.insert(idx, elem);
            } else if (!skipKnown)
                writeElem(elem);
        }
    }
}

/**
 * Returns the closest index to to `exp` in `slice`
 *
 * Performs a binary search on `slice` (assumes `slice` is sorted),
 * and returns either `exp`'s index in `slice` if `exact` is `true`,
 * or the index at which `exp` can be inserted in `slice` if `exact is `false`.
 * Inserting `exp` at the return value will keep the array sorted.
 *
 * dmd/mangle/cpp.d:2504 — `private size_t closestIndex (const(StringExp)[] slice, StringExp exp, out bool exact)`.
 * D module-private (the module's unittest drives it, 10 §1.7). D narrows `slice` by re-slicing and returns an
 * offset from the original `first` element; the port keeps the original array and the narrowed window's start
 * (`base`) and length (`len`), so `&slice[$/2] - first` is `base + len/2`. `exact` is `out`: reset on entry.
 *
 * Params:
 *   slice = The sorted slice to search into
 *   exp   = The string expression to search for
 *   exact = If `true` on return, `exp` was found in `slice`
 *
 * Returns:
 *   Either the index to insert `exp` at (if `exact == false`),
 *   or the index of `exp` in `slice`.
 */
export function closestIndex(slice: readonly StringExp[], exp: StringExp, exact: { value: boolean }): number {
    exact.value = false;
    if (!slice.length) return 0;

    let base = 0;
    let len = slice.length;
    while (true) {
        const mid = Math.floor(len / 2);
        const res = dstrcmp(exp.peekString(), slice[base + mid]!.peekString());
        if (res === 0) {
            exact.value = true;
            return base + mid;
        }

        if (len === 1)
            return base + (res > 0 ? 1 : 0);
        if (res > 0) {
            base += mid;
            len -= mid;
        } else
            len = mid;
    }
}

/***
 * Visits the return type of a function and writes leftover ABI tags
 *
 * dmd/mangle/cpp.d:2571 — `void leftOver(TypeFunction tf, const(Array!StringExp)* previous`. The tags of
 * the return type (through pointers and references) that are not in `previous`, inserted sorted into `toWrite`.
 *
 * Params:
 *   tf = Type of the function to mangle the return type of
 *   previous = already written ones
 *   toWrite = where to put StringExp's to be written
 */
function leftOver(tf: TypeFunction, previous: DArray<StringExp>, toWrite: DArray<StringExp>): void {
    /// dmd/mangle/cpp.d:2573 — `extern(C++) final class LeftoverVisitor : Visitor`, local to `leftOver`.
    class LeftoverVisitor extends Visitor {
        /// List of tags to write
        toWrite: DArray<StringExp>;
        /// List of tags to ignore
        ignore: DArray<StringExp>;

        ///
        constructor(previous: DArray<StringExp>, toWrite: DArray<StringExp>) {
            super();
            this.ignore = previous;
            this.toWrite = toWrite;
        }

        // dropped: `public alias visit = Visitor.visit;` (cpp.d:2588) — no overload hiding in TS (13 §1).

        /// Least specialized overload of each direct child of `RootObject`
        override visitDsymbol(o: Dsymbol): void {
            const ale = ABITagContainer.forSymbol(o);
            if (!ale) return;

            const match = { value: false };
            for (const elem of ale.elements!) {
                const se = toStringExp(elem!)!;
                closestIndex(this.ignore.opSlice(), se, match);
                if (match.value) continue;
                const idx = closestIndex(this.toWrite.opSlice(), se, match);
                if (!match.value)
                    this.toWrite.insert(idx, se);
            }
        }

        /// Ditto
        override visitType(o: Type): void {
            const sym = toDsymbol(o, null);
            if (sym)
                sym.accept(this);
        }

        /// Composite type
        override visitTypePointer(o: TypePointer): void {
            o.next!.accept(this);
        }

        override visitTypeReference(o: TypeReference): void {
            o.next!.accept(this);
        }
    }

    const remainingVisitor = new LeftoverVisitor(previous, toWrite);
    tf.next!.accept(remainingVisitor);
}

/**
 * Injective Latin-1 key of a byte string: one byte, one UTF-16 code unit. The `switch` over
 * `str.peekString()` bytes (cpp.d:1275, :1287, :1303) keys on it against its ASCII case labels (06 §3.4).
 * NOT an upstream symbol: a module-private house helper, as cond.ts and stringtable.ts carry their own.
 */
function keyOf(str: DString): string {
    let s = "";
    for (let i = 0; i < str.length; i++) s += String.fromCharCode(str[i]!);
    return s;
}
