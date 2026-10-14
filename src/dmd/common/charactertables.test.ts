// Ported unittests from dmd/common/charactertables.d (10-tests-diagnostics.md §1).
//
// The three in-source `unittest{}` blocks each assert membership of the character 'ğ'.
// VERIFIED (ldc2-1.42.0, /tmp/probe_chartab.d): 'ğ' is code point 287 (0x11F). A `dchar`
// literal is a code-point `number` (02-types.md §1), so the D `'ğ'` argument maps to 0x11F.

import { describe, test, expect } from "vitest";
import {
    isAnyIdentifierCharacter,
    isAnyStart,
    isAnyContinue,
} from "./charactertables.js";

const gbreve = 0x11f; // 'ğ' — code point 287, the literal used by all three upstream unittests

describe("charactertables.d", () => {
    // BEFORE: unittest { assert(isAnyIdentifierCharacter('ğ')); }   (charactertables.d:80)
    test("unittest#1", () => {
        expect(isAnyIdentifierCharacter(gbreve)).toBe(true);
    });

    // BEFORE: unittest { assert(isAnyStart('ğ')); }                 (charactertables.d:98)
    test("unittest#2", () => {
        expect(isAnyStart(gbreve)).toBe(true);
    });

    // BEFORE: unittest { assert(isAnyContinue('ğ')); }              (charactertables.d:116)
    test("unittest#3", () => {
        expect(isAnyContinue(gbreve)).toBe(true);
    });
});
