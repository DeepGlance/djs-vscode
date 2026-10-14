// Goal tests for src/dmd/objc.ts.
//
// dmd/objc.d has ZERO in-source `unittest{}` blocks, so this file takes the 10 §1.6b shape: a
// module-load smoke test, then behaviour pins on nodes built by hand. Every diagnostic string is
// ground-truthed against ldc2 1.43.0 (the fail_compilation `objc_*.d` TEST_OUTPUT blocks and the
// probes quoted at each test); the qualifier differs only because hand-built nodes have no module
// parent (`C.g` here, `p1.C.g` from ldc2).
//
// Every `x as unknown as Dsymbol` / `as unknown as AggregateDeclaration` below is the 02 §11.5 upcast
// cascade: AggregateDeclaration.deferred (Dsymbol) shadows Dsymbol.deferred (bool), so TS rejects the
// nominal upcast of a ClassDeclaration; the runtime object is the class itself.
//
// LOAD ORDER (01 §4.8, 10 §1.5): `./objc.js` is the FIRST import, so this file proves the module
// can be the entry point of the module graph. The consumers of the next sweep (the *sem modules)
// will value-import it; func.ts and dclass.ts already do.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { Objc, ObjcClassDeclaration, ObjcFuncDeclaration, ObjcSelector, objc } from "./objc.js";
import { BaseClass, ClassDeclaration, InterfaceDeclaration } from "./dclass.js";
import { ClassKind } from "./aggregate.js";
import { FuncDeclaration } from "./func.js";
import { Expression, IntegerExp } from "./expression.js";
import { Parameter, ParameterList, Type, TypeClass, TypeFunction } from "./mtype.js";
import { LINK, STC, VarArg } from "./astenums.js";
import { Visibility } from "./dsymbol.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { global } from "./globals.js";
import { target } from "./target.js";
import { Array as DArray } from "./root/array.js";
import { ds, dsToJs } from "../dstring.js";
import { initSemaHarness } from "../sema-harness.js";
import { Module } from "./dmodule.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";
import type { Parameters } from "./arraytypes.js";
import type { Dsymbol } from "./dsymbol.js";
import type { AggregateDeclaration } from "./aggregate.js";

function id(name: string): Identifier {
    return Identifier.idPool(ds(name));
}

function cls(name: string): ClassDeclaration {
    return new ClassDeclaration(Loc.initial, id(name), null, null, false);
}

/// A function `name(params...)` whose type is a TypeFunction with the given parameter names.
function func(name: string, paramNames: string[], opts: { property?: boolean; linkage?: LINK } = {}): FuncDeclaration {
    const ps: Parameters = new DArray<Parameter | null>();
    for (const p of paramNames)
        ps.push(new Parameter(Loc.initial, STC.none, Type.tint32, id(p), null, null));
    const tf = new TypeFunction(new ParameterList(ps, VarArg.none), Type.tvoid, opts.linkage ?? LINK.d);
    if (opts.property)
        tf.isProperty = true;
    const fd = new FuncDeclaration(Loc.initial, Loc.initial, id(name), STC.none, tf);
    fd._linkage = opts.linkage ?? LINK.d;
    return fd;
}

/// Runs `fn` and returns what it wrote to stderr (the diagnostic printer's channel).
function stderrOf(fn: () => void): string {
    let captured = "";
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (s: string): boolean => {
        captured += s;
        return true;
    };
    try {
        fn();
    } finally {
        (process.stderr as { write: typeof orig }).write = orig;
    }
    return captured;
}

describe("module load", () => {
    test("smoke: objc.js as the graph entry evaluates and exports the D symbols", () => {
        expect(typeof ObjcSelector).toBe("function");
        expect(typeof ObjcClassDeclaration).toBe("function");
        expect(typeof ObjcFuncDeclaration).toBe("function");
        expect(typeof Objc).toBe("function");
        expect(typeof objc).toBe("function");
        // the classes objc.ts extends from or constructs at runtime are evaluated too
        expect(typeof ClassDeclaration).toBe("function");
        expect(typeof Expression).toBe("function");
    });
});

describe("objc.ts", () => {
    beforeEach(() => {
        initSemaHarness();
        global.gag = 0;
        Objc._init(); // main.d:445, after Id.initialize() and Module._init()
    });
    afterEach(() => {
        target.objc.supported = true; // the fixed target's value (gen/target.cpp:183)
        Objc.deinitialize();
    });

    describe("ObjcSelector", () => {
        test("lookup interns: the same bytes give the same object; colons are counted up to the NUL", () => {
            const a = ObjcSelector.lookup(ds("initWithFoo:bar:"));
            const b = ObjcSelector.lookup(ds("initWithFoo:bar:"));
            expect(a).toBe(b);
            expect(a.paramCount).toBe(2);
            expect(a.stringlen).toBe(16);
            expect(dsToJs(a.toString())).toBe("initWithFoo:bar:");
            // the C string stops at its NUL (objc.d:71 `while (*i != 0)`)
            const c = ObjcSelector.lookup(ds("x:\0y:"));
            expect(dsToJs(c.toString())).toBe("x:");
            expect(c.paramCount).toBe(1);
        });

        test("lookup(s, len, pcount) keys on s[0 .. len] and keeps the given count", () => {
            const s = ObjcSelector.lookup(ds("abc:def"), 4, 7);
            expect(dsToJs(s.toString())).toBe("abc:");
            expect(s.paramCount).toBe(7);
            // a later lookup of the same key returns the first object; its count is not rewritten
            expect(ObjcSelector.lookup(ds("abc:"))).toBe(s);
        });

        test("the table owns a copy of the key: mutating the caller's buffer does not change the selector", () => {
            const buf = ds("foo:");
            const s = ObjcSelector.lookup(buf);
            buf[0] = 0x7A;
            expect(dsToJs(s.toString())).toBe("foo:");
        });

        test("_init empties the table (Objc._init re-runs it via Supported's constructor)", () => {
            const a = ObjcSelector.lookup(ds("once"));
            ObjcSelector._init();
            expect(ObjcSelector.lookup(ds("once"))).not.toBe(a);
        });

        test("toPascalCase upper-cases an ASCII lower-case first byte only", () => {
            expect(dsToJs(ObjcSelector.toPascalCase(ds("foo")))).toBe("Foo");
            expect(dsToJs(ObjcSelector.toPascalCase(ds("Foo")))).toBe("Foo");
            expect(dsToJs(ObjcSelector.toPascalCase(ds("_x")))).toBe("_x");
        });

        // ldc2 probe: the selector strings in the object file of
        //   extern (Objective-C) class C : NSObject { void f1() {} void f2(int a) {}
        //   void f3(int a, int b, int c) {} @property void isFoo(bool v) {} @property void bar(int v) {}
        //   @property int bar() {...} @property void is_(int v) {} @property void Zed(int v) {}
        //   static void sm(int q, int r) {} }
        // are f1, f2:, f3:b:c:, setFoo:, setBar:, bar, set_:, setZed:, sm:r:.
        test.each([
            ["f1", [], false, "f1", 0],
            ["f2", ["a"], false, "f2:", 1],
            ["f3", ["a", "b", "c"], false, "f3:b:c:", 3],
            ["sm", ["q", "r"], false, "sm:r:", 2],
            ["isFoo", ["v"], true, "setFoo:", 1],
            ["bar", ["v"], true, "setBar:", 1],
            ["bar", [], true, "bar", 0],
            ["is_", ["v"], true, "set_:", 1],
            ["Zed", ["v"], true, "setZed:", 1],
        ] as [string, string[], boolean, string, number][])("create(%s) -> selector as ldc2 emits it",
            (name, params, prop, sel, n) => {
                const s = ObjcSelector.create(func(name, params, { property: prop, linkage: LINK.objc }));
                expect(dsToJs(s.toString())).toBe(sel);
                expect(s.paramCount).toBe(n);
            });
    });

    describe("Objc._init / objc() / deinitialize", () => {
        test("the fixed target installs Supported and predefines D_ObjectiveC", () => {
            // ldc2 probe: `version (D_ObjectiveC) static assert(0);` fires on the default target.
            const names: string[] = [];
            for (let i = 0; i < global.versionids.length; i++)
                names.push(dsToJs(global.versionids.opIndex(i)!.toString()));
            expect(names).toContain("D_ObjectiveC");
            // Supported.setObjc marks the class; Unsupported would report an error instead.
            const cd = cls("C");
            const out = stderrOf(() => objc()!.setObjc(cd));
            expect(out).toBe("");
            expect(cd.classKind).toBe(ClassKind.objc);
        });

        test("deinitialize resets the accessor to null", () => {
            expect(objc()).not.toBeNull();
            Objc.deinitialize();
            expect(objc()).toBeNull();
        });

        // ldc2 probe: `-mtriple=x86_64-unknown-linux-gnu` installs Unsupported.
        test("Unsupported: class and interface arms report ldc2's diagnostics", () => {
            target.objc.supported = false;
            Objc._init();
            const cd = cls("C");
            const idecl = new InterfaceDeclaration(Loc.initial, id("I"), null);
            const errs = global.errors;
            const out = stderrOf(() => {
                objc()!.setObjc(cd);
                objc()!.setObjcInterfaceDeclaration(idecl);
            });
            expect(out).toContain("Error: class `C` Objective-C classes not supported");
            expect(out).toContain("Error: interface `I` Objective-C interfaces not supported");
            expect(global.errors).toBe(errs + 2);
            expect(cd.classKind).toBe(ClassKind.d);
            // the queries only an Objective-C declaration reaches are D `assert(0)`
            expect(() => objc()!.getRuntimeMetaclass(cd))
                .toThrow("Should never be called when Objective-C is not supported");
            expect(objc()!.getParent(func("f", []), cd)).toBe(cd);
            expect(objc()!.isThis(func("f", []))).toBeNull();
        });
    });

    describe("ObjcClassDeclaration", () => {
        test("isRootClass: an Objective-C class with neither metaclass nor base class", () => {
            const cd = cls("Root");
            expect(cd.objc.isRootClass()).toBe(false); // classKind d
            cd.classKind = ClassKind.objc;
            expect(cd.objc.isRootClass()).toBe(true);
            cd.objc.metaclass = cls("Meta");
            expect(cd.objc.isRootClass()).toBe(false);
            cd.objc.metaclass = null;
            cd.baseClass = cls("Base");
            expect(cd.objc.isRootClass()).toBe(false);
        });
    });

    describe("Supported", () => {
        test("setObjc: extern storage sets isExtern; setObjc(interface) always extern", () => {
            const cd = cls("E");
            cd.storage_class = STC.extern_;
            objc()!.setObjc(cd);
            expect(cd.objc.isExtern).toBe(true);
            expect(cd.objc.isSwiftStub).toBe(false); // no UDA
            const idecl = new InterfaceDeclaration(Loc.initial, id("P"), null);
            objc()!.setObjcInterfaceDeclaration(idecl);
            expect(idecl.classKind).toBe(ClassKind.objc);
            expect(idecl.objc.isExtern).toBe(true);
        });

        test("getRuntimeMetaclass: a metaclass without metaclass walks to the root metaclass", () => {
            const rootMeta = cls("RootMeta");
            rootMeta.objc.isMeta = true;
            const meta = cls("Meta");
            meta.objc.isMeta = true;
            meta.baseClass = rootMeta;
            const c = cls("C");
            c.objc.metaclass = meta;
            expect(objc()!.getRuntimeMetaclass(c)).toBe(meta);
            expect(objc()!.getRuntimeMetaclass(meta)).toBe(rootMeta);
            expect(objc()!.getRuntimeMetaclass(rootMeta)).toBe(rootMeta);
        });

        test("getParent: a static member of an Objective-C class belongs to its metaclass; out contract", () => {
            const c = cls("C");
            c.classKind = ClassKind.objc;
            const meta = cls("Meta");
            c.objc.metaclass = meta;
            const sfd = func("s", []);
            sfd.storage_class = STC.static_;
            expect(objc()!.getParent(sfd, c)).toBe(meta);
            expect(objc()!.getParent(func("i", []), c)).toBe(c);
            c.objc.metaclass = null;
            expect(() => objc()!.getParent(sfd, c)).toThrow(); // out(metaclass) { assert(metaclass); }
        });

        test("isThis: the metaclass for a selector-carrying member of a non-meta Objective-C class", () => {
            const c = cls("C");
            c.classKind = ClassKind.objc;
            const meta = cls("Meta");
            c.objc.metaclass = meta;
            const fd = func("m", [], { linkage: LINK.objc });
            fd.parent = c as unknown as Dsymbol; // 02 §11.5 cascade (header)
            expect(objc()!.isThis(fd)).toBeNull(); // no selector
            fd.objc.selector = ObjcSelector.lookup(ds("m"));
            expect(objc()!.isThis(fd)).toBe(meta);
            c.objc.isMeta = true;
            expect(objc()!.isThis(fd)).toBeNull();
        });

        test("isVirtual: private/package are not virtual; a final interface member is not", () => {
            const c = cls("C");
            const fd = func("v", [], { linkage: LINK.objc });
            fd.parent = c as unknown as Dsymbol; // 02 §11.5 cascade (header)
            fd.visibility = new Visibility(Visibility.Kind.public_);
            expect(objc()!.isVirtual(fd)).toBe(true);
            fd.visibility = new Visibility(Visibility.Kind.private_);
            expect(objc()!.isVirtual(fd)).toBe(false);
            fd.visibility = new Visibility(Visibility.Kind.package_);
            expect(objc()!.isVirtual(fd)).toBe(false);
            const idecl = new InterfaceDeclaration(Loc.initial, id("I"), null);
            const g = func("g", [], { linkage: LINK.objc });
            g.parent = idecl as unknown as Dsymbol; // 02 §11.5 cascade (header)
            g.visibility = new Visibility(Visibility.Kind.public_);
            g.storage_class = STC.final_;
            expect(objc()!.isVirtual(g)).toBe(false);
        });

        test("addToClassMethodList / addSymbols: only Objective-C, selector-carrying, non-meta entries", () => {
            const c = cls("C");
            const fd = func("m", [], { linkage: LINK.objc });
            fd.parent = c as unknown as Dsymbol; // 02 §11.5 cascade (header)
            objc()!.addToClassMethodList(fd, c); // classKind d: no-op
            c.classKind = ClassKind.objc;
            objc()!.addToClassMethodList(fd, c); // no selector: no-op
            fd.objc.selector = ObjcSelector.lookup(ds("m"));
            objc()!.addToClassMethodList(fd, c);
            expect(c.objc.methodList).toEqual([fd]);

            const classes = new DArray<ClassDeclaration | null>();
            objc()!.addSymbols(c, classes, null);
            expect(classes.length).toBe(1);
            c.objc.isExtern = true;
            objc()!.addSymbols(c, classes, null);
            expect(classes.length).toBe(1);
        });

        test("createSelectorParameter: null without a selector", () => {
            const m = new Module(Loc.initial, ds("m.d"), id("m"), 0, 0);
            const sc = scopeCreateGlobal(m, global.errorSink!);
            expect(objc()!.createSelectorParameter(func("m", []), sc)).toBeNull();
        });

        // The two monomorphized copies of the setMetaclass template (objc.d:922) are pinned side by
        // side so drift between them fails here. The body ends in `dsymbolSemantic(metaclass, sc)`,
        // which today stops at dsymbolsem.ts's own objc.setMetaclass wall (dsymbolsem.d:5617/:6113)
        // AFTER every effect pinned below; `buildMetaclass` tolerates only that TODO-BODY halt, so
        // these tests pin objc.ts and not the foreign wall, and stay valid once the sweep lifts it.
        function buildMetaclass(run: () => void): string {
            return stderrOf(() => {
                try {
                    run();
                } catch (e) {
                    if (!(e instanceof Error) || !e.message.startsWith("TODO-BODY: objc.setMetaclass"))
                        throw e;
                }
            });
        }

        function scopeOf(name: string): { m: Module; sc: ReturnType<typeof scopeCreateGlobal> } {
            const m = new Module(Loc.initial, ds(name + ".d"), id(name), 0, 0);
            m.members = new DArray<Dsymbol | null>();
            return { m, sc: scopeCreateGlobal(m, global.errorSink!) };
        }

        test("setMetaclass (T = ClassDeclaration): metaclass built; non-Objective-C base diagnosed", () => {
            // ldc2 fail_compilation/objc_non_objc_base.d: `class A : Base {}` with a D interface base.
            const { m, sc } = scopeOf("mc");
            const base = new ClassDeclaration(Loc.initial, id("B"), null, new DArray<Dsymbol | null>(), false);
            const bcs = new DArray<BaseClass | null>();
            const bc = new BaseClass();
            bc.sym = base;
            bcs.push(bc);
            const c = new ClassDeclaration(Loc.initial, id("C"), bcs, new DArray<Dsymbol | null>(), false);
            c.classKind = ClassKind.objc;
            c.objc.isExtern = true;
            c.parent = m as unknown as Dsymbol; // 02 §11.5 cascade (header): Module.errors shadows Dsymbol.errors
            const out = buildMetaclass(() => objc()!.setMetaclass(c, sc));
            expect(out).toContain(
                "Error: class `mc.C` base class for an Objective-C class must be `extern (Objective-C)`\n");
            const meta = c.objc.metaclass!;
            expect(meta).toBeInstanceOf(ClassDeclaration);
            expect(meta).not.toBeInstanceOf(InterfaceDeclaration);
            expect(meta.objc.isMeta).toBe(true);
            expect(meta.objc.isExtern).toBe(true);
            expect(meta.classKind).toBe(ClassKind.objc);
            expect((meta.storage_class & STC.static_) !== 0n).toBe(true);
            expect(c.objc.identifier).toBe(c.ident);
            expect(meta.objc.identifier).toBe(c.ident);
            expect(meta.baseClass).toBeNull(); // no base class resolved yet
            // ldc2 -vcg-ast names it `__anonclass_C_Meta<N>`
            expect(dsToJs(meta.ident!.toString())).toMatch(/^__anonclass_C_Meta\d+$/);
            expect(c.members!.opIndex(c.members!.length - 1)).toBe(meta);
        });

        test("setMetaclass (T = InterfaceDeclaration): metaclass built; non-Objective-C base diagnosed", () => {
            // ldc2 probe: `interface K {} extern (Objective-C) interface J : K {}`.
            const { m, sc } = scopeOf("mi");
            const k = new InterfaceDeclaration(Loc.initial, id("K"), null);
            const bcs = new DArray<BaseClass | null>();
            const bc = new BaseClass();
            bc.sym = k;
            bcs.push(bc);
            const j = new InterfaceDeclaration(Loc.initial, id("J"), bcs);
            j.members = new DArray<Dsymbol | null>();
            j.classKind = ClassKind.objc;
            j.objc.isExtern = true;
            j.parent = m as unknown as Dsymbol; // 02 §11.5 cascade (header): Module.errors shadows Dsymbol.errors
            const out = buildMetaclass(() => objc()!.setMetaclassInterfaceDeclaration(j, sc));
            expect(out).toContain(
                "Error: interface `mi.J` base interface for an Objective-C interface must be `extern (Objective-C)`\n");
            const meta = j.objc.metaclass!;
            expect(meta).toBeInstanceOf(InterfaceDeclaration);
            expect(meta.objc.isMeta).toBe(true);
            expect(meta.objc.isExtern).toBe(true);
            expect(meta.classKind).toBe(ClassKind.objc);
            expect((meta.storage_class & STC.static_) !== 0n).toBe(true);
            expect(meta.objc.identifier).toBe(j.ident);
            expect(dsToJs(meta.ident!.toString())).toMatch(/^__anonclass_J_Meta\d+$/);
            expect(j.members!.opIndex(j.members!.length - 1)).toBe(meta);
        });

        test("setMetaclass: no-op for a non-Objective-C class and for a metaclass", () => {
            const c = cls("C");
            objc()!.setMetaclass(c, null);
            expect(c.objc.metaclass).toBeNull();
            c.classKind = ClassKind.objc;
            c.objc.isMeta = true;
            objc()!.setMetaclass(c, null);
            expect(c.objc.metaclass).toBeNull();
        });
    });

    // The message text is byte-exact against ldc2. The nodes carry `Loc.initial`, so the printer
    // emits no `file(line): ` prefix and a supplemental line starts with its 7-space header alone;
    // ldc2's `p1.d(16):        function ...` is that header after the location's `: `.
    describe("diagnostics (byte-exact against ldc2)", () => {
        test("validateSelector: colon count (fail_compilation/objc_class2.d)", () => {
            const fd = func("test", ["a", "b", "c"], { linkage: LINK.objc });
            fd.parent = cls("A") as unknown as Dsymbol; // 02 §11.5 cascade (header)
            fd.objc.selector = ObjcSelector.lookup(ds("test:"));
            const out = stderrOf(() => objc()!.validateSelector(fd));
            expect(out).toContain(
                "Error: function `A.test` number of colons in Objective-C selector must match number of parameters\n");
        });

        test("checkLinkage: a selector needs Objective-C linkage (fail_compilation/objc_class1.d)", () => {
            const fd = func("oneTwo", ["a", "b"]);
            fd.parent = cls("A") as unknown as Dsymbol; // 02 §11.5 cascade (header)
            fd.objc.selector = ObjcSelector.lookup(ds("one:two:"));
            const out = stderrOf(() => objc()!.checkLinkage(fd));
            expect(out).toContain("Error: function `A.oneTwo` must have Objective-C linkage to attach a selector\n");
        });

        test("validateOptional: D linkage outside an interface (ldc2 probe, `class D { void h() @optional; }`)", () => {
            const fd = func("h", []);
            fd.parent = cls("D") as unknown as Dsymbol; // 02 §11.5 cascade (header)
            fd.objc.isOptional = true;
            const out = stderrOf(() => objc()!.validateOptional(fd));
            expect(out).toContain(
                "Error: function `D.h` only functions with Objective-C linkage can be declared as optional\n" +
                "       function is declared with D linkage\n");
            expect(out).toContain(
                "Error: function `D.h` only functions declared inside interfaces can be optional\n" +
                "       function is declared inside class\n");
        });

        test("checkOffsetof (fail_compilation/objc_offsetof.d message shape)", () => {
            // `as unknown as AggregateDeclaration` below: upcast cascade (02 §11.5), the
            // AggregateDeclaration.deferred (Dsymbol) / Dsymbol.deferred (bool) shadow.
            const ad = cls("Foo");
            ad.classKind = ClassKind.objc;
            const e = new IntegerExp(Loc.initial, 0n, Type.tint32);
            const out = stderrOf(() => objc()!.checkOffsetof(e, ad as unknown as AggregateDeclaration));
            expect(out).toContain("Error: no property `offsetof` for member `0` of type `int`\n" +
                "       `offsetof` is not available for members of Objective-C classes. " +
                "Please use the Objective-C runtime instead\n");
            ad.classKind = ClassKind.d;
            expect(stderrOf(() => objc()!.checkOffsetof(e, ad as unknown as AggregateDeclaration))).toBe("");
        });

        test("checkTupleof (fail_compilation/objc_tupleof.d)", () => {
            const c = cls("Foo");
            c.classKind = ClassKind.objc;
            const e = new IntegerExp(Loc.initial, 0n, Type.tint32);
            const out = stderrOf(() => objc()!.checkTupleof(e, new TypeClass(c)));
            expect(out).toContain("Error: no property `tupleof` for type `Foo`\n" +
                "       `tupleof` is not available for members of Objective-C classes. " +
                "Please use the Objective-C runtime instead\n");
        });
    });
});
