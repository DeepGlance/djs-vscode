// Vitest port of the in-source `unittest{}` blocks of dmd/func.d (10 §1), plus a thin set of
// behaviour pins over the translated declarations (10 §1.6b).
//
// dmd/func.d carries exactly ONE `unittest{}` block (func.d:801), which exercises
// `MODMatchToBuffer`; it is ported verbatim below as `unittest#1`.
//
// Harness init follows the canonical snippet (10 §1.5): Loc._init() + initTokens() + Id.initialize()
// so the constructors that need interned identifiers (CtorDeclaration -> Id.ctor, NewDeclaration ->
// Id.classNew, DtorDeclaration -> Id.dtor, …) work.

import { beforeEach, describe, expect, test } from "vitest";
import {
    AttributeViolation,
    BUILTIN,
    CtorDeclaration,
    DtorDeclaration,
    Ensure,
    FuncAliasDeclaration,
    FuncDeclaration,
    ILS,
    InvariantDeclaration,
    MODMatchToBuffer,
    NewDeclaration,
    ParameterDFAInfo,
    ParametersDFAInfo,
    SharedStaticCtorDeclaration,
    SharedStaticDtorDeclaration,
    StaticCtorDeclaration,
    StaticDtorDeclaration,
    UnitTestDeclaration,
} from "./func.js";
import { AssertError } from "../assert.js";
import { DSYM, Visibility } from "./dsymbol.js";
import { LINK, MODFlags, STC, VarArg } from "./astenums.js";
import { Id } from "./id.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { Objc } from "./objc.js";
import { Identifier } from "./identifier.js";
import { OutBuffer } from "./common/outbuffer.js";
import { ExpStatement } from "./statement.js";
import { Array as DArray } from "./root/array.js";
import type { Ensures } from "./arraytypes.js";
import { ParameterList, Type, TypeError as TypeErrorNode, TypeFunction } from "./mtype.js";
import { cstr, ds, dsToJs } from "../dstring.js";
import { Type_init } from "./typesem.js";

beforeEach(() => {
    Loc._init();
    initTokens();
    Id.initialize();
});

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

describe("func.d", () => {
    // dmd/func.d:801 — the module's only in-source unittest block.
    test("unittest#1", () => {
        const buf = new OutBuffer();
        let mismatches = MODMatchToBuffer(buf, MODFlags.shared_, 0);
        // D `buf[]` is a VIEW (opSliceAll), never a consuming extract (08 §13a.2).
        expect(dsToJs(buf.opSliceAll())).toBe("`shared` ");
        expect(mismatches.isNotShared).toBe(false);

        buf.setsize(0);
        mismatches = MODMatchToBuffer(buf, 0, MODFlags.shared_);
        expect(dsToJs(buf.opSliceAll())).toBe("non-shared ");
        expect(mismatches.isNotShared).toBe(true);

        buf.setsize(0);
        mismatches = MODMatchToBuffer(buf, MODFlags.const_, 0);
        expect(dsToJs(buf.opSliceAll())).toBe("`const` ");
        expect(mismatches.isMutable).toBe(false);

        buf.setsize(0);
        mismatches = MODMatchToBuffer(buf, 0, MODFlags.const_);
        expect(dsToJs(buf.opSliceAll())).toBe("mutable ");
        expect(mismatches.isMutable).toBe(true);
    });
});

describe("MODMatchToBuffer — the arms the upstream unittest does not cover (func.d:760)", () => {
    test("immutable and inout lhs print their own keyword", () => {
        const buf = new OutBuffer();
        MODMatchToBuffer(buf, MODFlags.immutable_, 0);
        expect(dsToJs(buf.opSliceAll())).toBe("`immutable` ");

        buf.setsize(0);
        MODMatchToBuffer(buf, MODFlags.wild, 0);
        expect(dsToJs(buf.opSliceAll())).toBe("`inout` ");
    });

    test("bothMutable && sharedMismatchOnly prints only the shared half (func.d:782)", () => {
        // lhs mutable-shared vs rhs mutable: `lhsMod & rhsMod` is 0 and the xor is exactly shared_,
        // so the second if-chain writes NOTHING and `isMutable` stays false.
        const buf = new OutBuffer();
        const m = MODMatchToBuffer(buf, MODFlags.shared_, 0);
        expect(dsToJs(buf.opSliceAll())).toBe("`shared` ");
        expect(m.isMutable).toBe(false);
    });
});

describe("FuncDeclaration ctor (func.d:367)", () => {
    test("assigns ident/type/endloc; tags funcDeclaration; a null type skips the infer branch", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("foo"), STC.none, null);
        expect(f.dsym).toBe(DSYM.funcDeclaration);
        expect(f.ident).not.toBeNull();
        expect(f.type).toBeNull();
        expect(f.visibility).toBeInstanceOf(Visibility);
        expect(f.visibility.kind).toBe(Visibility.Kind.undefined);
        // kind(): not isGenerated -> "function"
        expect(dsToJs(f.kind())).toBe("function");
        // no type -> the `if (type)` branch never runs, so inferRetType keeps its .init (false)
        expect(f.inferRetType).toBe(false);
        // endloc was stored via .copy() (value struct field store, 03 §1 #5)
        expect(f.endloc).not.toBe(Loc.initial);
    });

    test("a TypeFunction with a null return type sets inferRetType (func.d:389)", () => {
        const tfInfer = new TypeFunction(new ParameterList(null, VarArg.none), null, LINK.d);
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("infer"), STC.none, tfInfer);
        expect(f.inferRetType).toBe(true);

        const tfKnown = new TypeFunction(new ParameterList(null, VarArg.none), new TypeErrorNode(), LINK.d);
        const g = new FuncDeclaration(Loc.initial, Loc.initial, id("known"), STC.none, tfKnown);
        expect(g.inferRetType).toBe(false);
    });

    test("a non-function type hits the faithful assert(0) (func.d:392)", () => {
        expect(() => new FuncDeclaration(Loc.initial, Loc.initial, id("bad"), STC.none, new TypeErrorNode()))
            .toThrow(AssertError);
    });

    test("noreturn flag; storage_class is normalized against TYPECTOR|FUNCATTR (func.d:378)", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("nr"), STC.none, null, true);
        expect(f.noreturn).toBe(true);

        const tf = new TypeFunction(new ParameterList(null, VarArg.none), null, LINK.d);
        // STC.const_ is inside TYPECTOR -> stripped when a type is present; STC.static_ is not.
        const g = new FuncDeclaration(Loc.initial, Loc.initial, id("norm"),
            (STC.const_ | STC.static_) as STC, tf);
        expect((g.storage_class & STC.const_) === 0n).toBe(true);
        expect((g.storage_class & STC.static_) !== 0n).toBe(true);
    });

    test("isCodeseg/isOverloadable are always true; toAliasFunc is self", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("g"), STC.none, null);
        expect(f.isCodeseg()).toBe(true);
        expect(f.isOverloadable()).toBe(true);
        expect(f.toAliasFunc()).toBe(f);
    });

    test("isExport / isImportedSymbol read visibility + flags + body (func.d:562/567)", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("e"), STC.none, null);
        expect(f.isExport()).toBe(false);
        expect(f.isImportedSymbol()).toBe(false);
        f.visibility = new Visibility(Visibility.Kind.export_);
        expect(f.isExport()).toBe(true);
        // export + no body -> imported (a declaration)
        expect(f.isImportedSymbol()).toBe(true);
    });

    test("BUILTIN/ILS defaults match the D field initializers", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("d"), STC.none, null);
        expect(f.builtin).toBe(BUILTIN.unknown);
        expect(f.inlineStatusStmt).toBe(ILS.uninitialized);
        expect(f.inlineStatusExp).toBe(ILS.uninitialized);
        expect(f.vtblIndex).toBe(-1);
        // version(IN_LLVM) members are KEPT (we are LDC)
        expect(f.emitInstrumentation).toBe(true);
        expect(f.allowInlining).toBe(false);
        expect(f.neverInline).toBe(false);
    });

    test("saveFlags/restoreFlags round-trip the packed FUNCFLAG word (func.d:607/612)", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("fl"), STC.none, null);
        // isNRVO is the only FUNCFLAG member with a `true` initializer -> bit 12.
        expect(f.saveFlags()).toBe(1 << 12);
        expect(f.isNRVO).toBe(true);
        const saved = f.saveFlags();
        f.printf = true;
        expect(f.printf).toBe(true);
        expect(f.saveFlags()).toBe((1 << 12) | (1 << 9));
        f.restoreFlags(saved);
        expect(f.printf).toBe(false);
        expect(f.isNRVO).toBe(true);
    });

    test("getParameterList falls back to an empty non-variadic list (func.d:729)", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("p"), STC.none, null);
        const pl = f.getParameterList();
        expect(pl.parameters).toBeNull();
        expect(pl.varargs).toBe(VarArg.none);
    });

    test("getParameterList returns a VALUE copy, not the live TypeFunction field (func.d:721)", () => {
        // D's `final ParameterList getParameterList()` returns the struct by value (03 §1 #3), so a
        // caller mutating the result must not rewrite the function type.
        const tf = new TypeFunction(new ParameterList(null, VarArg.none), null, LINK.d);
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("pl"), STC.none, tf);
        const pl = f.getParameterList();
        expect(pl).not.toBe(tf.parameterList);
        pl.varargs = VarArg.variadic;
        expect(tf.parameterList.varargs).toBe(VarArg.none);
    });

    test("toFullSignature prints the postfix-attribute signature (func.d:523, hdrgen.d:3572)", () => {
        // `int sig() nothrow @safe` — the postfix form hdrgen.test.ts pins against the ldc2 probe
        // pf.d; toChars() of a parentless function is its bare identifier.
        Type_init();
        const tf = new TypeFunction(new ParameterList(null, VarArg.none), Type.tint32, LINK.d,
            (STC.nothrow_ | STC.safe) as STC);
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("sig"), STC.none, tf);
        expect(dsToJs(cstr(f.toFullSignature()))).toBe("int sig() nothrow @safe");
    });

    test("isThis(): the `static` arm asks objc(), which answers null without a selector (func.d:679)", () => {
        const plain = new FuncDeclaration(Loc.initial, Loc.initial, id("m"), STC.none, null);
        expect(plain.isThis()).toBeNull();   // isMemberLocal() of a parentless symbol
        // The driver runs `Objc._init()` at startup (main.d:445); the fixed target installs `Supported`,
        // whose isThis (objc.d:754) returns null when `fd.objc.selector` is null.
        Objc._init();
        try {
            const stat = new FuncDeclaration(Loc.initial, Loc.initial, id("s"), STC.static_, null);
            expect(stat.objc.selector).toBeNull();
            expect(stat.isThis()).toBeNull();
        } finally {
            Objc.deinitialize();
        }
    });
});

describe("FuncDeclaration contract accessors (func.d:401-437)", () => {
    test("getter is null until a non-null setter lazily allocates ContractInfo", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("c"), STC.none, null);
        expect(f.frequire()).toBeNull();
        expect(f.fensures()).toBeNull();
        // Setting null while empty is a no-op — no ContractInfo is allocated
        // (generateContractSetter). `contracts` is D module-private and truly class-local in
        // func.d, so it is TS `private` (01 §2.5); the allocation is observed only through the
        // accessors, which stay null either way.
        expect(f.setFrequire(null)).toBeNull();
        expect(f.frequire()).toBeNull();

        const st = new Ensure(id("res"), null);
        expect(st).toBeInstanceOf(Ensure);
        f.setFdrequire(f);
        expect(f.fdrequire()).toBe(f);
        // the group now exists: clearing a slot routes through it and is observable
        expect(f.setFrequire(null)).toBeNull();
        expect(f.frequire()).toBeNull();
        expect(f.fdrequire()).toBe(f);   // the other slots survive the clear
    });
});

describe("FuncDeclaration.findTemplateDeclRoot / inUnittest", () => {
    test("findTemplateDeclRoot returns null when the overload list has no template (func.d:457)", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("t"), STC.none, null);
        expect(f.findTemplateDeclRoot()).toBeNull();
    });

    test("inUnittest walks the parent chain (func.d:474)", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("u"), STC.none, null);
        expect(f.inUnittest()).toBe(false);
        const utd = new UnitTestDeclaration(Loc.initial, Loc.initial, STC.none, null);
        expect(utd.inUnittest()).toBe(true);       // itself a UnitTestDeclaration
        f.parent = utd;
        expect(f.inUnittest()).toBe(true);         // reached through toParent()
    });
});

describe("FuncDeclaration.searchLabel (func.d:497)", () => {
    test("interns one LabelDsymbol per identifier in labtab", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("lbl"), STC.none, null);
        expect(f.labtab).toBeNull();
        const a = f.searchLabel(id("L1"), Loc.initial);
        expect(f.labtab).not.toBeNull();
        expect(f.searchLabel(id("L1"), Loc.initial)).toBe(a);   // same mapping returned
        expect(f.searchLabel(id("L2"), Loc.initial)).not.toBe(a);
    });
});

describe("FuncDeclaration subclass constructors", () => {
    test("CtorDeclaration uses Id.ctor, tags ctorDeclaration, kind by flags (func.d:938)", () => {
        const c = new CtorDeclaration(Loc.initial, Loc.initial, STC.none, null);
        expect(c.dsym).toBe(DSYM.ctorDeclaration);
        expect(c.ident).toBe(Id.ctor);
        expect(dsToJs(c.kind())).toBe("constructor");
        c.isCpCtor = true;
        expect(dsToJs(c.kind())).toBe("copy constructor");
        c.isCpCtor = false;
        c.isMoveCtor = true;
        expect(dsToJs(c.kind())).toBe("move constructor");
    });

    test("DtorDeclaration's 2-argument D form defaults to Id.dtor/STC.none (func.d:997)", () => {
        const d = new DtorDeclaration(Loc.initial, Loc.initial);
        expect(d.dsym).toBe(DSYM.dtorDeclaration);
        expect(d.ident).toBe(Id.dtor);
        expect(d.storage_class).toBe(STC.none);
        expect(dsToJs(d.kind())).toBe("destructor");
    });

    test("StaticCtorDeclaration: 3-arg form names itself, 4-arg form takes the prefix", () => {
        const anon = new StaticCtorDeclaration(Loc.initial, Loc.initial, STC.none);
        expect(anon.dsym).toBe(DSYM.staticCtorDeclaration);
        expect((anon.storage_class & STC.static_) !== 0n).toBe(true);
        expect(dsToJs(anon.ident!.toString())).toContain("_staticCtor");
        expect(anon.isThis()).toBeNull();

        const shared = new SharedStaticCtorDeclaration(Loc.initial, Loc.initial, STC.none);
        expect(shared.dsym).toBe(DSYM.sharedStaticCtorDeclaration);
        expect(dsToJs(shared.ident!.toString())).toContain("_sharedStaticCtor");
        expect(shared.standalone).toBe(false);
    });

    // Regression pin: D writes the explicit non-virtual `FuncDeclaration.syntaxCopy(scd)` in both
    // Shared* classes (func.d:1080/:1141). Routing that through TS `super.` re-enters
    // StaticCtor/StaticDtor.syntaxCopy, whose `assert(s === null)` fires on the freshly built node.
    test("Shared static ctor/dtor syntaxCopy skips the StaticX base override (func.d:1080/1141)", () => {
        const sc = new SharedStaticCtorDeclaration(Loc.initial, Loc.initial, STC.none);
        sc.fbody = new ExpStatement(Loc.initial, null);
        const scCopy = sc.syntaxCopy(null);
        expect(scCopy).toBeInstanceOf(SharedStaticCtorDeclaration);
        expect(scCopy).not.toBe(sc);
        expect(scCopy.fbody).not.toBe(sc.fbody);   // FuncDeclaration.syntaxCopy ran on the target
        expect(scCopy.fbody).not.toBeNull();
        expect(dsToJs(scCopy.ident!.toString())).toContain("_sharedStaticCtor");

        const sd = new SharedStaticDtorDeclaration(Loc.initial, Loc.initial, STC.none);
        sd.fbody = new ExpStatement(Loc.initial, null);
        const sdCopy = sd.syntaxCopy(null);
        expect(sdCopy).toBeInstanceOf(SharedStaticDtorDeclaration);
        expect(sdCopy.fbody).not.toBe(sd.fbody);
        expect(dsToJs(sdCopy.ident!.toString())).toContain("_sharedStaticDtor");
    });

    test("StaticDtorDeclaration mirrors the ctor pair and has a null `this` (func.d:1092)", () => {
        const sdd = new StaticDtorDeclaration(Loc.initial, Loc.initial, STC.none);
        expect(sdd.dsym).toBe(DSYM.staticDtorDeclaration);
        expect(dsToJs(sdd.ident!.toString())).toContain("_staticDtor");
        expect(sdd.vgate).toBeNull();
        expect(sdd.isThis()).toBeNull();
    });

    test("NewDeclaration uses Id.classNew + STC.static_; kind='allocator' (func.d:1215)", () => {
        const n = new NewDeclaration(Loc.initial, STC.none);
        expect(n.dsym).toBe(DSYM.newDeclaration);
        expect(n.ident).toBe(Id.classNew);
        expect((n.storage_class & STC.static_) !== 0n).toBe(true);
        expect(dsToJs(n.kind())).toBe("allocator");
    });

    test("InvariantDeclaration generates an __invariant id when none given (func.d:1153)", () => {
        const i = new InvariantDeclaration(Loc.initial, Loc.initial, STC.none, null, null);
        expect(i.dsym).toBe(DSYM.invariantDeclaration);
        expect(dsToJs(i.ident!.toString())).toContain("__invariant");
    });

    test("UnitTestDeclaration has an empty deferredNested and a null `this` (func.d:1180)", () => {
        const u = new UnitTestDeclaration(Loc.initial, Loc.initial, STC.none, null);
        expect(u.dsym).toBe(DSYM.unitTestDeclaration);
        expect(u.deferredNested.length).toBe(0);
        expect(u.isThis()).toBeNull();
        expect(u.codedoc).toBeNull();
    });

    test("FuncAliasDeclaration wraps a target and forwards toAliasFunc + kind (func.d:827)", () => {
        const target = new FuncDeclaration(Loc.initial, Loc.initial, id("base"), STC.none, null);
        const fa = new FuncAliasDeclaration(id("aliasName"), target);
        expect(fa.dsym).toBe(DSYM.funcAliasDeclaration);
        expect(fa.funcalias).toBe(target);
        expect(fa.hasOverloads).toBe(true);
        expect(dsToJs(fa.kind())).toBe("function alias");
        expect(fa.toAliasFunc()).toBe(target); // forwards to target.toAliasFunc() (self)

        // hasOverloads=false requires the target NOT to be an alias itself (func.d:848)
        const inner = new FuncAliasDeclaration(id("inner"), target);
        expect(() => new FuncAliasDeclaration(id("outer"), inner, false)).toThrow(AssertError);
    });
});

describe("value structs in func.ts (03 §2)", () => {
    // `Mismatches` is D-function-local (func.d:762) and deliberately NOT exported by func.ts, so the
    // instance under test comes from MODMatchToBuffer — the only way D lets anyone hold one.
    test("Mismatches.copy() is an independent value copy", () => {
        const m = MODMatchToBuffer(new OutBuffer(), 0, MODFlags.const_);
        expect(m.isMutable).toBe(true);
        const c = m.copy();
        m.isMutable = false;
        expect(c.isMutable).toBe(true);
    });

    test("Ensure.syntaxCopy / arraySyntaxCopy deep-copy the statements (func.d:170/178)", () => {
        expect(Ensure.arraySyntaxCopy(null)).toBeNull();

        const st = new ExpStatement(Loc.initial, null);
        const e = new Ensure(id("res"), st);
        const ec = e.syntaxCopy();
        expect(ec.id).toBe(e.id);          // identifier is shared
        expect(ec.ensure).not.toBe(st);    // statement is deep-copied

        const arr: Ensures = new DArray<Ensure>();
        arr.push(e);
        const b = Ensure.arraySyntaxCopy(arr)!;
        expect(b).not.toBe(arr);                     // fresh container
        expect(b.length).toBe(1);
        expect(b.opIndex(0).ensure).not.toBe(st);    // each slot got its own syntaxCopy
        expect(arr.opIndex(0).ensure).toBe(st);      // the source array is untouched
    });

    test("FuncDeclaration.syntaxCopy copies the contracts/body into the target (func.d:439)", () => {
        const d = new DtorDeclaration(Loc.initial, Loc.initial);
        d.fbody = new ExpStatement(Loc.initial, null);
        const c = d.syntaxCopy(null);
        expect(c).toBeInstanceOf(DtorDeclaration);
        expect(c).not.toBe(d);
        expect(c.fbody).not.toBe(d.fbody);   // fbody.syntaxCopy()
        expect(c.frequires()).toBeNull();
        expect(c.ident).toBe(d.ident);
    });

    test("Ensure.copy() shares its class-ref fields (func.d:165)", () => {
        const e = new Ensure(id("res"), null);
        const c = e.copy();
        expect(c.id).toBe(e.id); // class ref: shared
        expect(c.ensure).toBeNull();
        // default construction: both fields null (D `Ensure e;`)
        const d = new Ensure();
        expect(d.id).toBeNull();
        expect(d.ensure).toBeNull();
    });

    test("ParameterDFAInfo defaults to Fact.Unspecified and copies field-wise (func.d:216)", () => {
        const p = new ParameterDFAInfo();
        expect(p.notNullIn).toBe(ParameterDFAInfo.Fact.Unspecified);
        expect(p.notNullOut).toBe(ParameterDFAInfo.Fact.Unspecified);
        expect(p.parameterId).toBe(0);
        p.notNullIn = ParameterDFAInfo.Fact.Guaranteed;
        const c = p.copy();
        p.notNullIn = ParameterDFAInfo.Fact.NotGuaranteed;
        expect(c.notNullIn).toBe(ParameterDFAInfo.Fact.Guaranteed);
    });

    test("ParametersDFAInfo recurses into its nested value structs (func.d:208)", () => {
        const ps = new ParametersDFAInfo();
        expect(ps.parameters).toBeNull();   // D slice .init is null, not an empty array
        ps.thisPointer.parameterId = -1;
        const c = ps.copy();
        ps.thisPointer.parameterId = 7;
        expect(c.thisPointer.parameterId).toBe(-1);   // nested struct was deep-copied
    });

    test("AttributeViolation.fromFuncDeclaration stores the focus function (func.d:1261)", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("v"), STC.none, null);
        const av = AttributeViolation.fromFuncDeclaration(Loc.initial, f);
        expect(av.fd).toBe(f);
        expect(av.action).toBeNull();
        expect(av.scopeVar).toBeNull();
        const c = av.copy();
        expect(c.fd).toBe(f);           // class ref: shared
        expect(c.loc).not.toBe(av.loc); // value struct: deep
    });

    test("AttributeViolation.fromFormat renders an argument-free format (func.d:1263)", () => {
        const av = AttributeViolation.fromFormat(Loc.initial, ds("cannot do it"), []);
        expect(dsToJs(av.action!)).toBe("cannot do it");
        expect(av.fd).toBeNull();
    });

    test("AttributeViolation.fromFormat renders each argument through toErrMsg(RootObject) (func.d:1268-1272)", () => {
        // hdrgen.d:112 dispatch: a Dsymbol prints through its toErrMsg (a plain function name is
        // `toChars()`), an Identifier through `toChars()`; the unused fourth slot renders "".
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("w"), STC.none, null);
        const av = AttributeViolation.fromFormat(Loc.initial, ds("%s calls %s via %s"), [f, id("g"), null]);
        expect(dsToJs(av.action!)).toBe("w calls g via ");
    });
});

describe("setThrow / setThrowCall are no-ops unless nothrow is being inferred (func.d:627/641)", () => {
    test("no violation is recorded when nothrowInprocess is false", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("t1"), STC.none, null);
        const g = new FuncDeclaration(Loc.initial, Loc.initial, id("t2"), STC.none, null);
        f.setThrow(Loc.initial, ds("throws"));
        f.setThrowCall(Loc.initial, g);
        expect(f.nothrowViolation).toBeNull();
    });

    test("setThrowCall records the callee once inference is in process", () => {
        const f = new FuncDeclaration(Loc.initial, Loc.initial, id("t3"), STC.none, null);
        const g = new FuncDeclaration(Loc.initial, Loc.initial, id("t4"), STC.none, null);
        f.nothrowInprocess = true;
        f.setThrowCall(Loc.initial, g);
        expect(f.nothrowViolation).toBeInstanceOf(AttributeViolation);
        expect(f.nothrowViolation!.fd).toBe(g);
        // the second call is a no-op — the first violation is kept
        const first = f.nothrowViolation;
        f.setThrowCall(Loc.initial, f);
        expect(f.nothrowViolation).toBe(first);
    });
});
