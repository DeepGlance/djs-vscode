// Ported from dmd/errors.d (module dmd.errors).
//
// Cycle C member: errors ↔ globals ↔ sarif ↔ … . globals is a value import used only inside bodies
// (the `global` singleton, read at call time — 01 §4.3), so it does not break the load cycle.
// `ErrorSinkCompiler` is constructed by `Global._init()` (post-load), so globals importing it back
// is safe. sarif (`addSarifDiagnostic`/`generateSarifReport`) is value-imported, used in bodies.
//
// Diagnostics are a BYTE-EXACT contract (10 §0): every format string is copied verbatim from
// upstream; every C-stdio `fprintf(stderr,…)`/`fputs(…,stderr)` becomes one
// `process.stderr.write(dsToJs(dmdformat(...)))` (10 §4.4); `message`-kind text goes to STDOUT.
//
// C-variadic resolution: every `static if (__VERSION__ < 2092) … else pragma(printf) …` pair
// resolves to the ELSE branch (`__VERSION__ == 2113 >= 2092`, verified ldc2 / 07 §3.2); the
// `pragma(printf)` then erases (04 §8). So each `void f(Loc, const(char)*, ...)` becomes a single
// TS function `f(loc, format, ...args)`; the `va_list ap; va_start; … va_end` triple erases — the
// rest array IS the va_list (04 §3.1).

import { ds, dsToJs, cstr, type DString } from "../dstring.js";
import { assertUnreachable, SwitchError } from "../assert.js";
import { K, keepReport } from "../keep.js";
import { ErrorSink } from "./errorsink.js";
import { global } from "./globals.js";
import { DiagnosticReporting, ErrorPrintMode } from "./globals.js";
import { FeatureState } from "./globals.js";
import { Loc, SourceLoc, MessageStyle, writeSourceLoc } from "./location.js";
import { OutBuffer } from "./common/outbuffer.js";
import { toDString, startsWith } from "./root/string.js";
import { Color } from "./console.js";
import type { Console } from "./console.js";
import { addSarifDiagnostic, generateSarifReport } from "./sarif.js";
import { dmdformat } from "./root/dmdformat.js";
import { utf_decodeChar } from "./root/utf.js";

// public import dmd.root.string: fTuple; (errors.d:15) -> re-export (01 §3.4).
export { fTuple } from "./root/string.js";

// nothrow: (errors.d:29) — ERASE (04 §8).

/// Constants used to discriminate kinds of error messages (errors.d:32). `enum ErrorKind` (no base
/// -> default `int`) -> TS numeric enum (02 §4.2).
export enum ErrorKind {
    warning,
    deprecation,
    error,
    tip,
    message,
}

/**
 * Represents a diagnostic message generated during compilation, such as errors, warnings, or other
 * messages (errors.d:45). VALUE struct -> class with `.copy()`. `string message` is a byte-slice
 * (shared on copy). `SourceLoc loc` is a value struct (deep-copied via its own `.copy()`).
 */
export class Diagnostic {
    loc: SourceLoc; // location in the source code where the diagnostic was generated
    message: DString; // text of the diagnostic message
    kind: ErrorKind; // type of diagnostic (error/warning/deprecation/…)

    constructor(loc: SourceLoc, message: DString, kind: ErrorKind) {
        this.loc = loc;
        this.message = message;
        this.kind = kind;
    }

    copy(): Diagnostic {
        return new Diagnostic(this.loc.copy(), this.message, this.kind);
    }
}

/// (errors.d:52) `__gshared Diagnostic[] diagnostics = []` — process-global collector for SARIF.
/// D module-private only by convention; sibling sarif.ts pushes/clears it, so it is exported.
export const diagnostics: Diagnostic[] = [];

/// Reset the SARIF diagnostics collector (the D `diagnostics.length = 0` truncation, used by
/// `ErrorSinkCompiler.plugSink`). A helper because a TS `const` array cannot be reassigned.
export function clearDiagnostics(): void {
    diagnostics.length = 0;
}

/***************************
 * Error message sink for D compiler (errors.d:57). `class ErrorSinkCompiler : ErrorSink`. The
 * `nothrow:`/`extern (C++):`/`override:` blocks erase except `override` is applied per-method
 * (04 §8, tsconfig noImplicitOverride). Each `v*` forwards to `vreportDiagnostic`/
 * `vsupplementalDiagnostic` (the same dispatch the abstract base wrappers feed).
 */
export class ErrorSinkCompiler extends ErrorSink {
    override verror(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        vreportDiagnosticLoc(loc, format, ap, ErrorKind.error);
    }

    override verrorSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        vsupplementalDiagnosticLoc(loc, format, ap, ErrorKind.error);
    }

    override vwarning(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        vreportDiagnosticLoc(loc, format, ap, ErrorKind.warning);
    }

    override vwarningSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        vsupplementalDiagnosticLoc(loc, format, ap, ErrorKind.warning);
    }

    override vdeprecation(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        vreportDiagnosticLoc(loc, format, ap, ErrorKind.deprecation);
    }

    override vdeprecationSupplemental(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        vsupplementalDiagnosticLoc(loc, format, ap, ErrorKind.deprecation);
    }

    override vmessage(loc: Loc, format: DString, ap: ReadonlyArray<unknown>): void {
        vreportDiagnosticLoc(loc, format, ap, ErrorKind.message);
    }

    override plugSink(): void {
        // Exit if there are no collected diagnostics (errors.d:101).
        if (!diagnostics.length) return;

        // Generate the SARIF report with the current diagnostics.
        generateSarifReport(false);

        // Clear diagnostics after generating the report.
        clearDiagnostics();
    }
}

/**
 * Color highlighting to classify messages (errors.d:115). `enum Classification : Color` — a typed
 * enum whose base type is another enum (Color). Per 02 §4.2 it stays a numeric enum; members fold
 * to their Color values at translation time.
 */
export enum Classification {
    error = Color.brightRed, // for errors
    gagged = Color.brightBlue, // for gagged errors
    warning = Color.brightYellow, // for warnings
    deprecation = Color.brightCyan, // for deprecations
    tip = Color.brightGreen, // for tip messages
}

// resolved: static if (__VERSION__ < 2092) -> false (2113; 07 §3.2). `noop` (errors.d:126/128)
// is the no-op error func used by previewErrorFunc when a feature is disabled. `pragma(printf)`
// erases (04 §8). `private extern (C++)` erase. It accepts and discards its args.
function noop(_loc: Loc, _format: DString, ..._args: unknown[]): void {}

/**
 * (errors.d:131) `package auto previewErrorFunc(...)` — selects which diagnostic function a preview
 * feature uses. Returns a function value (a `&error`/`&noop`/`&deprecation` function pointer ->
 * a plain function reference, 04 §4.4). `package`/`@safe @nogc pure nothrow` erase. The return
 * union is widened to the common `(loc, format, ...args) => void` signature all three share.
 */
export function previewErrorFunc(
    isDeprecated: boolean,
    featureState: FeatureState,
): (loc: Loc, format: DString, ...args: unknown[]) => void {
    // with (FeatureState) final switch (featureState) (06 §3.2/§5).
    switch (featureState) {
        case FeatureState.enabled:
            return error;
        case FeatureState.disabled:
            return noop;
        case FeatureState.default_:
            return isDeprecated ? noop : deprecation;
        default: {
            // final switch: D throws SwitchError on an unhandled value (06 §3.2).
            const _exhaustive: never = featureState;
            void _exhaustive;
            throw new SwitchError();
        }
    }
}

/**
 * (errors.d:146) `package auto previewSupplementalFunc(...)` — same shape as `previewErrorFunc` but
 * for the supplemental family.
 */
export function previewSupplementalFunc(
    isDeprecated: boolean,
    featureState: FeatureState,
): (loc: Loc, format: DString, ...args: unknown[]) => void {
    switch (featureState) {
        case FeatureState.enabled:
            return errorSupplemental;
        case FeatureState.disabled:
            return noop;
        case FeatureState.default_:
            return isDeprecated ? noop : deprecationSupplemental;
        default: {
            // final switch: D throws SwitchError on an unhandled value (06 §3.2).
            const _exhaustive: never = featureState;
            void _exhaustive;
            throw new SwitchError();
        }
    }
}

/**
 * Print an error message, increasing the global error count (errors.d:178, the __VERSION__>=2092
 * branch). Params: loc = location; format = printf-style format; ...args = printf-style varargs.
 */
export function error(loc: Loc, format: DString, ...args: unknown[]): void {
    vreportDiagnosticLoc(loc, format, args, ErrorKind.error);
}

/**
 * Same as above, but takes a filename and line information as separate parameters (errors.d:205).
 * `SourceLoc(filename.toDString, linnum, charnum)` — the filename `const(char)*` is already a
 * DString; `toDString` is the identity pass.
 */
export function errorFromFile(
    filename: DString,
    linnum: number,
    charnum: number,
    format: DString,
    ...args: unknown[]
): void {
    const loc = new SourceLoc(toDString(filename)!, linnum, charnum);
    vreportDiagnosticSourceLoc(loc, format, args, ErrorKind.error);
}

/// Callback for when the backend wants to report an error (errors.d:215). Same shape as
/// `errorFromFile`; kept distinct (it is a separate exported symbol upstream).
export function errorBackend(
    filename: DString,
    linnum: number,
    charnum: number,
    format: DString,
    ...args: unknown[]
): void {
    const loc = new SourceLoc(toDString(filename)!, linnum, charnum);
    vreportDiagnosticSourceLoc(loc, format, args, ErrorKind.error);
}

/// Print additional details about an error message (errors.d:241). Doesn't increase the error count.
export function errorSupplemental(loc: Loc, format: DString, ...args: unknown[]): void {
    vsupplementalDiagnosticLoc(loc, format, args, ErrorKind.error);
}

/// Print a warning message, increasing the global warning count (errors.d:265).
export function warning(loc: Loc, format: DString, ...args: unknown[]): void {
    vreportDiagnosticLoc(loc, format, args, ErrorKind.warning);
}

/// Print additional details about a warning message (errors.d:290).
export function warningSupplemental(loc: Loc, format: DString, ...args: unknown[]): void {
    vsupplementalDiagnosticLoc(loc, format, args, ErrorKind.warning);
}

/// Print a deprecation message (errors.d:315). May increase the warning or error count depending on
/// whether deprecations are ignored.
export function deprecation(loc: Loc, format: DString, ...args: unknown[]): void {
    vreportDiagnosticLoc(loc, format, args, ErrorKind.deprecation);
}

/// Print additional details about a deprecation message (errors.d:340).
export function deprecationSupplemental(loc: Loc, format: DString, ...args: unknown[]): void {
    vsupplementalDiagnosticLoc(loc, format, args, ErrorKind.deprecation);
}

/// Print a verbose message (errors.d:365). Doesn't prefix or highlight messages.
export function message(loc: Loc, format: DString, ...args: unknown[]): void {
    vreportDiagnosticLoc(loc, format, args, ErrorKind.message);
}

/// Same as above, but doesn't take a location argument (errors.d:388). Overload Form-A
/// (arity-distinct: `message(format,...)` vs `message(loc,format,...)`) -> renamed factory per
/// 04 §1A; the no-loc form is `messageNoLoc`. Uses `Loc.initial`.
export function messageNoLoc(format: DString, ...args: unknown[]): void {
    vreportDiagnosticLoc(Loc.initial, format, args, ErrorKind.message);
}

/**
 * The type of the diagnostic handler (errors.d:401). `alias DiagnosticHandler = bool delegate(...)`
 * -> a function-type alias (02 §5.2). `va_list args` -> the rest-array form (04 §3.1).
 * Returns: true if error handling is done, false to continue printing to stderr.
 */
export type DiagnosticHandler = (
    location: SourceLoc,
    headerColor: Color,
    header: DString,
    messageFormat: DString,
    args: ReadonlyArray<unknown>,
    prefix1: DString | null,
    prefix2: DString | null,
) => boolean;

/**
 * The diagnostic handler (errors.d:408). If non-null it will be called for every diagnostic message
 * issued by the compiler. If it returns false, the message will be printed to stderr as usual.
 * Exported mutable binding (a `__gshared` global the driver may set).
 */
export let diagnosticHandler: DiagnosticHandler | null = null;

/// Setter for the `__gshared diagnosticHandler` (a TS `let` export cannot be reassigned by importers).
export function setDiagnosticHandler(h: DiagnosticHandler | null): void {
    diagnosticHandler = h;
}

/// Print a tip message with the prefix and highlighting (errors.d:425). No-loc; uses `Loc.initial`.
export function tip(format: DString, ...args: unknown[]): void {
    vreportDiagnosticLoc(Loc.initial, format, args, ErrorKind.tip);
}

/**
 * Encapsulates a diagnostic as described by its location, format message, and kind (errors.d:435).
 * `private struct DiagnosticContext` — module-private value struct. Touched by sibling module-level
 * functions (vreportDiagnostic/printDiagnostic), so emitted without TS `private` (01 §2.5). The
 * ctor sets loc/p1/p2/kind; `headerColor`/`supplemental` default. `const(char)* p1/p2` -> DString|null.
 */
class DiagnosticContext {
    loc: SourceLoc; // location of error (const)
    headerColor: Classification = Classification.error; // color to set `header` output to (default-init)
    p1: DString | null; // additional message prefix
    p2: DString | null; // additional message prefix
    kind: ErrorKind; // kind of error being printed (const)
    supplemental = false; // true if supplemental error

    constructor(loc: SourceLoc, kind: ErrorKind, p1: DString | null = null, p2: DString | null = null) {
        this.loc = loc;
        this.p1 = p1;
        this.p2 = p2;
        this.kind = kind;
    }
}

/**
 * Implements error/warning/deprecation/message/tip (errors.d:466, the `Loc` overload). Forwards to
 * the SourceLoc overload via `loc.SourceLoc` (UFCS conversion `Loc -> SourceLoc`, here
 * `SourceLoc.fromLoc(loc)`). `private extern(C++)` erase. Named `vreportDiagnosticLoc` to keep the
 * two same-arity-different-type overloads distinct (04 §1B; the SourceLoc form is the canonical
 * worker `vreportDiagnosticSourceLoc`).
 */
function vreportDiagnosticLoc(
    loc: Loc,
    format: DString,
    ap: ReadonlyArray<unknown>,
    kind: ErrorKind,
    p1: DString | null = null,
    p2: DString | null = null,
): void {
    vreportDiagnosticSourceLoc(SourceLoc.fromLoc(loc), format, ap, kind, p1, p2);
}

/// ditto (errors.d:472) — the canonical worker, taking a SourceLoc. Reproduces the per-kind
/// gag/limit/sarif branching exactly (10 §3.4 — the reporting decision is load-bearing).
function vreportDiagnosticSourceLoc(
    loc: SourceLoc,
    format: DString,
    ap: ReadonlyArray<unknown>,
    kind: ErrorKind,
    p1: DString | null = null,
    p2: DString | null = null,
): void {
    if (K.on && keepReport(false, loc, format, ap, kind, p1, p2))
        return;   // the kept-module engine recorded the call and made it
    const info = new DiagnosticContext(loc, kind, p1, p2);

    // The `case ErrorKind.error` arm, extracted because `case ErrorKind.deprecation` reaches it by a
    // non-adjacent `goto case` (06 §3.6 (b)). The jump keeps `info.kind` and `kind`: a deprecation turned into an
    // error by `-de` is counted as an error but still printed with the `Deprecation: ` header (ldc2:
    // `-de` on `__traits(isVirtualFunction, …)` prints `Deprecation:` and exits 1).
    const caseError = (): void => {
        global.errors++;
        if (!global.gag) {
            info.headerColor = Classification.error;
            if (global.params.v.messageStyle === MessageStyle.sarif) {
                addSarifDiagnostic(loc, format, ap, kind);
                return;
            }
            printDiagnostic(format, ap, info);
            if (global.params.v.errorLimit && global.errors >= global.params.v.errorLimit) {
                // fprintf(stderr, …) — one assembled write (10 §4.4).
                process.stderr.write(
                    dsToJs(
                        dmdformat(ds("error limit (%d) reached, use `-verrors=0` to show all\n"), [
                            global.params.v.errorLimit,
                        ]),
                    ),
                );
                fatal(); // moderate blizzard of cascading messages
            }
        } else {
            if (global.params.v.showGaggedErrors) {
                info.headerColor = Classification.gagged;
                printDiagnostic(format, ap, info);
            }
            global.gaggedErrors++;
            global.windowErrors++;  // no D counterpart: see `Global.windowErrors`
        }
    };

    // final switch (info.kind) (06 §3.2).
    switch (info.kind) {
        case ErrorKind.error:
            caseError();
            return;

        case ErrorKind.deprecation:
            if (global.params.useDeprecated === DiagnosticReporting.error) {
                caseError();   // goto case ErrorKind.error;
                return;
            } else if (global.params.useDeprecated === DiagnosticReporting.inform) {
                if (!global.gag) {
                    global.deprecations++;
                    if (global.params.v.errorLimit === 0 || global.deprecations <= global.params.v.errorLimit) {
                        info.headerColor = Classification.deprecation;
                        if (global.params.v.messageStyle === MessageStyle.sarif) {
                            addSarifDiagnostic(loc, format, ap, kind);
                            return;
                        }
                        printDiagnostic(format, ap, info);
                    }
                } else {
                    global.gaggedDeprecations++;
                }
            }
            return;

        case ErrorKind.warning:
            if (global.params.useWarnings !== DiagnosticReporting.off) {
                if (!global.gag) {
                    info.headerColor = Classification.warning;
                    if (global.params.v.messageStyle === MessageStyle.sarif) {
                        addSarifDiagnostic(loc, format, ap, kind);
                        return;
                    }
                    printDiagnostic(format, ap, info);
                    if (global.params.useWarnings === DiagnosticReporting.error) global.warnings++;
                }
            }
            return;

        case ErrorKind.tip:
            if (!global.gag) {
                info.headerColor = Classification.tip;
                if (global.params.v.messageStyle === MessageStyle.sarif) {
                    addSarifDiagnostic(loc, format, ap, kind);
                    return;
                }
                printDiagnostic(format, ap, info);
            }
            return;

        case ErrorKind.message: {
            const tmp = new OutBuffer();
            writeSourceLoc(tmp, info.loc, Loc.showColumns, Loc.messageStyle);
            if (tmp.length()) {
                // fprintf(stdout, "%s: ", tmp.extractChars()) — message-kind goes to STDOUT (10 §4.1).
                process.stdout.write(dsToJs(dmdformat(ds("%s: "), [tmp.extractChars()])));
            }

            tmp.reset();
            tmp.vprintf(format, ap);
            process.stdout.write(dsToJs(cstr(tmp.peekChars()))); // fputs(tmp.peekChars(), stdout)
            process.stdout.write("\n"); // fputc('\n', stdout)
            // fflush(stdout) — Node flushes process.stdout on write; no-op.
            if (global.params.v.messageStyle === MessageStyle.sarif) {
                addSarifDiagnostic(loc, format, ap, kind);
                return;
            }
            return;
        }

        default: {
            // final switch: D throws SwitchError on an unhandled value (06 §3.2).
            const _exhaustive: never = info.kind;
            void _exhaustive;
            throw new SwitchError();
        }
    }
}

/**
 * The kept-module engine (src/keep.ts): the two reporting workers, as a replayed report calls them (a report
 * call recorded during an earlier compile, with its recorded arguments, under the current gag state).
 */
export function reportDiagnosticForKeep(supplemental: boolean, loc: SourceLoc, format: DString,
    ap: ReadonlyArray<unknown>, kind: ErrorKind, p1: DString | null, p2: DString | null): void {
    if (supplemental)
        vsupplementalDiagnosticSourceLoc(loc, format, ap, kind);
    else
        vreportDiagnosticSourceLoc(loc, format, ap, kind, p1, p2);
}

/**
 * Implements errorSupplemental/warningSupplemental/deprecationSupplemental (errors.d:594, the `Loc`
 * overload). Forwards to the SourceLoc worker.
 */
function vsupplementalDiagnosticLoc(loc: Loc, format: DString, ap: ReadonlyArray<unknown>, kind: ErrorKind): void {
    vsupplementalDiagnosticSourceLoc(SourceLoc.fromLoc(loc), format, ap, kind);
}

/// ditto (errors.d:600) — the canonical supplemental worker.
function vsupplementalDiagnosticSourceLoc(
    loc: SourceLoc,
    format: DString,
    ap: ReadonlyArray<unknown>,
    kind: ErrorKind,
): void {
    if (K.on && keepReport(true, loc, format, ap, kind, null, null))
        return;   // the kept-module engine recorded the call and made it
    const info = new DiagnosticContext(loc, kind);
    info.supplemental = true;
    // plain `switch` with a `default` (errors.d:604).
    switch (info.kind) {
        case ErrorKind.error:
            if (global.gag) {
                if (!global.params.v.showGaggedErrors) return;
                info.headerColor = Classification.gagged;
            } else {
                info.headerColor = Classification.error;
            }
            printDiagnostic(format, ap, info);
            return;

        case ErrorKind.deprecation:
            if (global.params.useDeprecated === DiagnosticReporting.error) {
                // goto case ErrorKind.error; (06 §3.6).
                if (global.gag) {
                    if (!global.params.v.showGaggedErrors) return;
                    info.headerColor = Classification.gagged;
                } else {
                    info.headerColor = Classification.error;
                }
                printDiagnostic(format, ap, info);
                return;
            } else if (global.params.useDeprecated === DiagnosticReporting.inform && !global.gag) {
                if (global.params.v.errorLimit === 0 || global.deprecations <= global.params.v.errorLimit) {
                    info.headerColor = Classification.deprecation;
                    printDiagnostic(format, ap, info);
                }
            }
            return;

        case ErrorKind.warning:
            if (global.params.useWarnings !== DiagnosticReporting.off && !global.gag) {
                info.headerColor = Classification.warning;
                printDiagnostic(format, ap, info);
            }
            return;

        default:
            return assertUnreachable("internal error: unhandled kind in error report");
    }
}

/**
 * Just print to stderr, doesn't care about gagging (errors.d:652). Text within backticks gets
 * syntax-highlighted ONLY when a console is attached; the corpus shim writes to a pipe (no TTY), so
 * `global.console` is null and the highlight branch is dead (10 §3.5 / §7). `unescapeBackticks` (the
 * non-TTY path) collapses `` `` `` -> `` ` ``. All stderr output assembled and written per 10 §4.4.
 */
function printDiagnostic(format: DString, ap: ReadonlyArray<unknown>, info: DiagnosticContext): void {
    let header: DString; // title of error message
    if (info.supplemental) {
        header = ds("       "); // 7 spaces (errors.d:656)
    } else {
        // final switch (info.kind) (errors.d:659).
        switch (info.kind) {
            case ErrorKind.error:
                header = ds("Error: ");
                break;
            case ErrorKind.deprecation:
                header = ds("Deprecation: ");
                break;
            case ErrorKind.warning:
                header = ds("Warning: ");
                break;
            case ErrorKind.tip:
                header = ds("  Tip: ");
                break;
            case ErrorKind.message:
                return assertUnreachable("printDiagnostic: message kind is never headered");
            default: {
                // final switch: D throws SwitchError on an unhandled value (06 §3.2).
                const _exhaustive: never = info.kind;
                void _exhaustive;
                throw new SwitchError();
            }
        }
    }

    if (diagnosticHandler !== null) {
        // info.headerColor is a Classification, whose values ARE Color values (D `enum Classification
        // : Color`); pass it as the Color the handler expects.
        if (diagnosticHandler(info.loc, info.headerColor as unknown as Color, header, format, ap, info.p1, info.p2))
            return;
    }

    // The stderr stream is assembled into `outBytes` and flushed once at the end (10 §4.4) so the
    // interleaving with `printErrorLineContext` matches DMD's sequential `fprintf`/`fputs` order.
    const outBytes: number[] = [];

    if (global.params.v.showGaggedErrors && global.gag) {
        appendDString(outBytes, dmdformat(ds("(spec:%d) "), [global.gag]));
    }
    const con = global.console as Console | null; // cast(Console) global.console

    const tmp = new OutBuffer();
    writeSourceLoc(tmp, info.loc, Loc.showColumns, Loc.messageStyle);
    const locString = tmp.extractSlice();
    if (con) con.setColorBright(true);
    if (locString.length) {
        // fprintf(stderr, "%.*s: ", cast(int) locString.length, locString.ptr)
        appendDString(outBytes, dmdformat(ds("%.*s: "), [locString.length, locString]));
    }
    if (con) con.setColor(info.headerColor as unknown as Color); // Classification value is a Color
    appendDString(outBytes, header); // fputs(header, stderr)
    if (con) con.resetColor();

    tmp.reset();
    if (info.p1) {
        tmp.writestring(info.p1);
        tmp.writestring(ds(" "));
    }
    if (info.p2) {
        tmp.writestring(info.p2);
        tmp.writestring(ds(" "));
    }
    tmp.vprintf(format, ap);

    // `con && strchr(tmp.peekChars(), '`')` — only when a console is attached (dead for the shim).
    if (con && strchrBacktick(tmp.peekChars())) {
        colorSyntaxHighlight(tmp);
        writeHighlights(con, tmp);
    } else {
        unescapeBackticks(tmp);
        appendDString(outBytes, cstr(tmp.peekChars())); // fputs(tmp.peekChars(), stderr)
    }
    outBytes.push(0x0a); // fputc('\n', stderr)

    let loc = info.loc;
    if (
        global.params.v.errorPrintMode !== ErrorPrintMode.simpleError &&
        // ignore invalid files
        !loc.opEquals(SourceLoc_init()) &&
        // ignore mixins for now
        !startsWith(loc.filename, ds(".d-mixin-")) &&
        !global.params.mixinOut.doOutput
    ) {
        tmp.reset();
        printErrorLineContext(tmp, loc.fileContent, loc.fileOffset);
        appendDString(outBytes, cstr(tmp.peekChars())); // fputs(tmp.peekChars(), stderr)
    }
    old_loc = loc;
    // 1.43-beta1 dropped the loc-dedup read of `old_loc` (upstream diff, errors.d:719) but kept
    // the write; `noUnusedLocals` flags a write-only module local, so: `void old_loc;` (04 §5,
    // module-level idiom) — no D call site reads it either, kept for 1:1 fidelity.
    void old_loc;
    // fflush(stderr) — flush by performing the single write now.
    process.stderr.write(dsToJs(new Uint8Array(outBytes)));
}

// `__gshared SourceLoc old_loc;` (errors.d:719) — module-global last-loc cache for supplemental
// de-duplication. Default-initialized SourceLoc (filename empty == SourceLoc.init).
let old_loc: SourceLoc = SourceLoc_init();

/**
 * No D counterpart: the djs driver's reset between two compiles in one process (src/djs.ts
 * `deinitializeFrontend`). `old_loc` is write-only since 1.43 (see its write above), so nothing observable depends
 * on it: the reset puts the slot back to its load-time value and releases the finished compile's last SourceLoc.
 */
export function resetErrorsState(): void {
    old_loc = SourceLoc_init();
}

/**
 * Given an error happening in source code `text`, at index `offset`, print the offending line and a
 * caret pointing to the error into `buf` (errors.d:740). `@safe` erases. The caret column is the
 * DISPLAY column (tab=4 stops, non-ASCII = one column), not the byte column (10 §3.6).
 */
export function printErrorLineContext(buf: OutBuffer, text: DString, offset: number): void {
    if (offset >= text.length) return; // Out of bounds (missing source content in SourceLoc)

    // Scan backwards for beginning of line.
    let s = offset;
    while (s > 0 && text[s - 1] !== 0x0a /* '\n' */) s--;

    const line = text.subarray(s); // text[s .. $]
    const byteColumn = offset - s; // column as reported in the error message (byte offset)
    const tabWidth = 4;

    // The number of column bytes and the number of display columns occupied by a character are not
    // the same for non-ASCII characters (https://issues.dlang.org/show_bug.cgi?id=21849).
    let currentColumn = 0;
    let caretColumn = 0; // actual display column taking into account tabs and unicode characters
    for (let i = 0; i < line.length; ) {
        const start = i;
        const r = utf_decodeChar(line, i);
        const u = r.dchar;
        i = r.nextIdx;
        if (u === 0x09 /* '\t' */) {
            // How many spaces until column is the next multiple of tabWidth.
            const equivalentSpaces = tabWidth - (currentColumn % tabWidth);
            for (let j = 0; j < equivalentSpaces; j++) buf.writeByte(0x20 /* ' ' */);
            currentColumn += equivalentSpaces;
        } else if (u === 0x0d /* '\r' */ || u === 0x0a /* '\n' */) {
            break;
        } else {
            buf.writestring(line.subarray(start, i)); // line[start .. i]
            currentColumn++;
        }
        if (i <= byteColumn) caretColumn = currentColumn;
    }
    buf.writeByte(0x0a); // '\n'

    for (let i = 0; i < caretColumn; i++) buf.writeByte(0x20 /* ' ' */);

    buf.writeByte(0x5e /* '^' */);
    buf.writeByte(0x0a /* '\n' */);
}

/**
 * The type of the fatal error handler (dmd/errors.d:806). Returns: true if error handling is done,
 * false to do exit(EXIT_FAILURE).
 */
export type FatalErrorHandler = () => boolean;

/// The fatal error handler (dmd/errors.d:812). If non-null it is called for every `fatal()` call.
export let fatalErrorHandler: FatalErrorHandler | null = null;

/// Setter for the `__gshared fatalErrorHandler`.
export function setFatalErrorHandler(h: FatalErrorHandler | null): void {
    fatalErrorHandler = h;
}

/**
 * Call this after printing out fatal error messages to clean up and exit the compiler (dmd/errors.d:818).
 * With a `fatalErrorHandler` answering true it RETURNS, as D does (dmd/errors.d:820-821), and the caller goes on
 * with the code that follows the call: an in-process host (an editor) gets every pass the driver runs past the
 * fatal point (ImportC's `fatal()`s excepted: src/driver/cpreprocessor.ts `stopAtFatal` stops there). Without a
 * handler, or with one answering false: plug the error sinks (flush SARIF), then exit non-zero (EXIT_FAILURE == 1);
 * `process.exit(1)` is the shim's `exit(EXIT_FAILURE)` (10 §4.1).
 * The CLI never returns from here: its handler, `throwFatalError`, throws `FatalError` itself (10 §4.1).
 */
export function fatal(): void {
    if (fatalErrorHandler && fatalErrorHandler())
        return;

    global.plugErrorSinks();

    process.exit(1);
}

/// Thrown by `throwFatalError`, the CLI's fatal handler: the stop of a compile that ldc2 ends with
/// `exit(EXIT_FAILURE)` (dmd/errors.d:825). `djsMain` finishes it (plugErrorSinks, status 1); it is not an ICE.
export class FatalError extends Error {
    constructor() {
        super("fatal");
        this.name = "FatalError";
    }
}

/**
 * The fatal handler of the CLI (`djsMain`'s default) and of the tests that pin a fatal stop: it never answers,
 * it throws `FatalError`, so `fatal()` does not return and the stack unwinds to the catch of the caller that
 * installed it. No D counterpart: ldc2 has no handler and `fatal()` exits the process (dmd/errors.d:825).
 */
export function throwFatalError(): never {
    throw new FatalError();
}

/**
 * Whether the compile runs in editor mode: a fatal handler other than the CLI's `throwFatalError` (or none, the tests'
 * harness) is installed, the host's, which answers true (10 §4.7, "Editor mode"). `djsMain` installs it before the
 * compile starts, so the mode is known before any `fatal()` is called. No D counterpart.
 */
export function editorMode(): boolean {
    return fatalErrorHandler !== null && fatalErrorHandler !== throwFatalError;
}

/**
 * The reading of the dmd tests that skip analysis, or a report, when ANY error was reported (`if (global.errors)`):
 * dmd/clone.d:1688 (`needCopyOrMoveCtor`), dmd/dsymbolsem.d:819 and :837 (the deferred semantic2/semantic3 loops),
 * dmd/templatesem.d:3001 under gag (at gag level 0 it keeps D's reading, templatesem.ts) and dmd/typesem.d:4405. No D
 * counterpart. The kept-module engine records, at each site, whether a unit's answer depended on the windows open at
 * its entry (keep.ts `keepReadErrors`).
 *
 * In the CLI it is D's test, `global.errors !== 0`, as ldc2. In editor mode (`editorMode`) it is
 * `global.windowErrors !== 0`: an error reported to the editor does not switch analysis off elsewhere; only the gagged
 * errors of the gag windows open now do, exactly as in a compile without the reported errors. `windowErrors` (djs's,
 * globals.ts) counts the gagged reports and is restored at each window's end, so at gag level 0 it is 0; inside windows
 * it counts the windows' own gagged errors, which dmd also adds to `global.errors`: in a compile without ungagged
 * errors the two readings are equal at every point, so the editor's output up to its first error is ldc2's. D's
 * `gaggedErrors` would not do: an instance with errors matched ungagged adds to it and it stays counted past every
 * window (dmd/templatesem.d:1021-1022).
 *
 * Why: the kept-module engine (src/keep.ts) replays a unit recorded in a compile without errors into one that has
 * reported some, where under D's reading a fresh compile skips that analysis. Under this reading a fresh compile reads
 * at the unit's tests what the recording read, so kept equals fresh without dropping the units that cross them: the
 * engine records the window state of each request and whether a unit read these tests (`keepReadErrors`), and refuses
 * only the replay of a reading unit entered with other gagged errors than recorded (keep.ts `replayUnit`, at
 * templatesem.d:3001 at gag level 0 `keepErrorState`, as in the CLI). Rejected: dropping or aborting the units that
 * cross these tests in another error state (exact, but `std.typecons` and `std.traits` instances cross them, and a kept
 * compile of a 170-module application after a semantic error cost a fresh one's 48-53 s); reading no error past a
 * returned `fatal()` (it hid the gagged errors: `__traits(compiles, ...)` answered true).
 */
export function analysisSeesErrors(): boolean {
    return editorMode() ? global.windowErrors !== 0 : global.errors !== 0;
}

/**
 * Try to stop forgetting to remove the breakpoints from release builds (errors.d:834). `@safe`
 * erases. Literally `assert(0)`.
 */
export function halt(): never {
    return assertUnreachable();
}

/**
 * Scan characters in `buf`. Assume text enclosed by `` `...` `` is D source code, and color
 * syntax-highlight it (errors.d:848). Double backticks become a single backtick without coloring.
 * `private` -> module-private (touched by sibling printDiagnostic + the ported unittest, 01 §2.5).
 * Reached ONLY when a console is attached (the shim never has one). Faithful OutBuffer ops.
 */
export function colorSyntaxHighlight(buf: OutBuffer): void {
    let inBacktick = false;
    let iCodeStart = 0;
    const offset = 0;
    for (let i = offset; i < buf.length(); ++i) {
        const c = buf.opIndex(i);
        switch (c) {
            case 0x60 /* '`' */: {
                // A double backtick means it's part of the content, don't color.
                if (i + 1 < buf.length() && buf.opIndex(i + 1) === 0x60) {
                    buf.remove(i, 1);
                    continue;
                }

                if (inBacktick) {
                    inBacktick = false;
                    const codebuf = new OutBuffer();
                    codebuf.write(buf.opSlice(iCodeStart, i)); // buf[iCodeStart .. i]
                    codebuf.writeByte(0);
                    // escape the contents, but do not perform highlighting except for DDOC_PSYMBOL
                    colorHighlightCode(codebuf);
                    buf.remove(iCodeStart, i - iCodeStart);
                    const pre = ds("");
                    i = buf.insert(iCodeStart, pre);
                    i = buf.insert(i, codebuf.opSliceAll()); // codebuf[]
                    break;
                }
                inBacktick = true;
                iCodeStart = i + 1;
                break;
            }
            default:
                break;
        }
    }
}

/// Replace double backticks in `buf` with a single backtick (errors.d:892). Always taken on the
/// non-TTY corpus path (10 §3.5). Public (no `private` upstream); the module unittest drives it.
export function unescapeBackticks(buf: OutBuffer): void {
    for (let i = 0; i + 1 < buf.length(); ++i) {
        if (buf.opIndex(i) === 0x60 /* '`' */ && buf.opIndex(i + 1) === 0x60) buf.remove(i, 1);
    }
}

/**
 * Embed these highlighting commands in the text stream (errors.d:917). `enum HIGHLIGHT : ubyte` —
 * members are Color values + the 0xFF escape marker. TS numeric enum (02 §4.2).
 */
export enum HIGHLIGHT {
    Default = Color.black, // back to whatever the console is set at
    Escape = 0xff, // '\xFF' — highlight Color follows
    Identifier = Color.white,
    Keyword = Color.white,
    Literal = Color.white,
    Comment = Color.darkGray,
    Other = Color.cyan, // other tokens
}

/**
 * Highlight code for CODE section (errors.d:934). STOP-stub (10 §7 / 11): this rewrites `buf` by
 * running the Lexer over its bytes and emitting HIGHLIGHT escapes, using pointer arithmetic between
 * the lexer cursor and `Token.ptr` (`tok.ptr - lastp`, `lex.p - tok.ptr`). That cursor/token-pointer
 * subtraction is not a mechanical byte-model translation, and the whole routine is UNREACHABLE for
 * the corpus shim: it is called only from `colorSyntaxHighlight`'s console branch, which fires only
 * when `global.console !== null` (a TTY) — the shim writes to a pipe, so `con` is always null. If a
 * future TTY-attached use needs it, port the lexer-cursor arithmetic deliberately (escalate, 11).
 */
function colorHighlightCode(_buf: OutBuffer): void {
    return assertUnreachable(
        "colorHighlightCode: TTY syntax-highlight path not ported (no console in the shim; 10 §7)",
    );
}

/**
 * Write the buffer contents with embedded highlights to stderr (errors.d:1007). `scope (exit)`
 * resetColor -> try/finally (06 §7.1). Reached only with a real console (dead for the shim). Writes
 * each non-escape byte to `con.fp()`; an escape byte selects the next color.
 */
function writeHighlights(con: Console, buf: OutBuffer): void {
    let colors = false;
    try {
        for (let i = 0; i < buf.length(); ++i) {
            const c = buf.opIndex(i);
            if (c !== HIGHLIGHT.Escape) {
                con.fp().write(new Uint8Array([c])); // fputc(c, con.fp)
                continue;
            }

            const color = buf.opIndex(++i);
            if (color === HIGHLIGHT.Default) {
                con.resetColor();
                colors = false;
            } else if (color === Color.white) {
                con.resetColor();
                con.setColorBright(true);
                colors = true;
            } else {
                con.setColor(color as Color);
                colors = true;
            }
        }
    } finally {
        // Do not mess up console if highlighting aborts.
        if (colors) con.resetColor();
    }
}

// ── helpers (no upstream .d source) ─────────────────────────────────────────────────────────────

/// A default-initialized SourceLoc (D `SourceLoc.init` — filename empty, line/column 0). A fresh
/// one each call so callers never alias `old_loc`.
function SourceLoc_init(): SourceLoc {
    return new SourceLoc(ds(""), 0, 0);
}

/// Append a DString's bytes onto a number[] accumulator (the assembled stderr stream).
function appendDString(acc: number[], s: DString): void {
    for (let i = 0; i < s.length; i++) acc.push(s[i]);
}

/// `strchr(tmp.peekChars(), '`') != null` — does the (NUL-terminated) C-string contain a backtick
/// before its terminator? (errors.d:707). Scans only the logical C-string (up to the first NUL).
function strchrBacktick(p: DString): boolean {
    return cstr(p).indexOf(0x60) >= 0; // backtick within the logical C-string (cstr stops at NUL)
}
