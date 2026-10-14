// Ported from dmd/iasm/gcc.d (module dmd.iasm.gcc), LDC 1.43.0 / DMD 2.113.
//
// Inline assembler for the GCC D compiler: parsing and semantic analysis of GCC-style
// (`asm { "insn" : outputs : inputs : clobbers : labels; }`) statements, and the semantic of ImportC's
// top-level `asm("...")` declarations. ldc2 runs this on every target (LDC's asmSemantic,
// gen/asmstmt.cpp:100, ported in src/gen/asmstmt.ts, routes every GCC-style statement here).
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES
// ---------------------------------------------------------------------------------------------
// * TEMPLATES OVER `Parser`. `requireToken`, `parseAssignment`, `parseConditional`, `parsePrimary`,
//   `parseAsmString`, `parseExtAsmOperands`, `parseExtAsmClobbers`, `parseExtAsmGotoLabels` and
//   `parseGccAsm` are `(Parser)(Parser p, ...)` templates called with UFCS. Every call site
//   instantiates them with ONE type, `Parser!ASTCodegen`: gccAsmSemantic's `scope p = cond ? new
//   CParser!ASTCodegen(...) : new Parser!ASTCodegen(...)` (dmd/iasm/gcc.d:47) has the common type of the
//   two arms, and CParser extends Parser; the unittest's `semanticAsm` (:591) is the same shape. So each
//   template is one function over the port's `Parser` (parse.ts), and a `CParser` (cparse.ts) passes
//   through it as a `Parser`. The ImportC dispatch is D's own runtime test on `p.Ccompile`, kept.
// * OVERLOADS (04 §1 Form B, first-parameter split). The two `gccAsmSemantic` overloads differ by the
//   receiver type. Both are called from other modules (gen/asmstmt.cpp:109 the GccAsmStatement form,
//   dsymbolsem.d:3378 the CAsmDeclaration form), so the first-declared form keeps the bare name and the
//   other is `gccAsmSemanticCAsmDeclaration`.
// * `private:` (dmd/iasm/gcc.d:153). Every declaration below it is module-private in D and stays unexported,
//   except `parseGccAsm`, which the module's own unittest calls (gcc.d:595): it is exported with a
//   `// D module-private` note (10 §1.7).
// * TOKEN COPIES. `memcpy(*ptoklist, token, Token.sizeof)` and `p.token = *toklist` are whole-struct
//   copies of a `Token`; both are `Object.assign(<target>, <source>.copy())`, the parse.ts
//   `setTokenList` form (for the memcpy at dmd/iasm/gcc.d:58 the copied `next` is overwritten at :60; for
//   `p.token = *toklist` at :70 it is the copied list the parser walks).
// * LOAD ORDER: `import dmd.cparse;` (dmd/iasm/gcc.d:27) is INVERTED (01 §4.4 registration slot). Measured with
//   the faithful value import, first at its position and then LAST: either way loadorder.test.ts goes red on
//   4 entries per loader (dmd/initsem.ts, dmd/parse.ts, dmd/target.ts, sema-harness.ts), `TypeError: Class
//   extends value undefined` at cparse.ts `class CParser extends Parser`, via parse.ts -> ... -> statementsem.ts
//   -> gen/asmstmt.ts -> iasm/gcc.ts -> cparse.ts while parse.ts is still evaluating. So this module owns the
//   slot `cparserSlot`, filled by the hoisted registrar `registerGccAsmCParser`, which cparse.ts calls from its
//   own body. ORDER CONTRACT: the slot is empty in every entry whose module graph does not contain cparse.ts,
//   and until cparse.ts makes that call; the ImportC leg of gccAsmSemantic (`sc.inCfile`) then fails loudly.
//   The D leg never reads the slot. The CParser casts below need only the type (`import type`).
//
// IMPORT ORDER (01 §4.8): the AST-node modules first, then the parsers, then the `*sem` modules.

import { ErrorExp } from "../expression.js";
import type { Expression } from "../expression.js";
import { GotoStatement } from "../statement.js";
import type { GccAsmStatement, Statement } from "../statement.js";
import type { CAsmDeclaration } from "../dsymbol.js";
import { Module } from "../dmodule.js";
import { Type } from "../mtype.js";
import { global } from "../globals.js";
import { target } from "../target.js";
import { Token, TOK } from "../tokens.js";
import { Array as DArray } from "../root/array.js";
import { Parser } from "../parse.js";
import { assert } from "../../assert.js";
import { ds, type DString } from "../../dstring.js";
import { expressionSemantic, checkValue, modifiableLvalue, semanticString } from "../expressionsem.js";
import { isAggregate, nextOf, pointerTo } from "../typesem.js";
import { implicitCastTo } from "../dcast.js";
import { resolveAliasThis } from "../dsymbolsem.js";
import { statementSemantic } from "../statementsem.js";

import type { Identifier } from "../identifier.js";
import type { Scope } from "../dscope.js";
import type { Expressions, Identifiers } from "../arraytypes.js";
import type { CParser } from "../cparse.js";

// The `dmd.cparse` edge, inverted (see LOAD ORDER above). `var` with no initializer: a provider whose body runs
// before this module's neither hits a TDZ nor has its registration reset when this body runs (01 §4.4).
var cparserSlot: typeof CParser | undefined; // cparse.d:37 `final class CParser(AST) : Parser!AST`

/**
 * Registration point for the `dmd.cparse` edge: cparse.ts hands over its `CParser` class from its own body, so
 * gccAsmSemantic can construct one for an asm statement in a C file without a load-time import of cparse.ts.
 */
export function registerGccAsmCParser(ctor: typeof CParser): void {
    cparserSlot = ctor;
}

/**
 * Parse and run semantic analysis on a GccAsmStatement (dmd/iasm/gcc.d:43).
 *
 * The statement's token list (`s.tokens`, the tokens of one asm instruction without its `;`) is copied,
 * a closing `;` at `s.loc` is appended, and the copy is parsed by a fresh `Parser` (a `CParser` when
 * `sc.inCfile`) whose diagnostics go to `global.errorSink`. Then the instruction template, the operand
 * constraints and the clobbers are folded to strings, the operands get expression semantic (outputs must
 * be modifiable lvalues), and each goto label becomes a `GotoStatement` in `s.gotos`, analysed in `sc`.
 *
 * Returns: `s`, completed, or `null` when parsing reported an error. Errors after parsing are reported
 * and `s` is still returned. `s.stc` takes `sc.stc`.
 */
export function gccAsmSemantic(s: GccAsmStatement, sc: Scope): Statement | null {
    //printf("GccAsmStatement.semantic()\n");
    const doUnittests = global.params.parsingUnittestsRequired();
    // `sc && sc.inCfile` (dmd/iasm/gcc.d:47): `sc` is never null here, the D test is kept. The CParser arm
    // reads the registration slot (LOAD ORDER above) and fails loudly when it is empty.
    let p: Parser;
    if (sc && sc.inCfile) {
        if (cparserSlot === undefined)
            throw new Error("gccAsmSemantic: registerGccAsmCParser not called (dmd/cparse.d:37)");
        p = new cparserSlot(sc._module, ds(""), false, global.errorSink!, target.c, null, global.compileEnv);
    } else {
        p = new Parser(null, sc._module, ds(""), false, global.errorSink!, global.compileEnv, doUnittests);
    }

    // Make a safe copy of the token list before parsing.
    let toklist: Token | null = null;
    // `Token **ptoklist = &toklist;` is the slot the next copy is stored into: `toklist` itself, then the
    // `next` field of the last copy, which is `last`.
    let last: Token | null = null;

    for (let token: Token | null = s.tokens; token; token = token.next) {
        const t = p.allocateToken();
        Object.assign(t, token.copy());
        if (last === null)
            toklist = t;
        else
            last.next = t;
        last = t;
        t.next = null;
    }
    // Append closing `;` location.
    const semi = p.allocateToken();
    if (last === null)
        toklist = semi;
    else
        last.next = semi;
    semi.value = TOK.semicolon;
    semi.loc = s.loc.copy();
    semi.next = null;

    // Adjust starting line number of the parser.
    Object.assign(p.token, toklist!.copy());
    p.baseLoc!.startLine = s.loc.linnum();
    p.linnum = s.loc.linnum();

    // Parse the gcc asm statement.
    const errors = global.errors;
    s = parseGccAsm(p, s);
    if (errors !== global.errors)
        return null;
    s.stc = sc.stc;

    // Fold the instruction template string.
    s.insn = semanticAsmString(sc, s.insn!, ds("asm instruction template"));

    if (s.labels && s.outputargs)
        p.eSink.error(s.loc, ds("extended asm statements with labels cannot have output constraints"));

    // Analyse all input and output operands.
    if (s.args) {
        for (let i = 0; i < s.args.length; i++) {
            const ec = s.constraints!.opIndex(i)!;
            s.constraints!.opIndexAssign(semanticAsmString(sc, ec, ds("asm operand")), i);

            let earg = s.args.opIndex(i)!;
            earg = expressionSemantic(earg, sc);
            // Check argument is a valid lvalue/rvalue.
            if (i < s.outputargs)
                earg = modifiableLvalue(earg, sc);
            else if (checkValue(earg))
                earg = ErrorExp.get();
            s.args.opIndexAssign(earg, i);
        }
    }

    // Analyse all clobbers.
    if (s.clobbers) {
        for (let i = 0; i < s.clobbers.length; i++) {
            const ec = s.clobbers.opIndex(i)!;
            s.clobbers.opIndexAssign(semanticAsmString(sc, ec, ds("asm clobber")), i);
        }
    }

    // Analyse all goto labels.
    if (s.labels) {
        for (let i = 0; i < s.labels.length; i++) {
            const ident = s.labels.opIndex(i)!;
            const gs = new GotoStatement(s.loc, ident);
            if (!s.gotos)
                s.gotos = new DArray<GotoStatement | null>();
            s.gotos.push(gs);
            statementSemantic(gs, sc);
        }
    }

    return s;
}

/**
 * Run semantic analysis on an ImportC top-level `asm("...")` declaration (dmd/iasm/gcc.d:139).
 *
 * Folds `ad.code` to a string literal and retypes it as a pointer to its element type. A declaration
 * outside a root module is appended to `Module.rootModule.members`, so it is emitted into the root
 * module. Precondition: `ad.code` folds to a string; D dereferences the `null` that `semanticString`
 * returns on failure, and the port throws there too.
 */
export function gccAsmSemanticCAsmDeclaration(ad: CAsmDeclaration, sc: Scope): void {
    // overload set: gccAsmSemantic(GccAsmStatement) | gccAsmSemantic(CAsmDeclaration) -> renamed by receiver.
    ad.code = semanticString(sc, ad.code, ds("asm definition"))!;
    ad.code.type = pointerTo(nextOf(ad.code.type!)!);

    // Asm definition always needs emitting into the root module.
    if (sc._module && sc._module.isRoot())
        return;
    const m = Module.rootModule;
    if (m)
        m.members!.push(ad);
}

/**
 * Issue error if the current token is not `value`. Otherwise, advance to next token
 * (dmd/iasm/gcc.d:166).
 * Returns: `true` if it advanced to the next token, `false` if an error was issued.
 */
function requireToken(p: Parser, value: TOK): boolean {
    if (p.token.value === value) {
        p.nextToken();
        return true;
    }

    p.eSink.error(p.token.loc, ds("found `%s` when expecting `%s`"), p.token.toChars(), Token.toCharsValue(value));
    return false;
}

/**
 * Run semantic analysis on `exp`, resolving it as a compile-time string (dmd/iasm/gcc.d:188).
 * `s` names what the string is for, in the diagnostic.
 * Returns: the string as an implicit cast to `string`, or the analysed expression (an ErrorExp after a
 * reported error) when it does not fold to a string.
 */
function semanticAsmString(sc: Scope, exp: Expression, s: DString): Expression {
    exp = expressionSemantic(exp, sc);

    // Resolve `alias this` if we were given a struct literal.
    const ad = isAggregate(exp.type!);
    if (ad) {
        if (ad.aliasthis && ad.type && !ad.type.isTypeError())
            // `null` only when gagged (dmd/dsymbolsem.d:1859 — `return gag && global.endGagging`); D passes no `gag`.
            exp = resolveAliasThis(sc, exp)!;
    }

    // Evaluate the expression as a string now or error trying.
    const se = semanticString(sc, exp, s);
    if (se)
        exp = implicitCastTo(se, sc, Type.tstring);

    return exp;
}

/**
 * Parse a D or ImportC assignment expression (dmd/iasm/gcc.d:214).
 */
function parseAssignment(p: Parser): Expression {
    // D `cast(CParser!ASTCodegen)p`: `Ccompile` is set only by the CParser constructor
    // (dmd/cparse.d:87 — `Ccompile = true;`), so the flag test proves the class, as the tag test of
    // 02 §11.5c #3 does.
    if (p.Ccompile)
        return (p as unknown as CParser).cparseAssignExp();

    return p.parseAssignExp();
}

/**
 * Parse a D or ImportC conditional expression (dmd/iasm/gcc.d:225).
 */
function parseConditional(p: Parser): Expression {
    // D `cast(CParser!ASTCodegen)p`, proved by `Ccompile` as in parseAssignment.
    if (p.Ccompile)
        return (p as unknown as CParser).cparseCondExp();

    return p.parseCondExp();
}

/**
 * Parse a D or ImportC primary expression (dmd/iasm/gcc.d:236).
 */
function parsePrimary(p: Parser): Expression {
    // D `cast(CParser!ASTCodegen)p`, proved by `Ccompile` as in parseAssignment.
    if (p.Ccompile)
        return (p as unknown as CParser).cparsePrimaryExp();

    return p.parsePrimaryExp();
}

/**
 * Parse an expression that evaluates to a string (dmd/iasm/gcc.d:255).
 * Grammar:
 *      | AsmStringExpr:
 *      |     StringLiteral
 *      |     ( ConditionalExpression )
 * Returns: the parsed string expression, or an ErrorExp after a reported error.
 */
function parseAsmString(p: Parser): Expression {
    if (p.token.value === TOK.leftParenthesis) {
        // Skip over opening `(`
        p.nextToken();
        const insn = parseConditional(p);
        if (insn.isErrorExp())
            return insn;

        // Look for closing `)`.
        if (!requireToken(p, TOK.rightParenthesis))
            return ErrorExp.get();

        return insn;
    } else if (p.token.value !== TOK.string_) {
        p.eSink.error(p.token.loc, ds("expected string literal or expression in parentheses"));
        return ErrorExp.get();
    }

    return parsePrimary(p);
}

/**
 * Parse list of extended asm input or output operands (dmd/iasm/gcc.d:295).
 * Grammar:
 *      | Operands:
 *      |     SymbolicName(opt) AsmStringExpr ( AssignExpression )
 *      |     SymbolicName(opt) AsmStringExpr ( AssignExpression ), Operands
 *      |
 *      | SymbolicName:
 *      |     [ Identifier ]
 * Appends each operand to `s.names`/`s.args`/`s.constraints` (created on the first one). After an error
 * the tokens up to `;` or end of file are skipped.
 * Returns: number of operands added to the gcc asm statement (0 after an error).
 */
function parseExtAsmOperands(p: Parser, s: GccAsmStatement): number {
    let numargs = 0;

    // BAIL tail (06 §4) of the `Lerror:` label (dmd/iasm/gcc.d:367).
    const LerrorTail = (): number => {
        while (p.token.value !== TOK.semicolon &&
               p.token.value !== TOK.endOfFile)
            p.nextToken();

        return 0;
    };

    if (p.token.value === TOK.colon ||
        p.token.value === TOK.colonColon ||
        p.token.value === TOK.semicolon ||
        p.token.value === TOK.endOfFile)
        return numargs;

    while (true) {
        let arg: Expression;
        let name: Identifier | null = null;

        if (p.token.value === TOK.leftBracket) {
            // Skip over opening `[`
            p.nextToken();
            // `as TOK` re-widens the field TS narrowed before `nextToken()` changed it (the parse.ts idiom).
            if ((p.token.value as TOK) === TOK.identifier) {
                // Store the symbolic name
                name = p.token.ident;
                p.nextToken();
            } else {
                p.eSink.error(p.token.loc, ds("identifier expected after `[`"));
                return LerrorTail(); // goto Lerror (dmd/iasm/gcc.d:323)
            }
            // Look for closing `]`
            if (!requireToken(p, TOK.rightBracket))
                return LerrorTail(); // goto Lerror (dmd/iasm/gcc.d:327)
        }

        // Look for the constraint string.
        const constraint = parseAsmString(p);
        if (constraint.isErrorExp())
            return LerrorTail(); // goto Lerror (dmd/iasm/gcc.d:333)

        // Look for the opening `(`
        if (!requireToken(p, TOK.leftParenthesis))
            return LerrorTail(); // goto Lerror (dmd/iasm/gcc.d:337)

        // Parse the assign expression
        arg = parseAssignment(p);
        if (arg.isErrorExp())
            return LerrorTail(); // goto Lerror (dmd/iasm/gcc.d:342)

        // Look for the closing `)`
        if (!requireToken(p, TOK.rightParenthesis))
            return LerrorTail(); // goto Lerror (dmd/iasm/gcc.d:346)

        // Add this operand to the list.
        if (!s.args) {
            s.names = new DArray<Identifier | null>();
            s.constraints = new DArray<Expression | null>();
            s.args = new DArray<Expression | null>();
        }
        s.names!.push(name);
        s.args.push(arg);
        s.constraints!.push(constraint);
        numargs++;

        // If the next token is not a `,`, there are no more operands.
        if (p.token.value !== TOK.comma)
            return numargs;

        // Skip over the `,` token.
        p.nextToken();
    }
}

/**
 * Parse list of extended asm clobbers (dmd/iasm/gcc.d:386).
 * Grammar:
 *      | Clobbers:
 *      |     AsmStringExpr
 *      |     AsmStringExpr , Clobbers
 * After an error the tokens up to `;` or end of file are skipped.
 * Returns: array of parsed clobber expressions; `null` when there are none, or after an error.
 */
function parseExtAsmClobbers(p: Parser): Expressions | null {
    let clobbers: Expressions | null = null;

    // BAIL tail (06 §4) of the `Lerror:` label (dmd/iasm/gcc.d:415).
    const LerrorTail = (): Expressions | null => {
        while (p.token.value !== TOK.semicolon &&
               p.token.value !== TOK.endOfFile)
            p.nextToken();

        return null;
    };

    if (p.token.value === TOK.colon ||
        p.token.value === TOK.colonColon ||
        p.token.value === TOK.semicolon ||
        p.token.value === TOK.endOfFile)
        return clobbers;

    while (true) {
        // Look for the clobbers string
        const clobber = parseAsmString(p);
        if (clobber.isErrorExp())
            return LerrorTail(); // goto Lerror (dmd/iasm/gcc.d:401)

        // Add it to the list.
        if (!clobbers)
            clobbers = new DArray<Expression | null>();
        clobbers.push(clobber);

        // If the next token is not a `,`, there are no more clobbers.
        if (p.token.value !== TOK.comma)
            return clobbers;

        // Skip over the `,` token.
        p.nextToken();
    }
}

/**
 * Parse list of extended asm goto labels (dmd/iasm/gcc.d:434).
 * Grammar:
 *      | GotoLabels:
 *      |     Identifier
 *      |     Identifier , GotoLabels
 * After an error the tokens up to `;` or end of file are skipped.
 * Returns: array of parsed goto labels, or `null` after an error.
 */
function parseExtAsmGotoLabels(p: Parser): Identifiers | null {
    let labels: Identifiers | null = null;

    // BAIL tail (06 §4) of the `Lerror:` label (dmd/iasm/gcc.d:460).
    const LerrorTail = (): Identifiers | null => {
        while (p.token.value !== TOK.semicolon &&
               p.token.value !== TOK.endOfFile)
            p.nextToken();

        return null;
    };

    while (true) {
        if (p.token.value === TOK.identifier) {
            if (!labels)
                labels = new DArray<Identifier | null>();
            labels.push(p.token.ident);

            // If the next token is not a `,`, there are no more labels.
            if (p.nextToken() !== TOK.comma)
                return labels;

            // Skip over the `,` token.
            p.nextToken();
        } else {
            p.eSink.error(p.token.loc, ds("identifier expected for goto label name, not `%s`"),
                          p.token.toChars());
            return LerrorTail(); // goto Lerror (dmd/iasm/gcc.d:457)
        }
    }
}

/**
 * Parse a gcc asm statement (dmd/iasm/gcc.d:491).
 * There are three forms of inline asm statements, basic, extended, and goto.
 * Grammar:
 *      | AsmInstruction:
 *      |     BasicAsmInstruction
 *      |     ExtAsmInstruction
 *      |     GotoAsmInstruction
 *      |
 *      | BasicAsmInstruction:
 *      |     AsmStringExpr
 *      |
 *      | ExtAsmInstruction:
 *      |     AsmStringExpr : Operands(opt) : Operands(opt) : Clobbers(opt)
 *      |
 *      | GotoAsmInstruction:
 *      |     AsmStringExpr : : Operands(opt) : Clobbers(opt) : GotoLabels(opt)
 * Fills `s.insn`, `s.outputargs`, the operand lists, `s.clobbers` and `s.labels` from the parser's
 * current token on, and requires the closing `;`. Errors go to `p.eSink`.
 * Returns: `s`, the parsed gcc asm statement.
 */
export function parseGccAsm(p: Parser, s: GccAsmStatement): GccAsmStatement {
    // D module-private (called by the D unittest, gcc.d:595; gcc.test.ts)
    s.insn = parseAsmString(p);
    if (s.insn.isErrorExp())
        return s;

    // No semicolon followed after instruction template, treat as extended asm.
    if (p.token.value === TOK.colon || p.token.value === TOK.colonColon) {
        let inputs = false;
        let clobbers = false;
        let labels = false;

        // Look for outputs.
        if (p.token.value === TOK.colon) {
            // Skip over the `:` token.
            p.nextToken();
            // Parse the output operands.
            s.outputargs = parseExtAsmOperands(p, s);
        } else if (p.token.value === TOK.colonColon)
            inputs = true;

        // Look for inputs.
        if (inputs || p.token.value === TOK.colon) {
            // Skip over the `:` or `::` token.
            p.nextToken();
            // Parse the input operands.
            parseExtAsmOperands(p, s);
        } else if (p.token.value === TOK.colonColon)
            clobbers = true;

        // Look for clobbers.
        if (clobbers || p.token.value === TOK.colon) {
            // Skip over the `:` or `::` token.
            p.nextToken();
            // Parse the clobbers.
            s.clobbers = parseExtAsmClobbers(p);
        } else if (p.token.value === TOK.colonColon)
            labels = true;

        // Look for labels.
        if (labels || p.token.value === TOK.colon) {
            // Skip over the `:` or `::` token.
            p.nextToken();
            // Parse the labels.
            s.labels = parseExtAsmGotoLabels(p);
        }
    }

    if (p.token.value === TOK.endOfFile)
        assert(global.errors !== 0);
    else
        requireToken(p, TOK.semicolon);

    return s;
}
