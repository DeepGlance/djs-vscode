// Ported from dmd/mustuse.d (module dmd.mustuse) — LDC 1.43.0 final / DMD 2.113.
//
// WHOLE-FILE faithful structural translation. mustuse.d declares SEVEN top-level symbols, all free
// functions, emitted here in D source order: `checkMustUse` (mustuse.d:30), `checkMustUseReserved`
// (:58), `isAssignment` (:90), `isAssignmentOpId` (:109), `isIncrementOrDecrement` (:125),
// `hasMustUseAttribute` (:189), `isMustUseAttribute` (:210). There are no `version`/`debug`/
// `static if` sites, no `opXxx` declarations, no structs, no unions, no `goto`s, no excluded-module
// import edges and no `unittest{}` blocks in the D file (manifest §2-§9, all zero, verified against
// the source).
//
// VISIBILITY (01 §2.5 / 10 §1.7). D marks the last five functions `private`, which is MODULE scope:
// the file's own siblings reach them, and in the port a co-located `.test.ts` cannot. All five are
// therefore exported, each carrying the mandatory `// D module-private` marker (01 §2.5, literal
// spelling, so the looseness is greppable) on the line above its declaration. The two
// D-public entry points (`checkMustUse`, `checkMustUseReserved`) are exported under their D names so
// the wall sweep in statementsem.ts / dsymbolsem.ts / enumsem.ts / expressionsem.ts, and the
// mis-homed carry-over at funcsem.ts:4492, can import them — those files are NOT touched here.
//
// IMPORTS. mustuse.d:11 — `module dmd.mustuse;` becomes the file path (01 §1.1). The five
// whole-module imports at mustuse.d:13-17 (`dmd.dscope`, `dmd.dsymbol`, `dmd.errors`,
// `dmd.expression`, `dmd.identifier`) become the named TS imports below, listing exactly the symbols
// the file uses (01 §3.1).
//
// DROPPED IMPORT (01 §3.1): `import dmd.location;` (mustuse.d:18, repeated function-locally at
// :128) — the file names no symbol from it (`Loc` appears only as the inferred type of `e.loc` /
// `sym.loc` forwarded to `error`), so a whole-module import with zero used symbols has no TS
// translation.
//
// INHERITED THROWS — THREE callees this file calls faithfully can throw TODAY, each owned by another
// file. NONE of the three is on every path, so no function here is dead: the paths the consumers
// actually sit on are pinned green in mustuse.test.ts. They are NOT walls of this file (nothing here
// is deferred; the call sites are the faithful D text) and they carry no marker, per 11 §2.5's rule
// that a wall records a deferral of THIS file's work. All three are reported as cross-file needs:
//   1. `foreachUda` (attribsem.ts:165) carries an open §2 escalation record over
//      `arrayExpressionSemantic` (attribsem.d:70) — which expressionsem.ts:2288 now EXPORTS, so that
//      record is stale. Its throw is CONDITIONAL: attribsem.ts:173-174 returns 0 first when the
//      symbol has no `userAttribDecl`, which is the common case and is pinned green. It bites only
//      for a symbol that really carries UDAs — then `hasMustUseAttribute`, and `checkMustUse` for a
//      struct/union-typed value, cannot return.
//   2. `StringExp.peekString` (expression.ts:1212) carries an open §2 escalation record over the
//      undecided StringExp payload representation (expression.d:1206). It is reached only by the
//      overloaded-preincrement leg of `isIncrementOrDecrement` (mustuse.d:156).
//   3. `toDsymbol` (typesem.ts:8217), called unconditionally at mustuse.d:36, holds THREE §2.5 walls
//      over `getDsymbol` (expressionsem.d:5248) — in `visitTraits` (typesem.ts:8237), `visitMixin`
//      (:8255) and `visitIdentifier` (:8277). The arms `checkMustUse` travels are all live and
//      return without throwing: `visitType` (:8218, every basic type -> null), `visitStruct` (:8221),
//      `visitEnum` (:8222) and `visitClass` (:8223). The three walled arms are the unresolved
//      `__traits`/`mixin`/bare-identifier types, which a semantically analysed `e.type` does not
//      carry — but that is a reachability argument, not a proof, so the walls are reported here
//      rather than left implicit. (This is the file's one manifest row marked WALLED.)

import { error } from "./errors.js";
import { Id } from "./id.js";
import { foreachUdaNoSemantic, isEnumAttribute } from "./attrib.js";
import { foreachUda } from "./attribsem.js";
import { toDsymbol } from "./typesem.js";
import { isExpression } from "./dtemplate.js";
import { EXP } from "./tokens.js";
import { ds, dsEquals } from "../dstring.js";
import { assert } from "../assert.js";

import type { Scope } from "./dscope.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Expression } from "./expression.js";
import type { Identifier } from "./identifier.js";

/**
 * dmd/mustuse.d:30 — `bool checkMustUse(Expression e, Scope* sc)`.
 *
 * Check whether discarding an expression would violate the requirements of `@mustuse`. If so, emit
 * an error.
 *
 * Params:
 *   e = the expression to check
 *   sc = scope in which `e` was semantically analyzed
 *
 * Returns: true on error, false on success.
 *
 * `Scope*` is pointer-to-class used as a plain reference (03-value-semantics.md, "pointer-to-class
 * maps to the reference") -> `Scope` (tree convention: clone.ts, dcast.ts and dsymbolsem.ts all
 * spell a D `Scope* sc` as `sc: Scope`).
 *
 * COST / BLAST RADIUS: for a struct/union-typed value this reaches `hasMustUseAttribute` ->
 * `foreachUda`, whose open escalation throws when the symbol carries UDAs (header note 1). A
 * scalar-typed value never enters that branch — `toDsymbol` answers null and the function returns
 * false, which is the path statementsem.ts:301 and expressionsem.ts:13086 sit on.
 */
export function checkMustUse(e: Expression, sc: Scope): boolean {
    // mustuse.d:32-33 — `import dmd.id : Id;` / `import dmd.typesem : toDsymbol;` hoisted to the
    // module-level TS imports (01 §4.4).

    // mustuse.d:35 — `assert(e.type);`. A nullable class reference in a boolean context (06 §2.7);
    // `assert` here is the runtime helper (10 §2), declared `asserts cond`, so it narrows `e.type`
    // for the two reads below exactly as D's flow does.
    assert(e.type !== null);

    // mustuse.d:36 — `if (auto sym = e.type.toDsymbol(sc))`. Declaration in a condition hoisted to a
    // `const` (06 §2.6) + nullable-reference test (06 §2.7). `toDsymbol` is the free function of
    // dmd.typesem reached by UFCS in D (04 §6), so the receiver becomes the first argument.
    const sym = toDsymbol(e.type, sc);
    if (sym !== null) {
        // mustuse.d:38 — `auto sd = sym.isStructDeclaration();`
        const sd = sym.isStructDeclaration();
        // mustuse.d:39 — isStructDeclaration returns non-null for both structs and unions
        // mustuse.d:40 — `if (sd && hasMustUseAttribute(sd, sc) && !isAssignment(e) && !isIncrementOrDecrement(e))`.
        // The `&&` chain keeps D's short-circuit order verbatim: the attribute lookup runs only for a
        // struct/union, and the two shape tests only after it answers true.
        //
        // upcast cascade (02 §11.5): AggregateDeclaration.deferred (aggregate.d:94, `Dsymbol`)
        // shadows Dsymbol.deferred (dsymbol.d:396, `bool`), so TS rejects the sound
        // `StructDeclaration` -> `Dsymbol` upcast. Deleted and re-checked with tsc first, per
        // §11.5's inverse rule: it does NOT compile away (TS2345 on `deferred`), so the cascade is
        // real. The row is in the §11.5b registry as `ratified` but UNAPPLIED in aggregate.ts, which
        // is why the cascade is the sanctioned interim form and a `dependency signature` record is
        // filed alongside it.
        if (sd !== null && hasMustUseAttribute(sd as unknown as Dsymbol, sc)
            && !isAssignment(e) && !isIncrementOrDecrement(e)) {
            // mustuse.d:42-43 — diagnostic text byte-exact (10 §3). `Id.udaMustUse` is dereferenced
            // unconditionally by D, so the `!` marks the point D would fault (02 §10.1).
            error(e.loc, ds("ignored value of `@%s` type `%s`; prepend a `cast(void)` if intentional"),
                Id.udaMustUse!.toChars(), e.type.toPrettyChars(true));
            return true; // mustuse.d:44
        }
    }
    return false; // mustuse.d:47
}

/**
 * dmd/mustuse.d:58 — `void checkMustUseReserved(Dsymbol sym)`.
 *
 * Called from a symbol's semantic to check for reserved usage of `@mustuse`. If such usage is found,
 * emits an errror.
 *
 * Params:
 *   sym = symbol to check
 *
 * CONNECTS: called from FOUR D sites — funcsem.d:537, dsymbolsem.d:5294 (the ClassDeclaration arm),
 * dsymbolsem.d:6006 (the InterfaceDeclaration arm) and enumsem.d:122. The port carries a wall at each
 * (dsymbolsem.ts:5936 and :6677 are the two dsymbolsem ones), plus a marked carry-over copy of this
 * function at funcsem.ts:4492, that the later sweep wave replaces with an import of this symbol; none
 * of those files is this file's to edit.
 */
export function checkMustUseReserved(sym: Dsymbol): void {
    // mustuse.d:60-62 — the three function-local imports (`foreachUdaNoSemantic`, `error`, `Id`)
    // hoisted to the module-level TS imports (01 §4.4).

    // mustuse.d:64-65 — Can't use foreachUda (and by extension hasMustUseAttribute) while
    // semantic analysis of `sym` is still in progress
    // mustuse.d:66 — `foreachUdaNoSemantic(sym, (exp) {` (through mustuse.d:83). The D lambda's parameter type is
    // inferred; attrib.ts:1019 fixes the delegate protocol as `(e: Expression) => number` (its own
    // header records that BOTH bound bodies dereference, so the parameter is non-null).
    foreachUdaNoSemantic(sym, (exp: Expression): number => {
        if (isMustUseAttribute(exp)) { // mustuse.d:67
            // mustuse.d:69 — `if (sym.isFuncDeclaration())`: nullable-reference test (06 §2.7).
            if (sym.isFuncDeclaration() !== null) {
                // mustuse.d:71-72 — byte-exact diagnostic.
                error(sym.loc, ds("`@%s` on functions is reserved for future use"), Id.udaMustUse!.toChars());
                sym.errors = true; // mustuse.d:73
            }
            // mustuse.d:75 — `else if (sym.isClassDeclaration() || sym.isEnumDeclaration())`. Both
            // operands are nullable references (06 §2.7); D's short-circuit means the enum probe runs
            // only when the class probe answers null, which the `||` preserves.
            else if (sym.isClassDeclaration() !== null || sym.isEnumDeclaration() !== null) {
                // mustuse.d:77-78 — byte-exact diagnostic; `sym.kind()` is the Dsymbol hook.
                error(sym.loc, ds("`@%s` on `%s` types is reserved for future use"),
                    Id.udaMustUse!.toChars(), sym.kind());
                sym.errors = true; // mustuse.d:79
            }
        }
        return 0; // continue  — mustuse.d:82
    });
}

/**
 * dmd/mustuse.d:90 — `private bool isAssignment(Expression e)`.
 *
 * Returns: true if the given expression is an assignment, either simple (a = b) or compound
 * (a += b, etc).
 *
 */
// D module-private (called by `checkMustUse` above and by mustuse.test.ts) — 10 §1.7.
export function isAssignment(e: Expression): boolean {
    // mustuse.d:92 — `if (e.isAssignExp || e.isBinAssignExp || e.isConstructExp || e.isBlitExp)`.
    // D property-call syntax on the four `isXxx()` RTTI accessors; each yields a nullable reference,
    // so each operand becomes an explicit `!== null` (06 §2.7). Order and short-circuit preserved.
    if (e.isAssignExp() !== null || e.isBinAssignExp() !== null
        || e.isConstructExp() !== null || e.isBlitExp() !== null)
        return true; // mustuse.d:93
    // mustuse.d:94 — `if (auto ce = e.isCallExp())` (06 §2.6 hoist + §2.7 test).
    const ce = e.isCallExp();
    if (ce !== null) {
        // mustuse.d:96 — `if (auto fd = ce.f)`: `CallExp.f` is `FuncDeclaration | null`
        // (expression.ts:2459).
        const fd = ce.f;
        if (fd !== null) {
            const id = fd.ident; // mustuse.d:98
            // mustuse.d:99 — `if (id && isAssignmentOpId(id))`.
            if (id !== null && isAssignmentOpId(id))
                return true; // mustuse.d:100
        }
    }
    return false; // mustuse.d:103
}

/**
 * dmd/mustuse.d:109 — `private bool isAssignmentOpId(Identifier id)`.
 *
 * Returns: true if id is the identifier of an assignment operator overload.
 *
 * mustuse.d:111 — `import dmd.id : Id;` hoisted to the module-level TS imports (01 §4.4).
 *
 * `id == Id.xxx` on two `Identifier` class references is REFERENCE identity: neither `RootObject`
 * (rootobject.d) nor `Identifier` (identifier.d) overrides `opEquals`, so D's `==` falls through to
 * `Object.opEquals`'s default `this is o`. Hence `===`, not a byte compare — and it is correct only
 * because every `Identifier` is interned through `Identifier.idPool` (10 §1.5). The `Id.*` slots are
 * `Identifier | null` until `Id.initialize()` runs; comparing against the nullable slot is exactly
 * what D does (an uninitialised slot simply never matches the non-null `id`), so no `!` here.
 */
// D module-private (called by `isAssignment` above and by mustuse.test.ts) — 10 §1.7.
export function isAssignmentOpId(id: Identifier): boolean {
    return id === Id.opAssign            // mustuse.d:113
        || id === Id.opIndexAssign       // mustuse.d:114
        || id === Id.opSlice             // mustuse.d:115
        || id === Id.opSliceAssign       // mustuse.d:116
        || id === Id.opOpAssign          // mustuse.d:117
        || id === Id.opIndexOpAssign     // mustuse.d:118
        || id === Id.opSliceOpAssign;    // mustuse.d:119
}

/**
 * dmd/mustuse.d:125 — `private bool isIncrementOrDecrement(Expression e)`.
 *
 * Returns: true if the given expression is an increment (++) or decrement (--).
 *
 * COST / BLAST RADIUS: the overloaded-preincrement leg (mustuse.d:156) calls
 * `StringExp.peekString`, whose body is expression.ts's open escalation — see the header note. The
 * EXP-tag leg and the comma leg are unaffected.
 */
// D module-private (called by `checkMustUse` above, recursively by itself at mustuse.d:177, and
// by mustuse.test.ts) — 10 §1.7.
export function isIncrementOrDecrement(e: Expression): boolean {
    // mustuse.d:127-130 — the four function-local imports (`isExpression`, `dmd.location`, `Id`,
    // `EXP`) hoisted to the module-level TS imports (01 §4.4); `dmd.location` names nothing used.

    // mustuse.d:132-135, i.e. mustuse.d:132 — `if (e.op == EXP.plusPlus` through mustuse.d:135 —
    // `|| e.op == EXP.preMinusMinus)`. `EXP` is an enum, so `===` on the tag is the whole test (no
    // truthiness involved).
    if (e.op === EXP.plusPlus
        || e.op === EXP.minusMinus
        || e.op === EXP.prePlusPlus
        || e.op === EXP.preMinusMinus)
        return true; // mustuse.d:136
    // mustuse.d:137 — `if (auto call = e.isCallExp())`, with the `else if` at :167 as its sole
    // alternative: the two probes are a CHAIN, so the comma hoist nests into the `else` to keep D's
    // short-circuit (06 §2.6, chained-declaration clause). A flat hoist would call
    // `e.isCommaExp()` even for a CallExp.
    const call = e.isCallExp();
    if (call !== null) {
        // mustuse.d:139-140 — Check for overloaded preincrement, e.g., a.opUnary!"++"
        const fd = call.f; // mustuse.d:141
        if (fd !== null) {
            // mustuse.d:143 — `if (fd.ident == Id.opUnary && fd.parent)`: reference identity on the
            // interned identifier (see `isAssignmentOpId`) + a nullable-reference test.
            if (fd.ident === Id.opUnary && fd.parent !== null) {
                // mustuse.d:145 — `if (auto ti = fd.parent.isTemplateInstance())`.
                const ti = fd.parent.isTemplateInstance();
                if (ti !== null) {
                    // mustuse.d:147 — `auto tiargs = ti.tiargs;`. `Objects*` -> `Objects | null`.
                    const tiargs = ti.tiargs;
                    // mustuse.d:148 — `if (tiargs && tiargs.length >= 1)`.
                    if (tiargs !== null && tiargs.length >= 1) {
                        // mustuse.d:150 — `if (auto argExp = (*tiargs)[0].isExpression())`. Two
                        // rewrites: the `Array!T` element read is `opIndex` (08 §2.0c), and
                        // `isExpression` is the free function of dmd.dtemplate reached by UFCS
                        // (04 §6), so the element becomes its argument.
                        const argExp = isExpression(tiargs.opIndex(0));
                        if (argExp !== null) {
                            // mustuse.d:152 — `if (auto op = argExp.isStringExp())`.
                            const op = argExp.isStringExp();
                            if (op !== null) {
                                // mustuse.d:154 — `if (op.len == 2 && op.sz == 1)`: both are
                                // `number` (a code-unit count and an element width, provably small —
                                // 09 §1.1).
                                if (op.len === 2 && op.sz === 1) {
                                    // mustuse.d:156 — `const s = op.peekString();` yields
                                    // `const(char)[]`, i.e. a `DString` byte view.
                                    const s = op.peekString();
                                    // mustuse.d:157 — `if (s == "++" || s == "--")`: D `==` on
                                    // char-slices is BYTE equality, which is `dsEquals`, never
                                    // `===` (dstring.ts's `DString` contract; 05-operators.md).
                                    if (dsEquals(s, ds("++")) || dsEquals(s, ds("--")))
                                        return true; // mustuse.d:158
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // mustuse.d:167 — `else if (auto comma = e.isCommaExp())`.
    else {
        const comma = e.isCommaExp();
        if (comma !== null) {
            // mustuse.d:169-170 — Check for overloaded postincrement, e.g., (auto tmp = a, ++a, tmp)
            // mustuse.d:171 — `if (comma.e1)`: `BinExp.e1` is `Expression | null`
            // (expression.ts:2074).
            if (comma.e1 !== null) {
                // mustuse.d:173 — `if (auto left = comma.e1.isCommaExp())`.
                const left = comma.e1.isCommaExp();
                if (left !== null) {
                    // mustuse.d:175 — `if (auto middle = left.e2)`.
                    const middle = left.e2;
                    if (middle !== null) {
                        // mustuse.d:177 — `if (middle && isIncrementOrDecrement(middle))`. D
                        // re-tests `middle` although :175 already proved it non-null; the redundant
                        // conjunct is emitted verbatim (06 §2.7) rather than dropped, so the text
                        // stays diff-able against upstream. It is inert, not dead code.
                        if (middle !== null && isIncrementOrDecrement(middle))
                            return true; // mustuse.d:178
                    }
                }
            }
        }
    }
    return false; // mustuse.d:183
}

/**
 * dmd/mustuse.d:189 — `private bool hasMustUseAttribute(Dsymbol sym, Scope* sc)`.
 *
 * Returns: true if the given symbol has the `@mustuse` attribute.
 *
 * COST / BLAST RADIUS: `foreachUda` (attribsem.ts:165) holds an open §2 escalation record over
 * `arrayExpressionSemantic` — see header note 1. Its throw is CONDITIONAL, so this function DOES
 * return normally on the path the sweep needs: attribsem.ts:173-174 returns 0 before the throw for
 * a symbol with no `userAttribDecl` (the common case), `result` stays at its mustuse.d:193
 * initializer and the answer is false — pinned in mustuse.test.ts. The throw bites only for a
 * symbol that really carries UDAs.
 */
// D module-private (called by `checkMustUse` above and by mustuse.test.ts) — 10 §1.7.
export function hasMustUseAttribute(sym: Dsymbol, sc: Scope): boolean {
    // mustuse.d:191 — `import dmd.attribsem : foreachUda;` hoisted (01 §4.4).

    let result = false; // mustuse.d:193

    // mustuse.d:195-202 — `foreachUda(sym, sc, (Expression uda) {` (through mustuse.d:202). The delegate closes over
    // `result` (04 §5 arrow, so `this` capture is a non-issue) and returns D's int protocol:
    // 1 = break, 0 = continue.
    foreachUda(sym, sc, (uda: Expression): number => {
        if (isMustUseAttribute(uda)) { // mustuse.d:196
            result = true;             // mustuse.d:198
            return 1; // break         — mustuse.d:199
        }
        return 0; // continue          — mustuse.d:201
    });

    return result; // mustuse.d:204
}

/**
 * dmd/mustuse.d:210 — `private bool isMustUseAttribute(Expression e)`.
 *
 * Returns: true if the given expression is core.attribute.mustuse.
 *
 */
// D module-private (called by `checkMustUseReserved` and `hasMustUseAttribute` above, and by
// mustuse.test.ts) — 10 §1.7.
export function isMustUseAttribute(e: Expression): boolean {
    // mustuse.d:212-213 — `import dmd.attrib : isEnumAttribute;` / `import dmd.id : Id;` hoisted.
    // mustuse.d:214 — `Id.udaMustUse` dereferenced unconditionally by D; the `!` marks that point.
    return isEnumAttribute(e, Id.udaMustUse!);
}
