// Ported from dmd/console.d (module dmd.console).
//
// Control the various text mode attributes, such as color, when writing text to the console.
//
// GOVERNING TRANSLATIONS (resolved against _config.md):
//   - resolved: version(Windows) -> false. The whole `WindowsConsole` class (console.d:83-161),
//     its `getStdHandle`/`SetConsoleTextAttribute`/`CONSOLE_SCREEN_BUFFER_INFO` machinery, the
//     `version(Windows)` branches in `detectTerminal`/`createConsole`, and the
//     `core.sys.windows.*` imports are DROPPED. We keep the POSIX `else` path.
//   - resolved: version(Posix) -> true. The `core.sys.posix.unistd` import (`isatty`,
//     `STDERR_FILENO`) maps to Node's POSIX-equivalent `process.stderr.isTTY` (see detectTerminal).
//   - dropped: the trailing `else { static assert(0); }` (console.d:31-34, :227-228) — dead once
//     the target is fixed to POSIX (_config.md §6); only one version arm is ever live.
//
// THE `FILE*` MAPPING (the one structural decision):
//   D's `Console`/`ANSIConsole` are parametric over a C `FILE*` stream (`_fp`), which the frontend
//   only ever instantiates with `core.stdc.stdio.stderr` (mars.d:397 `createConsole(stderr)`). There
//   is no `FILE*` in JS; the canonical port of a C-stdio write target is a write-sink (02 §10 opaque
//   handle; 10 §4.4 stderr FFI). We model `FILE*` as the minimal `FILE` interface below — a sink
//   with a byte `write` — which Node's `process.stderr` / `process.stdout` satisfy structurally. The
//   `fprintf(_fp, …)` / `fputs(…, _fp)` C-stdio writes assemble their bytes via `dmdformat` (the one
//   printf owner, 10 §3.5) and emit them in a single `_fp.write(...)` (10 §4.4: one format, one
//   write). This keeps the class structure 1:1 while resolving the stream to its real Node target.
//
// SCOPE NOTE: the ANSI color machinery is only reached when a TTY console is attached
// (errors.d:677 `cast(Console) global.console`); the djs CLI shim writes to a pipe, so this path is
// dead for the `fail_compilation` corpus (10 §7). `detectTerminal`/`detectColorPreference` (used by
// mars.d:617-624 to set `params.v.color`) are the live, faithfully-ported entry points.

import { ds } from "../dstring.js";
import { dmdformat } from "./root/dmdformat.js";

// `import core.stdc.stdio;`   (console.d:15) — C-stdio FFI. No runtime module: `FILE*` becomes the
//   `FILE` write-sink below; `fprintf`/`fputs`/`stdout`/`stderr` resolve to `dmdformat` + the sink's
//   `write` and Node's `process.stdout`/`process.stderr` (01 §3.7, 10 §4.4).
// `import core.stdc.stdlib;`  (console.d:16) — provided `getenv`; mapped to `process.env` below.
// `import core.stdc.string;`  (console.d:17) — provided `strcmp`; mapped to a JS `===` below.
// `import core.sys.posix.unistd;` (console.d:29, version(Posix)) — `isatty`/`STDERR_FILENO`; mapped
//   to `process.stderr.isTTY` (Node's POSIX is-a-terminal query) below.

/**
 * The byte write-sink that stands in for a C `FILE*` (02 §10 opaque handle; 10 §4.4).
 *
 * In the frontend a `FILE*` is only ever `stderr` (mars.d:397) — `process.stderr` and
 * `process.stdout` both satisfy this shape (`NodeJS.WriteStream.write` accepts a `Uint8Array`). The
 * port writes pre-formatted bytes (`dmdformat` output, a `DString`) straight to `write`; the buffer
 * IS the bytes C's `fprintf`/`fputs` would have emitted, so no re-encoding happens between formatter
 * and stream.
 */
export interface FILE {
    write(buffer: Uint8Array): boolean;
}

// `enum Color : int` (console.d:36) — a ≤32-bit-based enumeration -> TS numeric `enum` (02 §4.2).
// The member-initializer expressions (`red | green`, `bright | lightGray`, …) are bitwise-OR of
// earlier members; they fold at translation time (07-compile-time.md) to the constants verified with
// `ldc2 -run` (/tmp/probe_console.d). Domain is `number` (≤32-bit, 09 §4.1). `bright | black == 8`
// collides with `bright == 8` (so `darkGray == bright == 8`) — TS enums permit duplicate values,
// matching D.
export enum Color {
    black = 0,
    red = 1,
    green = 2,
    blue = 4,
    yellow = 1 | 2, // red | green               = 3
    magenta = 1 | 4, // red | blue                = 5
    cyan = 2 | 4, // green | blue                  = 6
    lightGray = 1 | 2 | 4, // red | green | blue   = 7
    bright = 8,
    darkGray = 8 | 0, // bright | black            = 8
    brightRed = 8 | 1, // bright | red             = 9
    brightGreen = 8 | 2, // bright | green         = 10
    brightBlue = 8 | 4, // bright | blue           = 12
    brightYellow = 8 | 3, // bright | yellow       = 11
    brightMagenta = 8 | 5, // bright | magenta     = 13
    brightCyan = 8 | 6, // bright | cyan           = 14
    white = 8 | 7, // bright | lightGray           = 15
}

/***************************************
 * Where text-mode console attributes are controlled.
 */
// `interface Console` (console.d:57) with pure method signatures -> TS `interface` (02 §3). The
// `nothrow:` block and the `@property` on `fp` ERASE (04 §8/§9): `@property FILE* fp()` -> `fp(): FILE`
// (a no-arg method; an interface cannot carry a `get` accessor, and call sites read `con.fp()`).
export interface Console {
    fp(): FILE;

    /**
     * Turn on/off intensity.
     * Params:
     *      bright = turn it on
     */
    setColorBright(bright: boolean): void;

    /**
     * Set color and intensity.
     * Params:
     *      color = the color
     */
    setColor(color: Color): void;

    /**
     * Reset console attributes to what they were
     * when create() was called.
     */
    resetColor(): void;
}

// dropped: final class WindowsConsole (console.d:83-161) — entirely under `version(Windows)`
// (resolved -> false, _config.md). Its `getStdHandle`/`GetConsoleScreenBufferInfo`/
// `SetConsoleTextAttribute` Win32 console API has no POSIX counterpart; the POSIX build never
// compiles it.

/* Uses the ANSI escape codes.
 * https://en.wikipedia.org/wiki/ANSI_escape_code
 * Foreground colors: 30..37
 * Background colors: 40..47
 * Attributes:
 *  0: reset all attributes
 *  1: high intensity
 *  2: low intensity
 *  3: italic
 *  4: single line underscore
 *  5: slow blink
 *  6: fast blink
 *  7: reverse video
 *  8: hidden
 */
// `private final class ANSIConsole : Console` (console.d:178) -> `class ANSIConsole implements Console`
// (02 §2/§3; `final` is harmless to keep implicit). `private`/`nothrow:`/`@safe` ERASE (04 §8). The
// class is module-`private` in D but referenced by the sibling `createConsole` (and the ported test),
// so it is emitted WITHOUT TS `private` and exported (01 §2.5 module-private convention).
export class ANSIConsole implements Console {
    // `private FILE* _fp;` (console.d:183) — the output stream. Touched by `fp()`/`createConsole`
    // (same module) -> emitted non-`private` // D module-private (01 §2.5).
    _fp: FILE; // D module-private

    // `this(FILE* fp) @safe { _fp = fp; }` (console.d:187) — @safe erases (04 §8).
    constructor(fp: FILE) {
        this._fp = fp;
    }

    // `@property FILE* fp()` (console.d:189) -> `fp(): FILE` (@property erases, 04 §9; the call site
    // errors.d reads `con.fp()` form — kept as a method to satisfy the `Console` interface).
    fp(): FILE {
        return this._fp;
    }

    // `fprintf(_fp, "\033[%dm", bright)` (console.d:193). `bright` is a `bool`; C's `%d` prints it as
    // 1/0. `dmdformat`'s `%d` consumes a number, so map the boolean to 1/0 at the call site (no
    // implicit bool->int in JS, 09 "Numeric truthiness"). Verified `ldc2`: true->ESC[1m, false->ESC[0m.
    setColorBright(bright: boolean): void {
        this._fp.write(dmdformat(ds("\x1b[%dm"), [bright ? 1 : 0]));
    }

    // `fprintf(_fp, "\033[%d;%dm", color & Color.bright ? 1 : 0, 30 + (color & ~Color.bright))`
    // (console.d:198). Both bitwise sub-expressions are `int`-domain (`number`), JS `&`/`~` direct
    // (09 §4.1). Verified `ldc2` (brightYellow): hi=1, code=33.
    setColor(color: Color): void {
        this._fp.write(dmdformat(ds("\x1b[%d;%dm"), [color & Color.bright ? 1 : 0, 30 + (color & ~Color.bright)]));
    }

    // `fputs("\033[m", _fp)` (console.d:203) — already-formatted literal bytes, written straight
    // (10 §4.4: `fputs` carries no format).
    resetColor(): void {
        this._fp.write(ds("\x1b[m"));
    }
}

/**
 Tries to detect whether DMD has been invoked from a terminal.
 Returns: `true` if a terminal has been detected, `false` otherwise
 */
// `bool detectTerminal()` (console.d:211), `version(Posix)` arm (console.d:213-217). `getenv("TERM")`
// -> `process.env.TERM` (a JS `string | undefined`, not a C `const(char)*` — no `DString`/NUL view
// needed); `isatty(STDERR_FILENO)` -> `process.stderr.isTTY` (Node's POSIX is-a-terminal query, the
// faithful equivalent of the libc call); `term && term[0]` -> TERM set AND non-empty;
// `strcmp(term, "dumb") != 0` -> `term !== "dumb"`.
export function detectTerminal(): boolean {
    const term = process.env.TERM;
    return process.stderr.isTTY === true && term !== undefined && term.length > 0 && term !== "dumb";
}

/**
 * Tries to detect the preference for colorized console output
 * based on the `NO_COLOR` environment variable: https://no-color.org/
 *
 * Returns: `true` if colorized console output is preferred
 */
// `bool detectColorPreference()` (console.d:237). `getenv("NO_COLOR")` -> `process.env.NO_COLOR`.
// D: `noColor == null || noColor[0] == '\0'` (prefer color when NO_COLOR is unset OR empty). In Node,
// an unset env var is `undefined` (the `== null` case) and an empty one is `""` (the `[0] == '\0'`
// case). Verified `ldc2`: unset->1, ''->1, '1'->0.
export function detectColorPreference(): boolean {
    const noColor = process.env.NO_COLOR;
    return noColor === undefined || noColor === "";
}

/**
 * Creates an instance of Console connected to stream fp.
 * Params:
 *      fp = io stream
 * Returns:
 *      reference to created Console
 */
// `Console createConsole(FILE* fp)` (console.d:250). The `version(Windows)` WindowsConsole.create
// attempt (console.d:252-256) drops (resolved -> false, _config.md); the POSIX path is the
// unconditional `return new ANSIConsole(fp)`.
export function createConsole(fp: FILE): Console {
    return new ANSIConsole(fp);
}
