import { describe, it, expect } from "vitest";
import {
  Type,
  TypeFunction,
  TypeSArray,
  TypeTuple,
  Parameter,
  ParameterList,
  MODtoChars,
  trustToString,
  MODtoString,
  ModToStc,
  MODimplicitConv,
  MODmethodConv,
  MODmerge,
  isSomeChar,
  buildScopeRef,
  ScopeRefToChars,
  ScopeRef,
  TypePointer,
  TypeTag,
} from "./mtype.js";
import { TRUST, MATCH, MODFlags, STC, TY, TMAX, VarArg, LINK, structalign_t } from "./astenums.js";
import { TOK } from "./tokens.js";
import { Array as Array_ } from "./root/array.js";
import { Loc } from "./location.js";
import { IntegerExp } from "./expression.js";
import { cstr, cstrlen, dsToJs } from "../dstring.js";
import { wildOf, pointerTo, Type_init, nextOf } from "./typesem.js";

// Ported / port-guard tests for the STRUCTURAL bodies filled in mtype.ts this phase.
//
// The ONLY in-source `unittest{}` block in dmd/mtype.d is `trustToString` (mtype.d:337-343) — ported
// verbatim below. The rest are PORT-GUARDS over the mechanical free functions (pure MOD/STC/TY logic,
// no semantic dispatch); each expected value was checked against the D source (and trustToString's
// `null == ""` against ldc2-1.42.0, /tmp/probe_trust.d → true).

describe("dmd/mtype.d unittest — trustToString (mtype.d:337)", () => {
  it("maps each TRUST flag to its attribute spelling (default_ -> '' since D null == \"\")", () => {
    expect(trustToString(TRUST.default_)).toBe("");
    expect(trustToString(TRUST.system)).toBe("@system");
    expect(trustToString(TRUST.trusted)).toBe("@trusted");
    expect(trustToString(TRUST.safe)).toBe("@safe");
  });
});

describe("mtype.d MOD helpers (port-guard)", () => {
  it("MODtoString maps every valid MOD combination (mtype.d:285)", () => {
    expect(MODtoString(0)).toBe("");
    expect(MODtoString(MODFlags.immutable_)).toBe("immutable");
    expect(MODtoString(MODFlags.shared_)).toBe("shared");
    expect(MODtoString(MODFlags.shared_ | MODFlags.const_)).toBe("shared const");
    expect(MODtoString(MODFlags.const_)).toBe("const");
    expect(MODtoString(MODFlags.shared_ | MODFlags.wild)).toBe("shared inout");
    expect(MODtoString(MODFlags.wild)).toBe("inout");
    expect(MODtoString(MODFlags.shared_ | MODFlags.wildconst)).toBe("shared inout const");
    expect(MODtoString(MODFlags.wildconst)).toBe("inout const");
  });

  it("ModToStc maps MOD bits to the matching STC flags (mtype.d:348)", () => {
    expect(ModToStc(0)).toBe(STC.none);
    expect(ModToStc(MODFlags.immutable_)).toBe(STC.immutable_);
    expect(ModToStc(MODFlags.const_)).toBe(STC.const_);
    expect(ModToStc(MODFlags.wild)).toBe(STC.wild);
    expect(ModToStc(MODFlags.shared_)).toBe(STC.shared_);
    // combination ORs together
    expect(ModToStc(MODFlags.const_ | MODFlags.shared_)).toBe((STC.const_ | STC.shared_) as unknown as bigint);
  });

  it("MODimplicitConv: identity, mutable/wild->const, immutable->const (mtype.d:182)", () => {
    expect(MODimplicitConv(MODFlags.const_, MODFlags.const_)).toBe(true); // identity
    expect(MODimplicitConv(0, MODFlags.const_)).toBe(true); // mutable -> const
    expect(MODimplicitConv(MODFlags.wild, MODFlags.const_)).toBe(true); // wild -> const
    expect(MODimplicitConv(MODFlags.immutable_, MODFlags.const_)).toBe(true); // immutable -> const
    expect(MODimplicitConv(MODFlags.const_, 0)).toBe(false); // const -/-> mutable
  });

  it("MODmethodConv: exact on identity, constant on implicit-conv (mtype.d:208)", () => {
    expect(MODmethodConv(MODFlags.const_, MODFlags.const_)).toBe(MATCH.exact);
    expect(MODmethodConv(0, MODFlags.const_)).toBe(MATCH.constant); // via MODimplicitConv
    expect(MODmethodConv(0, MODFlags.wild)).toBe(MATCH.constant); // mutable -> wild
    expect(MODmethodConv(MODFlags.const_, 0)).toBe(MATCH.nomatch);
  });

  it("MODmerge: identity, shared sticks, mutable|const -> const, wild -> wildconst (mtype.d:235)", () => {
    expect(MODmerge(MODFlags.const_, MODFlags.const_)).toBe(MODFlags.const_); // identity
    expect(MODmerge(0, MODFlags.const_)).toBe(MODFlags.const_); // mutable + const -> const
    expect(MODmerge(MODFlags.shared_, 0)).toBe(MODFlags.shared_ | MODFlags.const_); // shared sticks, const
    expect(MODmerge(MODFlags.immutable_, MODFlags.wild)).toBe(MODFlags.wildconst); // immutable vs wild
  });
});

describe("mtype.d isSomeChar (mtype.d:363)", () => {
  it("true only for char/wchar/dchar", () => {
    expect(isSomeChar(TY.Tchar)).toBe(true);
    expect(isSomeChar(TY.Twchar)).toBe(true);
    expect(isSomeChar(TY.Tdchar)).toBe(true);
    expect(isSomeChar(TY.Tint32)).toBe(false);
    expect(isSomeChar(TY.Tvoid)).toBe(false);
  });
});

describe("mtype.d ScopeRef classification (mtype.d:2691,2746)", () => {
  it("buildScopeRef maps STC ref/scope/return masks to ScopeRef", () => {
    expect(buildScopeRef(STC.none)).toBe(ScopeRef.None);
    expect(buildScopeRef(STC.ref_)).toBe(ScopeRef.Ref);
    expect(buildScopeRef(STC.scope_)).toBe(ScopeRef.Scope);
    expect(buildScopeRef(STC.return_)).toBe(ScopeRef.Return);
    expect(buildScopeRef((STC.return_ | STC.ref_) as unknown as typeof STC.none)).toBe(ScopeRef.ReturnRef);
    expect(buildScopeRef((STC.ref_ | STC.scope_) as unknown as typeof STC.none)).toBe(ScopeRef.RefScope);
    // out_ is treated as ref_
    expect(buildScopeRef(STC.out_)).toBe(ScopeRef.Ref);
  });

  it("ScopeRefToChars gives the debug name for each ScopeRef", () => {
    expect(ScopeRefToChars(ScopeRef.None)).toBe("None");
    expect(ScopeRefToChars(ScopeRef.RefScope)).toBe("RefScope");
    expect(ScopeRefToChars(ScopeRef.Ref_ReturnScope)).toBe("Ref_ReturnScope");
    expect(ScopeRefToChars(ScopeRef.Return)).toBe("Return");
  });
});

// ── Port-guards for the FIXER pass (each pins one D behaviour a defect had inverted) ────────
//
// Every expectation below is read off dmd/mtype.d (LDC 1.43.0-beta1) at the cited line; none is
// read off the TS. They are behaviour pins in the sense of 10 §1.8: if a later edit changes one,
// the change must be justified against the D line named in the test title.

describe("mtype.d FIXER port-guards", () => {
  it("Type.basic is TMAX-long and every unassigned tag reads Type.init === null (mtype.d:497)", () => {
    Type_init();
    expect(Type.basic.length).toBe(TMAX);
    // Ttag is a valid TY tag above Tnone that `Type_init` never fills: D reads `null` there, not
    // a hole. `TY.Tnone + 1`-sizing made this `undefined`.
    expect(Type.basic[TY.Ttag]).toBeNull();
    expect(Type.basic[TY.Tstruct]).toBeNull();
    expect(Type.basic[TY.Tint32]).not.toBeNull();
  });

  it("Type.equals(null) answers false, it does not throw (mtype.d:576 `t &&`)", () => {
    Type_init();
    expect(Type.tint32.equals(null)).toBe(false);
    expect(Type.tint32.equals(Type.tint32)).toBe(true);
    expect(Type.tint32.equals(Type.tint64)).toBe(false);
  });

  it("TypeNext.hasWild narrows to 0/1; Type.hasWild keeps the raw mask (mtype.d:882 vs :741)", () => {
    Type_init();
    const wildInt = wildOf(Type.tint32);
    // Type.hasWild (base): `return mod & MODFlags.wild;` — the MASK, so 8 for a wild type.
    expect(wildInt.hasWild()).toBe(MODFlags.wild);
    // TypeNext.hasWild: `mod & wild || (next && next.hasWild())` is a D `||`, i.e. bool -> 0/1.
    const wildPtr = pointerTo(wildInt);
    expect(wildPtr.hasWild()).toBe(1);
    expect(pointerTo(Type.tint32).hasWild()).toBe(0);
  });

  it("Type.copy gives the clone its OWN inline value structs (mtype.d:539 memcpy)", () => {
    Type_init();
    const pl = new ParameterList(new Array_<Parameter | null>(), VarArg.none, STC.none);
    const tf = new TypeFunction(pl, Type.tint32, LINK.d);
    const clone = tf.copy().isTypeFunction()!;
    // D's memcpy copies the ParameterList BITS: the two lists are independent storage.
    expect(clone.parameterList).not.toBe(tf.parameterList);
    clone.parameterList.parameters = new Array_<Parameter | null>();
    expect(tf.parameterList.parameters).not.toBe(clone.parameterList.parameters);
    // ...while a class reference (`next`) is shared, exactly as memcpy shares a pointer.
    expect(clone.next).toBe(tf.next);
  });

  it("TypeFunction's ctor takes its own copy of the by-value ParameterList (mtype.d:1366)", () => {
    Type_init();
    const pl = new ParameterList(new Array_<Parameter | null>(), VarArg.none, STC.none);
    const tf = new TypeFunction(pl, Type.tint32, LINK.d);
    expect(tf.parameterList).not.toBe(pl);
    pl.varargs = VarArg.variadic;
    expect(tf.parameterList.varargs).toBe(VarArg.none);
  });

  it("the no-arg TypeTuple ctor builds an EMPTY Parameters, not null (mtype.d:1983)", () => {
    Type_init();
    expect(new TypeTuple().arguments).not.toBeNull();
    expect(new TypeTuple().arguments!.length).toBe(0);
    expect(TypeTuple.empty.arguments).not.toBeNull();
    expect(TypeTuple.empty.arguments!.length).toBe(0);
    // ...while an EXPLICIT null still reaches D's `this(Parameters*)` behaviour (mtype.d:1931).
    expect(new TypeTuple(null).arguments).toBeNull();
  });

  it("TypeTuple's Form-B ctors are named factories, not a runtime type probe (mtype.d:1989/:1995)", () => {
    Type_init();
    const t1 = TypeTuple.fromType(Type.tint32);
    expect(t1.arguments!.length).toBe(1);
    expect(t1.arguments!.opIndex(0)!.type).toBe(Type.tint32);
    const t2 = TypeTuple.fromTypes(Type.tint32, Type.tint64);
    expect(t2.arguments!.length).toBe(2);
    expect(t2.arguments!.opIndex(1)!.type).toBe(Type.tint64);
    expect(TypeTuple.create().arguments!.length).toBe(0);
    expect(TypeTuple.createFromType(Type.tbool).arguments!.length).toBe(1);
  });

  it("TypeSArray's absent-dim form is the incomplete array; an explicit null stays null (mtype.d:1122/:1129)", () => {
    Type_init();
    const incomplete = new TypeSArray(Type.tint32);
    expect(incomplete.isIncomplete()).toBe(true);
    expect(new TypeSArray(Type.tint32, null).dim).toBeNull();
  });

  it("Parameter.toChars keeps D's `__anonymous_param` literal, NUL-terminated (mtype.d:2474)", () => {
    const p = new Parameter(Loc.initial, STC.none, null, null, null, null);
    const s = p.toChars();
    expect(dsToJs(cstr(s))).toBe("__anonymous_param");
    expect(s[s.length - 1]).toBe(0);
  });

  it("MODtoChars returns a NUL-terminated C string (mtype.d:281 `MODtoString(mod).ptr`)", () => {
    const s = MODtoChars(MODFlags.const_);
    expect(dsToJs(cstr(s))).toBe("const");
    expect(s[s.length - 1]).toBe(0);
    expect(cstrlen(MODtoChars(0))).toBe(0);
  });

  it("TypeFunction.iswild / attributesEqual are live (mtype.d:1464/:1470)", () => {
    Type_init();
    const mk = (): TypeFunction =>
      new TypeFunction(new ParameterList(new Array_<Parameter | null>()), Type.tint32, LINK.d);
    const a = mk();
    const b = mk();
    expect(a.iswild()).toBe(false);
    a.isInOutQual = true;
    expect(a.iswild()).toBe(true);
    expect(a.attributesEqual(b)).toBe(true);
    b.isNogc = true;
    expect(a.attributesEqual(b)).toBe(false);
    // trustSystemEqualsDefault collapses default_ and system (mtype.d:1480-1481).
    const c = mk();
    c.trust = TRUST.system;
    expect(mk().attributesEqual(c)).toBe(true);
    expect(mk().attributesEqual(c, false)).toBe(false);
  });

  it("ParameterList opApply/opEquals/hasDefaultArgs are live (mtype.d:2215/:2233/:2261)", () => {
    Type_init();
    const mkList = (withDefault: boolean): ParameterList => {
      const ps = new Array_<Parameter | null>();
      ps.push(new Parameter(Loc.initial, STC.none, Type.tint32, null,
        withDefault ? IntegerExp.fromValue(1n) : null, null));
      return new ParameterList(ps);
    };
    const plain = mkList(false);
    expect(plain.length()).toBe(1);

    const seen: number[] = [];
    expect(plain.opApply((i, _p) => { seen.push(i); return 0; })).toBe(0);
    expect(seen).toEqual([0]);
    // A non-zero control code stops the walk and is returned (05 §11).
    expect(plain.opApply((_i, _p) => 7)).toBe(7);

    expect(plain.hasDefaultArgs()).toBe(false);
    expect(plain.hasArgsWithoutDefault()).toBe(true);
    expect(mkList(true).hasDefaultArgs()).toBe(true);
    expect(mkList(true).hasArgsWithoutDefault()).toBe(false);

    // opEquals: same storage class + same Type identity per position (mtype.d:2581).
    expect(plain.opEquals(mkList(false))).toBe(true);
    expect(plain.opEquals(new ParameterList(new Array_<Parameter | null>()))).toBe(false);
  });

  it("Parameter._foreach / _foreachSemantic are separate Form-B entries (mtype.d:2417/:2424)", () => {
    Type_init();
    const ps = new Array_<Parameter | null>();
    ps.push(new Parameter(Loc.initial, STC.none, Type.tint32, null, null, null));
    ps.push(new Parameter(Loc.initial, STC.none, Type.tint64, null, null, null));

    const idxs: number[] = [];
    Parameter._foreach(ps, (i, _p) => { idxs.push(i); return 0; });
    expect(idxs).toEqual([0, 1]);

    const pairs: string[] = [];
    Parameter._foreachSemantic(ps, (oidx, _op, eidx, _ep) => { pairs.push(`${oidx}/${eidx}`); return 0; });
    expect(pairs).toEqual(["0/0", "1/1"]);

    // A tuple-typed parameter expands and does NOT itself count toward arity (mtype.d:2449-2470),
    // and the tuple test is on the RAW type — no toBasetype() step.
    const inner = new Array_<Parameter | null>();
    inner.push(new Parameter(Loc.initial, STC.none, Type.tint32, null, null, null));
    inner.push(new Parameter(Loc.initial, STC.none, Type.tbool, null, null, null));
    const outer = new Array_<Parameter | null>();
    outer.push(new Parameter(Loc.initial, STC.none, new TypeTuple(inner), null, null, null));
    expect(Parameter.dim(outer)).toBe(2);
    expect(Parameter.getNth(outer, 1)!.type).toBe(Type.tbool);
  });

  it("Parameter.isCovariantScope reads the folded covariant[][] table (mtype.d:2541/:2544)", () => {
    // Rows read off the D comment's From\To diagram (mtype.d:2548-2558).
    const ref = STC.ref_;
    const retRef = (STC.return_ | STC.ref_) as unknown as typeof STC.none;
    // Ref -> ReturnRef is covariant; ReturnRef -> Ref is not.
    expect(Parameter.isCovariantScope(true, ref, retRef)).toBe(true);
    expect(Parameter.isCovariantScope(true, retRef, ref)).toBe(false);
    // Identity is always covariant (the i==i diagonal).
    expect(Parameter.isCovariantScope(true, ref, ref)).toBe(true);
    // Differing in `ref` is never covariant (mtype.d:2526).
    expect(Parameter.isCovariantScope(true, ref, STC.none)).toBe(false);
  });

  it("Type.arraySyntaxCopy deep-copies and preserves null slots (mtype.d:823)", () => {
    Type_init();
    expect(Type.arraySyntaxCopy(null)).toBeNull();
    const types = new Array_<Type | null>();
    types.push(Type.tint32);
    types.push(null);
    const a = Type.arraySyntaxCopy(types)!;
    expect(a.length).toBe(2);
    expect(a.opIndex(0)).toBe(Type.tint32); // TypeBasic.syntaxCopy returns `this` (mtype.d:1036)
    expect(a.opIndex(1)).toBeNull();
    expect(a).not.toBe(types);
  });

  it("Parameter.create forwards to the ctor (mtype.d:2307)", () => {
    Type_init();
    const p = Parameter.create(Loc.initial, STC.ref_, Type.tint32, null, null, null);
    expect(p.type).toBe(Type.tint32);
    expect(p.isReference()).toBe(true);
  });

  it("Type.getUniqueID is 0 without a deco and stable per distinct deco (mtype.d:593)", () => {
    Type_init();
    const fresh = new TypeTuple();
    expect(fresh.deco).toBeNull();
    expect(fresh.getUniqueID()).toBe(0);
    const a = Type.tint32.getUniqueID();
    expect(a).not.toBe(0);
    expect(Type.tint32.getUniqueID()).toBe(a);
    expect(Type.tint64.getUniqueID()).not.toBe(a);
  });
});

// mtype.d:2145 — TypeTag redeclares `MOD mod`, so D gives a TypeTag object two slots: TypeTag-typed
// accesses (cparse.d:4943, hdrgen.d:4504-4524) use TypeTag's, Type-level ones use Type.mod (mtype.d:394).
// The port names the derived slot `modTag` (02 §11.5b). Expected values are D's: the tag is built as
// cparse.d:4097 builds it and const is ORed in as toConst does (cparse.d:4943).
describe("mtype.d:2145 TypeTag.mod — the shadow-split slot modTag (02 §11.5b)", () => {
  const constTag = (): TypeTag => {
    const tt = new TypeTag(Loc.initial, TOK.struct_, null, new structalign_t(), null, null, null);
    tt.modTag |= MODFlags.const_; // cparse.d:4943 — `tt.mod |= MODFlags.const_;`
    return tt;
  };

  it("the ctor clears TypeTag's slot and leaves Type.mod at its default (mtype.d:2158)", () => {
    Type_init();
    const tt = new TypeTag(Loc.initial, TOK.union_, null, new structalign_t(), null, null, null);
    expect(tt.modTag).toBe(0);
    expect(tt.mod).toBe(0);
  });

  it("const in TypeTag's slot is invisible to Type-level reads (isConst, isMutable)", () => {
    Type_init();
    const tt = constTag();
    expect(tt.modTag).toBe(MODFlags.const_);
    expect(tt.mod).toBe(0);
    expect(tt.isConst()).toBe(false);
    expect(tt.isMutable()).toBe(true);
  });

  it("toConst's pointee test sees a mutable tag: `const struct S * const` keeps the pointer mutable", () => {
    // cparse.d:4949 — `if (!tn || tn.isConst())` on the pointer's next: false, so no const is added.
    Type_init();
    const tn = nextOf(new TypePointer(constTag()));
    expect(tn).not.toBeNull();
    expect(tn!.isConst()).toBe(false);
  });

  it("copy() carries both slots: D memcpys sizeTy[Ttag], the whole TypeTag (mtype.d:525, :542)", () => {
    Type_init();
    const tt = constTag();
    tt.mod = MODFlags.shared_;
    const c = tt.copy().isTypeTag()!;
    expect(c).not.toBe(tt);
    expect(c.modTag).toBe(MODFlags.const_);
    expect(c.mod).toBe(MODFlags.shared_);
  });
});
