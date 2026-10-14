import { describe, test, expect } from "vitest";
import { MacroTable, utfStride } from "./dmacro.js";
import type { fp_t } from "./dmacro.js";
import { OutBuffer } from "./common/outbuffer.js";
import { ds } from "../dstring.js";
import type { DString } from "../dstring.js";

// Port of the in-source unittest{} block of dmd/dmacro.d (10 §1.2: a bare `unittest{}` →
// "unittest#1", 1-based source order), PLUS goal tests for `MacroTable.expand` that protect the
// faithful-expansion achievement. The `expand` engine is called from doc.ts (`gendocfile`), which the
// corpus reaches through -D; these goal tests isolate the engine and assert against
// byte sequences VERIFIED directly with ldc2-1.42.0 (the same `dmd.dmacro` + `OutBuffer`).

// box helper mirroring the module's `ref`/`out` cells.
interface Ref<T> {
    value: T;
}

// The id-character predicates `doc.d` passes to `expand` (C `isalpha`/`isalnum` + '_'), as `fp_t`
// (buf, p) callbacks. Verified against the ldc2 reference harness used to produce the expectations.
const isIdStart: fp_t = (buf: DString, p: number): boolean => {
    const c = buf[p];
    return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f; /* _ */
};
const isIdTail: fp_t = (buf: DString, p: number): boolean => {
    const c = buf[p];
    return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f;
};

/** Expand `input` through `mt` and return the resulting bytes (the whole buffer). */
function expandAll(mt: MacroTable, input: string, arg: DString | null = null, rl = 100): {
    ok: boolean;
    bytes: number[];
} {
    const buf = new OutBuffer();
    buf.writestring(ds(input));
    const end: Ref<number> = { value: buf.length() };
    const ok = mt.expand(buf, 0, end, arg, rl, isIdStart, isIdTail);
    return { ok, bytes: Array.from(buf.opSliceAll()) };
}

describe("dmacro", () => {
    // unittest#1 (dmacro.d:450) — utfStride lookup table.
    test("unittest#1: utfStride", () => {
        expect(utfStride(0)).toBe(1);
        expect(utfStride(0x80)).toBe(1);
        expect(utfStride(0xc0)).toBe(2);
        expect(utfStride(0xe0)).toBe(3);
        expect(utfStride(0xf0)).toBe(4);
        expect(utfStride(0xf8)).toBe(5);
        expect(utfStride(0xfc)).toBe(6);
        expect(utfStride(0xfe)).toBe(1);
    });

    // Goal tests: faithful $(NAME arg) expansion with the 0xFF "blue paint" markers (0xFF '{' …
    // 0xFF '}'). Expectations are the exact bytes ldc2-1.42.0 produced (verified).
    describe("expand (verified vs ldc2)", () => {
        function table(): MacroTable {
            const mt = new MacroTable();
            mt.define(ds("B"), ds("<b>$0</b>"));
            mt.define(ds("GREET"), ds("Hello, $1!"));
            mt.define(ds("ID"), ds("$0"));
            return mt;
        }

        test("simple $(B bold)", () => {
            const r = expandAll(table(), "$(B bold)");
            expect(r.ok).toBe(true);
            // ff 7b 3c 62 3e ff 7b 62 6f 6c 64 ff 7d 3c 2f 62 3e ff 7d
            expect(r.bytes).toEqual([
                0xff, 0x7b, 0x3c, 0x62, 0x3e, 0xff, 0x7b, 0x62, 0x6f, 0x6c, 0x64, 0xff, 0x7d, 0x3c,
                0x2f, 0x62, 0x3e, 0xff, 0x7d,
            ]);
        });

        test("positional arg $(GREET World)", () => {
            const r = expandAll(table(), "$(GREET World)");
            expect(r.ok).toBe(true);
            // ff 7b 48 65 6c 6c 6f 2c 20 ff 7b 57 6f 72 6c 64 ff 7d 21 ff 7d
            expect(r.bytes).toEqual([
                0xff, 0x7b, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0xff, 0x7b, 0x57, 0x6f, 0x72,
                0x6c, 0x64, 0xff, 0x7d, 0x21, 0xff, 0x7d,
            ]);
        });

        test("$(GREET a,b,c) takes the first comma-arg", () => {
            const r = expandAll(table(), "$(GREET a,b,c)");
            expect(r.ok).toBe(true);
            // same as $(GREET a) — $1 is "a"
            expect(r.bytes).toEqual([
                0xff, 0x7b, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0xff, 0x7b, 0x61, 0xff, 0x7d,
                0x21, 0xff, 0x7d,
            ]);
        });

        test("escaped $$(B) is de-escaped, not expanded", () => {
            const r = expandAll(table(), "literal $$(B) text");
            expect(r.ok).toBe(true);
            // "literal $(B) text"
            expect(r.bytes).toEqual(Array.from(ds("literal $(B) text")));
        });

        test("empty-arg $(B) is left verbatim (v == end, not closed)", () => {
            const r = expandAll(table(), "$(B)");
            expect(r.ok).toBe(true);
            expect(r.bytes).toEqual(Array.from(ds("$(B)")));
        });

        test("undefined $(UNKNOWN xyz) with no fallback → removed", () => {
            const r = expandAll(table(), "$(UNKNOWN xyz)");
            expect(r.ok).toBe(true);
            expect(r.bytes).toEqual([]);
        });

        test("text with no macros is unchanged", () => {
            const r = expandAll(table(), "no macros here");
            expect(r.ok).toBe(true);
            expect(r.bytes).toEqual(Array.from(ds("no macros here")));
        });
    });

    describe("DDOC_UNDEFINED_MACRO fallback (verified vs ldc2)", () => {
        function table(): MacroTable {
            const mt = new MacroTable();
            mt.define(ds("DDOC_UNDEFINED_MACRO"), ds("UNDEF($0)"));
            return mt;
        }

        test("fallback with arg prepends the macro name", () => {
            const r = expandAll(table(), "$(NOPE hi)");
            expect(r.ok).toBe(true);
            // ff 7b 55 4e 44 45 46 28 ff 7b 4e 4f 50 45 2c 68 69 ff 7d 29 ff 7d
            expect(r.bytes).toEqual([
                0xff, 0x7b, 0x55, 0x4e, 0x44, 0x45, 0x46, 0x28, 0xff, 0x7b, 0x4e, 0x4f, 0x50, 0x45,
                0x2c, 0x68, 0x69, 0xff, 0x7d, 0x29, 0xff, 0x7d,
            ]);
        });

        test("fallback without arg uses the macro name as arg", () => {
            const r = expandAll(table(), "$(NOPE)");
            expect(r.ok).toBe(true);
            // ff 7b 55 4e 44 45 46 28 ff 7b 4e 4f 50 45 ff 7d 29 ff 7d
            expect(r.bytes).toEqual([
                0xff, 0x7b, 0x55, 0x4e, 0x44, 0x45, 0x46, 0x28, 0xff, 0x7b, 0x4e, 0x4f, 0x50, 0x45,
                0xff, 0x7d, 0x29, 0xff, 0x7d,
            ]);
        });
    });

    describe("define (replace + lookup)", () => {
        test("re-define replaces the text in place", () => {
            const mt = new MacroTable();
            mt.define(ds("X"), ds("first"));
            mt.define(ds("X"), ds("second"));
            // $(X arg) -> blue-painted "second" (verified vs ldc2: $(X) with no arg is left
            // verbatim — v == end, the 2nd-pass guard `u + 4 < end` excludes it; an arg makes
            // `v < end`). So we use $(X arg) to observe the replaced text.
            const r = expandAll(mt, "$(X arg)");
            expect(r.ok).toBe(true);
            expect(r.bytes).toEqual([
                0xff, 0x7b, ...Array.from(ds("second")), 0xff, 0x7d,
            ]);
        });
    });

    describe("UTF-8 macro name (utfStride scan path)", () => {
        test("2-byte name char advances by utfStride (verified vs ldc2)", () => {
            const mt = new MacroTable();
            mt.define(Uint8Array.from([0xc3, 0xa9]), ds("OK$0")); // name "é"
            // isIdStart/isIdTail that also accept UTF continuation bytes (forces the stride path).
            const utfStart: fp_t = (buf, p) => {
                const c = buf[p];
                return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c >= 0x80;
            };
            const utfTail: fp_t = (buf, p) => {
                const c = buf[p];
                return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
                    (c >= 0x30 && c <= 0x39) || c >= 0x80;
            };
            const buf = new OutBuffer();
            buf.writestring(Uint8Array.from([0x24, 0x28, 0xc3, 0xa9, 0x20, 0x7a, 0x29])); // "$(é z)"
            const end: Ref<number> = { value: buf.length() };
            const ok = mt.expand(buf, 0, end, null, 100, utfStart, utfTail);
            expect(ok).toBe(true);
            // ff 7b 4f 4b ff 7b 7a ff 7d ff 7d
            expect(Array.from(buf.opSliceAll())).toEqual([
                0xff, 0x7b, 0x4f, 0x4b, 0xff, 0x7b, 0x7a, 0xff, 0x7d, 0xff, 0x7d,
            ]);
        });
    });

    describe("recursion limit", () => {
        test("ping-pong macros exceed the limit → returns false", () => {
            const mt = new MacroTable();
            mt.define(ds("A"), ds("x$(B $0y)"));
            mt.define(ds("B"), ds("z$(A $0w)"));
            // ldc2: ok=0 at rl=3 (and at rl=50) for "$(A start)".
            expect(expandAll(mt, "$(A start)", null, 3).ok).toBe(false);
        });
    });
});
