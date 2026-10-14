// Ported from dmd/sarif.d (module dmd.sarif).
//
// Cycle C member: sarif ↔ globals ↔ errors. Provides SARIF (Static Analysis Results Interchange
// Format) JSON diagnostic output. `global`/`ErrorKind`/`diagnostics` are value imports used only in
// bodies (01 §4.3). All `string` building is byte-oriented (DString via OutBuffer); the C-stdio
// `vsnprintf`/`sprintf` route through `dmdformat` (10 §3.5).

import { ds, dsConcat, dsToJs, cstr, type DString } from "../dstring.js";
import { assertUnreachable } from "../assert.js";
import { global } from "./globals.js";
import type { SourceLoc } from "./location.js";
import { OutBuffer } from "./common/outbuffer.js";
import { ErrorKind, diagnostics, Diagnostic } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";

/**
 * Contains information about the tool used for analysis in SARIF reports (sarif.d:30). Value struct.
 * `string name/toolVersion` -> DString. `toJson` builds a JSON object string via OutBuffer.
 */
export class ToolInformation {
    name: DString = ds(""); // Name of the tool
    toolVersion: DString = ds(""); // Version of the tool

    /// Converts the tool information to a JSON string (sarif.d:38). Always returns the EMPTY string:
    /// see `extractCharsThenLength`.
    toJson(): DString {
        const buffer = new OutBuffer();
        buffer.writestring(ds(`{"name": "`));
        buffer.writestring(this.name);
        buffer.writestring(ds(`", "version": "`));
        buffer.writestring(this.toolVersion);
        buffer.writestring(ds(`"}`));
        return extractCharsThenLength(buffer);
    }
}

/**
 * `cast(string) buffer.extractChars()[0 .. buffer.length()].dup`, the return statement of the four `toJson`
 * methods (sarif.d:45, :92, :148, :167). D evaluates the sliced operand before the bounds, and `extractChars()`
 * takes ownership and leaves the buffer at length 0, so the upper bound is 0 and the result is ALWAYS the empty
 * string. An upstream quirk kept on purpose: ldc2 1.43.0 returns len=0 from each of the four sites, probed with
 * the real sarif.d bodies (the composing `SarifReport.toJson` therefore also returns empty). The diagnostics ldc2
 * prints go through `generateSarifReport`, which does not use these methods.
 */
function extractCharsThenLength(buffer: OutBuffer): DString {
    const chars = buffer.extractChars();
    return chars.slice(0, buffer.length());
}

/**
 * Converts an integer to a string (sarif.d:58). `char[32] buffer; sprintf(buffer.ptr, "%d", value)`
 * -> `dmdformat("%d", [value])`. The D code returns the WHOLE 32-byte buffer (`buffer[0..length].dup`)
 * including trailing NUL/garbage; here we return the formatted digits (the logical value, which is
 * what is then `writestring`-ed). NUL-trim matches the C-string the original buffer represents. The
 * full-buffer quirk is unobservable: the only caller, `SarifResult.toJson`, returns empty.
 */
export function intToString(value: number): DString {
    return dmdformat(ds("%d"), [value]);
}

/**
 * Represents a SARIF result containing a rule ID, message, and location (sarif.d:66). Value struct.
 */
export class SarifResult {
    ruleId: DString = ds(""); // Rule identifier
    message: DString = ds(""); // Error or warning message
    uri: DString = ds(""); // URI of the affected file
    startLine = 0; // Line number where the issue occurs
    startColumn = 0; // Column number where the issue occurs

    /// Converts the SARIF result to a JSON string (sarif.d:78).
    toJson(): DString {
        const buffer = new OutBuffer();
        buffer.writestring(ds(`{"ruleId": "`));
        buffer.writestring(this.ruleId);
        buffer.writestring(ds(`", "message": "`));
        buffer.writestring(this.message);
        buffer.writestring(ds(`", "location": {"artifactLocation": {"uri": "`));
        buffer.writestring(this.uri);
        buffer.writestring(ds(`"}, "region": {"startLine": `));
        buffer.writestring(intToString(this.startLine));
        buffer.writestring(ds(`, "startColumn": `));
        buffer.writestring(intToString(this.startColumn));
        buffer.writestring(ds(`}}}`));
        return extractCharsThenLength(buffer);
    }
}

/**
 * Adds a SARIF diagnostic entry to the diagnostics list (sarif.d:107). Formats `format`/`ap` via
 * `vsnprintf` (1024-byte buffer) -> `dmdformat` (10 §3.5), then appends a Diagnostic. `va_list ap`
 * -> the rest-array (04 §3.1). `const SourceLoc loc` is by-value; stored into the new Diagnostic.
 */
export function addSarifDiagnostic(loc: SourceLoc, format: DString, ap: ReadonlyArray<unknown>, kind: ErrorKind): void {
    // char[1024] buffer; vsnprintf(...) — dmdformat produces the full message; the 1024-byte
    // truncation of the C buffer is not reproduced (dmdformat returns the complete bytes). The
    // truncation only ever mattered for pathologically long messages; the SARIF text is the logical
    // string up to the first NUL (cstr), matching `buffer[0 .. written]`.
    const formattedMessage = cstr(dmdformat(format, ap.slice()));

    // diagnostics ~= Diagnostic(loc, formattedMessage, kind)
    diagnostics.push(new Diagnostic(loc.copy(), formattedMessage, kind));
}

/**
 * Represents a SARIF report containing tool information, invocation, and results (sarif.d:120).
 */
export class SarifReport {
    tool: ToolInformation = new ToolInformation(); // Information about the analysis tool
    invocation: Invocation = new Invocation(); // Execution information
    results: SarifResult[] = []; // List of SARIF results (errors, warnings, etc.)

    /// Converts the SARIF report to a JSON string (sarif.d:130).
    toJson(): DString {
        const buffer = new OutBuffer();
        buffer.writestring(ds(`{"tool": `));
        buffer.writestring(this.tool.toJson());
        buffer.writestring(ds(`, "invocation": `));
        buffer.writestring(this.invocation.toJson());
        buffer.writestring(ds(`, "results": [`));
        if (this.results.length > 0) {
            buffer.writestring(this.results[0].toJson());
            for (let i = 1; i < this.results.length; i++) {
                buffer.writestring(ds(`, `));
                buffer.writestring(this.results[i].toJson());
            }
        }
        buffer.writestring(ds(`]}`));
        return extractCharsThenLength(buffer);
    }
}

/**
 * Represents invocation information for the analysis process (sarif.d:153).
 */
export class Invocation {
    executionSuccessful = false; // Whether the execution was successful

    /// Converts the invocation information to a JSON string (sarif.d:161).
    toJson(): DString {
        const buffer = new OutBuffer();
        buffer.writestring(ds(`{"executionSuccessful": `));
        buffer.writestring(this.executionSuccessful ? ds("true") : ds("false"));
        buffer.writestring(ds(`}`));
        return extractCharsThenLength(buffer);
    }
}

/**
 * Formats an error message using a format string and a variable argument list (sarif.d:181).
 * `char[2048] buffer; vsnprintf(...)` -> `dmdformat`. Returns the formatted bytes (the C code returns
 * the whole 2048-byte buffer; here the logical formatted string).
 */
export function formatErrorMessage(format: DString, ap: ReadonlyArray<unknown>): DString {
    return cstr(dmdformat(format, ap.slice()));
}

/**
 * Converts an `ErrorKind` value to a SARIF-compatible severity-level string (sarif.d:198).
 * `final switch` (06 §3.2).
 */
export function errorKindToString(kind: ErrorKind): DString {
    switch (kind) {
        case ErrorKind.error:
            return ds("error"); // Serious problem
        case ErrorKind.warning:
            return ds("warning"); // Problem found
        case ErrorKind.deprecation:
            return ds("note"); // Minor problem, opportunity for improvement
        case ErrorKind.tip:
            return ds("note"); // Minor improvement suggestion
        case ErrorKind.message:
            return ds("none"); // Not applicable for "fail" kind, so use "none"
        default: {
            const _e: never = kind;
            return assertUnreachable(`errorKindToString: unhandled ErrorKind ${_e as number}`);
        }
    }
}

/**
 * Generates a SARIF report and prints it to `stdout` (sarif.d:224). Builds a SARIF 2.1.0
 * JSON-formatted report (tool/invocation/results) with `OutBuffer` indentation. `nothrow` erases.
 * The final `fputs(sarifOutput, stdout); fflush(stdout)` -> one `process.stdout.write` (10 §4.4).
 */
export function generateSarifReport(executionSuccessful: boolean): void {
    // Create an OutBuffer to store the SARIF report.
    const ob = new OutBuffer();
    ob.doindent = true;

    // Extract and clean the version string.
    let toolVersion = global.versionString();
    // Remove 'v' prefix if it exists.
    if (toolVersion.length > 0 && toolVersion[0] === 0x76 /* 'v' */) toolVersion = toolVersion.subarray(1);

    // Find the first non-numeric character after the version number (`strchr(ptr, '-')`).
    let length = toolVersion.length;
    const nonNumeric = indexOfByte(toolVersion, 0x2d /* '-' */);
    if (nonNumeric >= 0) length = nonNumeric;

    let cleanedVersion = toolVersion.subarray(0, length);

    // strip trailing newlines.
    while (
        cleanedVersion.length > 0 &&
        (cleanedVersion[cleanedVersion.length - 1] === 0x0a /* '\n' */ ||
            cleanedVersion[cleanedVersion.length - 1] === 0x0d) /* '\r' */
    ) {
        cleanedVersion = cleanedVersion.subarray(0, cleanedVersion.length - 1);
    }

    // Build SARIF report.
    ob.writestringln(ds("{"));
    ob.level = 1;

    ob.writestringln(ds(`"version": "2.1.0",`));
    ob.writestringln(ds(`"$schema": "https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0.json",`));
    ob.writestringln(ds(`"runs": [{`));

    // Tool Information.
    ob.level += 1;
    ob.writestringln(ds(`"tool": {`));
    ob.level += 1;
    ob.writestringln(ds(`"driver": {`));
    ob.level += 1;

    // Write "name" field. `global.compileEnv.vendor.ptr` — the vendor C-string; %s/writestring sees
    // the logical bytes (cstr).
    ob.writestring(ds(`"name": "`));
    ob.writestring(cstr(global.compileEnv.vendor));
    ob.writestringln(ds(`",`));

    // Write "version" field.
    ob.writestring(ds(`"version": "`));
    ob.writestring(cleanedVersion);
    ob.writestringln(ds(`",`));

    // Write "informationUri" field.
    ob.writestringln(ds(`"informationUri": "https://dlang.org/dmd.html"`));
    ob.level -= 1;
    ob.writestringln(ds("}"));
    ob.level -= 1;
    ob.writestringln(ds("},"));

    // Invocation Information.
    ob.writestringln(ds(`"invocations": [{`));
    ob.level += 1;
    ob.writestring(ds(`"executionSuccessful": `));
    ob.writestring(executionSuccessful ? ds("true") : ds("false"));
    ob.writestringln(ds(""));
    ob.level -= 1;
    ob.writestringln(ds("}],"));

    // Results Array.
    ob.writestringln(ds(`"results": [`));
    ob.level += 1;

    for (let idx = 0; idx < diagnostics.length; idx++) {
        const diag = diagnostics[idx];
        ob.writestringln(ds("{"));
        ob.level += 1;

        // Rule ID. `"DMD-" ~ errorKindToString(diag.kind) ~ ","` — D string concat ~ -> dsConcat.
        ob.writestring(dsConcat(ds(`"ruleId": "DMD-`), errorKindToString(diag.kind), ds(`",`)));
        ob.writestringln(ds(""));

        // Message Information.
        ob.writestringln(ds(`"message": {`));
        ob.level += 1;
        ob.writestring(ds(`"text": "`));
        ob.writestring(diag.message);
        ob.writestringln(ds(`"`));
        ob.level -= 1;
        ob.writestringln(ds("},"));

        // Error Severity Level.
        ob.writestring(dsConcat(ds(`"level": "`), errorKindToString(diag.kind), ds(`",`)));
        ob.writestringln(ds(""));

        // Location Information.
        ob.writestringln(ds(`"locations": [{`));
        ob.level += 1;
        ob.writestringln(ds(`"physicalLocation": {`));
        ob.level += 1;

        // Artifact Location.
        ob.writestringln(ds(`"artifactLocation": {`));
        ob.level += 1;
        ob.writestring(ds(`"uri": "`));
        ob.writestring(diag.loc.filename);
        ob.writestringln(ds(`"`));
        ob.level -= 1;
        ob.writestringln(ds("},"));

        // Region Information.
        ob.writestringln(ds(`"region": {`));
        ob.level += 1;
        ob.writestring(ds(`"startLine": `));
        ob.printf(ds(`%d,`), diag.loc.linnum);
        ob.writestringln(ds(""));
        ob.writestring(ds(`"startColumn": `));
        ob.printf(ds(`%d`), diag.loc.charnum);
        ob.writestringln(ds(""));
        ob.level -= 1;
        ob.writestringln(ds("}"));

        // Close physicalLocation and locations.
        ob.level -= 1;
        ob.writestringln(ds("}"));
        ob.level -= 1;
        ob.writestringln(ds("}]"));

        // Closing brace for each diagnostic item.
        ob.level -= 1;
        if (idx < diagnostics.length - 1) ob.writestringln(ds("},"));
        else ob.writestringln(ds("}"));
    }

    // Close the run and SARIF JSON.
    ob.level -= 1;
    ob.writestringln(ds("]"));
    ob.level -= 1;
    ob.writestringln(ds("}]"));
    ob.level -= 1;
    ob.writestringln(ds("}"));

    // Extract the final null-terminated string and print it to stdout (one write, 10 §4.4).
    const sarifOutput = ob.extractChars();
    process.stdout.write(dsToJs(cstr(sarifOutput)));
}

// ── helpers (no upstream .d source) ─────────────────────────────────────────────────────────────

/// `strchr(s.ptr, byte)` — index of the first `byte` in `s`, or -1 (the D code only consults
/// `nonNumeric != null` and the pointer difference, modeled as an index here).
function indexOfByte(s: DString, byte: number): number {
    return s.indexOf(byte);
}
