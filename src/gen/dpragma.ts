// Ported from gen/dpragma.d (module gen.dpragma), with the bodies of gen/pragma.cpp it binds.
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES
// ---------------------------------------------------------------------------------------------
// * HOME (01 Rule 1.1). `gen/dpragma.d` is a D module (`module gen.dpragma;`) that DECLARES the
//   `LDCPragma` enum and four `extern (C++)` functions; their bodies live in LDC's C++ glue,
//   gen/pragma.cpp (and one helper in gen/inlineir.cpp). Rule 1.1 maps the dotted module name to
//   `src/gen/dpragma.ts`, and the frontend's `import gen.dpragma : …` sites (pragmasem.d:53,
//   :350, builtin.d:96, expression.d:327, expressionsem.d:544/:4626/:10379, dsymbolsem.d:9094)
//   resolve here. This differs from the `Target` precedent on purpose: there the bodiless
//   `extern (C++)` declarations are MEMBERS of `dmd.target.Target`, so their gen/target.cpp bodies
//   are homed in target.ts (11 §2.5); here the declaring module is `gen.dpragma` itself.
// * SCOPE. Only what the frontend observes is ported: pragma recognition (DtoGetPragma), the
//   argument checks and their diagnostics, and the state written on declarations
//   (`llvmInternal`, `mangleOverride`, `intrinsicName`, `isCrtCtor`/`isCrtDtor`, `priority`,
//   `Module.noModuleInfo`/`llvmForceLogging`). gen/pragma.cpp has no IR emission of its own; the
//   one C++ dependency outside it, `DtoCheckInlineIRPragma` (gen/inlineir.cpp:53), is the check
//   half of gen/inlineir.cpp and is ported below; the rest of that file is IR emission and is not.
// * TWO ENUMS. dpragma.d's binding of `LDCPragma` (dpragma.d:22) is OUT OF SYNC with the C++ enum
//   it binds (gen/pragma.h:25): the D side lacks `LLVMconvertvector` and `LLVMprofile_instr`, so
//   from the 25th member on the two numberings differ (D `LLVMextern_weak` = 24, which is C++
//   `LLVMconvertvector`; C++ `LLVMextern_weak` = 25). The C++ bodies WRITE the C++ values into
//   `llvmInternal`; the D frontend READS them against the D values. ldc2 1.43.0 shows the
//   consequence: `pragma(LDC_extern_weak) extern __gshared int x; static if (&x)` takes the true
//   branch, because the weak-symbol test at expression.d:333 compares 25 against 24 and never
//   fires. Both enums are therefore emitted with their own values: `LDCPragma` is the D binding
//   (for D readers), `LDCPragmaCpp` is the C++ enum (for the C++ bodies and the values they return
//   and store). Members 0..23 are identical in both.
// * `fatal()` (errors.ts) exits the process, throws `FatalError` under the CLI's handler, or returns under a
//   host's handler that answers true (10 §4.7); the C++ `fatal()` after each diagnostic is that call.
// * `const char *&arg1str` (DtoGetPragma's out-parameter) is a `Ref` box (03 §3.2). The buffer it
//   receives keeps C's NUL terminator; every C `strlen`/`%s` read of it goes through `cstr`
//   (02 §11), so a wide string literal ends at its first zero byte exactly as in C.

// IMPORT ORDER (01 §4.8): the AST-node module first, then the `*sem` modules.
import { type Expression, WANTvalue } from "../dmd/expression.js";
import { STC, TY } from "../dmd/astenums.js";
import { error, fatal, warning } from "../dmd/errors.js";
import { Type } from "../dmd/mtype.js";
import { optimize } from "../dmd/optimize.js";
import { expressionSemantic, toInteger } from "../dmd/expressionsem.js";
import { Id } from "../dmd/id.js";
import { assert, assertUnreachable } from "../assert.js";
import { cstr, cstrlen, ds, dsToJs, type DString } from "../dstring.js";
import { toUint64 } from "../numeric.js";

import type { PragmaDeclaration } from "../dmd/attrib.js";
import type { Dsymbol } from "../dmd/dsymbol.js";
import type { Scope } from "../dmd/dscope.js";
import type { FuncDeclaration } from "../dmd/func.js";
import type { TemplateDeclaration } from "../dmd/dtemplate.js";
import type { VarDeclaration } from "../dmd/declaration.js";
import type { Identifier } from "../dmd/identifier.js";
import type { dinteger_t } from "../dmd/globals.js";

/**
 * A C++ `T&` out-parameter the callee REASSIGNS — one mutable cell (03 §3.2/§7.2). Declared per
 * file, as elsewhere in the tree (pragmasem.ts, dcast.ts).
 */
interface Ref<T> {
    value: T;
}

/**
 * gen/dpragma.d:22 — `extern (C++) enum LDCPragma : int`, the D binding, with D's own numbering.
 * D frontend code compares `llvmInternal` against these (builtin.d:98, expression.d:333,
 * expressionsem.d:549). See the header for why it differs from `LDCPragmaCpp` from member 24 on.
 */
export enum LDCPragma {
    LLVMnone = 0,   // Not an LDC pragma.
    LLVMignore, // Pragma has already been processed in DtoGetPragma, ignore.
    LLVMintrinsic,
    LLVMglobal_crt_ctor,
    LLVMglobal_crt_dtor,
    LLVMno_typeinfo,
    LLVMalloca,
    LLVMva_start,
    LLVMva_copy,
    LLVMva_end,
    LLVMva_arg,
    LLVMinline_asm,
    LLVMinline_ir,
    LLVMfence,
    LLVMatomic_store,
    LLVMatomic_load,
    LLVMatomic_cmp_xchg,
    LLVMatomic_rmw,
    LLVMbitop_bt,
    LLVMbitop_btc,
    LLVMbitop_btr,
    LLVMbitop_bts,
    LLVMbitop_vld,
    LLVMbitop_vst,
    LLVMextern_weak,
}

/**
 * gen/pragma.h:25 — the C++ `enum LDCPragma`, with C++'s numbering: the values gen/pragma.cpp
 * returns from `DtoGetPragma` and stores into `llvmInternal`. Named with a `Cpp` suffix because
 * the D name is taken by the binding above (01 Rule 1.1, non-upstream names for invented symbols).
 */
export enum LDCPragmaCpp {
    LLVMnone = 0,   // Not an LDC pragma.
    LLVMignore, // Pragma has already been processed in DtoGetPragma, ignore.
    LLVMintrinsic,
    LLVMglobal_crt_ctor,
    LLVMglobal_crt_dtor,
    LLVMno_typeinfo,
    LLVMalloca,
    LLVMva_start,
    LLVMva_copy,
    LLVMva_end,
    LLVMva_arg,
    LLVMinline_asm,
    LLVMinline_ir,
    LLVMfence,
    LLVMatomic_store,
    LLVMatomic_load,
    LLVMatomic_cmp_xchg,
    LLVMatomic_rmw,
    LLVMbitop_bt,
    LLVMbitop_btc,
    LLVMbitop_btr,
    LLVMbitop_bts,
    LLVMbitop_vld,
    LLVMbitop_vst,
    LLVMconvertvector,
    LLVMextern_weak,
    LLVMprofile_instr,
}

// gen/pragma.cpp:27 — `namespace { … }`: the helpers below are file-local in C++, so unexported.

/// gen/pragma.cpp:28 — `bool parseStringExp(Expression *e, const char *&res)`.
function parseStringExp(e: Expression, res: Ref<DString | null>): boolean {
    e = optimize(e, WANTvalue);
    const se = e.isStringExp(); // `if (e->op != EXP::string_) return false;` + the static_cast
    if (se === null) {
        return false;
    }
    const size = (se.len + 1) * se.sz;
    const s = new Uint8Array(size); // `mem.xmalloc(size)`; writeTo fills it, the NUL terminator included
    se.writeTo(s, true);
    res.value = s;
    return true;
}

/// gen/pragma.cpp:41 — `bool parseIntExp(Expression *e, dinteger_t &res)`.
function parseIntExp(e: Expression, res: Ref<dinteger_t>): boolean {
    e = optimize(e, WANTvalue);
    const i = e.isIntegerExp();
    if (i !== null) {
        // `dinteger_t` is `ulong` in C++: a signed literal arrives sign-extended in the bigint
        // carrier, and C++ reads the same bits unsigned (09 §1.3).
        res.value = toUint64(i.getInteger());
        return true;
    }
    return false;
}

/// gen/pragma.cpp:50 — `bool parseBoolExp(Expression *e, bool &res)`.
function parseBoolExp(e: Expression, res: Ref<boolean>): boolean {
    e = optimize(e, WANTvalue);
    const i = e.isIntegerExp();
    if (i !== null) {
        if (e.type!.equals(Type.tbool)) {
            res.value = (toInteger(i) !== 0n);
            return true;
        }
    }
    return false;
}

/**
 * gen/pragma.cpp:63 — `template <typename T> int applyPragma(Dsymbol *s, predicate, action)`.
 * Applies an action to matching symbols, recursively descending into nested
 * AttribDeclarations, and returns the number of applications.
 * A match that already carries an LDC pragma is a fatal error.
 */
function applyPragma<T extends Dsymbol>(s: Dsymbol, predicate: (s: Dsymbol) => T | null,
                                        action: (t: T) => void): number {
    const matchingDecl = predicate(s);
    if (matchingDecl !== null) {
        if (matchingDecl.llvmInternal !== LDCPragmaCpp.LLVMnone) {
            error(s.loc, ds("multiple LDC specific pragmas are not allowed"));
            fatal();
        }
        action(matchingDecl);
        return 1;
    }

    const ad = s.isAttribDeclaration();
    if (ad !== null) {
        if (ad.decl !== null) {
            let count = 0;
            for (const child of ad.decl.opSlice()) {
                count += applyPragma(child!, predicate, action);
            }
            return count;
        }
    }

    return 0;
}

/// gen/pragma.cpp:88 — `int applyFunctionPragma(Dsymbol *s, std::function<void(FuncDeclaration *)> action)`.
function applyFunctionPragma(s: Dsymbol, action: (fd: FuncDeclaration) => void): number {
    return applyPragma<FuncDeclaration>(s, (s) => s.isFuncDeclaration(), action);
}

/// gen/pragma.cpp:94 — `int applyTemplatePragma(Dsymbol *s, std::function<void(TemplateDeclaration *)> action)`.
function applyTemplatePragma(s: Dsymbol, action: (td: TemplateDeclaration) => void): number {
    return applyPragma<TemplateDeclaration>(s, (s) => s.isTemplateDeclaration(), action);
}

/// gen/pragma.cpp:100 — `int applyVariablePragma(Dsymbol *s, std::function<void(VarDeclaration *)> action)`.
function applyVariablePragma(s: Dsymbol, action: (vd: VarDeclaration) => void): number {
    return applyPragma<VarDeclaration>(s, (s) => s.isVarDeclaration(), action);
}

// gen/pragma.cpp:133-138 — the `ldc.`-prefixed intrinsic table, sorted for the binary search at :146-158.
const ldcIntrinsic: readonly { name: DString; pragma: LDCPragmaCpp }[] = [
    { name: ds("bitop.bt"), pragma: LDCPragmaCpp.LLVMbitop_bt },
    { name: ds("bitop.btc"), pragma: LDCPragmaCpp.LLVMbitop_btc },
    { name: ds("bitop.btr"), pragma: LDCPragmaCpp.LLVMbitop_btr },
    { name: ds("bitop.bts"), pragma: LDCPragmaCpp.LLVMbitop_bts },
    { name: ds("bitop.vld"), pragma: LDCPragmaCpp.LLVMbitop_vld },
    { name: ds("bitop.vst"), pragma: LDCPragmaCpp.LLVMbitop_vst },
    { name: ds("convertvector"), pragma: LDCPragmaCpp.LLVMconvertvector },
];

/// `std::string::compare` over bytes: the sign of the first differing byte, else the length difference.
function compareBytes(a: DString, b: DString): number {
    const n = Math.min(a.length, b.length);
    for (let k = 0; k < n; ++k) {
        if (a[k] !== b[k])
            return a[k]! - b[k]!;
    }
    return a.length - b.length;
}

/**
 * gen/pragma.cpp:107 — `LDCPragma DtoGetPragma(Scope *sc, PragmaDeclaration *decl, const char *&arg1str)`.
 * Declared at gen/dpragma.d:50.
 *
 * Recognizes an LDC-specific pragma by `decl.ident`, checks its arguments and returns its kind,
 * or `LLVMnone` for any other pragma (the caller then tries the remaining dmd pragmas).
 *
 * Side effects: runs `expressionSemantic` on the first argument (without storing it back into
 * `decl.args`) for the pragmas that take one; writes `arg1str` for `LDC_intrinsic` and
 * `LDC_atomic_rmw` (the string literal, NUL-terminated) and for the crt constructor/destructor
 * pragmas (the decimal priority); sets `sc._module.noModuleInfo` / `llvmForceLogging` for
 * `LDC_no_moduleinfo` / `LDC_verbose` (returned as `LLVMignore`). A malformed argument list is
 * reported and is fatal, except a crt priority above 65535, which is reported and clamped.
 *
 * Returns: a C++ `LDCPragma` value (gen/pragma.h:25).
 */
export function DtoGetPragma(sc: Scope, decl: PragmaDeclaration, arg1str: Ref<DString | null>): LDCPragmaCpp {
    const ident = decl.ident;
    const args = decl.args;

    const getFirstArg = (): Expression | null => {
        return (args !== null && args.length > 0) ? expressionSemantic(args.opIndex(0)!, sc) : null;
    };

    const pragmaError = (msg: string): void => {
        error(decl.loc, ds("`pragma(%s)` %s"), decl.ident!.toChars(), ds(msg));
    };

    // pragma(LDC_intrinsic, "string") { funcdecl(s) }
    if (ident === Id.LDC_intrinsic) {
        // The `!`: `getFirstArg()` is non-null once `args->length == 1` held (C++ passes it on unchecked).
        if (args === null || args.length !== 1 || !parseStringExp(getFirstArg()!, arg1str)) {
            pragmaError("requires exactly 1 string literal parameter");
            fatal();
        }

        // Recognize LDC-specific pragmas.
        const prefix = ds("ldc.");
        const s = arg1str.value!;
        const arg1str_length = cstrlen(s);
        if (arg1str_length > prefix.length && compareBytes(s.subarray(0, prefix.length), prefix) === 0) {
            // Got ldc prefix, binary search through ldcIntrinsic.
            const name = s.subarray(prefix.length, arg1str_length);
            let i = 0, j = ldcIntrinsic.length;
            do {
                const k = Math.trunc((i + j) / 2);
                const cmp = compareBytes(name, ldcIntrinsic[k]!.name);
                if (!cmp) {
                    return ldcIntrinsic[k]!.pragma;
                }
                if (cmp < 0) {
                    j = k;
                } else {
                    i = k + 1;
                }
            } while (i !== j);
        }

        return LDCPragmaCpp.LLVMintrinsic;
    }

    // pragma(LDC_global_crt_{c,d}tor [, priority]) { funcdecl(s) }
    // pragma(crt_{con,de}structor [, priority]) { funcdecl(s) }
    if (ident === Id.LDC_global_crt_ctor || ident === Id.LDC_global_crt_dtor ||
        ident === Id.crt_constructor || ident === Id.crt_destructor) {
        const priority: Ref<dinteger_t> = { value: 0n }; // uninitialized in C++: see the `fatal()` below
        if (args !== null) {
            if (args.length !== 1 || !parseIntExp(getFirstArg()!, priority)) {
                pragmaError("requires at most 1 integer literal parameter");
                fatal();
                // pragma.cpp:174 reads `priority`, unassigned when parseIntExp failed: past a returning `fatal()`
                // LDC reads an indeterminate value (undefined behaviour), no continuation to port.
                assertUnreachable("DtoGetPragma: crt priority unassigned past fatal() (pragma.cpp:174)");
            }
            if (priority.value > 65535n) {
                pragmaError("may not have a priority greater than 65535");
                priority.value = 65535n;
            }
        } else {
            priority.value = 65535n;
        }
        // `snprintf(buf, 8, "%llu", …)` + `strdup(buf)`: at most five digits after the clamp.
        arg1str.value = ds(priority.value.toString() + "\0");
        return ident === Id.LDC_global_crt_ctor || ident === Id.crt_constructor
            ? LDCPragmaCpp.LLVMglobal_crt_ctor
            : LDCPragmaCpp.LLVMglobal_crt_dtor;
    }

    // pragma(LDC_no_typeinfo) { typedecl(s) }
    if (ident === Id.LDC_no_typeinfo) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMno_typeinfo;
    }

    // pragma(LDC_no_moduleinfo) ;
    if (ident === Id.LDC_no_moduleinfo) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        sc._module!.noModuleInfo = true;
        return LDCPragmaCpp.LLVMignore;
    }

    // pragma(LDC_alloca) { funcdecl(s) }
    if (ident === Id.LDC_alloca) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMalloca;
    }

    // pragma(LDC_va_start) { templdecl(s) }
    if (ident === Id.LDC_va_start) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMva_start;
    }

    // pragma(LDC_va_copy) { funcdecl(s) }
    if (ident === Id.LDC_va_copy) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMva_copy;
    }

    // pragma(LDC_va_end) { funcdecl(s) }
    if (ident === Id.LDC_va_end) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMva_end;
    }

    // pragma(LDC_va_arg) { templdecl(s) }
    if (ident === Id.LDC_va_arg) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMva_arg;
    }

    // pragma(LDC_fence) { funcdecl(s) }
    if (ident === Id.LDC_fence) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMfence;
    }

    // pragma(LDC_atomic_load) { templdecl(s) }
    if (ident === Id.LDC_atomic_load) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMatomic_load;
    }

    // pragma(LDC_atomic_store) { templdecl(s) }
    if (ident === Id.LDC_atomic_store) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMatomic_store;
    }

    // pragma(LDC_atomic_cmp_xchg) { templdecl(s) }
    if (ident === Id.LDC_atomic_cmp_xchg) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMatomic_cmp_xchg;
    }

    // pragma(LDC_atomic_rmw, "string") { templdecl(s) }
    if (ident === Id.LDC_atomic_rmw) {
        if (args === null || args.length !== 1 || !parseStringExp(getFirstArg()!, arg1str)) {
            pragmaError("requires exactly 1 string literal parameter");
            fatal();
        }
        return LDCPragmaCpp.LLVMatomic_rmw;
    }

    // pragma(LDC_verbose);
    if (ident === Id.LDC_verbose) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        sc._module!.llvmForceLogging = true;
        return LDCPragmaCpp.LLVMignore;
    }

    // pragma(LDC_inline_asm) { templdecl(s) }
    if (ident === Id.LDC_inline_asm) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMinline_asm;
    }

    // pragma(LDC_inline_ir) { templdecl(s) }
    if (ident === Id.LDC_inline_ir) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMinline_ir;
    }

    // pragma(LDC_extern_weak) { vardecl(s) }
    if (ident === Id.LDC_extern_weak) {
        if (args !== null && args.length > 0) {
            pragmaError("takes no parameters");
            fatal();
        }
        return LDCPragmaCpp.LLVMextern_weak;
    }

    // pragma(LDC_profile_instr, [true | false])
    if (ident === Id.LDC_profile_instr) {
        // checking of this pragma is done in DtoCheckProfileInstrPragma()
        return LDCPragmaCpp.LLVMprofile_instr;
    }

    return LDCPragmaCpp.LLVMnone;
}

/**
 * gen/inlineir.cpp:53 — `void DtoCheckInlineIRPragma(Identifier *ident, Dsymbol *s)`.
 * The declaration-shape check of `pragma(LDC_inline_ir)`: `s` must be a template with one function
 * member and three (string, type, type tuple) or five (string, string, string, type, type tuple)
 * parameters. Every violation is fatal. Declared in gen/inlineir.h, which has no D binding: only
 * DtoCheckPragma calls it.
 */
function DtoCheckInlineIRPragma(ident: Identifier, s: Dsymbol): void {
    assert(ident !== null);
    assert(s !== null);
    const td = s.isTemplateDeclaration();
    if (td !== null) {
        const member = td.onemember;
        if (member === null) {
            error(s.loc, ds("the `%s` pragma template must have exactly one member"), ident.toChars());
            fatal();
        }
        // inlineir.cpp:63 dereferences `member` unchecked: null only past a returning `fatal()` at :61, a crash in
        // LDC as here.
        const fun = member!.isFuncDeclaration();
        if (fun === null) {
            error(s.loc, ds("the `%s` pragma template's member must be a function declaration"), ident.toChars());
            fatal();
        }
        // The magic inlineIR template is one of
        // pragma(LDC_inline_ir)
        //   R inlineIR(string code, R, P...)(P);
        // pragma(LDC_inline_ir)
        //   R inlineIREx(string prefix, string code, string suffix, R, P...)(P);

        const params = td.parameters!;
        let valid_params = (params.length === 3 || params.length === 5) &&
            params.opIndex(params.length - 2)!.isTemplateTypeParameter() !== null &&
            params.opIndex(params.length - 1)!.isTemplateTupleParameter() !== null;

        if (valid_params) {
            for (let i = 0; i < (params.length - 2); ++i) {
                const p0 = params.opIndex(i)!.isTemplateValueParameter();
                valid_params = valid_params && p0 !== null && p0.valType === Type.tstring;
            }
        }

        if (!valid_params) {
            error(s.loc, ds("the `%s` pragma template must have three (string, type and type tuple) or "
                + "five (string, string, string, type and type tuple) parameters"), ident.toChars());
            fatal();
        }
    } else {
        error(s.loc, ds("the `%s` pragma is only allowed on template declarations"), ident.toChars());
        fatal();
    }
}

/**
 * gen/pragma.cpp:344 — `void DtoCheckPragma(PragmaDeclaration *decl, Dsymbol *s, LDCPragma llvm_internal,
 * const char *const arg1str)`. Declared at gen/dpragma.d:51.
 *
 * Applies the LDC pragma `llvm_internal` (as returned by `DtoGetPragma` for `decl`) to `s`, one
 * member of `decl.decl` that has already been through `dsymbolSemantic`: validates the shape of
 * the declarations it reaches (descending through nested attribute declarations) and records the
 * pragma on them (`llvmInternal`; for `LDC_intrinsic` also `mangleOverride` on a function and
 * `intrinsicName` on a template; for the crt pragmas `isCrtCtor`/`isCrtDtor` and `priority`).
 * `LLVMnone`, `LLVMignore` and `LLVMprofile_instr` do nothing. Every shape violation is fatal,
 * except the crt signature checks, which are reported and leave the flag cleared.
 */
export function DtoCheckPragma(decl: PragmaDeclaration, s: Dsymbol, llvm_internal: LDCPragmaCpp,
                               arg1str: DString | null): void {
    if (llvm_internal === LDCPragmaCpp.LLVMnone || llvm_internal === LDCPragmaCpp.LLVMignore ||
        llvm_internal === LDCPragmaCpp.LLVMprofile_instr) {
        return;
    }

    const ident = decl.ident!;

    switch (llvm_internal) {
        case LDCPragmaCpp.LLVMintrinsic: {
            let count = applyFunctionPragma(s, (fd) => {
                fd.llvmInternal = llvm_internal;
                fd.mangleOverride = cstr(arg1str!); // `{strlen(arg1str), arg1str}`
            });
            count += applyTemplatePragma(s, (td) => {
                td.llvmInternal = llvm_internal;
                td.intrinsicName = arg1str;
            });
            if (count !== 1) {
                error(s.loc, ds("the `%s` pragma doesn't affect exactly 1 function/template declaration"),
                    ident.toChars());
                fatal();
            }
            break;
        }

        case LDCPragmaCpp.LLVMglobal_crt_ctor:
        case LDCPragmaCpp.LLVMglobal_crt_dtor: {
            const count = applyFunctionPragma(s, (fd) => {
                const tf = fd.type!.isTypeFunction();
                assert(tf !== null);

                let isValid = false;
                if (tf.next!.ty !== TY.Tvoid) {
                    error(fd.loc, ds("%s `%s` must return `void` for `pragma(%s)`"),
                        fd.kind(), fd.toPrettyChars(), ident.toChars());
                } else if (tf.parameterList.length() > 0) {
                    error(fd.loc, ds("%s `%s` must not take any parameters for `pragma(%s)`"),
                        fd.kind(), fd.toPrettyChars(), ident.toChars());
                } else if (fd.isThis() !== null) {
                    error(fd.loc, ds("%s `%s` cannot be a non-static member function for `pragma(%s)`"),
                        fd.kind(), fd.toPrettyChars(), ident.toChars());
                } else {
                    isValid = true;
                }

                if (!isValid) {
                    if (llvm_internal === LDCPragmaCpp.LLVMglobal_crt_ctor) {
                        fd.isCrtCtor = false;
                    } else {
                        fd.isCrtDtor = false;
                    }
                } else {
                    if (llvm_internal === LDCPragmaCpp.LLVMglobal_crt_ctor) {
                        fd.isCrtCtor = true;
                    } else {
                        fd.isCrtDtor = true;
                    }
                    // `std::atoi(arg1str)`: arg1str is DtoGetPragma's decimal rendering of the priority.
                    fd.priority = Number.parseInt(dsToJs(cstr(arg1str!)), 10);
                }
            });
            if (count !== 1) {
                error(s.loc, ds("the `%s` pragma doesn't affect exactly 1 function declaration"), ident.toChars());
                fatal();
            }
            break;
        }

        case LDCPragmaCpp.LLVMatomic_rmw:
        case LDCPragmaCpp.LLVMconvertvector: {
            const count = applyTemplatePragma(s, (td) => {
                td.llvmInternal = llvm_internal;
                td.intrinsicName = arg1str;
            });
            if (count !== 1) {
                error(s.loc, ds("the `%s` pragma doesn't affect exactly 1 template declaration"), ident.toChars());
                fatal();
            }
            break;
        }

        case LDCPragmaCpp.LLVMva_start:
        case LDCPragmaCpp.LLVMva_arg:
        case LDCPragmaCpp.LLVMatomic_load:
        case LDCPragmaCpp.LLVMatomic_store:
        case LDCPragmaCpp.LLVMatomic_cmp_xchg: {
            const count = applyTemplatePragma(s, (td) => {
                if (td.parameters!.length !== 1) {
                    error(s.loc, ds("the `%s` pragma template must have exactly one template parameter"),
                        ident.toChars());
                    fatal();
                } else if (td.onemember === null) {
                    error(s.loc, ds("the `%s` pragma template must have exactly one member"), ident.toChars());
                    fatal();
                } else if (td.overnext !== null || td.overroot !== null) {
                    error(s.loc, ds("the `%s` pragma template must not be overloaded"), ident.toChars());
                    fatal();
                }
                td.llvmInternal = llvm_internal;
            });
            if (count !== 1) {
                error(s.loc, ds("the `%s` pragma doesn't affect exactly 1 template declaration"), ident.toChars());
                fatal();
            }
            break;
        }

        case LDCPragmaCpp.LLVMalloca:
        case LDCPragmaCpp.LLVMva_copy:
        case LDCPragmaCpp.LLVMva_end:
        case LDCPragmaCpp.LLVMfence:
        case LDCPragmaCpp.LLVMbitop_bt:
        case LDCPragmaCpp.LLVMbitop_btc:
        case LDCPragmaCpp.LLVMbitop_btr:
        case LDCPragmaCpp.LLVMbitop_bts:
        case LDCPragmaCpp.LLVMbitop_vld:
        case LDCPragmaCpp.LLVMbitop_vst: {
            const count = applyFunctionPragma(s, (fd) => {
                fd.llvmInternal = llvm_internal;
            });
            if (count !== 1) {
                error(s.loc, ds("the `%s` pragma doesn't affect exactly 1 function declaration"), ident.toChars());
                fatal();
            }
            break;
        }

        case LDCPragmaCpp.LLVMno_typeinfo:
            applyPragma<Dsymbol>(s, (s) => s, (s) => { s.llvmInternal = llvm_internal; });
            break;

        case LDCPragmaCpp.LLVMinline_asm: {
            const count = applyTemplatePragma(s, (td) => {
                if (td.parameters!.length > 1) {
                    error(s.loc, ds("the `%s` pragma template must have exactly zero or one template parameters"),
                        ident.toChars());
                    fatal();
                } else if (td.onemember === null) {
                    error(s.loc, ds("the `%s` pragma template must have exactly one member"), ident.toChars());
                    fatal();
                }
                td.llvmInternal = llvm_internal;
            });
            if (count !== 1) {
                error(s.loc, ds("the `%s` pragma doesn't affect exactly 1 template declaration"), ident.toChars());
                fatal();
            }
            break;
        }

        case LDCPragmaCpp.LLVMinline_ir: {
            DtoCheckInlineIRPragma(ident, s);
            const count = applyTemplatePragma(s, (td) => {
                if (td.onemember === null) {
                    error(s.loc, ds("the `%s` pragma template must have exactly one member"), ident.toChars());
                    fatal();
                }
                td.llvmInternal = llvm_internal;
            });
            if (count !== 1) {
                error(s.loc, ds("the `%s` pragma doesn't affect exactly 1 template declaration"), ident.toChars());
                fatal();
            }
            break;
        }

        case LDCPragmaCpp.LLVMextern_weak: {
            let count = applyVariablePragma(s, (vd) => {
                if (!vd.isDataseg() || (vd.storage_class & STC.extern_) === 0n) {
                    error(s.loc, ds("`%s` requires storage class `extern`"), ident.toChars());
                    fatal();
                }

                // It seems like the interaction between weak symbols and thread-local
                // storage is not well-defined (the address of an undefined weak TLS
                // symbol is non-zero on the ELF static TLS model on Linux x86_64).
                // Thus, just disallow this altogether.
                if (vd.isThreadlocal()) {
                    error(s.loc, ds("`%s` cannot be applied to thread-local variable `%s`"),
                        ident.toChars(), vd.toPrettyChars());
                    fatal();
                }
                vd.llvmInternal = llvm_internal;
            });
            count += applyFunctionPragma(s, (fd) => {
                if (fd.fbody !== null) {
                    error(s.loc, ds("`%s` cannot be applied to function definitions"), ident.toChars());
                    fatal();
                }
                fd.llvmInternal = llvm_internal;
            });

            if (count === 0) {
                error(s.loc, ds("the `%s` pragma doesn't affect any variable or function declarations"),
                    ident.toChars());
                fatal();
            }
            break;
        }

        default:
            warning(s.loc, ds("the LDC specific pragma `%s` is not yet implemented, ignoring"), ident.toChars());
    }
}

/**
 * gen/pragma.cpp:577 — `bool DtoIsIntrinsic(FuncDeclaration *fd)`. Declared at gen/dpragma.d:53.
 * True when `fd` is an `LDC_intrinsic` function or one of LDC's magic intrinsics
 * (`DtoIsMagicIntrinsic`). Reads `fd.llvmInternal` only; no side effects.
 */
export function DtoIsIntrinsic(fd: FuncDeclaration): boolean {
    return fd.llvmInternal === LDCPragmaCpp.LLVMintrinsic || DtoIsMagicIntrinsic(fd);
}

/**
 * gen/pragma.cpp:581 — `bool DtoIsMagicIntrinsic(FuncDeclaration *fd)`. Declared in gen/pragma.h:60
 * (no D binding). True for the pragmas LDC lowers itself instead of calling an LLVM intrinsic
 * by name: va_*, alloca, fence, atomics, bitop and convertvector.
 */
export function DtoIsMagicIntrinsic(fd: FuncDeclaration): boolean {
    // note: keep in sync with DtoLowerMagicIntrinsic()
    switch (fd.llvmInternal) {
        case LDCPragmaCpp.LLVMva_start: // doesn't map to an instruction, but handled as magic intrinsic by LDC
        case LDCPragmaCpp.LLVMva_copy: // ditto
        case LDCPragmaCpp.LLVMva_arg:
        case LDCPragmaCpp.LLVMva_end: // ditto
        case LDCPragmaCpp.LLVMalloca:
        case LDCPragmaCpp.LLVMfence:
        case LDCPragmaCpp.LLVMatomic_store:
        case LDCPragmaCpp.LLVMatomic_load:
        case LDCPragmaCpp.LLVMatomic_cmp_xchg:
        case LDCPragmaCpp.LLVMatomic_rmw:
        case LDCPragmaCpp.LLVMbitop_bt:
        case LDCPragmaCpp.LLVMbitop_btc:
        case LDCPragmaCpp.LLVMbitop_btr:
        case LDCPragmaCpp.LLVMbitop_bts:
        case LDCPragmaCpp.LLVMbitop_vld:
        case LDCPragmaCpp.LLVMbitop_vst:
        case LDCPragmaCpp.LLVMconvertvector:
            return true;

        default:
            return false;
    }
}

/**
 * gen/pragma.cpp:610 — `bool DtoCheckProfileInstrPragma(Expression *arg, bool &value)`. Declared at
 * gen/dpragma.d:52. `pragma(LDC_profile_instr, [true | false])`: stores the constant-folded `bool`
 * argument into `value`. Return false if an error occurred (the argument is not a `bool` constant);
 * the caller reports it.
 */
export function DtoCheckProfileInstrPragma(arg: Expression, value: Ref<boolean>): boolean {
    return parseBoolExp(arg, value);
}
