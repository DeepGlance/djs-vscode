import { describe, test, expect, beforeEach } from "vitest";
import { Identifier } from "./identifier.js";
import { ds, dsUtf8, dsToJs } from "../dstring.js";
import { Loc, newBaseLoc } from "./location.js";
import { initTokens } from "./tokens.js";

// Port of the in-source unittest{} block of dmd/identifier.d (10 §1.2: bare block -> "unittest#1").
// D's `Identifier.isValidIdentifier("...".ptr)` passes a NUL-terminated C-string; in djs the input
// is the byte-slice (a DString). `ğ` (U+011F) is UTF-8 `c4 9f`, so the source text carries non-ASCII
// code points -> use `dsUtf8` (the multi-byte UTF-8 form, NOT `ds`) so the validator sees the real
// UTF-8 bytes the lexer would (08 §11). `isValidIdentifier` decodes high-bit bytes and checks them
// against the Unicode start/continue tables, exactly the D path.

describe("identifier.d", () => {
    // identifier.d:406
    test("unittest#1", () => {
        expect(Identifier.isValidIdentifier(dsUtf8("tes123_t"))).toBe(true);
        expect(Identifier.isValidIdentifier(dsUtf8("tes123_^t"))).toBe(false);
        expect(Identifier.isValidIdentifier(dsUtf8("te123s_ğt"))).toBe(true);
        expect(Identifier.isValidIdentifier(dsUtf8("t^e123s_ğt"))).toBe(false);
    });
});

// REGRESSION PIN — generateIdWithLoc buffer aliasing (identifier.d:259/:285 read idBuf[] as a
// VIEW; the port once used the CONSUMING extractData() at the locKey site, emptying the buffer
// so every generated name collapsed to "" or "_N". 08 §13a.2 view-vs-consume.)
describe("identifier.d — generateIdWithLoc (view-not-consume regression)", () => {
    beforeEach(() => {
        // ORDER CONTRACT (01 §5.2): initTokens() FIRST — it re-creates the interning table.
        Loc._init();
        initTokens();
    });

    function mintLoc(fileOffset: number): Loc {
        const loc = new Loc();
        loc.index_ = 1 + fileOffset; // first BaseLoc: startIndex == 1
        return loc;
    }

    test("first name carries prefix + line/col (not empty)", () => {
        const base = newBaseLoc(ds("gen.d"), ds("ab\ncd\n"));
        base.newLine(3); // line 2 starts at byte offset 3
        const id = Identifier.generateIdWithLoc(ds("__lambda"), mintLoc(0));
        expect(dsToJs(id.toChars())).toBe("__lambda_L1_C1");
    });

    test("same (prefix, loc) bumps the counter; different loc does not", () => {
        const base = newBaseLoc(ds("gen2.d"), ds("ab\ncd\n"));
        base.newLine(3);
        expect(dsToJs(Identifier.generateIdWithLoc(ds("__lambda"), mintLoc(0)).toChars()))
            .toBe("__lambda_L1_C1");
        expect(dsToJs(Identifier.generateIdWithLoc(ds("__lambda"), mintLoc(0)).toChars()))
            .toBe("__lambda_L1_C1_1");
        expect(dsToJs(Identifier.generateIdWithLoc(ds("__lambda"), mintLoc(0)).toChars()))
            .toBe("__lambda_L1_C1_2");
        expect(dsToJs(Identifier.generateIdWithLoc(ds("__lambda"), mintLoc(3)).toChars()))
            .toBe("__lambda_L2_C1");
    });
});
