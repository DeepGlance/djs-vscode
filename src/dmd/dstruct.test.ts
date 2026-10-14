// Goal tests for src/dmd/dstruct.ts.
//
// dmd/dstruct.d has ZERO in-source `unittest{}` blocks, so this file takes the 10 §1.6b shape:
// one module-load smoke test (importing the module executes its top level, catching load-order /
// cycle regressions in the core SCC) plus a small set of behavior pins the EXISTING harness
// reaches honestly — node construction the way aggregate.test.ts builds it, and the pure accessors
// (`kind`, `hasCopyConstruction`, `numArgTypes`, `argType`, the resolved bit-field pairs).
//
// No new harness machinery is built here (10 §1.6b): everything below is constructible with the
// canonical init snippet (10 §1.5) — initTokens() first (it also runs Identifier.initTable), then
// Id.initialize() and Loc._init().

import { beforeEach, describe, expect, test } from "vitest";
import { StructDeclaration, StructFlags, UnionDeclaration } from "./dstruct.js";
import { DSYM } from "./dsymbol.js";
import { TypeStruct, TypeTuple } from "./mtype.js";
import { Parameter } from "./mtype.js";
import { Array as Array_ } from "./root/array.js";
import { STC, ThreeState } from "./astenums.js";
import { Id } from "./id.js";
import { Identifier } from "./identifier.js";
import { Loc } from "./location.js";
import { initTokens } from "./tokens.js";
import { dsToJs } from "../dstring.js";
import type { Parameters } from "./arraytypes.js";

beforeEach(() => {
    initTokens(); // also runs Identifier.initTable
    Id.initialize();
    Loc._init();
});

function id(name: string): Identifier {
    return Identifier.idPool(Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))));
}

/// `new StructDeclaration(loc, id, inObject: false)` — the shape every non-`object.d` parse uses
/// (dmd/parse.d builds struct declarations with `inObject` false).
function makeStruct(name = "S"): StructDeclaration {
    return new StructDeclaration(Loc.initial, id(name), false);
}

describe("module load", () => {
    test("smoke: importing dmd.dstruct executes its top level and exports the D symbols", () => {
        expect(typeof StructDeclaration).toBe("function");
        expect(typeof UnionDeclaration).toBe("function");
        expect(typeof StructFlags).toBe("object");
    });
});

describe("StructFlags (dmd/dstruct.d:30)", () => {
    test("members keep D's values", () => {
        expect(StructFlags.none).toBe(0x0);
        expect(StructFlags.hasPointers).toBe(0x1);
    });
});

describe("StructDeclaration constructor (dmd/dstruct.d:83)", () => {
    test("tags itself DSYM.structDeclaration and builds the forward-reference TypeStruct", () => {
        const sd = makeStruct();
        expect(sd.dsym).toBe(DSYM.structDeclaration);
        expect(sd.type).toBeInstanceOf(TypeStruct);
        // dmd/dstruct.d:90 — `type = new TypeStruct(this)`: the forward reference points back.
        expect(sd.type!.isTypeStruct()!.sym).toBe(sd);
    });

    test("D default-inits: ispod == ThreeState.none, zeroInit == false, empty postblits", () => {
        const sd = makeStruct();
        expect(sd.ispod).toBe(ThreeState.none);   // dmd/dstruct.d:88
        expect(sd.zeroInit).toBe(false);          // dmd/dstruct.d:87
        expect(sd.postblit).toBe(null);
        expect(sd.postblits.length).toBe(0);      // dmd/dstruct.d:41 — Array!FuncDeclaration begins empty
        expect(sd.argTypes).toBe(null);
        expect(sd.alignment.isUnknown()).toBe(true); // structalign_t .init == value 0 == unknown
    });

    test("static create() is the constructor (dmd/dstruct.d:99)", () => {
        const sd = StructDeclaration.create(Loc.initial, id("S"), false);
        expect(sd).toBeInstanceOf(StructDeclaration);
        expect(sd.dsym).toBe(DSYM.structDeclaration);
    });

    test("kind() is \"struct\" (dmd/dstruct.d:113)", () => {
        expect(dsToJs(makeStruct().kind())).toBe("struct");
    });
});

describe("the resolved generateBitFields accessors (dmd/dstruct.d:57-81)", () => {
    // The mixin packs 12 one-bit `bool` members into one `ushort` (declaration order,
    // `requestTypeInfo` excluded because IN_LLVM is ON). The storage word itself is `private` in
    // both D (common/bitfields.d:118) and the port, so the bit INDEX a member occupies is not
    // observable from here — and it is not observable in D either. These pins therefore assert
    // what the public surface does expose, which is exactly what a wrong bit assignment would
    // break: every member reads back what was written, and no member disturbs another (a bit
    // collision shows up as a sibling flipping). The layout itself is audited in dstruct.ts,
    // against the D declaration order.
    test("all 12 members start false", () => {
        const sd = makeStruct();
        expect(sd.hasIdentityAssign).toBe(false);
        expect(sd.hasBlitAssign).toBe(false);
        expect(sd.hasIdentityEquals).toBe(false);
        expect(sd.hasNoFields).toBe(false);
        expect(sd.hasCopyCtor).toBe(false);
        expect(sd.hasMoveCtor).toBe(false);
        expect(sd.hasPointerField).toBe(false);
        expect(sd.hasVoidInitPointers).toBe(false);
        expect(sd.hasUnsafeBitpatterns).toBe(false);
        expect(sd.hasFieldWithInvariant).toBe(false);
        expect(sd.computedTypeProperties).toBe(false);
    });

    // Named write/read pairs rather than string-keyed access: no cast, and a renamed member
    // becomes a compile error instead of a silently-skipped pin.
    const members: ReadonlyArray<
        readonly [string, (s: StructDeclaration, v: boolean) => void, (s: StructDeclaration) => boolean]
    > = [
        ["zeroInit", (s, v) => { s.zeroInit = v; }, (s) => s.zeroInit],
        ["hasIdentityAssign", (s, v) => { s.hasIdentityAssign = v; }, (s) => s.hasIdentityAssign],
        ["hasBlitAssign", (s, v) => { s.hasBlitAssign = v; }, (s) => s.hasBlitAssign],
        ["hasIdentityEquals", (s, v) => { s.hasIdentityEquals = v; }, (s) => s.hasIdentityEquals],
        ["hasNoFields", (s, v) => { s.hasNoFields = v; }, (s) => s.hasNoFields],
        ["hasCopyCtor", (s, v) => { s.hasCopyCtor = v; }, (s) => s.hasCopyCtor],
        ["hasMoveCtor", (s, v) => { s.hasMoveCtor = v; }, (s) => s.hasMoveCtor],
        ["hasPointerField", (s, v) => { s.hasPointerField = v; }, (s) => s.hasPointerField],
        ["hasVoidInitPointers", (s, v) => { s.hasVoidInitPointers = v; }, (s) => s.hasVoidInitPointers],
        ["hasUnsafeBitpatterns", (s, v) => { s.hasUnsafeBitpatterns = v; }, (s) => s.hasUnsafeBitpatterns],
        ["hasFieldWithInvariant", (s, v) => { s.hasFieldWithInvariant = v; }, (s) => s.hasFieldWithInvariant],
        ["computedTypeProperties", (s, v) => { s.computedTypeProperties = v; }, (s) => s.computedTypeProperties],
    ];

    test("each member owns its own bit: setting one flips it and NOTHING else", () => {
        // The observable form of "each member owns exactly its declared bit": if two members
        // shared a bit (or a setter's mask were wrong), writing one would flip a sibling here.
        for (const [name, set] of members) {
            const sd = makeStruct();
            set(sd, true);
            for (const [otherName, , get] of members) {
                expect(get(sd), `${name}=true must leave ${otherName} at ${otherName === name}`)
                    .toBe(otherName === name);
            }
            set(sd, false);
            for (const [otherName, , get] of members)
                expect(get(sd), `${name}=false must leave ${otherName} false`).toBe(false);
        }
    });

    test("setting one member leaves the others untouched", () => {
        const sd = makeStruct();
        sd.hasCopyCtor = true;
        sd.computedTypeProperties = true;
        expect(sd.hasCopyCtor).toBe(true);
        expect(sd.computedTypeProperties).toBe(true);
        expect(sd.zeroInit).toBe(false);
        expect(sd.hasMoveCtor).toBe(false);
    });
});

describe("hasCopyConstruction (dmd/dstruct.d:123)", () => {
    test("false when there is neither a postblit nor a copy constructor", () => {
        expect(makeStruct().hasCopyConstruction()).toBe(false);
    });

    test("true when hasCopyCtor is set", () => {
        const sd = makeStruct();
        sd.hasCopyCtor = true;
        expect(sd.hasCopyConstruction()).toBe(true);
    });
});

describe("numArgTypes / argType (dmd/dstruct.d:133,:138)", () => {
    test("0 and null while argTypes is unset", () => {
        const sd = makeStruct();
        expect(sd.numArgTypes()).toBe(0);
        expect(sd.argType(0)).toBe(null);
    });

    test("0 and null when argTypes carries a null `arguments` pointer", () => {
        const sd = makeStruct();
        // `new TypeTuple(null)` reaches D's `this(Parameters*)` with a null pointer (mtype.ts).
        sd.argTypes = new TypeTuple(null);
        expect(sd.numArgTypes()).toBe(0);
        expect(sd.argType(0)).toBe(null);
    });

    test("counts the tuple's parameters and returns the index-th type, null past the end", () => {
        const sd = makeStruct();
        const params: Parameters = new Array_<Parameter | null>();
        const t0 = makeStruct("A").type!;
        const t1 = makeStruct("B").type!;
        params.push(new Parameter(Loc.initial, STC.none, t0, null, null, null));
        params.push(new Parameter(Loc.initial, STC.none, t1, null, null, null));
        sd.argTypes = new TypeTuple(params);
        expect(sd.numArgTypes()).toBe(2);
        expect(sd.argType(0)).toBe(t0);
        expect(sd.argType(1)).toBe(t1);
        expect(sd.argType(2)).toBe(null);   // index >= numArgTypes -> null
    });
});

describe("UnionDeclaration (dmd/dstruct.d:148)", () => {
    test("is a StructDeclaration tagged DSYM.unionDeclaration", () => {
        const ud = new UnionDeclaration(Loc.initial, id("U"));
        expect(ud).toBeInstanceOf(StructDeclaration);
        expect(ud.dsym).toBe(DSYM.unionDeclaration);
        // dmd/dstruct.d:152 — `super(loc, id, false)`: the struct ctor still runs.
        expect(ud.type).toBeInstanceOf(TypeStruct);
        expect(ud.ispod).toBe(ThreeState.none);
    });

    test("kind() is \"union\" (dmd/dstruct.d:164)", () => {
        expect(dsToJs(new UnionDeclaration(Loc.initial, id("U")).kind())).toBe("union");
    });

    test("syntaxCopy asserts on a non-null destination (dmd/dstruct.d:158)", () => {
        const ud = new UnionDeclaration(Loc.initial, id("U"));
        const other = new UnionDeclaration(Loc.initial, id("V"));
        expect(() => ud.syntaxCopy(other)).toThrow();
    });
});
