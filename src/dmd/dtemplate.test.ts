// Behavioral pins for dmd/dtemplate.d (10-tests-diagnostics.md §1.6b).
//
// dtemplate.d carries ZERO in-source `unittest` blocks, so there is nothing to port under §1.2.
// This suite takes the §1.6b shape: one module-load smoke test plus a small set of pins on behavior
// that is constructible with the EXISTING harness conventions (node constructors only — no parser,
// no semantic pass). Nothing here builds new harness machinery, and nothing pins a path the harness
// cannot reach honestly.
//
// What is pinned:
//   1. module load + the manifest constant (dtemplate.d:69);
//   2. the `dynamic_cast` substitutes gate on the DYNCAST tag, including the null-operand arm
//      (dtemplate.d:78-130) — the module's most-reused primitive;
//   3. `TemplateInstance`'s `_nest` bit field (dtemplate.d:825-862): the counter and the three flag
//      bits share one `ushort` and must not disturb each other;
//   4. `Tuple.toChars` (dtemplate.d:216): `Tuple` overrides `toChars` itself and renders its objects
//      through root/array.ts's Objects variant of `Array.toChars` (07 §3.5(b));
//   5. `TypeDeduced` (dtemplate.d:386) behind `initDtemplate()` — the 01 §4.1 lazy-class shape and
//      its ORDER CONTRACT. This is a LOAD-ORDER pin, not a wall: it is the only reason this module
//      can be imported from anywhere in the SCC, and a regression there is otherwise silent until
//      some unrelated third module dies with `Class extends value undefined`.

import { describe, test, expect } from "vitest";

// Import an SCC member FIRST: the core SCC only loads cleanly when the entry is inside it
// (01-conventions.md §4.5 — the load-order invariant recorded in visitor/index.ts).
import { IdentifierExp } from "./expression.js";
import { Type, TypeError as DTypeError } from "./mtype.js";
import { Identifier } from "./identifier.js";
import { TY } from "./astenums.js";
import { TOK } from "./tokens.js";
import { DYNCAST } from "./rootobject.js";
import { Loc } from "./location.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import type { DString } from "../dstring.js";
import { ErrorSinkNull } from "./errorsink.js";
import { dmdformat } from "./root/dmdformat.js";
import { Array as DArray } from "./root/array.js";

import {
    IDX_NOTFOUND,
    Tuple,
    TemplateInstance,
    TemplateTypeParameter,
    TemplateTupleParameter,
    isExpression,
    isDsymbol,
    isType,
    isTuple,
    isIdentifier,
    isParameter,
    isTemplateParameter,
    getType,
    objectSyntaxCopy,
    TemplateStats,
    TemplateDeclaration,
    printTemplateStats,
    initDtemplate,
} from "./dtemplate.js";
import type { TemplateParameter } from "./dtemplate.js";
import * as dtemplate from "./dtemplate.js"; // the `TypeDeduced` binding is read AFTER initDtemplate

describe("dtemplate.d", () => {
    // §1.6b module-load smoke: importing the module executes its top level. Reaching this assertion
    // at all is the smoke result.
    test("module loads; IDX_NOTFOUND is the dtemplate.d:69 manifest constant", () => {
        expect(IDX_NOTFOUND).toBe(0x12345678);
    });

    // 01 §4.1 LAZY CLASS + §5.2 ORDER CONTRACT. `TypeDeduced` (dtemplate.d:386) is the module's one
    // top-level read of a core-SCC value (`extends Type`), so it is declared here and defined by
    // `initDtemplate()`. Two things are pinned, and both are load-order invariants that fail
    // silently — as a `Class extends value undefined` in some THIRD module — if they regress:
    //   (a) the binding is EMPTY until `initDtemplate()` runs (that emptiness IS the deferral);
    //   (b) after it runs the class is the faithful dtemplate.d:386-412 node.
    // The ORDER CONTRACT is "mtype.js has finished evaluating" — the `import { Type } from
    // "./mtype.js"` at the top of this file is what satisfies it. `Type._init()` is deliberately NOT
    // called: it is an anchor in the canonical harness order, not a precondition, and both `Type`
    // operands below are `new TypeError()`, which mtype.ts constructs without any table.
    test("TypeDeduced is deferred into initDtemplate (dtemplate.d:386)", () => {
        // (a) the deferral itself. This read happens before any initDtemplate() call in this file.
        expect(dtemplate.TypeDeduced).toBeUndefined();

        initDtemplate();
        expect(dtemplate.TypeDeduced).toBeTypeOf("function");

        // (b) dtemplate.d:392 — the ctor seeds `tded` and pushes the first (expression, tparam) pair.
        const tt = new DTypeError();
        const tparam = new DTypeError();
        const e = new IdentifierExp(Loc.initial, new Identifier(ds("T"), TOK.identifier));
        const td = new dtemplate.TypeDeduced(tt, e, tparam);

        expect(td).toBeInstanceOf(Type); // dtemplate.d:386 — `final class TypeDeduced : Type`
        expect(td.ty).toBe(TY.Tnone); // dtemplate.d:394 — `super(Tnone)`
        expect(td.tded).toBe(tt);
        expect(td.argexps.length).toBe(1);
        expect(td.tparams.length).toBe(1);

        // dtemplate.d:400 — the 2-arg `update` appends without touching `tded` (04 §1B rename).
        const e2 = new IdentifierExp(Loc.initial, new Identifier(ds("U"), TOK.identifier));
        td.updateFromExpression(e2, tparam);
        expect(td.tded).toBe(tt);
        expect(td.argexps.length).toBe(2);

        // dtemplate.d:406 — the 3-arg `update` DOES set `tded`, then appends.
        const tt2 = new DTypeError();
        td.updateFromType(tt2, e, tparam);
        expect(td.tded).toBe(tt2);
        expect(td.argexps.length).toBe(3);
        expect(td.tparams.length).toBe(3);

        // ONE-SHOT (01 §5.2): a second call is a no-op, so the class IDENTITY is stable and an
        // instance built before it keeps satisfying `instanceof TypeDeduced`. This is the pin that
        // would go red if the guard in `initDtemplate()` were dropped for a rebuild.
        const first = dtemplate.TypeDeduced;
        initDtemplate();
        expect(dtemplate.TypeDeduced).toBe(first);
        expect(td).toBeInstanceOf(dtemplate.TypeDeduced);
    });

    // dtemplate.d:78-130 — every substitute answers from `o.dyncast()` alone, and answers `null`
    // for a null operand (`if (!o || ...)`).
    test("the dynamic_cast substitutes gate on the DYNCAST tag", () => {
        const t = new Tuple();
        expect(t.dyncast()).toBe(DYNCAST.tuple); // dtemplate.d:211

        expect(isTuple(t)).toBe(t);
        expect(isType(t)).toBe(null);
        expect(isExpression(t)).toBe(null);
        expect(isDsymbol(t)).toBe(null);
        expect(isParameter(t)).toBe(null);
        expect(isIdentifier(t)).toBe(null);
        expect(isTemplateParameter(t)).toBe(null);

        // dtemplate.d:477 — every TemplateParameter answers DYNCAST.templateparameter.
        const tp = new TemplateTypeParameter(Loc.initial, null, null, null);
        expect(tp.dyncast()).toBe(DYNCAST.templateparameter);
        expect(isTemplateParameter(tp)).toBe(tp);
        expect(isType(tp)).toBe(null);

        // an Identifier is DYNCAST.identifier, reached only by isIdentifier (dtemplate.d:118)
        const id = new Identifier(ds("Foo"), TOK.identifier);
        expect(isIdentifier(id)).toBe(id);
        expect(isDsymbol(id)).toBe(null);

        // the `!o` arm of every substitute (dtemplate.d:81, :89, :97, :105, :113, :120, :127)
        expect(isExpression(null)).toBe(null);
        expect(isDsymbol(null)).toBe(null);
        expect(isType(null)).toBe(null);
        expect(isTuple(null)).toBe(null);
        expect(isParameter(null)).toBe(null);
        expect(isIdentifier(null)).toBe(null);
        expect(isTemplateParameter(null)).toBe(null);
    });

    // dtemplate.d:171 — `getType` answers the Type itself, else an Expression's `.type`, else null.
    // dtemplate.d:184 — `objectSyntaxCopy` passes a non-Type/non-Expression object through verbatim.
    test("getType and objectSyntaxCopy route by the same tags", () => {
        const terr = new DTypeError();
        expect(getType(terr)).toBe(terr);

        // an Expression whose `.type` is unset answers null (Expression.type .init is null, 09 §1.0)
        const e = new IdentifierExp(Loc.initial, new Identifier(ds("x"), TOK.identifier));
        expect(e.type).toBe(null);
        expect(getType(e)).toBe(null);

        const t = new Tuple();
        expect(getType(t)).toBe(null);

        // dtemplate.d:186 — the null arm.
        expect(objectSyntaxCopy(null)).toBe(null);
        // dtemplate.d:192 — neither a Type nor an Expression: returned as-is, not copied.
        expect(objectSyntaxCopy(t)).toBe(t);
    });

    // dtemplate.d:825-862 — `_nest` packs a counter in the low 13 bits and three flags in the 3 MSBs
    // of a `ushort`. The pin is that the two halves are independent.
    test("TemplateInstance._nest keeps the counter and the flag bits independent", () => {
        const ti = new TemplateInstance(Loc.initial, new Identifier(ds("Foo"), TOK.identifier), null);

        // fresh instance: counter 0, all three flags clear (dtemplate.d:864 sets none of them)
        expect(ti.nest).toBe(0);
        expect(ti.semantictiargsdone).toBe(false);
        expect(ti.havetempdecl).toBe(false);
        expect(ti.gagged).toBe(false);

        ti.nestUp(); // dtemplate.d:839
        ti.nestUp();
        expect(ti.nest).toBe(2);

        // setting every flag must leave the counter alone (dtemplate.d:843/:850/:857)
        ti.semantictiargsdone = true;
        ti.havetempdecl = true;
        ti.gagged = true;
        expect(ti.nest).toBe(2);
        expect(ti.semantictiargsdone).toBe(true);
        expect(ti.havetempdecl).toBe(true);
        expect(ti.gagged).toBe(true);

        // ... and the counter must leave the flags alone
        ti.nestDown(); // dtemplate.d:840
        expect(ti.nest).toBe(1);
        expect(ti.semantictiargsdone).toBe(true);
        expect(ti.gagged).toBe(true);

        // clearing one flag clears only that flag
        ti.havetempdecl = false;
        expect(ti.havetempdecl).toBe(false);
        expect(ti.semantictiargsdone).toBe(true);
        expect(ti.gagged).toBe(true);
        expect(ti.nest).toBe(1);
    });

    // dtemplate.d:1159-1218 — the stats table is keyed on the TemplateDeclaration identity and both
    // entry points are no-ops for a null declaration (dtemplate.d:1188, :1211).
    test("TemplateStats ignores a null template declaration", () => {
        const before = TemplateStats.stats.size;
        TemplateStats.incInstance(null, null, false);
        TemplateStats.incUnique(null, null);
        expect(TemplateStats.stats.size).toBe(before);
    });

    // `Tuple.toChars` (dtemplate.d:216-219) is `objects.toChars()`: `[` + the elements' toString joined by `,`
    // + `]`, a null element as `null` (root/array.d:75-140).
    test("Tuple.toChars renders its objects as Array!RootObject.toChars does", () => {
        const t = new Tuple();
        expect(dsToJs(t.toChars())).toBe("[]");
        t.objects.push(Identifier.idPool(ds("x")));
        t.objects.push(null);
        expect(dsToJs(t.toChars())).toBe("[x,null]");
    });

    // dtemplate.d:339-344 / :1256-1287 — both print the declaration through hdrgen's
    // toCharsMaybeConstraints with `skipConstraints` set, so a constraint never reaches the text.
    test("toCharsNoConstraints and printTemplateStats print the signature without its constraint", () => {
        const tps = new DArray<TemplateParameter | null>();
        tps.push(new TemplateTypeParameter(Loc.initial, new Identifier(ds("T"), TOK.identifier), null, null));
        const constraint = new IdentifierExp(Loc.initial, new Identifier(ds("never_printed"), TOK.identifier));
        const td = new TemplateDeclaration(Loc.initial, new Identifier(ds("foo"), TOK.identifier), tps, constraint,
            null);
        expect(dsToJs(cstr(td.toCharsNoConstraints()))).toBe("foo(T)");

        // `-vtemplates` report (ldc2 prints "vtemplate: 2 (1 distinct) instantiation(s) of template
        // `foo(T)` found" for a template instantiated twice with the same argument).
        const messages: string[] = [];
        class Collect extends ErrorSinkNull {
            override vmessage(_loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
                messages.push(dsToJs(cstr(dmdformat(format, [...ap]))));
            }
        }
        const saved = new Map(TemplateStats.stats);
        TemplateStats.stats.clear();
        try {
            TemplateStats.stats.set(td, new TemplateStats(2, 1));
            printTemplateStats(false, new Collect());
        } finally {
            TemplateStats.stats.clear();
            for (const [k, v] of saved) TemplateStats.stats.set(k, v);
        }
        expect(messages).toEqual(["vtemplate: 2 (1 distinct) instantiation(s) of template `foo(T)` found"]);
    });

    // A TemplateTupleParameter carries no specialization and no default (dtemplate.d:741/:746) —
    // the two constant getters the parse-time AST relies on.
    test("TemplateTupleParameter has neither specialization nor default", () => {
        const id = new Identifier(ds("TL"), TOK.identifier);
        const tp = new TemplateTupleParameter(Loc.initial, id);
        expect(tp.isTemplateTupleParameter()).toBe(tp);
        expect(tp.specialization()).toBe(null);
        expect(tp.hasDefaultArg()).toBe(false);
        expect(dsToJs(tp.toChars())).toBe("TL"); // dtemplate.d:472
        // dtemplate.d:709 — syntaxCopy makes a fresh node with the same loc/ident.
        const cp = tp.syntaxCopy();
        expect(cp).not.toBe(tp);
        expect(cp.ident).toBe(id);
    });
});
