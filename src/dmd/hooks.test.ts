// Co-located tests for src/dmd/hooks.ts (ported from dmd/hooks.d).
//
// dmd/hooks.d has no `unittest` block (10 §1.6b); its one function forwards to gen.ldctraits. The pins
// state the forwarding contract: a trait LDC does not own comes back `null`, so `semanticTraits` goes on
// with its own arms; an LDC trait comes back analysed. The value is ldc2 1.43.0's
// (`pragma(msg, __traits(targetCPU));` prints `generic` on arm64-apple-darwin).
import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { beforeEach, describe, expect, test } from "vitest";
import { Loc } from "./location.js";
import { TraitsExp } from "./expression.js";
import { Scope } from "./dscope.js";
import { Id } from "./id.js";
import { TY } from "./astenums.js";
import { dsToJs } from "../dstring.js";
import { nextOf } from "./typesem.js";
import { semanticTraitsHook } from "./hooks.js";

describe("hooks.ts", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("a trait LDC does not own is not recognized: null", () => {
        expect(semanticTraitsHook(new TraitsExp(Loc.initial, Id.isArithmetic, null), Scope.alloc())).toBeNull();
    });

    test("`__traits(targetCPU)` comes back as the analysed string literal \"generic\"", () => {
        const r = semanticTraitsHook(new TraitsExp(Loc.initial, Id.targetCPU, null), Scope.alloc());
        expect(r).not.toBeNull();
        const se = r!.isStringExp()!;
        expect(dsToJs(se.peekString())).toBe("generic");
        expect(se.type!.ty).toBe(TY.Tarray); // `typeof(__traits(targetCPU))` is `string` on ldc2
        expect(nextOf(se.type!)!.ty).toBe(TY.Tchar);
    });
});
