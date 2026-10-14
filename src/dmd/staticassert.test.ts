import { beforeEach, describe, expect, test } from "vitest";
import { initSemaHarness } from "../sema-harness.js";
import { StaticAssert } from "./staticassert.js";
import { Expression, IntegerExp, StringExp } from "./expression.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { Type } from "./mtype.js";
import { Array as DArray } from "./root/array.js";
import { ds } from "../dstring.js";

// dmd/staticassert.d has no unittests (10 §1.6b): pins for the two constructors and syntaxCopy.

beforeEach(() => {
    initSemaHarness();
});

const cond = (): Expression => new IntegerExp(Loc.initial, 0n, Type.tint32);
const msg = (): Expression => new StringExp(Loc.initial, [...ds("m")]);

describe("StaticAssert (dmd/staticassert.d)", () => {
    test("smoke: the module loads", () => {
        expect(typeof Expression).toBe("function");
        expect(typeof StaticAssert).toBe("function");
    });

    test("the Expressions* constructor keeps its messages and names the symbol Id.empty (staticassert.d:39)", () => {
        const msgs = new DArray<Expression | null>();
        msgs.push(msg());
        const sa = new StaticAssert(Loc.initial, cond(), msgs);
        expect(sa.msgs).toBe(msgs);
        expect(sa.ident).toBe(Id.empty);
    });

    test("fromExpression wraps one message, null included (staticassert.d:31)", () => {
        const m = msg();
        const sa = StaticAssert.fromExpression(Loc.initial, cond(), m);
        expect(sa.msgs!.length).toBe(1);
        expect(sa.msgs!.opIndex(0)).toBe(m);
        expect(StaticAssert.fromExpression(Loc.initial, cond(), null).msgs!.opIndex(0)).toBeNull();
    });

    test("syntaxCopy copies the condition and the messages (staticassert.d:45)", () => {
        const msgs = new DArray<Expression | null>();
        msgs.push(msg());
        const sa = new StaticAssert(Loc.initial, cond(), msgs);
        const c = sa.syntaxCopy(null);
        expect(c).not.toBe(sa);
        expect(c.msgs).not.toBe(msgs);
        expect(c.msgs!.length).toBe(1);
        expect(new StaticAssert(Loc.initial, cond(), null).syntaxCopy(null).msgs).toBeNull();
    });
});
