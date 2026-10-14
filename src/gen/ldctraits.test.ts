// Co-located tests for src/gen/ldctraits.ts (ported from gen/ldctraits.d with the gen/ldctraits.cpp bodies).
//
// gen/ldctraits.d has no `unittest` block (10 §1.6b). The two LDC traits are pinned end to end, through
// `semanticTraits` -> `semanticTraitsHook` -> `semanticTraitsLDC`, against ldc2 1.43.0 on arm64-apple-darwin
// (`ldc2 -c -o- <file>`, no `-mcpu`/`-mattr`), byte for byte, the probe output quoted at each pin. The
// feature pins cover all 8 features the default CPU enables (the whole `DEFAULT_FEATURE_BITS` table), a
// sample of recognised-but-disabled ones, and the unrecognised spellings that make LLVM warn on stderr.
import { initSemaHarness } from "../sema-harness.js"; // imports ./dmd/parse.js first: the module-graph root (10 §1.5)
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Parser } from "../dmd/parse.js";
import { ErrorSinkNull } from "../dmd/errorsink.js";
import { moduleFromParse } from "../dmd/dmodule.js";
import { runSemantic } from "../dmd/dsymbolsem.js";
import { setDiagnosticHandler } from "../dmd/errors.js";
import { DiagnosticReporting, global } from "../dmd/globals.js";
import { dmdformat } from "../dmd/root/dmdformat.js";
import { dsConcat, dsToJs } from "../dstring.js";
import * as ldctraits from "./ldctraits.js";

/** lex + parse + runSemantic over `src` (UTF-8) as a module of its own; returns the captured diagnostics
 *  (`<line>: <header><message>`), the text written to stderr (`pragma(msg)` and LLVM's warnings) and the
 *  same stderr as bytes, one char code per byte (`raw`), for the pins where the bytes are not UTF-8. */
function runModule(src: string): { diags: string[]; msgs: string; raw: string } {
    const bytes = new TextEncoder().encode(src);
    const buf = new Uint8Array(bytes.length + 1); // NUL-terminated: the lexer scans to the NUL
    buf.set(bytes, 0);
    const chunks: Uint8Array[] = [];
    const diags: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
        chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
        return true;
    });
    setDiagnosticHandler((loc, _color, header, messageFormat, args) => {
        diags.push(`${loc.linnum}: ` + dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
        return true;
    });
    try {
        const p = new Parser(null, null, buf, false, new ErrorSinkNull(), null, false);
        p.nextToken();
        runSemantic(moduleFromParse(p.parseModule(), p.md));
    } finally {
        setDiagnosticHandler(null);
        spy.mockRestore();
    }
    const out = dsConcat(...chunks);
    let raw = "";
    for (let i = 0; i < out.length; i++)
        raw += String.fromCharCode(out[i]);
    return { diags, msgs: dsToJs(out), raw };
}

describe("gen/ldctraits.ts", () => {
    beforeEach(() => {
        initSemaHarness();
    });

    test("SMOKE: the module loads; only `semanticTraitsLDC` is exported (the C++ bodies are file-local)", () => {
        expect(typeof ldctraits.semanticTraitsLDC).toBe("function");
        expect(Object.keys(ldctraits)).toEqual(["semanticTraitsLDC"]);
    });

    test("targetCPU and targetHasFeature for the default CPU (ldc2-pinned)", () => {
        const r = runModule(`enum cpu = __traits(targetCPU);
pragma(msg, cpu, " ", typeof(cpu));
static foreach (f; ["enable-select-opt", "ete", "fp-armv8", "fuse-adrp-add", "fuse-aes", "neon", "trbe",
                    "use-postra-scheduler", "crypto", "aes", "sve", "lse", "v8a", "CONTEXTIDREL2", "NEON", "+neon"])
    pragma(msg, f, " ", __traits(targetHasFeature, f));
pragma(msg, typeof(__traits(targetHasFeature, "neon")));
pragma(msg, __traits(targetHasFeature, "ne" ~ "on"));
`);
        expect(r.diags).toEqual([]);
        expect(r.msgs).toBe("generic string\nenable-select-opt true\nete true\nfp-armv8 true\nfuse-adrp-add true\n"
            + "fuse-aes true\nneon true\ntrbe true\nuse-postra-scheduler true\ncrypto false\naes false\nsve false\n"
            + "lse false\nv8a false\nCONTEXTIDREL2 false\n"
            + "'-NEON' is not a recognized feature for this target (ignoring feature)\nNEON false\n"
            + "'-+neon' is not a recognized feature for this target (ignoring feature)\n+neon false\nbool\ntrue\n");
    });

    test("unrecognised names are looked up and echoed as bytes: BOM, embedded NUL, invalid UTF-8 (ldc2-pinned)", () => {
        // ldc2 -c -o- on these four lines writes each name's bytes whole in LLVM's warning (a leading BOM is
        // not "neon"; the NUL does not end the name; 0xFF stays 0xFF), then `false`.
        const r = runModule(`pragma(msg, __traits(targetHasFeature, "\uFEFFneon"));
pragma(msg, __traits(targetHasFeature, "neon\\0zz"));
pragma(msg, __traits(targetHasFeature, "\\xFFab"));
pragma(msg, __traits(targetHasFeature, "ne\u00E9"));
`);
        const warn = "' is not a recognized feature for this target (ignoring feature)\nfalse\n";
        expect(r.diags).toEqual([]);
        expect(r.raw)
            .toBe("'-\xEF\xBB\xBFneon" + warn + "'-neon\0zz" + warn + "'-\xFFab" + warn + "'-ne\xC3\xA9" + warn);
    });

    test("targetCPU with arguments: the warning shows only when warnings are on (ldc2 -wi)", () => {
        // ldc2 -wi: `l2.d(1): Warning: ignoring arguments for __traits targetCPU`; without -wi, nothing.
        expect(runModule("enum x = __traits(targetCPU, 1);\n").diags).toEqual([]);
        initSemaHarness();
        global.params.useWarnings = DiagnosticReporting.inform;
        try {
            expect(runModule("enum x = __traits(targetCPU, 1);\n").diags)
                .toEqual(["1: Warning: ignoring arguments for __traits targetCPU"]);
        } finally {
            global.params.useWarnings = DiagnosticReporting.off;
        }
    });
});
