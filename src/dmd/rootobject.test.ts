import { describe, it, expect } from "vitest";
import { DYNCAST, RootObject } from "./rootobject.js";
import { DError } from "../assert.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";

// Minimal concrete subclass mirroring how every real AST node overrides the base:
// it provides toChars() and a dyncast() tag. Exercises virtual dispatch through toString().
class Expr extends RootObject {
    constructor(private readonly bytes: DString) {
        super();
    }
    override toChars(): DString {
        return this.bytes;
    }
    override dyncast(): DYNCAST {
        return DYNCAST.expression;
    }
}

// A subclass that does NOT override toChars() — to confirm the base abstract behavior is
// inherited (calling it still throws) while dyncast() can be overridden independently.
class TagOnly extends RootObject {
    override dyncast(): DYNCAST {
        return DYNCAST.dsymbol;
    }
}

describe("DYNCAST", () => {
    it("assigns 0..10 in declaration order (values are observable contract, 08 §1)", () => {
        expect(DYNCAST.object).toBe(0);
        expect(DYNCAST.expression).toBe(1);
        expect(DYNCAST.dsymbol).toBe(2);
        expect(DYNCAST.type).toBe(3);
        expect(DYNCAST.identifier).toBe(4);
        expect(DYNCAST.tuple).toBe(5);
        expect(DYNCAST.parameter).toBe(6);
        expect(DYNCAST.statement).toBe(7);
        expect(DYNCAST.condition).toBe(8);
        expect(DYNCAST.templateparameter).toBe(9);
        expect(DYNCAST.initializer).toBe(10);
    });

    it("has exactly 11 named members", () => {
        // Reverse mappings make Object.keys twice the member count for a numeric enum.
        const names = Object.keys(DYNCAST).filter((k) => Number.isNaN(Number(k)));
        expect(names.length).toBe(11);
    });
});

describe("RootObject base", () => {
    it("dyncast() returns DYNCAST.object on a bare RootObject (rootobject.d:54)", () => {
        expect(new RootObject().dyncast()).toBe(DYNCAST.object);
    });

    it("toChars() is abstract — throws DError (the assert(0), rootobject.d:43)", () => {
        const r = new RootObject();
        expect(() => r.toChars()).toThrow(DError);
    });

    it("toString() throws because it dispatches to the abstract toChars()", () => {
        const r = new RootObject();
        expect(() => r.toString()).toThrow(DError);
    });

    it("an unoverridden toChars() in a subclass still throws (abstract inherited)", () => {
        const t = new TagOnly();
        expect(() => t.toChars()).toThrow(DError);
        expect(() => t.toString()).toThrow(DError);
        // dyncast override is independent and works:
        expect(t.dyncast()).toBe(DYNCAST.dsymbol);
    });
});

describe("RootObject virtual dispatch (verified against ldc2)", () => {
    it("toString() forwards to the subclass toChars() and returns its DString bytes", () => {
        const e = new Expr(ds("hello"));
        const s = e.toString();
        expect(s).toBeInstanceOf(Uint8Array);
        expect(Array.from(s)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    });

    it("toChars() and toString() return the same bytes when toChars() carries no NUL", () => {
        const e = new Expr(ds("World"));
        expect(Array.from(e.toString())).toEqual(Array.from(e.toChars()));
    });

    it("toString() stops at the NUL an extractChars-style toChars() keeps (rootobject.d:50-51 strlen slice)", () => {
        const e = new Expr(ds("int\0"));
        expect(Array.from(e.toString())).toEqual([0x69, 0x6e, 0x74]); // "int", as D's p[0 .. strlen(p)]
    });

    it("the returned DString has no embedded NUL (DString carries its own length)", () => {
        const e = new Expr(ds("abc"));
        const s = e.toString();
        expect(s.length).toBe(3);
        expect(Array.from(s)).not.toContain(0);
    });

    it("dyncast() override returns the subclass tag, not DYNCAST.object", () => {
        const e = new Expr(ds("x"));
        expect(e.dyncast()).toBe(DYNCAST.expression);
        expect(e.dyncast()).not.toBe(DYNCAST.object);
    });

    it("returns the exact same DString reference the subclass supplies (no copy)", () => {
        const bytes = ds("ref");
        const e = new Expr(bytes);
        expect(e.toChars()).toBe(bytes); // identity: base toString just forwards
    });
});
