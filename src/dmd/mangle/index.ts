/**
 * Does name mangling for `extern(D)` symbols.
 *
 * Specification: $(LINK2 https://dlang.org/spec/abi.html#name_mangling, Name Mangling)
 *
 * Copyright: Copyright (C) 1999-2025 by The D Language Foundation, All Rights Reserved
 * Authors: Walter Bright, https://www.digitalmars.com
 * License:   $(LINK2 https://www.boost.org/LICENSE_1_0.txt, Boost License 1.0)
 * Source:    $(LINK2 https://github.com/dlang/dmd/blob/master/compiler/src/dmd/mangle/package.d, _dmangle.d)
 * Documentation:  https://dlang.org/phobos/dmd_dmangle.html
 * Coverage:    https://codecov.io/gh/dlang/dmd/src/master/compiler/src/dmd/mangle/package.d
 * References:  https://dlang.org/blog/2017/12/20/ds-newfangled-name-mangling/
 */
// module dmd.mangle;
//
// `package.d` maps to the ESM package entry point `index.ts` (01-conventions Rule 1.1).
//
// The whole module is ported: the type mangler (`mangleToBuffer(Type)`, `mangleType`,
// `mangleFuncType`, `mangleParameter`, `Backref`), the symbol/expression mangler (`class Mangler`
// with every `visit` override D declares), the four entry points (`mangleExact`, the `Expression` /
// `Dsymbol` / `TemplateInstance` forms of `mangleToBuffer`), `decoToType`, `isValidMangling` and the
// private byte helpers. The mangle-char tables live in `./basic.ts` (`mangleChar`, `tyToDecoBuffer`),
// re-exported here so `dmd.mangle` is the one entry point, as `package.d` re-exports `dmd.mangle.basic`.
//
// OVERLOAD SET `mangleToBuffer` (package.d:35/48/56/64) — a FIRST-parameter (receiver) split, 04 §1
// Form B rule 2: the `Type` form keeps the bare name (typesem.ts and declaration.ts import it); the
// others take the receiver-type suffix: `mangleToBufferExpression`, `mangleToBufferDsymbol`,
// `mangleToBufferTemplateInstance`.
//
// Callee walls reached from here (owned elsewhere): `StringExp.peekString/peekWstring/peekDstring/getIndex` for
// sz > 1 (the StringExp payload escalation, expression.ts). A template value argument that is a wide string
// reaches it.

import {
    Tpointer,
    Treference,
    Tdelegate,
    Tslice,
    Tarray,
    Tsarray,
    Taarray,
    Tfunction,
    Tident,
    Tclass,
    Tstruct,
    Tenum,
    Ttuple,
    Tnull,
    Tvector,
    Tnoreturn,
    Terror,
    MODFlags,
    LINK,
    TRUST,
    STC,
} from "../astenums.js";
import type { MOD } from "../astenums.js";
import {
    Type,
    TypeNext,
    TypeFunction,
    TypeSArray,
    TypeDArray,
    TypeAArray,
    TypeVector,
    TypeTuple,
    TypeIdentifier,
    TypeEnum,
    TypeStruct,
    TypeClass,
    TypeNull,
    TypeNoreturn,
    Parameter,
    buildScopeRef,
    ScopeRef,
} from "../mtype.js";
import { OutBuffer } from "../common/outbuffer.js";
import { tyToDecoBuffer } from "./basic.js";
import { isAnyIdentifierCharacter } from "../common/charactertables.js";
import { cstr, ds, dsUtf8 } from "../../dstring.js";
import type { DString } from "../../dstring.js";
import { assert, assertUnreachable } from "../../assert.js";
import { Visitor } from "../visitor/index.js";
// package.d:149 — `import dmd.expressionsem : toInteger, toReal, toImaginary;`
import { toInteger, toReal, toImaginary } from "../expressionsem.js";
import { registerMangleToBuffer } from "../declaration.js";
import { FileType } from "../astenums.js"; // value: Mangler.visit(Dsymbol) C-module global-namespace test
import { error } from "../errors.js";
import { Id } from "../id.js";
import { startsWith } from "../root/string.js";
import { CTFloat } from "../root/ctfloat.js";
import type { real_t } from "../root/ctfloat.js";
import { utf_decodeWchar, utf_isValidDchar } from "../root/utf.js";
import { toInt64, toUint64 } from "../../numeric.js";
import { EXP } from "../tokens.js";
import { global } from "../globals.js";
import type { dinteger_t } from "../globals.js";
import type { Dsymbol } from "../dsymbol.js";
import type { Identifier } from "../identifier.js";
import type { TemplateInstance } from "../dtemplate.js";
import type { FuncDeclaration, FuncAliasDeclaration } from "../func.js";
import type { AggregateDeclaration } from "../aggregate.js";
import type { Declaration, VarDeclaration, OverDeclaration } from "../declaration.js";
import type {
    Expression,
    IntegerExp,
    RealExp,
    ComplexExp,
    NullExp,
    StringExp,
    ArrayLiteralExp,
    AssocArrayLiteralExp,
    StructLiteralExp,
    FuncExp,
} from "../expression.js";
// last (01 §4.8): typesem imports this module back. By this line the `../expressionsem.js` import above
// has already entered the semantic layer, so typesem is evaluated or mid-evaluation and this edge changes
// no load order; merge2 is read only at call time (Backref.addRefToType).
import { merge2 } from "../typesem.js";
// last, same reason: class modules of the SCC, read only at call time (Mangler.visitAggregateDeclaration).
import { ClassDeclaration } from "../dclass.js";
import { Module } from "../dmodule.js";
// last, same reason: semantic-layer functions and SCC constants, each read only at call time inside a
// Mangler method (package.d:145-166: dinterpret, dsymbolsem, dtemplate, expression, funcsem, optimize,
// target). One exception, read at MODULE EVALUATION: `registerMangleToBufferTemplateInstance`, called
// at the end of this file. It is safe in any load order: a hoisted function declaration writing a
// hoisted `var` slot (dtemplate.ts:86), so neither has a temporal dead zone and the call works even
// while dtemplate.ts is still evaluating.
import { ctfeInterpret } from "../dinterpret.js";
import { toAlias } from "../dsymbolsem.js";
import { isType, isExpression, isDsymbol, isTuple, registerMangleToBufferTemplateInstance } from "../dtemplate.js";
import { WANTvalue } from "../expression.js";
import { isUnique } from "../funcsem.js";
import { optimize } from "../optimize.js";
import { target } from "../target.js";

// Re-export the mangle-char tables / basic-type mangler so `dmd.mangle` is the single entry point
// (package.d publicly re-exports `dmd.mangle.basic`). 02-types §5.3: a cross-module re-export.
export { mangleChar, tyToDecoBuffer } from "./basic.js";

/******************************************************************************
 * Returns exact mangled name of function (package.d:21).
 *
 * Memoized in `fd.mangleString`: the first call runs the `Mangler` and stores the result; later
 * calls return the stored bytes. The result is NUL-terminated (`extractChars`, 08 §11), as D's
 * `const(char)*` is.
 */
export function mangleExact(fd: FuncDeclaration): DString {
    //printf("mangleExact()\n");
    if (fd.mangleString === null) {
        const buf = new OutBuffer();
        const backref = new Backref(null);
        const v = new Mangler(buf, backref);
        v.mangleExact(fd);
        fd.mangleString = buf.extractChars(); // consume: `buf` is local and dies here
    }
    return fd.mangleString;
}

/**
 * Append the `deco` mangling of type `t` to `buf` (package.d:35).
 *
 * Fast path: a semantically-merged type already carries its interned `deco` string — write it
 * verbatim. Otherwise run the full `mangleType` over a fresh `Backref` rooted at `t`.
 * `t.deco` is the JS-string form of D's `char* deco` (mtype.ts), decoded from the mangle's UTF-8
 * bytes (typesem); `dsUtf8` re-encodes it byte-exact. (`ds` is one byte per UTF-16 unit: it would
 * corrupt an identifier character in U+0080..U+00FF and cannot encode one above U+00FF.)
 */
export function mangleToBuffer(t: Type, buf: OutBuffer): void {
    if (t.deco)
        buf.writestring(dsUtf8(t.deco));
    else {
        const backref = new Backref(t);
        mangleType(t, 0, buf, backref);
    }
}

// DEFERRED `dmd.mangle` EDGE (01 §4.4 / translation-order.md §3). D's importer here is
// declaration.d:725, a FUNCTION-LOCAL `import dmd.mangle;` inside `getTypeInfoIdent`. Rendering it
// as a top-level value import in declaration.ts dragged this module — and behind it the whole
// semantic layer — into declaration.ts's own evaluation and broke func.ts's
// `class FuncDeclaration extends Declaration` (01 §4.1). The edge is inverted instead: this module
// hands the function over as soon as it has one. `registerMangleToBuffer` is a hoisted function
// declaration, so the call is safe even if declaration.ts is still evaluating.
registerMangleToBuffer(mangleToBuffer);

/// package.d:48 — `void mangleToBuffer(Expression e, ref OutBuffer buf)`. Form-B receiver split (04 §1
/// rule 2): the `Expression` member of the `mangleToBuffer` set. Appends the value mangling of `e`.
export function mangleToBufferExpression(e: Expression, buf: OutBuffer): void {
    //printf("mangleToBuffer e()\n");
    const backref = new Backref(null);
    const v = new Mangler(buf, backref);
    e.accept(v);
}

/// package.d:56 — `void mangleToBuffer(Dsymbol s, ref OutBuffer buf)`. Form-B receiver split (04 §1
/// rule 2): the `Dsymbol` member. Appends the symbol mangling of `s` (for a declaration, `_D...`).
export function mangleToBufferDsymbol(s: Dsymbol, buf: OutBuffer): void {
    //printf("mangleToBuffer s(%s)\n", s.toChars());
    const backref = new Backref(null);
    const v = new Mangler(buf, backref);
    s.accept(v);
}

/// package.d:64 — `void mangleToBuffer(TemplateInstance ti, ref OutBuffer buf)`. Form-B receiver split
/// (04 §1 rule 2): the `TemplateInstance` member. Appends `__T<name><args>Z` (no parent chain) — the
/// text `TemplateInstance.genIdent` interns as the instance identifier.
export function mangleToBufferTemplateInstance(ti: TemplateInstance, buf: OutBuffer): void {
    //printf("mangleToBuffer ti()\n");
    const backref = new Backref(null);
    const v = new Mangler(buf, backref);
    v.mangleTemplateInstance(ti);
}

/**
 * Convert a string representing a type (the deco) and return its equivalent Type (package.d:114).
 *
 * Params:
 *   deco = bytes containing the deco
 * Returns:
 *   null if the conversion failed; the interned `Type` if it succeeded.
 */
export function decoToType(deco: DString): Type | null {
    const sv = Type.stringtable.lookup(deco);
    if (sv) {
        if (sv.value) {
            const t: Type = sv.value;
            assert(t.deco);
            return t;
        }
    }
    return null;
}

/***************************************** private ***************************************/

// The private imports of package.d:135-168 are at the top of this file (the SCC members among them in
// the trailing block, 01 §4.8). dropped: `core.stdc.ctype`, `core.stdc.stdio`, `core.stdc.string`
// (the libc calls they serve are rendered inline), `dmd.arraytypes`, `dmd.root.aav`,
// `dmd.root.stringtable` (types only, or replaced by `Map` in `Backref`), `dmd.tokens` (`EXP` comes
// from tokens.ts through the same import).

/// Returns: `true` if the given character is a valid mangled character (package.d:73).
/// `package(dmd)` visibility; exported here (TS has no package access) for the in-module unittests.
export function isValidMangling(c: number /* dchar */): boolean {
    return (
        (c >= /* 'A' */ 0x41 && c <= /* 'Z' */ 0x5a) ||
        (c >= /* 'a' */ 0x61 && c <= /* 'z' */ 0x7a) ||
        (c >= /* '0' */ 0x30 && c <= /* '9' */ 0x39) ||
        (c !== 0 && strchrMangling(c)) ||
        isAnyIdentifierCharacter(c)
    );
}

// `strchr("$%().:?@[]_", c)` (package.d:81) — membership in the literal set. A boolean is all the
// caller needs (the pointer return is only tested for non-null).
function strchrMangling(c: number): boolean {
    // "$%().:?@[]_" as byte codes.
    switch (c) {
        case 0x24: // '$'
        case 0x25: // '%'
        case 0x28: // '('
        case 0x29: // ')'
        case 0x2e: // '.'
        case 0x3a: // ':'
        case 0x3f: // '?'
        case 0x40: // '@'
        case 0x5b: // '['
        case 0x5d: // ']'
        case 0x5f: // '_'
            return true;
        default:
            return false;
    }
}

/************************************************
 * Append the mangling of type `t` to `buf` (package.d:178).
 * Params:
 *      t = type to mangle
 *      modMask = mod bits currently applying to t
 *      buf = buffer to append mangling to
 *      backref = state of back references (updated)
 */
export function mangleType(t: Type, modMask: MOD, buf: OutBuffer, backref: Backref): void {
    // The nested D `void visitWithMask(Type, ubyte)` closure — kept as a local closure so the
    // recursion threads `buf`/`backref` exactly as D does (they are captured, not re-passed).
    const visitWithMask = (t: Type, modMask: MOD): void => {
        // package.d:182 — `void mangleSymbol(Dsymbol s)`: build a Mangler and run its symbol pass.
        const mangleSymbol = (s: Dsymbol): void => {
            const v = new Mangler(buf, backref);
            v.mangleSymbol(s);
        };

        // package.d:188 — `void visitType(Type t)`: the basic-type mangle char.
        const visitType = (t: Type): void => {
            tyToDecoBuffer(buf, t.ty);
        };

        // package.d:193 — `void visitTypeNext(TypeNext t)`: this char, then the element/next type.
        const visitTypeNext = (t: TypeNext): void => {
            visitType(t);
            visitWithMask(t.next!, t.mod);
        };

        // package.d:199 — `void visitTypeVector(TypeVector t)`: 'Nh' + basetype.
        const visitTypeVector = (t: TypeVector): void => {
            buf.writestring(ds("Nh"));
            visitWithMask(t.basetype, t.mod);
        };

        // package.d:205 — `void visitTypeSArray(TypeSArray t)`: 'G' + dim + element.
        const visitTypeSArray = (t: TypeSArray): void => {
            visitType(t);
            if (t.dim)
                buf.print(toInteger(t.dim)); // UFCS `t.dim.toInteger()` → expressionsem.d:192
            if (t.next)
                visitWithMask(t.next, t.mod);
        };

        // package.d:214 — `void visitTypeDArray(TypeDArray t)`: 'A' + element.
        const visitTypeDArray = (t: TypeDArray): void => {
            visitType(t);
            if (t.next)
                visitWithMask(t.next, t.mod);
        };

        // package.d:221 — `void visitTypeAArray(TypeAArray t)`: 'H' + key + value.
        const visitTypeAArray = (t: TypeAArray): void => {
            visitType(t);
            visitWithMask(t.index!, 0);
            visitWithMask(t.next!, t.mod);
        };

        // package.d:228 — `void visitTypeFunction(TypeFunction t)`: linkage + params + return.
        const visitTypeFunction = (t: TypeFunction): void => {
            mangleFuncType(t, t, t.mod, t.next, buf, backref);
        };

        // package.d:235 — `void visitTypeIdentifier(TypeIdentifier t)`: '@' + length-prefixed ident.
        const visitTypeIdentifier = (t: TypeIdentifier): void => {
            visitType(t);
            const name = t.ident!.toString();
            // `cast(int)name.length` — a small byte-count; `print` takes the `ulong` (bigint) domain.
            buf.print(BigInt(name.length));
            buf.writestring(name);
        };

        // package.d:243 — `void visitTypeEnum(TypeEnum t)`: 'E' + symbol.
        const visitTypeEnum = (t: TypeEnum): void => {
            visitType(t);
            mangleSymbol(t.sym!);
        };

        // package.d:249 — `void visitTypeStruct(TypeStruct t)`: 'S' + symbol.
        const visitTypeStruct = (t: TypeStruct): void => {
            visitType(t);
            mangleSymbol(t.sym!);
        };

        // package.d:256 — `void visitTypeClass(TypeClass t)`: 'C' + symbol.
        const visitTypeClass = (t: TypeClass): void => {
            visitType(t);
            mangleSymbol(t.sym!);
        };

        // package.d:263 — `void visitTypeTuple(TypeTuple t)`: 'B' + each param + 'Z'.
        const visitTypeTuple = (t: TypeTuple): void => {
            visitType(t);
            // `foreach`-over-opApply (05 §11): D's `Parameter._foreach(t.arguments, dg)`. The dg
            // mangles each expanded parameter and continues (return 0).
            Parameter._foreach(t.arguments, (_idx: number, param: Parameter): number => {
                mangleParameter(param, buf, backref);
                return 0;
            });
            buf.writeByte(/* 'Z' */ 0x5a);
        };

        // package.d:274 — `void visitTypeNull(TypeNull t)`: just the 'n' char.
        const visitTypeNull = (t: TypeNull): void => {
            visitType(t);
        };

        // package.d:279 — `void visitTypeNoreturn(TypeNoreturn t)`: 'Nn'.
        const visitTypeNoreturn = (_t: TypeNoreturn): void => {
            buf.writestring(ds("Nn"));
        };

        if (modMask !== t.mod) {
            MODtoDecoBuffer(buf, t.mod);
        }
        if (backref.addRefToType(buf, t))
            return;

        switch (t.ty) {
            case Tpointer:
            case Treference:
            case Tdelegate:
            case Tslice:
                // 02 §11.5c form 3, a SET of tags: the case labels Tpointer / Treference / Tdelegate /
                // Tslice are exactly the TypeNext subclasses TypePointer / TypeReference /
                // TypeDelegate / TypeSlice, which no single `isXxx()` expresses (D: `cast(TypeNext)t`).
                visitTypeNext(t as TypeNext);
                break;

            case Tarray:
                visitTypeDArray(t.isTypeDArray()!);
                break;
            case Tsarray:
                visitTypeSArray(t.isTypeSArray()!);
                break;
            case Taarray:
                visitTypeAArray(t.isTypeAArray()!);
                break;
            case Tfunction:
                visitTypeFunction(t.isTypeFunction()!);
                break;
            case Tident:
                visitTypeIdentifier(t.isTypeIdentifier()!);
                break;
            case Tclass:
                visitTypeClass(t.isTypeClass()!);
                break;
            case Tstruct:
                visitTypeStruct(t.isTypeStruct()!);
                break;
            case Tenum:
                visitTypeEnum(t.isTypeEnum()!);
                break;
            case Ttuple:
                visitTypeTuple(t.isTypeTuple()!);
                break;
            case Tnull:
                visitTypeNull(t.isTypeNull()!);
                break;
            case Tvector:
                visitTypeVector(t.isTypeVector()!);
                break;
            case Tnoreturn:
                visitTypeNoreturn(t.isTypeNoreturn()!);
                break;

            case Terror:
                break; // ignore errors

            default:
                visitType(t);
                break;
        }
    };

    visitWithMask(t, modMask);
}

/*************************************************************
 * Mangle type of function, writing it to `buf` (package.d:332).
 * Params:
 *      t = function type
 *      ta = consult original function type for attributes
 *      modMask = type modifiers
 *      tret = function return type
 *      buf = sink for mangling characters
 *      backref = back reference
 */
export function mangleFuncType(
    t: TypeFunction, ta: TypeFunction, modMask: MOD, tret: Type | null,
    buf: OutBuffer, backref: Backref,
): void {
    if (t.inuse && tret) {
        t.inuse = 2; // flag error to caller
        return;
    }
    t.inuse++;
    // PAIRED STATE (11 §2.5): D decrements once at region end (package.d:417); a wall reached through the
    // parameter/return mangling (a template value argument inside a type) must not leave `inuse` raised.
    try {
        if (modMask !== t.mod)
            MODtoDecoBuffer(buf, t.mod);

        let mc: number;
        // D `final switch (t.linkage)`: exhaustive over LINK.
        switch (t.linkage) {
            case LINK.default_:
            case LINK.d:
                mc = /* 'F' */ 0x46;
                break;
            case LINK.c:
                mc = /* 'U' */ 0x55;
                break;
            case LINK.windows:
                mc = /* 'W' */ 0x57;
                break;
            case LINK.cpp:
                mc = /* 'R' */ 0x52;
                break;
            case LINK.objc:
                mc = /* 'Y' */ 0x59;
                break;
            case LINK.system:
                return assertUnreachable(); // assert(0)
            default:
                return assertUnreachable(); // final switch exhaustiveness
        }
        buf.writeByte(mc);

        if (ta.purity)
            buf.writestring(ds("Na"));
        if (ta.isNothrow)
            buf.writestring(ds("Nb"));
        if (ta.isRef)
            buf.writestring(ds("Nc"));
        if (ta.isProperty)
            buf.writestring(ds("Nd"));
        if (ta.isNogc)
            buf.writestring(ds("Ni"));

        // `return scope` must be in that order
        if (ta.isReturnScope && !ta.isReturnInferred) {
            buf.writestring(ds("NjNl"));
        } else {
            // when return ref, the order is `scope return`
            if (ta.isScopeQual && !ta.isScopeInferred)
                buf.writestring(ds("Nl"));

            if (ta.isReturn && !ta.isReturnInferred)
                buf.writestring(ds("Nj"));
        }

        if (ta.isLive)
            buf.writestring(ds("Nm"));

        switch (ta.trust) {
            case TRUST.trusted:
                buf.writestring(ds("Ne"));
                break;
            case TRUST.safe:
                buf.writestring(ds("Nf"));
                break;
            default:
                break;
        }

        // Write argument types — `foreach (idx, param; t.parameterList)` lowers to opApply, i.e.
        // `Parameter._foreach(t.parameterList.parameters, dg)` (mtype ParameterList.opApply).
        Parameter._foreach(t.parameterList.parameters, (_idx: number, param: Parameter): number => {
            mangleParameter(param, buf, backref);
            return 0;
        });
        // mark end of arg list: 'Z' - varargs (0->'Z' not-variadic, 1->'Y', 2->'X').
        buf.writeByte((/* 'Z' */ 0x5a - t.parameterList.varargs) & 0xff);
        if (tret !== null)
            mangleType(tret, 0, buf, backref);
    } finally {
        t.inuse--;
    }
}

/*************************************************************
 * Mangle a function parameter (package.d:422). https://dlang.org/spec/abi.html#Parameter
 */
export function mangleParameter(p: Parameter, buf: OutBuffer, backref: Backref): void {
    // `stc` is the 64-bit STC flag set (bigint, branded). Local `bigint` drops the brand so the
    // bitwise mutation/`switch` below read as plain integer flag math (same pattern as buildScopeRef).
    let stc: bigint = p.storageClass;

    // Inferred storage classes don't get mangled in
    if (stc & STC.scopeinferred)
        stc = stc & ~(STC.scope_ | STC.scopeinferred);
    if (stc & STC.returninferred)
        stc = stc & ~(STC.return_ | STC.returninferred);

    // much like hdrgen.stcToBuffer()
    let rrs: DString | null = null;
    const isout = (stc & STC.out_) !== 0n;
    // D `final switch (buildScopeRef(stc))`: exhaustive over ScopeRef.
    switch (buildScopeRef(stc as STC)) {
        case ScopeRef.None:
        case ScopeRef.Scope:
        case ScopeRef.Ref:
        case ScopeRef.Return:
        case ScopeRef.RefScope:
            break;

        case ScopeRef.ReturnScope:
            rrs = ds("NkM"); // return scope
            buf.writestring(rrs);
            stc = stc & ~(STC.out_ | STC.scope_ | STC.ref_ | STC.return_);
            break;
        case ScopeRef.ReturnRef:
            rrs = isout ? ds("NkJ") : ds("NkK"); // return ref
            buf.writestring(rrs);
            stc = stc & ~(STC.out_ | STC.scope_ | STC.ref_ | STC.return_);
            break;
        case ScopeRef.ReturnRef_Scope:
            rrs = isout ? ds("MNkJ") : ds("MNkK"); // scope return ref
            buf.writestring(rrs);
            stc = stc & ~(STC.out_ | STC.scope_ | STC.ref_ | STC.return_);
            break;
        case ScopeRef.Ref_ReturnScope:
            rrs = isout ? ds("NkMJ") : ds("NkMK"); // return scope ref
            buf.writestring(rrs);
            stc = stc & ~(STC.out_ | STC.scope_ | STC.ref_ | STC.return_);
            break;
        default:
            return assertUnreachable(); // final switch exhaustiveness
    }

    if (stc & STC.scope_)
        buf.writeByte(/* 'M' */ 0x4d); // scope

    if (stc & STC.return_)
        buf.writestring(ds("Nk")); // return

    switch (stc & ((STC.IOR | STC.lazy_) & ~STC.constscoperef)) {
        case STC.none:
            break;
        case STC.in_:
            buf.writeByte(/* 'I' */ 0x49);
            break;
        case STC.in_ | STC.ref_:
            buf.writestring(ds("IK"));
            break;
        case STC.out_:
            buf.writeByte(/* 'J' */ 0x4a);
            break;
        case STC.ref_:
            buf.writeByte(/* 'K' */ 0x4b);
            break;
        case STC.lazy_:
            buf.writeByte(/* 'L' */ 0x4c);
            break;
        default:
            // dropped: debug { printf("storageClass = x%llx\n", ...); } (non-debug build, _config.md)
            return assertUnreachable(); // assert(0)
    }
    mangleType(p.type!, stc & STC.in_ ? MODFlags.const_ : 0, buf, backref);
}

/**
 * package.d:492 — `private extern (C++) final class Mangler : Visitor`. The symbol and expression
 * mangler: `mangleSymbol(s)` appends the mangling of a Dsymbol (a declaration's full `_D...` name, or a
 * qualified name inside a type deco), `e.accept(v)` the mangling of a template value argument.
 *
 * D declares these `visit` overrides, each ported under its 13 §1 name: Declaration, FuncDeclaration,
 * FuncAliasDeclaration, OverDeclaration, VarDeclaration, AggregateDeclaration, TemplateInstance,
 * Dsymbol, Expression, IntegerExp, RealExp, ComplexExp, NullExp, StringExp, ArrayLiteralExp,
 * AssocArrayLiteralExp, StructLiteralExp, FuncExp. Every other node reaches one of them through the
 * base visitor's forwarding chain (visitor/parsetime.ts, visitor/index.ts), exactly as in D:
 * StructDeclaration/ClassDeclaration → AggregateDeclaration, TemplateMixin → TemplateInstance,
 * the other Expression kinds → Expression.
 *
 * `OutBuffer`/`Backref` are D pointers to the caller's values; here they are class references
 * (03 §7), shared with the caller, never copied.
 */
export class Mangler extends Visitor {
    // dropped: `alias visit = Visitor.visit;` (13 §1) and `static assert(Key.sizeof == size_t.sizeof)`
    // (package.d:496, an aav layout check with no TS counterpart).
    buf: OutBuffer;
    backref: Backref;

    // package.d:501 — `extern (D) this(ref OutBuffer buf, Backref* backref)`.
    constructor(buf: OutBuffer, backref: Backref) {
        super();
        this.buf = buf;
        this.backref = backref;
    }

    // package.d:507 — `void mangleSymbol(Dsymbol s)`.
    mangleSymbol(s: Dsymbol): void {
        s.accept(this);
    }

    // package.d:512 — `void mangleIdentifier(Identifier id, Dsymbol s)`. Back-reference the identifier
    // if already mangled, else write its length-prefixed text.
    mangleIdentifier(id: Identifier, s: Dsymbol): void {
        if (!this.backref.addRefToIdentifier(this.buf, id))
            toBuffer(this.buf, id.toString(), s);
    }

    // package.d:518 — `void mangleInteger(dinteger_t v)`. `'N'` + magnitude for a value negative as
    // `sinteger_t`, else `'i'` + value. The carrier is the signed-normalized bigint (09 §2): the sign
    // test is `cast(sinteger_t)` = `toInt64`, and the printed `ulong` is `toUint64` (D's `-v` wraps
    // mod 2^64, so `long.min` prints 9223372036854775808).
    mangleInteger(v: dinteger_t): void {
        if (toInt64(v) < 0n) {
            this.buf.writeByte(/* 'N' */ 0x4e);
            this.buf.print(toUint64(-v));
        } else {
            this.buf.writeByte(/* 'i' */ 0x69);
            this.buf.print(toUint64(v));
        }
    }

    ////////////////////////////////////////////////////////////////////////////
    // package.d:533 — `void mangleDecl(Declaration sthis)`. Parent chain, own identifier, then the
    // function type (`mangleFunc`) or the variable type.
    mangleDecl(sthis: Declaration): void {
        this.mangleParent(sthis);
        assert(sthis.ident);
        this.mangleIdentifier(sthis.ident, sthis);
        const fd = sthis.isFuncDeclaration();
        if (fd !== null) {
            this.mangleFunc(fd, false);
        } else if (sthis.type) {
            mangleType(sthis.type, 0, this.buf, this.backref);
        } else
            assertUnreachable(); // assert(0)
    }

    // package.d:550 — `void mangleParent(Dsymbol s)`. Mangle the symbol's enclosing chain (module /
    // aggregate / function / template instance), outermost first.
    mangleParent(s: Dsymbol): void {
        //printf("mangleParent() %s %s\n", s.kind(), s.toChars());
        let p: Dsymbol | null;
        const tiS = s.isTemplateInstance();
        if (tiS)
            p = tiS.isTemplateMixin() ? tiS.parent : tiS.tempdecl!.parent;
        else
            p = s.parent;
        if (p) {
            let localNum = s.localNum;
            this.mangleParent(p);
            const ti = p.isTemplateInstance();
            if (ti && !ti.isTemplateMixin()) {
                localNum = ti.tempdecl!.localNum;
                this.mangleTemplateInstance(ti);
            } else if (p.getIdent()) {
                this.mangleIdentifier(p.ident!, s);
                const f = p.isFuncDeclaration();
                if (f !== null)
                    this.mangleFunc(f, true);
            } else
                this.buf.writeByte(/* '0' */ 0x30);

            if (localNum)
                writeLocalParent(this.buf, localNum);
        }
    }

    // package.d:582 — `void mangleFunc(FuncDeclaration fd, bool inParent)`. `M` for a function with a
    // context pointer, then the function type: as a parent (`inParent`) the type without its return
    // type, attributes read from the original (pre-inference) type.
    mangleFunc(fd: FuncDeclaration, inParent: boolean): void {
        //printf("deco = '%s'\n", fd.type.deco ? fd.type.deco : "null");
        //printf("fd.type = %s\n", fd.type.toChars());
        if (fd.needThis() || fd.isNested())
            this.buf.writeByte(/* 'M' */ 0x4d);

        if (!fd.type || fd.type.ty === Terror) {
            // never should have gotten here, but could be the result of
            // failed speculative compilation
            this.buf.writestring(ds("9__error__FZ"));

            //printf("[%s] %s no type\n", fd.loc.toChars(), fd.toChars());
            //assert(0); // don't mangle function until semantic3 done.
        } else if (inParent) {
            const tf = fd.type.isTypeFunction();
            const tfo = fd.originalType!.isTypeFunction();
            mangleFuncType(tf!, tfo!, 0, null, this.buf, this.backref);
        } else {
            mangleType(fd.type, 0, this.buf, this.backref);
        }
    }

    // package.d:610 — `override void visit(Declaration d)`. An externally callable name (C/C++/ObjC
    // linkage at module scope) verbatim; otherwise `_D` + the qualified mangle.
    override visitDeclaration(d: Declaration): void {
        //printf("Declaration.mangle(this = %p, '%s', parent = '%s', linkage = %d)\n",
        //        d, d.toChars(), d.parent ? d.parent.toChars() : "null", d.linkage);
        const id = externallyMangledIdentifier(d);
        if (id !== null) {
            this.buf.writestring(id);
            return;
        }
        this.buf.writestring(ds("_D"));
        this.mangleDecl(d);
        // dropped: the `debug { ... isValidMangling ... }` self-check (package.d:621-634) — non-debug
        // build (_config.md §3).
    }

    /******************************************************************************
     * package.d:660 — `override void visit(FuncDeclaration fd)`.
     *
     * Normally FuncDeclaration and FuncAliasDeclaration have overloads.
     * If and only if there is no overloads, mangle() could return
     * exact mangled name.
     *
     *      module test;
     *      void foo(long) {}           // _D4test3fooFlZv
     *      void foo(string) {}         // _D4test3fooFAyaZv
     *
     *      // from FuncDeclaration.mangle().
     *      pragma(msg, foo.mangleof);  // prints unexact mangled name "4test3foo"
     *                                  // by calling Dsymbol.mangle()
     *
     *      // from FuncAliasDeclaration.mangle()
     *      pragma(msg, __traits(getOverloads, test, "foo")[0].mangleof);  // "_D4test3fooFlZv"
     *      pragma(msg, __traits(getOverloads, test, "foo")[1].mangleof);  // "_D4test3fooFAyaZv"
     *
     * If a function has no overloads, .mangleof property still returns exact mangled name.
     *
     *      void bar() {}
     *      pragma(msg, bar.mangleof);  // still prints "_D4test3barFZv"
     *                                  // by calling FuncDeclaration.mangleExact().
     */
    override visitFuncDeclaration(fd: FuncDeclaration): void {
        if (isUnique(fd)) // UFCS `fd.isUnique()` → funcsem.d:408 (04 §6)
            this.mangleExact(fd);
        else
            this.visitDsymbol(fd);
    }

    // package.d:669 — `override void visit(FuncAliasDeclaration fd)` (ditto).
    override visitFuncAliasDeclaration(fd: FuncAliasDeclaration): void {
        const f = fd.toAliasFunc();
        const fa = f.isFuncAliasDeclaration();
        if (!fd.hasOverloads && !fa) {
            this.mangleExact(f);
            return;
        }
        if (fa) {
            this.mangleSymbol(fa);
            return;
        }
        this.visitDsymbol(fd);
    }

    // package.d:686 — `override void visit(OverDeclaration od)`.
    override visitOverDeclaration(od: OverDeclaration): void {
        if (od.overnext) {
            this.visitDsymbol(od);
            return;
        }
        const fd = od.aliassym!.isFuncDeclaration();
        if (fd !== null) {
            if (isUnique(fd)) { // UFCS `fd.isUnique()` → funcsem.d:408, the FuncDeclaration form
                this.mangleExact(fd);
                return;
            }
        }
        const td = od.aliassym!.isTemplateDeclaration();
        if (td !== null) {
            if (td.overnext === null) {
                this.mangleSymbol(td);
                return;
            }
        }
        this.visitDsymbol(od);
    }

    // package.d:712 — `void mangleExact(FuncDeclaration fd)`. `pragma(mangle)` override, `_Dmain`,
    // the bare Windows entry points, else the full `_D` declaration mangle.
    mangleExact(fd: FuncDeclaration): void {
        assert(!fd.isFuncAliasDeclaration());
        if (fd.mangleOverride) {
            this.buf.writestring(fd.mangleOverride);
            return;
        }
        if (fd.isMain()) {
            this.buf.writestring(ds("_Dmain"));
            return;
        }
        if (fd.isWinMain() || fd.isDllMain()) {
            this.buf.writestring(fd.ident!.toString());
            return;
        }

        // resolved: version(IN_LLVM) -> on (_config.md §1): `import gen.llvmhelpers : isTargetWasm;
        // bool isWasm = isTargetWasm();` (package.d:733-734). `isTargetWasm` is a bodiless `extern (C++)`
        // (gen/llvmhelpers.d:23) implemented at gen/llvmhelpers.cpp:74 as `targetTriple->isWasm()`: false
        // on every supported triple (10 §4.8: none is Wasm), folded at the site (11 §2.5), like target.ts's
        // `isTargetWindowsMSVC`.
        const isWasm = false;

        if (fd.isCMain() && isWasm) {
            if (fd.parameters)
                this.buf.writestring(ds("__main_argc_argv"));
            else
                this.buf.writestring(ds("__main_void"));
            return;
        }

        this.visitDeclaration(fd);
    }

    // package.d:750 — `override void visit(VarDeclaration vd)`.
    override visitVarDeclaration(vd: VarDeclaration): void {
        if (vd.mangleOverride) {
            this.buf.writestring(vd.mangleOverride);
            return;
        }
        this.visitDeclaration(vd);
    }

    // package.d:760 — `override void visit(AggregateDeclaration ad)`. Temporarily null-parents the
    // classes reserved to the compiler (Exception, TypeInfo*, Object, ModuleInfo), then delegates to
    // `visit(Dsymbol)`.
    override visitAggregateDeclaration(ad: AggregateDeclaration): void {
        const cd = ad.isClassDeclaration();
        const parentsave = ad.parent;
        // PAIRED STATE (11 §2.5): `ad.parent` is nulled below and restored once after the Dsymbol
        // mangle (package.d:776); that mangle can reach a wall (a template value argument in the parent
        // chain), so the restore sits in a `finally`.
        try {
            if (cd) {
                /* These are reserved to the compiler, so keep simple
                 * names for them.
                 */
                // `strncmp(cd.ident.toChars(), "TypeInfo_", 9) == 0`: n equals the literal's length, so the
                // comparison is exactly a prefix test. `cd == Module.moduleinfo` is spelled through `ad`
                // (the same object; Module.moduleinfo is typed AggregateDeclaration, which TS will not
                // compare against a ClassDeclaration).
                if (cd.ident === Id.Exception && cd.parent!.ident === Id.object || cd.ident === Id.TypeInfo ||
                    cd.ident === Id.TypeInfo_Struct || cd.ident === Id.TypeInfo_Class ||
                    cd.ident === Id.TypeInfo_Tuple || cd === ClassDeclaration.object || cd === Type.typeinfoclass ||
                    ad === Module.moduleinfo ||
                    startsWith(cd.ident!.toChars(), ds("TypeInfo_"))) {
                    // Don't mangle parent
                    ad.parent = null;
                }
            }
            this.visitDsymbol(ad);
        } finally {
            ad.parent = parentsave;
        }
    }

    // package.d:779 — `override void visit(TemplateInstance ti)`. Parent chain, then the mixin's own
    // identifier (a named `mixin T!() id;`) or the `__T` instance mangle.
    override visitTemplateInstance(ti: TemplateInstance): void {
        // dropped: `version (none)` trace block (package.d:781, _config.md §3).
        if (!ti.tempdecl)
            error(ti.loc, ds("%s `%s` is not defined"), ti.kind(), ti.toPrettyChars());
        else
            this.mangleParent(ti);

        if (ti.isTemplateMixin() && ti.ident)
            this.mangleIdentifier(ti.ident, ti);
        else
            this.mangleTemplateInstance(ti);
    }

    // package.d:799 — `void mangleTemplateInstance(TemplateInstance ti)`. `__T` (or `__U` inside a
    // template constraint), the template name, one entry per argument (`T` type, `V` value, `S`
    // symbol, `X` externally-mangled symbol, a leading `H` when the parameter is specialized), `Z`.
    mangleTemplateInstance(ti: TemplateInstance): void {
        const tempdecl = ti.tempdecl!.isTemplateDeclaration();
        assert(tempdecl);

        // Use "__U" for the symbols declared inside template constraint.
        const T = ti.members ? /* 'T' */ 0x54 : /* 'U' */ 0x55;
        this.buf.printf(ds("__%c"), T);
        this.mangleIdentifier(tempdecl.ident!, tempdecl);

        let args = ti.tiargs!;
        const nparams = tempdecl.parameters!.length - (tempdecl.isVariadic() ? 1 : 0);
        for (let i = 0; i < args.length; i++) {
            const o = args.opIndex(i);
            const ta = isType(o);
            let ea = isExpression(o);
            let sa = isDsymbol(o);
            const va = isTuple(o);
            //printf("\to [%d] %p ta %p ea %p sa %p va %p\n", i, o, ta, ea, sa, va);

            // SHARED-ARM `Lsa:` (package.d:872, 06 §4): the `else if (sa)` arm, entered by its own test and
            // by the three jumps of the `ea` arm (package.d:836/842/851). It is the last statement
            // of the loop body, so each of its `continue`s is a `return` from the arm.
            const LsaArm = (): void => {
                sa = toAlias(sa!); // UFCS `sa.toAlias()` → dsymbolsem.d:1523
                if (sa.isDeclaration() && !sa.isOverDeclaration()) {
                    let d = sa.isDeclaration()!;

                    const fad = d.isFuncAliasDeclaration();
                    if (fad !== null)
                        d = fad.toAliasFunc();
                    if (d.mangleOverride) {
                        this.buf.writeByte(/* 'X' */ 0x58);
                        toBuffer(this.buf, d.mangleOverride, d);
                        return; // continue
                    }
                    const id = externallyMangledIdentifier(d);
                    if (id !== null) {
                        this.buf.writeByte(/* 'X' */ 0x58);
                        toBuffer(this.buf, id, d);
                        return; // continue
                    }
                    if (!d.type || !d.type.deco) {
                        error(ti.loc, ds("%s `%s` forward reference of %s `%s`"), ti.kind(), ti.toPrettyChars(),
                            d.kind(), d.toChars());
                        return; // continue
                    }
                }
                this.buf.writeByte(/* 'S' */ 0x53);
                this.mangleSymbol(sa);
            };

            if (i < nparams && tempdecl.parameters!.opIndex(i)!.specialization())
                this.buf.writeByte(/* 'H' */ 0x48); // https://issues.dlang.org/show_bug.cgi?id=6574
            if (ta) {
                this.buf.writeByte(/* 'T' */ 0x54);
                mangleType(ta, 0, this.buf, this.backref);
            } else if (ea) {
                // Don't interpret it yet, it might actually be an alias template parameter.
                // Only constfold manifest constants, not const/immutable lvalues, see
                // https://issues.dlang.org/show_bug.cgi?id=17339.
                const keepLvalue = true; // enum keepLvalue = true;
                ea = optimize(ea, WANTvalue, keepLvalue);
                const ev = ea.isVarExp();
                if (ev !== null) {
                    sa = ev.var_;
                    ea = null;
                    LsaArm(); // goto Lsa (dmd/mangle/package.d:836)
                    continue;
                }
                const et = ea.isThisExp();
                if (et !== null) {
                    sa = et.var_;
                    ea = null;
                    LsaArm(); // goto Lsa (dmd/mangle/package.d:842)
                    continue;
                }
                const ef = ea.isFuncExp();
                if (ef !== null) {
                    if (ef.td)
                        sa = ef.td;
                    else
                        sa = ef.fd;
                    ea = null;
                    LsaArm(); // goto Lsa (dmd/mangle/package.d:851)
                    continue;
                }
                this.buf.writeByte(/* 'V' */ 0x56);
                if (ea.op === EXP.tuple) {
                    error(ea.loc, ds("sequence is not a valid template value argument"));
                    continue;
                }
                // Now that we know it is not an alias, we MUST obtain a value
                const olderr = global.errors;
                ea = ctfeInterpret(ea);
                if (ea.op === EXP.error || olderr !== global.errors)
                    continue;

                /* Use type mangling that matches what it would be for a function parameter
                */
                mangleType(ea.type!, 0, this.buf, this.backref);
                ea.accept(this);
            } else if (sa) {
                // Lsa: (package.d:872)
                LsaArm();
            } else if (va) {
                assert(i + 1 === args.length); // must be last one
                args = va.objects;
                i = -1; // `i = -cast(size_t)1;` — the loop's `i++` wraps it to 0
            } else
                assertUnreachable(); // assert(0)
        }
        this.buf.writeByte(/* 'Z' */ 0x5a);
    }

    // package.d:913 — `override void visit(Dsymbol s)`. The base symbol mangle: parent chain + the
    // symbol's own length-prefixed identifier.
    override visitDsymbol(s: Dsymbol): void {
        // dropped: `version (none)` trace block (package.d:915, _config.md §3).
        if (s.parent && s.ident) {
            const m = s.parent.isModule();
            if (m) {
                if (m.filetype === FileType.c) {
                    /* C types at global level get mangled into the __C global namespace
                     * to get the same mangling regardless of which module it
                     * is declared in. This works because types are the same if the mangling
                     * is the same.
                     */
                    this.mangleIdentifier(Id.ImportC!, s); // parent
                    this.mangleIdentifier(s.ident, s);
                    return;
                }
            }
        }
        this.mangleParent(s);
        if (s.ident)
            this.mangleIdentifier(s.ident, s);
        else
            toBuffer(this.buf, s.toString(), s);
        //printf("Dsymbol.mangle() %s = %s\n", s.toChars(), id);
    }

    ////////////////////////////////////////////////////////////////////////////
    // package.d:948 — `override void visit(Expression e)`. Any expression kind without its own
    // override cannot be a template value argument.
    override visitExpression(e: Expression): void {
        if (!e.type!.isTypeError())
            error(e.loc, ds("expression `%s` is not a valid template value argument"), e.toChars());
    }

    // package.d:954 — `override void visit(IntegerExp e)`.
    override visitIntegerExp(e: IntegerExp): void {
        this.mangleInteger(toInteger(e)); // UFCS `e.toInteger()` → expressionsem.d:192
    }

    // package.d:959 — `override void visit(RealExp e)`.
    override visitRealExp(e: RealExp): void {
        this.buf.writeByte(/* 'e' */ 0x65);
        realToMangleBuffer(this.buf, e.value);
    }

    // package.d:965 — `override void visit(ComplexExp e)`.
    override visitComplexExp(e: ComplexExp): void {
        this.buf.writeByte(/* 'c' */ 0x63);
        realToMangleBuffer(this.buf, toReal(e)); // UFCS `e.toReal()` → expressionsem.d:150
        this.buf.writeByte(/* 'c' */ 0x63); // separate the two
        realToMangleBuffer(this.buf, toImaginary(e)); // UFCS `e.toImaginary()` → expressionsem.d:137
    }

    // package.d:973 — `override void visit(NullExp e)`.
    override visitNullExp(_e: NullExp): void {
        this.buf.writeByte(/* 'n' */ 0x6e);
    }

    // package.d:978 — `override void visit(StringExp e)`. `a`/`w`/`d` + UTF-8 byte count + `_` + the
    // UTF-8 bytes in lower-case hex; a string that is not valid UTF (or an 8-byte-element hex string)
    // is mangled as an array literal of its code units.
    override visitStringExp(e: StringExp): void {
        let m: number;
        const tmp = new OutBuffer();
        let q: DString;

        // package.d:984 — nested `void mangleAsArray()`.
        const mangleAsArray = (): void => {
            this.buf.writeByte(/* 'A' */ 0x41);
            this.buf.print(BigInt(e.len)); // `buf.print(e.len)` — size_t in the ulong (bigint) domain
            for (let i = 0; i < e.len; i++)
                this.mangleInteger(e.getIndex(i));
        };

        /* Write string in UTF-8 format
         */
        switch (e.sz) {
            case 1:
                m = /* 'a' */ 0x61;
                q = e.peekString();
                break;
            case 2: {
                m = /* 'w' */ 0x77;
                const slice = e.peekWstring();
                for (let u = 0; u < e.len;) {
                    // `utf_decodeWchar(slice, u, c)`: the `ref u` cursor and `out c` come back in the result.
                    const r = utf_decodeWchar(slice, u);
                    u = r.nextIdx;
                    if (r.error !== null)
                        return mangleAsArray();
                    else
                        tmp.writeUTF8(r.dchar);
                }
                q = tmp.peekSlice(); // `tmp[]`
                break;
            }
            case 4: {
                m = /* 'd' */ 0x64;
                const slice = e.peekDstring();
                for (const c of slice) {
                    if (!utf_isValidDchar(c))
                        return mangleAsArray();
                    else
                        tmp.writeUTF8(c);
                }
                q = tmp.peekSlice(); // `tmp[]`
                break;
            }
            case 8:
                // String of size 8 has to be hexstring cast to long[], mangle as array literal
                return mangleAsArray();
            default:
                return assertUnreachable(); // assert(0)
        }
        this.buf.reserve(1 + 11 + 2 * q.length);
        this.buf.writeByte(m);
        this.buf.print(BigInt(q.length));
        this.buf.writeByte(/* '_' */ 0x5f); // nbytes <= 11
        this.buf.writeHexString(q, false);
    }

    // package.d:1042 — `override void visit(ArrayLiteralExp e)`.
    override visitArrayLiteralExp(e: ArrayLiteralExp): void {
        const dim = e.elements ? e.elements.length : 0;
        this.buf.writeByte(/* 'A' */ 0x41);
        this.buf.print(BigInt(dim));
        for (let i = 0; i < dim; i++) {
            e.opIndex(i)!.accept(this); // `e[i]` → ArrayLiteralExp.opIndex (05 §7)
        }
    }

    // package.d:1053 — `override void visit(AssocArrayLiteralExp e)`.
    override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
        const dim = e.keys!.length;
        this.buf.writeByte(/* 'A' */ 0x41);
        this.buf.print(BigInt(dim));
        for (let i = 0; i < dim; i++) {
            e.keys!.opIndex(i)!.accept(this);
            e.values!.opIndex(i)!.accept(this);
        }
    }

    // package.d:1065 — `override void visit(StructLiteralExp e)`.
    override visitStructLiteralExp(e: StructLiteralExp): void {
        const dim = e.elements ? e.elements.length : 0;
        this.buf.writeByte(/* 'S' */ 0x53);
        this.buf.print(BigInt(dim));
        for (let i = 0; i < dim; i++) {
            const ex = e.elements!.opIndex(i);
            if (ex)
                ex.accept(this);
            else
                this.buf.writeByte(/* 'v' */ 0x76); // 'v' for void
        }
    }

    // package.d:1080 — `override void visit(FuncExp e)`.
    override visitFuncExp(e: FuncExp): void {
        this.buf.writeByte(/* 'f' */ 0x66);
        if (e.td)
            this.mangleSymbol(e.td);
        else
            this.mangleSymbol(e.fd!);
    }
}

/*****
 * Back-reference state (package.d:1093). The encoded mangling is `'Q' <relative position>`.
 *
 * D's `Backref` is a `struct` but is only ever passed by `ref`/pointer through the mangler — never
 * copied by value — so it is ported as a class (reference, 03 §7); there is no `.copy()`.
 */
export class Backref {
    // package.d:1168 — `Type rootType;` (avoid infinite recursion).
    rootType: Type | null;
    // package.d:1169 — `AssocArray!(Type, size_t) types;` Type => (offset+1) in buf.
    private types = new Map<Type, number>();
    // package.d:1170 — `AssocArray!(Identifier, size_t) idents;` Identifier => (offset+1) in buf.
    private idents = new Map<Identifier, number>();

    constructor(rootType: Type | null) {
        this.rootType = rootType;
    }

    /**
     * Back-reference a non-basic type (package.d:1108).
     * Returns true if the type was found (a back reference has been encoded); false otherwise (the
     * current position is saved for later back references).
     */
    addRefToType(buf: OutBuffer, t: Type): boolean {
        if (t.isTypeBasic())
            return false;

        // https://issues.dlang.org/show_bug.cgi?id=21591 — for an unmerged TypeFunction, use the
        // generic merged function type as the backref cache key to avoid missed backrefs. Skip when
        // `t` IS the root type passed to mangleToBuffer (avoids infinite recursion through merge).
        if (t !== this.rootType) {
            if (t.isFunction_Delegate_PtrToFunction()) {
                // package.d:1127 — D's function-local `import dmd.typesem : merge2;`, hoisted to the
                // last top-level import (01 §4.4: mangle is already inside the typesem cycle).
                t = merge2(t);
            }
        }

        return backrefImpl(buf, this.types, t);
    }

    /**
     * Back-reference a single identifier (package.d:1148).
     * Returns true if the identifier was found; false otherwise (position saved).
     */
    addRefToIdentifier(buf: OutBuffer, id: Identifier): boolean {
        return backrefImpl(buf, this.idents, id);
    }
}

/**
 * package.d:1155 — `bool backrefImpl(T)(ref OutBuffer buf, ref AssocArray!(T, size_t) aa, T key)`.
 *
 * D's `getLvalue` returns the slot address and callers write through it; here the get/set pair
 * replaces the slot pointer (aav contract, 08 §6). A stored value is always `buf.length+1 >= 1`, so
 * an absent key (`undefined` from the Map) is indistinguishable from D's freshly-`getLvalue`d 0 slot
 * — both take the "not found" branch. Monomorphized over the two key kinds (Type / Identifier).
 */
function backrefImpl<T>(buf: OutBuffer, aa: Map<T, number>, key: T): boolean {
    const existing = aa.get(key);
    if (existing) {
        // `if (*p)` — present and non-zero.
        const offset = existing - 1;
        writeBackRef(buf, buf.length() - offset);
        return true;
    }
    aa.set(key, buf.length() + 1);
    return false;
}

/*********************************
 * Mangling for mod (package.d:1176).
 */
function MODtoDecoBuffer(buf: OutBuffer, mod: MOD): void {
    switch (mod) {
        case 0:
            break;
        case MODFlags.const_:
            buf.writeByte(/* 'x' */ 0x78);
            break;
        case MODFlags.immutable_:
            buf.writeByte(/* 'y' */ 0x79);
            break;
        case MODFlags.shared_:
            buf.writeByte(/* 'O' */ 0x4f);
            break;
        case MODFlags.shared_ | MODFlags.const_:
            buf.writestring(ds("Ox"));
            break;
        case MODFlags.wild:
            buf.writestring(ds("Ng"));
            break;
        case MODFlags.wildconst:
            buf.writestring(ds("Ngx"));
            break;
        case MODFlags.shared_ | MODFlags.wild:
            buf.writestring(ds("ONg"));
            break;
        case MODFlags.shared_ | MODFlags.wildconst:
            buf.writestring(ds("ONgx"));
            break;
        default:
            assertUnreachable(); // assert(0)
            break;
    }
}

/**
 * Write a back reference with the relative position encoded base-26 (package.d:1225): upper-case
 * letters for all digits but the last, which uses a lower-case letter. The decoder looks up the
 * referenced position to tell an identifier (starts with a digit) from a type (starts with a
 * letter). Verified base-26 output against ldc2 (/tmp/probe_mangle.d).
 *
 * Params:
 *   buf = buffer to write to
 *   pos = relative position to encode
 */
function writeBackRef(buf: OutBuffer, pos: number): void {
    buf.writeByte(/* 'Q' */ 0x51);
    const base = 26;
    let mul = 1;
    while (pos >= mul * base)
        mul *= base;
    while (mul >= base) {
        const dig = Math.trunc(pos / mul) & 0xff; // cast(ubyte)(pos / mul)
        buf.writeByte((/* 'A' */ 0x41 + dig) & 0xff);
        pos -= dig * mul;
        mul = Math.trunc(mul / base);
    }
    buf.writeByte((/* 'a' */ 0x61 + pos) & 0xff);
}

/*****
 * dmd/mangle/package.d:1247 — `void toBuffer(ref OutBuffer buf, const(char)[] id, Dsymbol s)`. Write a
 * length-prefixed identifier (`<len><id>`); a result past 8 MiB is reported as a probable recursive
 * expansion and nothing is written.
 */
function toBuffer(buf: OutBuffer, id: DString, s: Dsymbol): void {
    const len = id.length;
    if (buf.length() + len >= 8 * 1024 * 1024) // 8 megs ought be enough for anyone
        error(s.loc, ds("%s `%s` excessive length %llu for symbol, possible recursive expansion?"), s.kind(),
            s.toPrettyChars(), BigInt(buf.length() + len));
    else {
        buf.print(BigInt(len)); // `buf.print(len)` — length in the uinteger_t (bigint) domain
        buf.writestring(id);
    }
}

/*****
 * dmd/mangle/package.d:1272 — `void writeLocalParent(ref OutBuffer buf, uint localNum)`. Append a fake
 * `__Sddd` parent so two same-named locals in one function get distinct mangles (issue 20565); called
 * from `Mangler.mangleParent` when `localNum` is non-zero.
 */
function writeLocalParent(buf: OutBuffer, localNum: number): void {
    let ndigits = 1;
    let n = localNum;
    while (n >= 10) {
        n = Math.floor(n / 10);
        ++ndigits;
    }
    // `buf.printf("%u__S%u", ndigits + 3, localNum)` — `<ndigits+3>__S<localNum>`.
    buf.writestring(ds(`${ndigits + 3}__S${localNum}`));
}

/*************************
 * dmd/mangle/package.d:1291 — `void realToMangleBuffer(ref OutBuffer buf, real_t value)`. Write real to
 * buffer.
 * Params:
 *      buf = buffer to write to
 *      value = real to write
 */
function realToMangleBuffer(buf: OutBuffer, value: real_t): void {
    /* Rely on %A to get portable mangling.
     * Must munge result to get only identifier characters.
     *
     * Possible values from %A  => mangled result
     * NAN                      => NAN
     * -INF                     => NINF
     * INF                      => INF
     * -0X1.1BC18BA997B95P+79   => N11BC18BA997B95P79
     * 0X1.9P+2                 => 19P2
     */
    if (CTFloat.isNaN(value)) {
        buf.writestring(ds("NAN")); // no -NAN bugs
        return;
    }

    if (value < CTFloat.zero) {
        buf.writeByte(/* 'N' */ 0x4e);
        value = -value;
    }

    if (CTFloat.isInfinity(value)) {
        buf.writestring(ds("INF"));
        return;
    }

    // `char[36] buffer = void; const n = CTFloat.sprint(buffer.ptr, buffer.length, 'A', value);` — the
    // port's `sprint` returns the formatted bytes (root/ctfloat.ts), so `n` is their length.
    // 'A' format yields [-]0xh.hhhhp+-d
    const buffer: DString = CTFloat.sprint("A", value);
    const n = buffer.length;
    assert(n < 36); // assert(n < buffer.length)
    for (const c of buffer.subarray(2, n)) {
        switch (c) {
            case /* '-' */ 0x2d:
                buf.writeByte(/* 'N' */ 0x4e);
                break;

            case /* '+' */ 0x2b:
            case /* '.' */ 0x2e:
                break;

            default:
                buf.writeByte(c);
                break;
        }
    }
}

/************************************************************
 * dmd/mangle/package.d:1361 — `extern (D) const(char)[] externallyMangledIdentifier(Declaration d)`.
 *
 * Try to obtain an externally mangled identifier from a declaration.
 * If the declaration is at global scope or mixed in at global scope,
 * the user might want to call it externally, so an externally mangled
 * name is returned. Member functions or nested functions can't be called
 * externally in C, so in that case null is returned. C++ does support
 * namespaces, so extern(C++) always gives a C++ mangled name.
 *
 * See also: https://issues.dlang.org/show_bug.cgi?id=20012
 *
 * Params:
 *     d = declaration to mangle
 *
 * Returns:
 *     an externally mangled name or null if the declaration cannot be called externally
 */
function externallyMangledIdentifier(d: Declaration): DString | null {
    assert(!d.mangleOverride, "mangle overrides should have been handled earlier");

    const linkage = d.resolvedLinkage();
    const par = d.toParent(); //toParent() skips over mixin templates
    if (!par || par.isModule() || linkage === LINK.cpp ||
        (linkage === LINK.c && d.isCsymbol() &&
         // https://github.com/dlang/dmd/issues/21241
         // Static check is so C static functions get a unique mangle so the linker
         // won't merge them if compiling all-at-once.
         // Non-static functions can use their ident as their mangle.
         ((d.isFuncDeclaration() && !d.isStatic()) ||
          (d.isVarDeclaration() && d.isDataseg() && (d.storage_class & STC.extern_) !== 0n)))) {
        if (linkage !== LINK.d && d.localNum)
            error(d.loc, ds("%s `%s` the same declaration cannot be in multiple scopes with non-D linkage"), d.kind(),
                d.toPrettyChars());

        // D `final switch (linkage)`: exhaustive over LINK (06 §3.2).
        switch (linkage) {
            case LINK.d:
                break;
            case LINK.c:
            case LINK.windows:
            case LINK.objc:
                return d.ident!.toString();
            case LINK.cpp: {
                const p = target.cpp.toMangle(d);
                return cstr(p); // mangle/package.d:1390 `p.toDString()`: the bytes before the NUL
            }
            case LINK.default_:
                error(d.loc, ds("%s `%s` forward declaration"), d.kind(), d.toPrettyChars());
                return d.ident!.toString();
            case LINK.system:
                return assertUnreachable(); // assert(0)
            default:
                return assertUnreachable(); // final switch exhaustiveness
        }
    }
    return null;
}

// dtemplate.ts cannot value-import this module (load cycle; see its registration note): hand the
// TemplateInstance overload over (dmd/dtemplate.d:1048 is its caller).
registerMangleToBufferTemplateInstance(mangleToBufferTemplateInstance);
