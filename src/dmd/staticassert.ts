// Ported from dmd/staticassert.d (module dmd.staticassert).
//
// The `static assert` declaration node. D's two same-arity constructors map per 04 §1.1(c): the
// `Expressions*` form (the field constructor, reached from parse.d:2191 and syntaxCopy) stays the TS
// `constructor`; the single-message `Expression` form (cparse.d:3301, `_Static_assert`) becomes the
// static factory `fromExpression`.
//
// Load order: `Dsymbol` is a value import used in `extends` (01 §4.2). `Expression` and `Id` are read
// only inside method bodies, at call time (01 §4.5).

import { Dsymbol } from "./dsymbol.js";
import { DSYM } from "./dsymbol.js";
import { Expression } from "./expression.js";
import { Id } from "./id.js";
import { Array as DArray } from "./root/array.js";
import { assert } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";
import type { Loc } from "./location.js";
import type { Expressions } from "./arraytypes.js";
import type { Visitor } from "./visitor/index.js";

/***********************************************************
 * dmd/staticassert.d:26 — `extern (C++) final class StaticAssert : Dsymbol`.
 */
export class StaticAssert extends Dsymbol {
    exp: Expression;
    msgs: Expressions | null;

    /// dmd/staticassert.d:39 — `extern (D) this(Loc loc, Expression exp, Expressions* msgs)`.
    constructor(loc: Loc, exp: Expression, msgs: Expressions | null) {
        super(DSYM.staticAssert, loc, Id.empty);
        this.exp = exp;
        this.msgs = msgs;
    }

    /// dmd/staticassert.d:31 — `extern (D) this(Loc loc, Expression exp, Expression msg)`: a one-element
    /// `msgs` holding `msg`, which may be null.
    static fromExpression(loc: Loc, exp: Expression, msg: Expression | null): StaticAssert {
        const msgs: Expressions = new DArray<Expression | null>(1);
        msgs.opIndexAssign(msg, 0);
        return new StaticAssert(loc, exp, msgs);
    }

    /// dmd/staticassert.d:45
    override syntaxCopy(s: Dsymbol | null): StaticAssert {
        assert(s === null); // staticassert.d:47
        return new StaticAssert(this.loc, this.exp.syntaxCopy(),
            this.msgs !== null ? Expression.arraySyntaxCopy(this.msgs) : null);
    }

    /// dmd/staticassert.d:51
    override kind(): DString {
        return ds("static assert");
    }

    override accept(v: Visitor): void {
        v.visitStaticAssert(this);
    }
}
