// Port of dmd/root/man.d — Open an online manual page (launch the system browser at a URL).
//
// Faithful 1:1 frontend port (NOT a runtime-lib reimplementation): man.d is a small driver
// "nicety" — the only export is `browse(url)`, which the DMD/LDC driver calls to open the online
// manual (e.g. from `-man`). It is NOT on the lex→sema→CTFE path the djs CLI shim exercises, so it
// is never reached by the corpus; it is ported for structural completeness and diff-ability.
//
// GOVERNING TRANSLATIONS (resolved against _config.md):
//   - resolved: version(Windows) -> false  (drop the ShellExecuteA branch).
//   - resolved: version(OSX) / version(Posix) -> both ON-ish, collapsed to one POSIX path
//     (_config.md §1: OSX/linux are "CONDITIONAL→treat as one POSIX"). The two POSIX arms differ
//     ONLY in the launch command: macOS uses `open`, Linux uses `$BROWSER` or `xdg-open`. That
//     macOS-vs-Linux divergence is FLAGGED #1 in _config.md ("man.d: open vs xdg-open … keep a
//     runtime process.platform switch, or hard-pick one host?") — an undecided human decision.
//   - The launch mechanism itself (`fork()` + `execvp()`, and the Windows `ShellExecuteA`) has NO
//     faithful JS equivalent: JS has no `fork`/`execvp`. A naive `child_process.spawn` would be a
//     guess on BOTH the FLAGGED command choice and the process model. Per the STOP protocol
//     (11-escalate.md) and the task brief, the browser-launch body is a STOP-stub; the rest of the
//     function (signature + the `in` contract) is ported faithfully. See the gap report.

import { ds } from "../../dstring.js";
import type { DString } from "../../dstring.js";
import { cstr } from "../../dstring.js";
import { startsWith } from "./string.js";
import { assert } from "../../assert.js";

// The two URL-scheme prefixes the `in` contract checks for (man.d:27/39/73 `strncmp(url,…)==0`).
// `strncmp(url,"http://",7)==0` is exactly "url begins with these 7 bytes" — reproduced by
// `startsWith` over the logical C-string (the bytes of `url` before its NUL terminator).
const HTTP_PREFIX: DString = ds("http://");
const HTTPS_PREFIX: DString = ds("https://");

/**
 * `browse(url)` (man.d:24/36/70) — open the given `url` in the system web browser.
 *
 * Contract (the D `in{}` precondition, man.d:26-28 / 38-40 / 72-74): `url` MUST begin with
 * `http://` or `https://`. Ported faithfully as a leading `assert` (cheatsheet 04§7: `in{…}` →
 * leading asserts). `url` is a D `const(char)*` → a NUL-terminated `DString` (02§11); `cstr` views
 * the bytes before the first NUL, which is the logical string `strncmp` would have compared.
 *
 * The actual launch (fork/execvp the browser process) is a STOP-stub — see the file header and the
 * gap report: the macOS-`open`-vs-Linux-`xdg-open` command choice is FLAGGED #1 in _config.md and
 * JS has no `fork`/`execvp`, so a faithful translation cannot be produced without a human decision.
 * `browse` is a driver nicety off the shim's lex→sema→CTFE path, so the stub is never hit by the
 * corpus; if a future driver feature needs it, resolve the flag and replace the stub.
 *
 * Cost: O(prefix) for the contract check, then throws. Returns `void` (man.d: `void browse`).
 */
export function browse(url: DString): void {
    const logical = cstr(url);
    assert(startsWith(logical, HTTP_PREFIX) || startsWith(logical, HTTPS_PREFIX));

    // DJS-ESCALATE: browser launch via fork()/execvp() (open vs xdg-open) — no faithful JS port,
    // FLAGGED #1 in _config.md (dmd/root/man.d:42-66 OSX / :76-94 Posix)
    throw new Error("DJS-ESCALATE: man.browse — browser launch not translated (see escalation report)");
}
