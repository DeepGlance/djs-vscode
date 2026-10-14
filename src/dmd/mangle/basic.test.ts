import { describe, test, expect } from "vitest";
import { dsToJs } from "../../dstring.js";
import { dmdformat } from "../root/dmdformat.js";
import { mangleChar } from "./basic.js";

// Ported from dmd/mangle/basic.d:87-98 (the single in-source `unittest{}` block).
// It asserts every TY index in `mangleChar` was assigned (no slot left at `char.init`).
// `char.init == 0xFF` (verified ldc2 /tmp/probe_charinit.d); our port pre-fills with 0xFF
// so an accidentally-missing slot reproduces D's char.init rather than `undefined`.
// `assert(0)` -> `expect.unreachable` (10-tests-diagnostics.md §1.4); the `fprintf(stderr, ...)`
// is the upstream debug print emitted only on that (never-taken) failure path.
describe("basic.d", () => {
    test("unittest#1", () => {
        mangleChar.forEach((mangle, i) => {
            if (mangle === 0xff) {
                // char.init
                process.stderr.write(dsToJs(dmdformat("ty = %u\n", [i >>> 0])));
                expect.unreachable(`mangleChar[${i}] is unfilled (char.init)`);
            }
        });
    });
});
