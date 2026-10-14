// Tests for src/dmd/sarif.ts.
//
// The four `toJson` methods (sarif.d:45, :92, :148, :167) return `buffer.extractChars()[0 .. buffer.length()].dup`.
// The expected text is the output of ldc2 1.43.0 running the real sarif.d method bodies against
// dmd/common/outbuffer.d: every method returns a string of length 0, because `extractChars()` empties the buffer
// before the upper bound `buffer.length()` is read.

import { describe, expect, test } from "vitest";

import { ds } from "../dstring.js";
import { Invocation, SarifReport, SarifResult, ToolInformation } from "./sarif.js";

function makeResult(): SarifResult {
    const r = new SarifResult();
    r.ruleId = ds("DMD-error");
    r.message = ds("m");
    r.uri = ds("e.d");
    r.startLine = 1;
    r.startColumn = 19;
    return r;
}

describe("sarif toJson evaluation order (extractChars before length)", () => {
    test("ToolInformation.toJson is empty (sarif.d:45)", () => {
        const t = new ToolInformation();
        t.name = ds("LDC");
        t.toolVersion = ds("1.43.0");
        expect(t.toJson().length).toBe(0);
    });

    test("SarifResult.toJson is empty (sarif.d:92)", () => {
        expect(makeResult().toJson().length).toBe(0);
    });

    test("Invocation.toJson is empty (sarif.d:167)", () => {
        const i = new Invocation();
        i.executionSuccessful = true;
        expect(i.toJson().length).toBe(0);
    });

    test("SarifReport.toJson is empty (sarif.d:148)", () => {
        const rep = new SarifReport();
        rep.tool.name = ds("LDC");
        rep.tool.toolVersion = ds("1.43.0");
        rep.invocation.executionSuccessful = true;
        rep.results = [makeResult(), makeResult()];
        expect(rep.toJson().length).toBe(0);
    });
});
