// Ported from dmd/lambdacomp.d (module dmd.lambdacomp).
//
// "Implements the serialization of a lambda function." Two function literals are the same when their
// serializations are equal; the string's exact bytes therefore decide `__traits(isSame)`, so every
// write below is the D write, byte for byte.
//
// Top-level D declarations, in source order: `LOG` (:41), the private `ExpType` (:46), `isSameFuncLiteral`
// (:64), the private `getSerialization` (:102) and the private `SerializeVisitor` (:113). No unittest blocks.
//
// VISITOR IDIOM (13-visitor.md): Idiom A. `SerializeVisitor : SemanticTimeTransitiveVisitor` is a real class;
// each `visit(X)` overload becomes the named slot `visitX` (§1) and `alias visit = …` (:123) is dropped.
// The `checkTemplateInstance(T)` template (:408) over `TypeStruct | TypeClass` takes the shared `sym.parent`.
//
// RESOLVED: `enum LOG = false` (:41) and its ten `static if (LOG)` printf blocks — dropped (07 §3).
// CASTS: `as unknown as Dsymbol` on `StructDeclaration`/`ClassDeclaration` is the port-wide widening of D's
// implicit upcast (the `deferred` field types differ, 02 §11.5).
// DROPPED: `mem.xfree` of the two serializations in `isSameFuncLiteral` (:75, :77) — GC-owned buffers.

import { STC, TY } from "./astenums.js";
import type { Scope } from "./dscope.js";
import type { Dsymbol } from "./dsymbol.js";
import type { FuncLiteralDeclaration } from "./func.js";
import type {
    ArrayLiteralExp, AssocArrayLiteralExp, BinExp, CallExp, ComplexExp, DeclarationExp, DefaultInitExp, DotIdExp,
    DotVarExp, DsymbolExp, ErrorExp, FuncExp, HaltExp, IdentifierExp, IntegerExp, IntervalExp, IsExp, MixinExp,
    NewAnonClassExp, NewExp, NullExp, ObjcClassReferenceExp, OverExp, RealExp, ScopeExp, StringExp, StructLiteralExp,
    SymbolExp, TemplateExp, ThisExp, TraitsExp, TupleExp, TypeExp, TypeidExp, UnaExp, VarExp, VoidInitExp,
} from "./expression.js";
import type { Parameter, TypeBasic, TypeClass, TypeStruct } from "./mtype.js";
import { OutBuffer } from "./common/outbuffer.js";
import { StringTable } from "./root/stringtable.js";
import type { Ref } from "./root/speller.js";
import { SemanticTimeTransitiveVisitor } from "./visitor/index.js";
import { EXPtoString } from "./hdrgen.js";
import { mangleToBufferDsymbol } from "./mangle/index.js";
import { getConstInitializer, toInteger } from "./expressionsem.js";
import { search, searchScope } from "./dsymbolsem.js";
import { assert } from "../assert.js";
import { ds, dsEquals, type DString } from "../dstring.js";
import { toUint64 } from "../numeric.js";

/** The type of the visited expression (lambdacomp.d:46). */
enum ExpType {
    None,
    EnumDecl,
    Arg,
}

/**
 * dmd/lambdacomp.d:64 — compares two lambda functions by their serialization.
 *
 * Returns `true` when both lambdas serialize (see `getSerialization`) and the serializations are
 * byte-equal; a lambda that cannot be serialized is never the same as anything, itself included.
 * `sc` is the scope where the lambdas are compared; it is passed through and unused, as in D.
 */
export function isSameFuncLiteral(l1: FuncLiteralDeclaration, l2: FuncLiteralDeclaration, sc: Scope): boolean {
    let result = false;
    const ser1 = getSerialization(l1, sc);
    if (ser1 !== null) {
        const ser2 = getSerialization(l2, sc);
        if (ser2 !== null) {
            if (dsEquals(ser1, ser2))
                result = true;
        }
    }
    return result;
}

/**
 * dmd/lambdacomp.d:102 — the string representation of a lambda function, computed by visiting the
 * subtree that starts at the `FuncLiteralDeclaration`.
 *
 * Limitations (D): only IntegerExps, Enums and function arguments are supported in the body. A function
 * call, a local variable or a template instance drops the serialization and the lambda is uncomparable.
 * Returns: the serialization, or null when it is empty (uncomparable).
 */
function getSerialization(fld: FuncLiteralDeclaration, _sc: Scope): DString | null {
    const serVisitor = new SerializeVisitor(fld.parent!._scope);
    fld.accept(serVisitor);
    const len = serVisitor.buf.length();
    if (len === 0)
        return null;

    return serVisitor.buf.extractSlice();
}

class SerializeVisitor extends SemanticTimeTransitiveVisitor {
    private arg_hash = new StringTable<DString>();
    private sc: Scope | null;
    private et: ExpType = ExpType.None;
    private d: Dsymbol | null = null;

    buf = new OutBuffer();

    constructor(sc: Scope | null) {
        super();
        this.sc = sc;
    }

    /**
     * Entrypoint of the SerializeVisitor (lambdacomp.d:136): `dim:` then, per named parameter, its
     * serialized type; then the returned expression. An empty buffer at the end means "uncomparable".
     */
    override visitFuncLiteralDeclaration(fld: FuncLiteralDeclaration): void {
        assert(fld.type!.ty !== TY.Terror);

        const tf = fld.type!.isTypeFunction()!;
        const dim = tf.parameterList.length();
        // Start the serialization by printing the number of arguments the lambda has.
        this.buf.printf(ds("%d:"), dim);

        this.arg_hash._init(dim + 1);
        // For each argument
        tf.parameterList.opApply((i: number, fparam: Parameter): number => {
            if (fparam.ident !== null) {
                // the variable name is introduced into a hashtable where the key is the user defined name
                // and the value is the canonical name (arg0, arg1 ...)
                const key = fparam.ident.toString();
                const value = new OutBuffer();
                value.writestring(ds("arg"));
                value.print(BigInt(i));
                this.arg_hash.insert(key, value.extractSlice());
                // and the type of the variable is serialized.
                fparam.accept(this);
            }
            return 0;
        });

        // Now the function body can be serialized.
        const rs = fld.fbody!.endsWithReturnStatement();
        if (rs !== null && rs.exp !== null) {
            rs.exp.accept(this);
        } else {
            this.buf.setsize(0);
        }
    }

    override visitDotIdExp(exp: DotIdExp): void {
        if (this.buf.length() === 0)
            return;

        // First we need to see what kind of expression e1 is. It might an enum member (enum.value) or the
        // field of an argument (argX.value) if the argument is an aggregate type. This is reported through
        // the et variable.
        exp.e1!.accept(this);
        if (this.buf.length() === 0)
            return;

        if (this.et === ExpType.EnumDecl) {
            const s = search(this.d!, exp.loc, exp.ident!);
            if (s !== null) {
                const em = s.isEnumMember();
                if (em !== null) {
                    em.value!.accept(this);
                }
                this.et = ExpType.None;
                this.d = null;
            }
        } else if (this.et === ExpType.Arg) {
            this.buf.setsize(this.buf.length() - 1);
            this.buf.writeByte(0x2e); // '.'
            this.buf.writestring(exp.ident!.toString());
            this.buf.writeByte(0x5f); // '_'
        }
    }

    checkArgument(id: DString): boolean {
        // The identifier may be an argument
        const stringtable_value = this.arg_hash.lookup(id);
        if (stringtable_value !== null) {
            // In which case we need to update the serialization accordingly
            const gen_id = stringtable_value.value;
            this.buf.write(gen_id);
            this.buf.writeByte(0x5f); // '_'
            this.et = ExpType.Arg;
            return true;
        }
        return false;
    }

    override visitIdentifierExp(exp: IdentifierExp): void {
        if (this.buf.length() === 0)
            return;

        const id = exp.ident!.toChars();

        // If it's not an argument
        if (this.checkArgument(id))
            return;

        // we must check what the identifier expression is.
        const scopesym: Ref<Dsymbol | null> = { value: null };
        const s = searchScope(this.sc!, exp.loc, exp.ident!, scopesym);

        // If it's an unknown symbol, consider the function incomparable
        if (s === null) {
            this.buf.setsize(0);
            return;
        }

        const v = s.isVarDeclaration();
        // If it's a VarDeclaration, it must be a manifest constant
        if (v !== null && (v.storage_class & STC.manifest) !== 0n) {
            getConstInitializer(v)!.accept(this);
        } else {
            const em = s.isEnumDeclaration();
            if (em !== null) {
                this.d = em;
                this.et = ExpType.EnumDecl;
            } else {
                const fd = s.isFuncDeclaration();
                if (fd !== null) {
                    this.writeMangledName(fd);
                }
                // For anything else, the function is deemed uncomparable
                else {
                    this.buf.setsize(0);
                }
            }
        }
    }

    override visitDotVarExp(exp: DotVarExp): void {
        exp.e1!.accept(this);
        if (this.buf.length() === 0)
            return;

        this.buf.setsize(this.buf.length() - 1);
        this.buf.writeByte(0x2e); // '.'
        this.buf.writestring(exp.var_.toChars());
        this.buf.writeByte(0x5f); // '_'
    }

    override visitVarExp(exp: VarExp): void {
        if (this.buf.length() === 0)
            return;

        const id = exp.var_.ident!.toChars();
        if (!this.checkArgument(id)) {
            this.buf.setsize(0);
        }
    }

    // serialize function calls
    override visitCallExp(exp: CallExp): void {
        if (this.buf.length() === 0)
            return;

        if (exp.f === null) {
            exp.e1!.accept(this);
        } else {
            this.writeMangledName(exp.f);
        }

        this.buf.writeByte(0x28); // '('
        for (const arg of exp.arguments_!.opSlice()) {
            arg!.accept(this);
        }
        this.buf.writeByte(0x29); // ')'
    }

    override visitUnaExp(exp: UnaExp): void {
        if (this.buf.length() === 0)
            return;

        this.buf.writeByte(0x28); // '('
        this.buf.writestring(EXPtoString(exp.op));
        exp.e1!.accept(this);
        if (this.buf.length() !== 0)
            this.buf.writestring(ds(")_"));
    }

    override visitIntegerExp(exp: IntegerExp): void {
        if (this.buf.length() === 0)
            return;

        this.buf.print(toUint64(toInteger(exp))); // D: dinteger_t converts to the ulong of print()
        this.buf.writeByte(0x5f); // '_'
    }

    override visitRealExp(exp: RealExp): void {
        if (this.buf.length() === 0)
            return;

        this.buf.writestring(exp.toChars());
        this.buf.writeByte(0x5f); // '_'
    }

    override visitBinExp(exp: BinExp): void {
        if (this.buf.length() === 0)
            return;

        this.buf.writeByte(0x28); // '('
        this.buf.writestring(EXPtoString(exp.op));

        exp.e1!.accept(this);
        if (this.buf.length() === 0)
            return;

        exp.e2!.accept(this);
        if (this.buf.length() === 0)
            return;

        this.buf.writeByte(0x29); // ')'
    }

    override visitTypeBasic(t: TypeBasic): void {
        this.buf.writestring(ds(t.dstring)); // the token spelling, a JS string in the port
        this.buf.writeByte(0x5f); // '_'
    }

    writeMangledName(s: Dsymbol | null): void {
        if (s !== null) {
            const mangledName = new OutBuffer();
            mangleToBufferDsymbol(s, mangledName);
            this.buf.writestring(mangledName.peekSlice());
            this.buf.writeByte(0x5f); // '_'
        } else
            this.buf.setsize(0);
    }

    /**
     * lambdacomp.d:408 — `checkTemplateInstance(T)(T t) if (is(T == TypeStruct) || is(T == TypeClass))`.
     * A struct or class that is a template instance is uncomparable: the buffer is emptied.
     */
    private checkTemplateInstance(t: TypeStruct | TypeClass): boolean {
        const sym = t.sym!;
        if (sym.parent !== null && sym.parent.isTemplateInstance() !== null) {
            this.buf.setsize(0);
            return true;
        }
        return false;
    }

    override visitTypeStruct(t: TypeStruct): void {
        if (!this.checkTemplateInstance(t))
            this.writeMangledName(t.sym as unknown as Dsymbol | null);
    }

    override visitTypeClass(t: TypeClass): void {
        if (!this.checkTemplateInstance(t))
            this.writeMangledName(t.sym as unknown as Dsymbol | null);
    }

    override visitParameter(p: Parameter): void {
        const ti = p.type!.ty === TY.Tident ? p.type!.isTypeIdentifier()! : null;
        if (ti !== null && ti.ident!.toString().length > 3 && startsWithT(ti.ident!.toChars())) {
            this.buf.writestring(ds("none_"));
        } else
            this.visitTypeHelper(p.type);
    }

    override visitStructLiteralExp(e: StructLiteralExp): void {
        const ty = e.stype !== null ? e.stype.isTypeStruct() : null;
        if (ty === null) {
            this.buf.setsize(0);
            return;
        }

        this.writeMangledName(ty.sym as unknown as Dsymbol | null);
        const dim = e.elements!.length;
        for (let i = 0; i < dim; i++) {
            const elem = e.elements!.opIndex(i);
            if (elem !== null)
                elem.accept(this);
            else
                this.buf.writestring(ds("null_"));
        }
    }

    override visitArrayLiteralExp(_e: ArrayLiteralExp): void { this.buf.setsize(0); }
    override visitAssocArrayLiteralExp(_e: AssocArrayLiteralExp): void { this.buf.setsize(0); }
    override visitMixinExp(_e: MixinExp): void { this.buf.setsize(0); }
    override visitComplexExp(_e: ComplexExp): void { this.buf.setsize(0); }
    override visitDeclarationExp(_e: DeclarationExp): void { this.buf.setsize(0); }
    override visitDefaultInitExp(_e: DefaultInitExp): void { this.buf.setsize(0); }
    override visitDsymbolExp(_e: DsymbolExp): void { this.buf.setsize(0); }
    override visitErrorExp(_e: ErrorExp): void { this.buf.setsize(0); }
    override visitFuncExp(_e: FuncExp): void { this.buf.setsize(0); }
    override visitHaltExp(_e: HaltExp): void { this.buf.setsize(0); }
    override visitIntervalExp(_e: IntervalExp): void { this.buf.setsize(0); }
    override visitIsExp(_e: IsExp): void { this.buf.setsize(0); }
    override visitNewAnonClassExp(_e: NewAnonClassExp): void { this.buf.setsize(0); }
    override visitNewExp(_e: NewExp): void { this.buf.setsize(0); }
    override visitNullExp(_e: NullExp): void { this.buf.setsize(0); }
    override visitObjcClassReferenceExp(_e: ObjcClassReferenceExp): void { this.buf.setsize(0); }
    override visitOverExp(_e: OverExp): void { this.buf.setsize(0); }
    override visitScopeExp(_e: ScopeExp): void { this.buf.setsize(0); }
    override visitStringExp(_e: StringExp): void { this.buf.setsize(0); }
    override visitSymbolExp(_e: SymbolExp): void { this.buf.setsize(0); }
    override visitTemplateExp(_e: TemplateExp): void { this.buf.setsize(0); }
    override visitThisExp(_e: ThisExp): void { this.buf.setsize(0); }
    override visitTraitsExp(_e: TraitsExp): void { this.buf.setsize(0); }
    override visitTupleExp(_e: TupleExp): void { this.buf.setsize(0); }
    override visitTypeExp(_e: TypeExp): void { this.buf.setsize(0); }
    override visitTypeidExp(_e: TypeidExp): void { this.buf.setsize(0); }
    override visitVoidInitExp(_e: VoidInitExp): void { this.buf.setsize(0); }
}

/** `strncmp(id, "__T", 3) == 0` (lambdacomp.d:441). */
function startsWithT(id: DString): boolean {
    return id.length >= 3 && id[0] === 0x5f && id[1] === 0x5f && id[2] === 0x54;
}
