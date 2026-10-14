// Ported from gen/llvmhelpers.d (module gen.llvmhelpers), with the body of gen/llvmhelpers.cpp it binds.
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES
// ---------------------------------------------------------------------------------------------
// * HOME (01 Rule 1.1), as for gen/dpragma.ts: `gen/llvmhelpers.d` is a D module declaring
//   `extern (C++)` functions whose bodies live in gen/llvmhelpers.cpp. Of its three declarations,
//   `DtoSetFuncDeclIntrinsicName` (llvmhelpers.d:20) is ported here; `isTargetWindowsMSVC` (:22) is
//   already const-folded at its only frontend reader, target.ts (target.d:36), and `isTargetWasm`
//   (:23) has no frontend reader.
// * DtoType FOLD (11 §2.5, gen/*.cpp as ground truth). `DtoOverloadedIntrinsicName` sizes the
//   template argument through `gDataLayout->getTypeSizeInBits(DtoType(T))`, an LLVM type query.
//   For the types that reach it (floating, non-complex, or integral, else it is a fatal error
//   first) the target fixes the answer: DtoType maps
//   bool to i1 (ir/irtype.cpp:103), char/wchar/dchar and the integers to iN of their size
//   (:58-78), float/double to their IEEE types, real to `target.realType` (gen/target.cpp:44
//   `getRealType`: double, fp128 or x86_fp80 by the triple, `target.realKind`), an enum to its base type
//   (gen/tollvm.cpp:167), and a vector to `<dim x DtoMemType(elem)>` (ir/irtype.cpp:181-189; DtoMemType
//   widens i1 to i8). The fold is `llvmBits` below; the ppc_fp128 special case (llvmhelpers.cpp:1256) cannot
//   occur (no supported triple is ppc64).

import { error, fatal } from "../dmd/errors.js";
import { TY } from "../dmd/astenums.js";
import { isComplex, isFloating, isIntegral, size, toBasetype } from "../dmd/typesem.js";
import { toUInteger } from "../dmd/expressionsem.js";
import { isType } from "../dmd/dtemplate.js";
import { assert, assertUnreachable } from "../assert.js";
import { cstr, ds, dsToJs, type DString } from "../dstring.js";
import { LDCPragmaCpp } from "./dpragma.js";
import { target } from "../dmd/target.js";

import type { FuncDeclaration } from "../dmd/func.js";
import type { TemplateDeclaration, TemplateInstance } from "../dmd/dtemplate.js";
import type { Type } from "../dmd/mtype.js";

/**
 * `gDataLayout->getTypeSizeInBits(DtoType(t))`, for a type that is floating (not complex) or integral, or a
 * vector of those; see the header for the mapping it folds. LLVM's size in bits of `x86_fp80` is 80, its store
 * size, not the 128 of its allocation (`real.sizeof` 16): `target.realsize - target.realpad` bytes.
 */
function llvmBits(t: Type): number {
    const bt = toBasetype(t); // stripModifiers + the Tenum arm of DtoType (gen/tollvm.cpp:167)
    if (bt.ty === TY.Tbool)
        return 1; // i1 (ir/irtype.cpp:103)
    if (bt.ty === TY.Tfloat80 || bt.ty === TY.Timaginary80)
        return (target.realsize - target.realpad) * 8;   // f64 | f128 | f80
    return Number(size(bt)) * 8;
}

/**
 * gen/llvmhelpers.cpp:1222 — `static char *DtoOverloadedIntrinsicName(TemplateInstance *ti,
 * TemplateDeclaration *td)`.
 * The intrinsic name of `td` with each `f#` / `i#` replaced by the LLVM type of the instance's one
 * template argument (`f64`, `i32`, `v4f32`). A non-numeric argument, a `#` after the wrong letter,
 * or a `#` after neither letter is a fatal error.
 */
function DtoOverloadedIntrinsicName(ti: TemplateInstance, td: TemplateDeclaration): DString {
    // dropped (codegen logging): the IF_LOG / LOG_SCOPE lines (llvmhelpers.cpp:1224-1225, :1229-1233, :1284)

    assert(td.intrinsicName !== null);

    // for now use the size in bits of the first template param in the instance
    assert(ti.tdtypes.length === 1);
    const T = isType(ti.tdtypes.opIndex(0))!; // `static_cast<Type *>(ti->tdtypes[0])`

    let prefix: string;
    if (isFloating(T) && !isComplex(T)) {
        prefix = "f";
    } else if (isIntegral(T)) {
        prefix = "i";
    } else {
        error(ti.loc, ds("%s `%s` has invalid template parameter for intrinsic: `%s`"),
            ti.kind(), ti.toPrettyChars(), T.toChars());
        fatal(); // or LLVM asserts
        // llvmhelpers.cpp:1247: past a returning `fatal()` LDC goes on with `prefix` indeterminate (undefined
        // behaviour), no continuation to port.
        return assertUnreachable("DtoOverloadedIntrinsicName: no prefix past fatal() (llvmhelpers.cpp:1247)");
    }

    let name = dsToJs(cstr(td.intrinsicName));

    // replace `{f,i}#` by `{f,i}<bitsize>` (int: `i32`) or
    // `v<vector length>{f,i}<vector element bitsize>` (float4: `v4f32`)
    let replacement: string;
    const tv = toBasetype(T).isTypeVector();
    if (tv !== null) {
        const tsa = tv.basetype.isTypeSArray()!;
        const elemBits = Math.max(llvmBits(tsa.next!), 8); // DtoMemType: i1 -> i8
        replacement = "v" + toUInteger(tsa.dim!).toString() + prefix + elemBits.toString();
    } else {
        replacement = prefix + llvmBits(T).toString();
    }

    let pos: number;
    while ((pos = name.indexOf("#")) !== -1) {
        if (pos > 0 && name[pos - 1] === prefix) {
            name = name.slice(0, pos - 1) + replacement + name.slice(pos + 1);
        } else {
            if (pos && (name[pos - 1] === "i" || name[pos - 1] === "f")) {
                // Wrong type character.
                error(ti.loc, ds("%s `%s` has invalid parameter type for intrinsic `%s`: `%s` is not a%s type"),
                    ti.kind(), ti.toPrettyChars(), ds(name), T.toChars(),
                    ds(name[pos - 1] === "i" ? "n integral" : " floating-point"));
            } else {
                // Just plain wrong. (Error in declaration, not instantiation)
                error(td.loc, ds("%s `%s` has an invalid intrinsic name: `%s`"),
                    td.kind(), td.toPrettyChars(), ds(name));
            }
            fatal(); // or LLVM asserts
            // llvmhelpers.cpp:1285: past a returning `fatal()` the loop finds the same `#` again and repeats its
            // error without end, as LDC's does: a host whose handler returns hangs here (10 §4.7).
        }
    }

    return ds(name); // `mem.xstrdup(name.c_str())`
}

/**
 * gen/llvmhelpers.cpp:1296 — `void DtoSetFuncDeclIntrinsicName(TemplateInstance *ti, TemplateDeclaration *td,
 * FuncDeclaration *fd)`. Declared at gen/llvmhelpers.d:20. For D frontend: fix up an overloaded intrinsic
 * name string.
 *
 * Called at template instantiation (templatesem.d:1275) with the instance's single member `fd`, after
 * `fd.llvmInternal` was copied from `td`. For an `LDC_intrinsic` template, sets `fd.mangleOverride` to
 * `td.intrinsicName` with its `#` placeholders resolved for the instance's type argument; any other
 * `llvmInternal` leaves `fd` unchanged.
 */
export function DtoSetFuncDeclIntrinsicName(ti: TemplateInstance, td: TemplateDeclaration, fd: FuncDeclaration): void {
    if (fd.llvmInternal === LDCPragmaCpp.LLVMintrinsic) {
        const cstr_ = DtoOverloadedIntrinsicName(ti, td);
        assert(cstr_ !== null);
        fd.mangleOverride = cstr_; // `{strlen(cstr), cstr}`: the name holds no NUL
    }
}
