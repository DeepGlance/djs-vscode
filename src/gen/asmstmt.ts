// djs's own semantic step for asm statements, the hook statementsem.d declares under `version (IN_LLVM)`
// (statementsem.d:70-73, `extern(C++) Statement asmSemantic(AsmStatement s, Scope* sc)`), called from `visitAsm`
// (statementsem.d:3727). It is written for djs, not ported: LDC's body (gen/asmstmt.cpp) and its x86 parser
// (gen/asm-x86.h) are derived from GDC under the Artistic license or the GPL, and are not part of djs (LICENSE).
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES
// ---------------------------------------------------------------------------------------------
// * WHAT LDC DOES, AND WHAT DJS KEEPS. A GCC-style instruction goes to `gccAsmSemantic` (dmd/iasm/gcc.ts, a port
//   of DMD's Boost code): kept as LDC has it. A DMD-style instruction is rejected on every architecture but x86
//   (and under -noasm), with LDC's messages, which the corpus pins: kept. On x86_64 LDC then runs its x86 parser
//   over the instruction's operands. djs does not: the statement stays an opaque `InlineAsmStatement`, and the
//   module gets one warning (`warning()`: silent by default, printed under -wi and -w, never counted as an error).
// * THE SKIP. The DMD parser (parse.ts `parseAsm`) already delimits the block on tokens, nested braces and string
//   and character literals included, and splits it into one `AsmStatement` per instruction; labels inside the block
//   are declared by statementsem's `visitCompoundAsm`. The skip is at this step only: no operand is analysed.
// * WHAT THE SKIP CHANGES, djs doing no codegen. The frontend never sees the symbols an x86 instruction names: no
//   error inside an instruction is reported (unknown opcode, bad operand, an undefined name or label), a label named
//   only by an instruction is not created (so no "label is undefined" error), a nested function's local used only
//   in asm does not make its frame a closure (`-vgc`'s closure line and `@nogc`'s closure error), and a deprecated
//   or private symbol used only in asm gives no diagnostic. The `naked` pseudo-instruction is still recognised: it
//   sets `FuncDeclaration.isNaked`, which semantic3 reads (no invariant calls, the contracts error), so a naked
//   function's `-vcg-ast` and diagnostics stay ldc2's.

import { GccAsmStatement, InlineAsmStatement } from "../dmd/statement.js";
import type { AsmStatement, Statement } from "../dmd/statement.js";
import { TOK } from "../dmd/tokens.js";
import { DiagnosticReporting, global } from "../dmd/globals.js";
import { Id } from "../dmd/id.js";
import { error, errorSupplemental, fatal, warning } from "../dmd/errors.js";
import { ds, dsUtf8 } from "../dstring.js";
import { gccAsmSemantic } from "../dmd/iasm/gcc.js";
import { targetTriple } from "../dmd/target.js";

import type { Module } from "../dmd/dmodule.js";
import type { Scope } from "../dmd/dscope.js";

// WHY a WeakSet keyed on the Module and never reset: a fresh compile builds new Module objects, so it starts empty;
// a kept compile (keep.ts) keeps a module's object only when its semantic is replayed, warning included, so a live
// template instance of that module does not warn a second time, as a fresh compile would not.
const warned = new WeakSet<Module>();

/**
 * Semantic analysis of one instruction of an `asm { ... }` block.
 *
 * GCC-style (the first token is a string literal or `(`): a `GccAsmStatement` analysed by `gccAsmSemantic`.
 * DMD-style: marks `sc.func` as having inline asm and becomes an `InlineAsmStatement` carrying `s.caseSensitive`;
 * on a non-x86_64 target, and under -noasm, it is an error (LDC's text), and the compilation stops with `fatal()`
 * unless errors are gagged. On x86_64 it is kept unanalysed (see the notes above), with one ungagged warning per
 * module; a `naked` instruction marks the function naked.
 *
 * Precondition: a DMD-style statement sits inside a function (`sc.func` non-null), as the parser builds it.
 * Returns: `null` for an empty token list, else the statement (`null` if GCC-style parsing failed).
 */
export function asmSemantic(s: AsmStatement, sc: Scope): Statement | null {
    if (!s.tokens) {
        return null;
    }

    if (s.tokens.value === TOK.string_ || s.tokens.value === TOK.leftParenthesis) {
        return gccAsmSemantic(new GccAsmStatement(s.loc, s.tokens), sc);
    }

    sc.func!.hasInlineAsm = true;
    const ias = new InlineAsmStatement(s.loc, s.tokens);
    ias.caseSensitive = s.caseSensitive;

    let err = false;
    const t = targetTriple();
    if (t.arch !== "x86_64") {
        error(ias.loc, ds("DMD-style `asm { op; }` statements are not supported for the \"%s\" architecture."),
              dsUtf8(t.archName));
        errorSupplemental(ias.loc, dsUtf8("Use GDC-style `asm { \"op\" : …; }` syntax or "
                                          + "`ldc.llvmasm.__asm` instead."));
        err = true;
    }
    if (!global.params.useInlineAsm) {
        error(ias.loc, ds("the `asm` statement is not allowed when the -noasm switch is used"));
        err = true;
    }
    if (err) {
        if (!global.gag) {
            fatal();
        }
        return ias;
    }

    if (ias.tokens!.value === TOK.identifier && ias.tokens!.ident === Id.naked && ias.tokens!.next === null) {
        sc.func!.isNaked = true;
    }
    if (!global.gag && !warned.has(sc._module!)) {
        warned.add(sc._module!);
        // WHY informational under -w too: the notice is about djs, not the code; it must not fail a compile ldc2
        // passes, so it is printed as a warning and never counted as one.
        const useWarnings = global.params.useWarnings;
        if (useWarnings === DiagnosticReporting.error)
            global.params.useWarnings = DiagnosticReporting.inform;
        warning(ias.loc,
                ds("inline assembly is not checked by djs (x86 DMD-style asm parser not included, see LICENSE)"));
        global.params.useWarnings = useWarnings;
    }
    return ias;
}
