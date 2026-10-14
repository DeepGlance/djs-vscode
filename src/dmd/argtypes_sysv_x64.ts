// Ported from dmd/argtypes_sysv_x64.d (module dmd.argtypes_sysv_x64), as LDC 1.43.0 builds it.
//
// Breaks a D type down into basic (register) types for the x86_64 System V ABI. The frontend reads the answer
// through `Target.toArgTypes` (gen/target.cpp:339-340) when the target triple is x86_64 Linux (10 §4.8), which
// feeds `__argTypes` (expressionsem.d:9147), `StructDeclaration.argTypes` (dsymbolsem.d:10290) and, through
// `TargetABI::getArgTypes` (gen/abi/abi.cpp:78), `Target.isReturnOnStack` and `Target.preferPassByRef`
// (gen/abi/x86-64.cpp:203-217).
//
// NUMERIC DOMAIN (09 §1.1/§1.3.1). `toArgTypes_sysv_x64` keeps the type size in the `bigint` domain of
// `typesem.size()` until it has checked `size > 32`; past that check every size, offset and eightbyte index is at
// most 32 and is a `number`. Field offsets and alignments are D `uint`s (`number` in the port already).
//
// IMPORTS. D's `import core.stdc.stdio;` serves only the `debug printf` at argtypes_sysv_x64.d:100 (a `debug`
// block, OFF: _config.md §3) and has no TS counterpart (01 §3.7). `import dmd.declaration;` and
// `import dmd.target;` are read through the types' own fields (`sym.fields`, `target.isLP64`); the
// function-local `import dmd.typesem : sarrayOf;` (:71) hoists into the module-level typesem import (01 §4.4).
// AST-node modules FIRST, the *sem modules after them (01 §4.8).
//
// VISITOR (13 §1). `ToClassesVisitor`'s `visit` overloads become the named methods of the canonical `Visitor`;
// `visit(TypeNoreturn)` calls `visit(Type.tvoid)`, whose static type is `Type`, so D resolves it to
// `visit(Type)` (the "Unexpected type" halt), and so does the port (`visitType`). No caller reaches it: a
// `noreturn` has size 0 (null answer) and a `noreturn` field is skipped.

import { TY } from "./astenums.js";
import { Type, TypeTuple, TypeVector } from "./mtype.js";
import type {
    TypeAArray, TypeBasic, TypeClass, TypeDArray, TypeDelegate, TypeEnum, TypeNoreturn, TypeNull, TypePointer,
    TypeSArray, TypeStruct,
} from "./mtype.js";
import { Visitor } from "./visitor/index.js";
import { alignsize, sarrayOf, size, toBasetype } from "./typesem.js";
import { isPOD } from "./dsymbolsem.js";
import { toInteger } from "./expressionsem.js";
import { target } from "./target.js";
import { assert, assertUnreachable } from "../assert.js";
import { maskUnsignedN } from "../numeric.js";

/**
 * dmd/argtypes_sysv_x64.d:36 — `TypeTuple toArgTypes_sysv_x64(Type t)`.
 *
 * This breaks a type down into 'simpler' types that can be passed to a function
 * in registers, and returned in registers.
 * This is the implementation for the x86_64 System V ABI (not used for Win64),
 * based on https://www.uclibc.org/docs/psABI-x86_64.pdf.
 *
 * Returns: a tuple of types, each element can be passed in a register; a tuple of zero length
 * (`TypeTuple.empty`, shared) means the type cannot be passed/returned in registers; null indicates a `void`
 * (any zero-sized type). `Type.terror` yields a tuple of itself.
 *
 * Precondition: `t` has had semantic (its size is final). Cost: one `size()` query plus, for an aggregate of at
 * most 32 bytes, a recursive walk of its fields; it may build one vector type.
 */
export function toArgTypes_sysv_x64(t: Type): TypeTuple | null {
    if (t === Type.terror)
        return TypeTuple.fromType(t);

    // ported: D's local `size` -> `size_` (01 §2.3: it would shadow typesem's `size`)
    const size_ = size(t);   // `cast(size_t)` of a `ulong`: the identity on a 64-bit target
    if (size_ === 0n)
        return null;
    if (size_ > 32n)
        return TypeTuple.empty;
    const sz = Number(size_);   // at most 32 here

    const classification = classify(t, sz);
    const classes = classification.slice();
    const N = classes.length;
    const c0 = classes[0]!;

    switch (c0) {
    case Class.memory:
        return TypeTuple.empty;
    case Class.x87:
        return TypeTuple.fromType(Type.tfloat80);
    case Class.complexX87:
        return TypeTuple.fromTypes(Type.tfloat80, Type.tfloat80);
    default:
        break;
    }

    if (N > 2 || (N === 2 && classes[1] === Class.sseUp)) {
        assert(c0 === Class.sse);
        for (const c of classes.slice(1))
            assert(c === Class.sseUp);

        assert(sz % 8 === 0);
        return TypeTuple.fromType(new TypeVector(sarrayOf(Type.tfloat64, BigInt(N))));
    }

    assert(N >= 1 && N <= 2);
    const argtypes: (Type | null)[] = [null, null];
    for (let i = 0; i < N; i++) {
        const c = classes[i]!;
        // the last eightbyte may be filled partially only
        let sizeInEightbyte = (i < N - 1) ? 8 : sz % 8;
        if (sizeInEightbyte === 0)
            sizeInEightbyte = 8;

        if (c === Class.integer) {
            argtypes[i] =
                sizeInEightbyte > 4 ? Type.tint64 :
                sizeInEightbyte > 2 ? Type.tint32 :
                sizeInEightbyte > 1 ? Type.tint16 :
                                      Type.tint8;
        } else if (c === Class.sse) {
            argtypes[i] =
                sizeInEightbyte > 4 ? Type.tfloat64 :
                                      Type.tfloat32;
        } else {
            // dropped: `debug printf("class: %d\n", c);` (argtypes_sysv_x64.d:100, a `debug` block: OFF)
            assertUnreachable("Unexpected class");
        }
    }

    return N === 1
        ? TypeTuple.fromType(argtypes[0]!)
        : TypeTuple.fromTypes(argtypes[0]!, argtypes[1]!);
}

// classification per eightbyte (64-bit chunk) — dmd/argtypes_sysv_x64.d:114 `enum Class : ubyte` (private)
const enum Class {
    integer,
    sse,
    sseUp,
    x87,
    x87Up,
    complexX87,
    noClass,
    memory,
}

/// dmd/argtypes_sysv_x64.d:126 — `Class merge(Class a, Class b) @safe` (private).
function merge(a: Class, b: Class): Class {
    const any = (value: Class): boolean => a === value || b === value;

    if (a === b)
        return a;
    if (a === Class.noClass)
        return b;
    if (b === Class.noClass)
        return a;
    if (any(Class.memory))
        return Class.memory;
    if (any(Class.integer))
        return Class.integer;
    if (any(Class.x87) || any(Class.x87Up) || any(Class.complexX87))
        return Class.memory;
    return Class.sse;
}

/**
 * dmd/argtypes_sysv_x64.d:145 — `struct Classification` (private): the classes of the first `numEightbytes`
 * eightbytes. Built once by `classify` and only read; never copied after construction.
 */
class Classification {
    constructor(readonly classes: readonly Class[], readonly numEightbytes: number) {}

    /// dmd/argtypes_sysv_x64.d:150 — `const(Class[]) slice() const return @safe`.
    slice(): readonly Class[] {
        return this.classes.slice(0, this.numEightbytes);
    }
}

/// dmd/argtypes_sysv_x64.d:153 — `Classification classify(Type t, size_t size)` (private).
function classify(t: Type, size_: number): Classification {
    const v = new ToClassesVisitor(size_);
    t.accept(v);
    return new Classification(v.result.slice(), v.numEightbytes);
}

/** The `out uint offset, out uint typeAlignment` pair of `classifyFields`'s field getter (03 §3.3). */
interface FieldInfo {
    offset: number;
    typeAlignment: number;
}

/**
 * dmd/argtypes_sysv_x64.d:160 — `extern (C++) final class ToClassesVisitor : Visitor` (private). Classifies
 * each eightbyte of a type of `size` bytes into `result[0 .. numEightbytes]`.
 */
class ToClassesVisitor extends Visitor {
    readonly size: number;
    numEightbytes: number;
    result: Class[] = [Class.noClass, Class.noClass, Class.noClass, Class.noClass];

    constructor(size_: number) {
        super();
        assert(size_ > 0);
        this.size = size_;
        this.numEightbytes = Math.trunc((size_ + 7) / 8);
    }

    memory(): void {
        this.result.fill(Class.memory, 0, this.numEightbytes);
    }

    one(a: Class): void {
        this.result[0] = a;
    }

    two(a: Class, b: Class): void {
        this.result[0] = a;
        this.result[1] = b;
    }

    // dropped: `alias visit = Visitor.visit;` (argtypes_sysv_x64.d:189) — the named methods of 13 §1 need no
    // overload-set merge.

    override visitType(_t: Type): void {
        assertUnreachable("Unexpected type");
    }

    override visitTypeEnum(t: TypeEnum): void {
        toBasetype(t).accept(this);
    }

    override visitTypeNoreturn(_t: TypeNoreturn): void {
        // Treat as void
        return this.visitType(Type.tvoid);
    }

    override visitTypeBasic(t: TypeBasic): void {
        switch (t.ty) {
        case TY.Tvoid:
        case TY.Tbool:
        case TY.Tint8:
        case TY.Tuns8:
        case TY.Tint16:
        case TY.Tuns16:
        case TY.Tint32:
        case TY.Tuns32:
        case TY.Tint64:
        case TY.Tuns64:
        case TY.Tchar:
        case TY.Twchar:
        case TY.Tdchar:
            return this.one(Class.integer);

        case TY.Tint128:
        case TY.Tuns128:
            return this.two(Class.integer, Class.integer);

        case TY.Tfloat80:
        case TY.Timaginary80:
            return this.two(Class.x87, Class.x87Up);

        case TY.Tfloat32:
        case TY.Tfloat64:
        case TY.Timaginary32:
        case TY.Timaginary64:
        case TY.Tcomplex32: // struct { float a, b; }
            return this.one(Class.sse);

        case TY.Tcomplex64: // struct { double a, b; }
            return this.two(Class.sse, Class.sse);

        case TY.Tcomplex80: // struct { real a, b; }
            this.result.fill(Class.complexX87, 0, 4);
            return;

        default:
            assertUnreachable("Unexpected basic type");
        }
    }

    override visitTypeVector(_t: TypeVector): void {
        this.result[0] = Class.sse;
        this.result.fill(Class.sseUp, 1, this.numEightbytes);
    }

    override visitTypeAArray(_t: TypeAArray): void {
        return this.one(Class.integer);
    }

    override visitTypePointer(_t: TypePointer): void {
        return this.one(Class.integer);
    }

    override visitTypeNull(_t: TypeNull): void {
        return this.one(Class.integer);
    }

    override visitTypeClass(_t: TypeClass): void {
        return this.one(Class.integer);
    }

    override visitTypeDArray(_t: TypeDArray): void {
        if (!target.isLP64)
            return this.one(Class.integer);
        return this.two(Class.integer, Class.integer);
    }

    override visitTypeDelegate(_t: TypeDelegate): void {
        if (!target.isLP64)
            return this.one(Class.integer);
        return this.two(Class.integer, Class.integer);
    }

    override visitTypeSArray(t: TypeSArray): void {
        // treat as struct with N fields

        const baseElemType = toBasetype(t.next!).isTypeStruct();
        if (baseElemType !== null && !isPOD(baseElemType.sym!))
            return this.memory();

        this.classifyStaticArrayElements(0, t);
        this.finalizeAggregate();
    }

    override visitTypeStruct(t: TypeStruct): void {
        if (!isPOD(t.sym!))
            return this.memory();

        this.classifyStructFields(0, t);
        this.finalizeAggregate();
    }

    classifyStructFields(baseOffset: number, t: TypeStruct): void {
        const getNthField = (n: number, info: FieldInfo): Type => {
            const field = t.sym!.fields.opIndex(n)!;
            info.offset = field.offset;
            info.typeAlignment = alignsize(field.type!);
            return field.type!;
        };

        this.classifyFields(baseOffset, t.sym!.fields.length, getNthField);
    }

    classifyStaticArrayElements(baseOffset: number, t: TypeSArray): void {
        const elemType = t.next!;
        const elemSize = size(elemType);
        const elemTypeAlignment = alignsize(elemType);

        const getNthElement = (n: number, info: FieldInfo): Type => {
            info.offset = Number(maskUnsignedN(32, BigInt(n) * elemSize));   // `cast(uint)(n * elemSize)`
            info.typeAlignment = elemTypeAlignment;
            return elemType;
        };

        this.classifyFields(baseOffset, Number(toInteger(t.dim!)), getNthElement);
    }

    classifyFields(baseOffset: number, nfields_: number, getFieldInfo: (n: number, info: FieldInfo) => Type): void {
        // D `foreach (n; 0 .. nfields)` evaluates the bound once; the body's `nfields--` only feeds the final
        // `nfields == 0` test.
        let nfields = nfields_;
        // classify each field (recursively for aggregates) and merge all classes per eightbyte
        for (let n = 0; n < nfields_; n++) {
            const info: FieldInfo = { offset: 0, typeAlignment: 0 };   // `out` locals start at `uint.init`
            const ftype = getFieldInfo(n, info);
            const foffset_relative = info.offset;
            const ftypeAlignment = info.typeAlignment;
            const fsize = Number(size(ftype));   // at most this aggregate's size (<= 32)

            const foffset = maskU32(baseOffset + foffset_relative);
            if (foffset & maskU32(ftypeAlignment - 1)) // not aligned
                return this.memory();

            const ts = ftype.isTypeStruct();
            const tsa = ts === null ? ftype.isTypeSArray() : null;
            if (ts !== null)
                this.classifyStructFields(foffset, ts);
            else if (tsa !== null)
                this.classifyStaticArrayElements(foffset, tsa);
            else if (toBasetype(ftype).isTypeNoreturn() !== null) {
                // Ignore noreturn members with sizeof = 0
                // Potential custom alignment changes are factored in above
                nfields--;
                continue;
            } else {
                const fEightbyteStart = Math.trunc(foffset / 8);
                const fEightbyteEnd = Math.trunc((foffset + fsize + 7) / 8);
                if (ftype.ty === TY.Tcomplex32) { // may lie in 2 eightbytes
                    assert(foffset % 4 === 0);
                    for (let i = fEightbyteStart; i < fEightbyteEnd; i++)
                        this.result[i] = merge(this.result[i]!, Class.sse);
                } else {
                    assert(foffset % 8 === 0 ||
                        fEightbyteEnd - fEightbyteStart <= 1 ||
                        !target.isLP64,
                        "Field not aligned at eightbyte boundary but contributing to multiple eightbytes?"
                    );
                    const fclasses = classify(ftype, fsize).slice();
                    for (let i = 0; i < fclasses.length; i++) {
                        const existing = fEightbyteStart + i;
                        this.result[existing] = merge(this.result[existing]!, fclasses[i]!);
                    }
                }
            }
        }

        if (nfields === 0)
            return this.memory();
    }

    finalizeAggregate(): void {
        for (let i = 0; i < this.result.length; i++) {
            const c = this.result[i]!;
            if (c === Class.memory ||
                (c === Class.x87Up && !(i > 0 && this.result[i - 1] === Class.x87)))
                return this.memory();

            if (c === Class.sseUp && !(i > 0 &&
                (this.result[i - 1] === Class.sse || this.result[i - 1] === Class.sseUp)))
                this.result[i] = Class.sse;
        }

        if (this.numEightbytes > 2) {
            if (this.result[0] !== Class.sse)
                return this.memory();

            for (const c of this.result.slice(1, this.numEightbytes))
                if (c !== Class.sseUp)
                    return this.memory();
        }

        // Undocumented special case for aggregates with the 2nd eightbyte
        // consisting of padding only (`struct S { align(16) int a; }`).
        // clang only passes the first eightbyte in that case, so let's do the
        // same.
        if (this.numEightbytes === 2 && this.result[1] === Class.noClass)
            this.numEightbytes = 1;
    }
}

/** D `uint` arithmetic: the low 32 bits of a non-negative or wrapped-negative `number` (09 §2). */
function maskU32(x: number): number {
    return x >>> 0;
}
