import { describe, test, expect, beforeAll } from "vitest";
import { importHint, initImphint } from "./imphint.js";
import { ds } from "../dstring.js";

// Port of the in-source unittest{} block of dmd/imphint.d (10 §1.2: bare block -> "unittest#1").
//
// `importHint` reads the module-level `hints` table, which D builds in `shared static this()`
// (ported to `initImphint()`). The D unittest runner runs module constructors before unittests; we
// reproduce that with a `beforeAll` that calls `initImphint()` once (10 §1.5: emit the same init the
// D runner does when a block touches module-construction state). `initImphint` is idempotent.
//
// The lookup keys are D `string` literals = byte slices (DString), built with `ds(...)` (all ASCII).
// D `!is null` / `is null` on the returned `const(char)[]` -> TS `!== null` / `=== null` (verified
// with ldc2: a found hint returns the value slice, an absent one returns a null slice).

describe("imphint.d", () => {
    beforeAll(() => {
        initImphint();
    });

    // imphint.d:180
    test("unittest#1", () => {
        expect(importHint(ds("printf"))).not.toBe(null);
        expect(importHint(ds("fabs"))).not.toBe(null);
        expect(importHint(ds("xxxxx"))).toBe(null);
    });
});
