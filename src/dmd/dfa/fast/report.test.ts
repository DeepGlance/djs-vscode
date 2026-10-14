// Tests for src/dmd/dfa/fast/report.ts (ported from dmd/dfa/fast/report.d, LDC 1.43.0).
//
// dmd/dfa/fast/report.d ships no `unittest{}` block (10 §1). These pin:
//   1. the diagnostic texts, byte for byte, against ldc2 1.43.0 `-preview=fastdfa` on
//      tests/dmd/fail_compilation/fastdfa.d (and a member call probe for the argument index counting `this`),
//      with the location each line is emitted at (the use site, or the declaration for a supplemental);
//   2. the silences that decide whether a finding is reported (depth against the innermost loopy label,
//      unmodellable variables, compiler temporaries, literal asserts, floats outside math);
//   3. the parameter-fact inference of onEndOfFunction / onEndOfScope.

import { beforeEach, describe, expect, test } from "vitest";

// FIRST on purpose: this import makes report.ts the module that enters the graph (01 §4.8).
import { DFAReporter } from "./report.js";
import { DFACommon, Nullable, Truthiness } from "./structure.js";
import type { DFAVar } from "./structure.js";
import { Type } from "../../mtype.js";
import { STC } from "../../astenums.js";
import { VarDeclaration } from "../../declaration.js";
import { StructDeclaration } from "../../dstruct.js";
import { FuncDeclaration, ParameterDFAInfo } from "../../func.js";
import { Identifier } from "../../identifier.js";
import { Loc } from "../../location.js";
import { ErrorSinkNull } from "../../errorsink.js";
import { dmdformat } from "../../root/dmdformat.js";
import { Array as DArray } from "../../root/array.js";
import { pointerTo } from "../../typesem.js";
import { cstr, ds, dsToJs } from "../../../dstring.js";
import type { DString } from "../../../dstring.js";
import { initSemaHarness } from "../../../sema-harness.js";

beforeEach(() => {
    initSemaHarness();
});

/** One emitted line: its kind, the Loc object it was emitted at, and the formatted text. */
interface Line { kind: "error" | "supplemental"; loc: Loc; text: string; }

class Collect extends ErrorSinkNull {
    lines: Line[] = [];
    override verror(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.lines.push({ kind: "error", loc, text: dsToJs(cstr(dmdformat(format, [...ap]))) });
    }
    override verrorSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        this.lines.push({ kind: "supplemental", loc, text: dsToJs(cstr(dmdformat(format, [...ap]))) });
    }
}

const fn = (): FuncDeclaration => new FuncDeclaration(Loc.initial, Loc.initial, Identifier.idPool(ds("f")), STC.none,
    null);

function mkVar(name: string, type: Type, stc: STC = STC.none, parent: FuncDeclaration = fn()): VarDeclaration {
    const vd = new VarDeclaration(Loc.singleFilename(ds(`${name}.d`)), type, Identifier.idPool(ds(name)), null, stc);
    vd.parent = parent;
    return vd;
}

/** A DFACommon with a function scope (depth 1) that is also the innermost loopy label, and a reporter on it. */
function setup(): { c: DFACommon; r: DFAReporter; sink: Collect } {
    const c = new DFACommon();
    c.allocator.dfaCommon = c;
    c.pushScope();
    c.setScopeAsLoopyLabel();
    const sink = new Collect();
    const r = new DFAReporter();
    r.dfaCommon = c;
    r.errorSink = sink;
    return { c, r, sink };
}

function declared(c: DFACommon, vd: VarDeclaration, depth: number): DFAVar {
    const v = c.findVariable(vd)!;
    v.declaredAtDepth = depth;
    return v;
}

const at = Loc.singleFilename(ds("use.d"));

describe("diagnostic texts (ldc2 -preview=fastdfa)", () => {
    test("onDereference: `Dereference on null variable `ptr``, at the use site", () => {
        const { c, r, sink } = setup();
        const v = declared(c, mkVar("ptr", pointerTo(Type.tint32)), 1);
        const scv = c.acquireScopeVar(v)!;
        const cctx = scv.lr.getContext()!;
        cctx.nullable = Nullable.Null;
        r.onDereference(cctx, at);
        expect(sink.lines).toEqual([{ kind: "error", loc: at, text: "Dereference on null variable `ptr`" }]);
    });

    test("onLoopyLabelLessNullThan: `Variable `ptr` was required to be non-null and has become null`", () => {
        const { c, r, sink } = setup();
        const v = declared(c, mkVar("ptr", pointerTo(Type.tint32)), 1);
        r.onLoopyLabelLessNullThan(v, at);
        expect(sink.lines).toEqual([
            { kind: "error", loc: at, text: "Variable `ptr` was required to be non-null and has become null" },
        ]);
    });

    test("onAssertIsFalse: `Assert can be proven to be false` for a variable context", () => {
        const { c, r, sink } = setup();
        const v = declared(c, mkVar("c", Type.tint32), 1);
        const lr = c.makeLatticeRef();
        lr.setContextFromDFAVar(v)!.truthiness = Truthiness.False;
        r.onAssertIsFalse(lr, at);
        expect(sink.lines).toEqual([{ kind: "error", loc: at, text: "Assert can be proven to be false" }]);
        expect(lr.isNull()).toBe(false); // by ref: neither moved nor destroyed
    });

    test("onFunctionCallArgumentLessThan: the argument error, then the parameter it was passed to", () => {
        const { c, r, sink } = setup();
        const calling = fn();
        const ptr = mkVar("ptr", pointerTo(Type.tint32), STC.parameter, calling);
        calling.parameters = new DArray<VarDeclaration | null>();
        calling.parameters.push(ptr);
        const info = new ParameterDFAInfo();
        info.parameterId = 0;

        const arg = c.makeLatticeRef().acquireConstantAsContextTruthiness(Truthiness.False, Nullable.Null, null);
        r.onFunctionCallArgumentLessThan(arg, info, calling, at);

        // fastdfa.d(78) / (71): a free function counts from 0
        expect(sink.lines).toEqual([
            { kind: "error", loc: at, text: "Argument is expected to be non-null but was null" },
            { kind: "supplemental", loc: ptr.loc, text: "For parameter `ptr` in argument 0" },
        ]);

        sink.lines = [];
        info.parameterId = -1;
        r.onFunctionCallArgumentLessThan(arg, info, calling, at);
        expect(sink.lines).toEqual([
            { kind: "error", loc: at, text: "Argument is expected to be non-null but was null" },
            { kind: "supplemental", loc: calling.loc, text: "For parameter `this` in called function" },
        ]);
    });

    test("onFunctionCallArgumentLessThan: a member function counts its hidden `this` as argument 0", () => {
        const { c, r, sink } = setup();
        const calling = fn();
        calling.parent = new StructDeclaration(Loc.initial, Identifier.idPool(ds("S")), false);
        const q = mkVar("q", pointerTo(Type.tint32), STC.parameter, calling);
        calling.parameters = new DArray<VarDeclaration | null>();
        calling.parameters.push(q);
        const info = new ParameterDFAInfo();
        info.parameterId = 0;

        r.onFunctionCallArgumentLessThan(c.makeLatticeRef().acquireConstantAsContext(), info, calling, at);
        // probe p3.d: `S s; s.deref(null);` -> "For parameter `q` in argument 1"
        expect(sink.lines.map((l) => l.text)).toEqual([
            "Argument is expected to be non-null but was null", "For parameter `q` in argument 1"]);
    });

    test("onReadOfUninitialized: the plain read, supplemented at the declaration", () => {
        const { c, r, sink } = setup();
        const vd = mkVar("val1", Type.tint32);
        const v = declared(c, vd, 1);
        r.onReadOfUninitialized(v, c.makeLatticeRef(), at, false);
        // fastdfa.d(295) / (294)
        expect(sink.lines).toEqual([
            { kind: "error", loc: at, text: "Expression reads from an uninitialized variable, it must be written to at "
                + "least once before reading" },
            { kind: "supplemental", loc: vd.loc, text: "For variable `val1`" },
        ]);
    });

    test("onReadOfUninitialized: a default-initialized float in a math operation (the NaN error)", () => {
        const { c, r, sink } = setup();
        const vd = mkVar("v", Type.tfloat32);
        const v = declared(c, vd, 1);
        v.wasDefaultInitialized = true;
        r.onReadOfUninitialized(v, c.makeLatticeRef(), at, true);
        // fastdfa.d(355) / (354)
        expect(sink.lines).toEqual([
            { kind: "error", loc: at, text: "Expression reads a default initialized variable that is a floating "
                + "point type" },
            { kind: "supplemental", loc: at, text: "It will have the value of Not Any Number(nan), it will be "
                + "propagated with mathematical operations" },
            { kind: "supplemental", loc: vd.loc, text: "For variable `v`" },
            { kind: "supplemental", loc: vd.loc,
                text: "Initialize to float.nan or 0 explicitly to disable this error" },
        ]);
    });
});

describe("silences", () => {
    test("onDereference: a variable declared outside the innermost loopy label, or unmodellable, is silent", () => {
        const { c, r, sink } = setup();
        c.pushScope();
        c.setScopeAsLoopyLabel(); // innermost loopy label at depth 2
        const outer = declared(c, mkVar("outer", pointerTo(Type.tint32)), 1);
        const cOuter = c.makeLatticeRef().setContextFromDFAVar(outer)!;
        r.onDereference(cOuter, at);

        const inner = declared(c, mkVar("inner", pointerTo(Type.tint32)), 2);
        inner.unmodellable = true;
        r.onDereference(c.makeLatticeRef().setContextFromDFAVar(inner)!, at);

        r.onDereference(c.makeLatticeRef().acquireConstantAsContext(), at); // no variable
        expect(sink.lines).toEqual([]);
    });

    test("onAssertIsFalse: a bare literal is not reported (too many false positives)", () => {
        const { c, r, sink } = setup();
        const lr = c.makeLatticeRef();
        lr.acquireConstantAsContextTruthiness(Truthiness.False, Nullable.Unknown, null);
        r.onAssertIsFalse(lr, at);
        expect(sink.lines).toEqual([]);
    });

    test("onReadOfUninitialized: temporaries, depth 0, outer declarations and floats outside math are silent", () => {
        const { c, r, sink } = setup();
        r.onReadOfUninitialized(declared(c, mkVar("t", Type.tint32, STC.temp), 1), c.makeLatticeRef(), at, false);
        r.onReadOfUninitialized(declared(c, mkVar("z", Type.tint32), 0), c.makeLatticeRef(), at, false);
        const f = declared(c, mkVar("f", Type.tfloat64), 1);
        f.wasDefaultInitialized = true;
        r.onReadOfUninitialized(f, c.makeLatticeRef(), at, false);
        c.pushScope();
        c.setScopeAsLoopyLabel();
        r.onReadOfUninitialized(declared(c, mkVar("o", Type.tint32), 1), c.makeLatticeRef(), at, false);
        expect(sink.lines).toEqual([]);
    });
});

describe("parameter fact inference", () => {
    function withParam(c: DFACommon, fd: FuncDeclaration, stc: STC = STC.parameter): DFAVar {
        const vd = mkVar("p", pointerTo(Type.tint32), stc, fd);
        fd.parameters = new DArray<VarDeclaration | null>();
        fd.parameters.push(vd);
        const v = declared(c, vd, 1);
        v.param = new ParameterDFAInfo();
        return v;
    }

    test("onEndOfFunction: the inference chain, arm by arm (by value, by ref, unmodellable, specified by user)", () => {
        const { c, r } = setup();
        const fd = fn();
        const v = withParam(c, fd);
        const p = v.param!;

        // nullable by value: NotGuaranteed on input, Unspecified on output
        r.onEndOfFunction(fd, at);
        expect([p.notNullIn, p.notNullOut]).toEqual([ParameterDFAInfo.Fact.NotGuaranteed,
            ParameterDFAInfo.Fact.Unspecified]);

        // by ref, written once: the output takes the input fact
        v.isByRef = true;
        v.writeCount = 1;
        p.notNullIn = ParameterDFAInfo.Fact.Guaranteed;
        r.onEndOfFunction(fd, at);
        expect(p.notNullOut).toBe(ParameterDFAInfo.Fact.Guaranteed);

        // by ref, written twice: an Unspecified output becomes NotGuaranteed
        v.writeCount = 2;
        p.notNullOut = ParameterDFAInfo.Fact.Unspecified;
        r.onEndOfFunction(fd, at);
        expect(p.notNullOut).toBe(ParameterDFAInfo.Fact.NotGuaranteed);

        // unmodellable and nullable: both facts go back to Unspecified
        v.unmodellable = true;
        p.notNullIn = ParameterDFAInfo.Fact.Guaranteed;
        p.notNullOut = ParameterDFAInfo.Fact.Guaranteed;
        r.onEndOfFunction(fd, at);
        expect([p.notNullIn, p.notNullOut]).toEqual([ParameterDFAInfo.Fact.Unspecified,
            ParameterDFAInfo.Fact.Unspecified]);

        // specified by the user: kept as written
        p.specifiedByUser = true;
        p.notNullIn = ParameterDFAInfo.Fact.Guaranteed;
        r.onEndOfFunction(fd, at);
        expect(p.notNullIn).toBe(ParameterDFAInfo.Fact.Guaranteed);
    });

    test("onEndOfScope: only after a return; Unspecified becomes Guaranteed on NonNull, else downgraded", () => {
        const { c, r } = setup();
        const fd = fn();
        const v = withParam(c, fd);
        const cctx = c.acquireScopeVar(v)!.lr.getContext()!;
        cctx.nullable = Nullable.NonNull;

        r.onEndOfScope(fd, at);
        expect(v.param!.notNullOut).toBe(ParameterDFAInfo.Fact.Unspecified); // the scope has not returned

        c.currentDFAScope!.haveReturned = true;
        r.onEndOfScope(fd, at);
        expect(v.param!.notNullOut).toBe(ParameterDFAInfo.Fact.Guaranteed);

        cctx.nullable = Nullable.Unknown;
        r.onEndOfScope(fd, at);
        expect(v.param!.notNullOut).toBe(ParameterDFAInfo.Fact.NotGuaranteed);
    });
});
