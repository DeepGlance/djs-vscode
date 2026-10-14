// Hand-written djs runtime helper (not a 1:1 port of a single dmd/root file).
// Contract: 08-runtime-lib.md §12, 10-tests-diagnostics.md §2, 06-control-flow.md §8.3.
//
// This module is the SINGLE sink for the project's `assert` translation rule and the
// home of D's Throwable/Exception/Error class hierarchy (06 §8.3 mandates these classes
// live in the runtime lib). Every translated `assert(...)` routes through `assert` /
// `assertUnreachable` here; do not invent per-file assert helpers (08 §12).
//
// Crash-only design: a failed assert THROWS and
// unwinds to the CLI shim's top-level handler, which exits non-zero. Asserts are never
// elided in a "release" build — a silenced assert hides corruption (10 §2.2).
//
// ldc2-verified (DMD v2.112.1) message semantics:
//   assert(false)        -> AssertError, message "Assertion failure"
//   assert(false, "msg") -> AssertError, message "msg"
//   assert(0)            -> AssertError, message "Assertion failure"

/**
 * Root of D's exception hierarchy (`Throwable`). Extends the JS `Error` so that
 * V8 captures a stack trace and Vitest/Node print it on an uncaught throw.
 *
 * Renamed from D's `Throwable` to `DThrowable` to avoid confusion at catch sites;
 * the JS global `Error` is used ONLY as the base of this class, never as D's `Error`
 * (which is `DError` below). Confusing the two silently changes which catch arm fires.
 */
export class DThrowable extends Error {
  constructor(message: string) {
    super(message);
    // `Error` subclassing under transpilation can leave `name` pointing at the base;
    // pin it explicitly so diagnostics and `instanceof`-adjacent string checks are stable.
    this.name = "DThrowable";
  }
}

/**
 * D's `Exception` — the recoverable branch of the hierarchy. The frontend throws these
 * for user-facing, catchable conditions; CTFE / `__traits(compiles, …)` catch these but
 * deliberately let `DError`/`AssertError` through (10 §2.3).
 */
export class DException extends DThrowable {
  constructor(message: string) {
    super(message);
    this.name = "DException";
  }
}

/**
 * D's `Error` — the UNRECOVERABLE branch (assertion failures, switch errors, range
 * errors). Renamed to `DError`: it is NOT the JS global `Error`. An escaped `DError`
 * at the shim top level is an Internal Compiler Error, reported as such (10 §2.2/§4).
 */
export class DError extends DThrowable {
  constructor(message: string) {
    super(message);
    this.name = "DError";
  }
}

/**
 * D's `core.exception.AssertError`, thrown by every failed `assert`. Kept as a distinct
 * subclass so later CTFE/`__traits(compiles)` machinery can `instanceof`-discriminate an
 * assertion failure from an ordinary exception (10 §2.3). Always throw THIS from the
 * assert helpers, never a bare `DError` or JS `Error`.
 */
export class AssertError extends DError {
  constructor(message: string) {
    super(message);
    this.name = "AssertError";
  }
}

/**
 * D's `core.exception.SwitchError`, thrown by a `final switch` whose subject hit no case
 * (06 §3.2). Defined here alongside the rest of the unrecoverable hierarchy so control-flow
 * translations have one import home; the `final switch` default arm constructs it.
 */
export class SwitchError extends DError {
  constructor(message = "No appropriate switch clause found") {
    super(message);
    this.name = "SwitchError";
  }
}

/**
 * D's `assert(cond)` / `assert(cond, msg)`.
 *
 * Throws `AssertError` on a falsy `cond`; the message is `msg` if given, else the
 * ldc2-verified default `"Assertion failure"`. The `asserts cond` predicate makes TS
 * narrow `cond` afterwards (so `assert(x !== null); x.foo()` type-checks), mirroring D
 * where code after `assert(x !is null)` may dereference `x`. Use this predicate form,
 * never an ad-hoc `=== undefined` recovery check — the point is to crash, not recover.
 *
 * Cost: branch + (on failure) one allocation; safe in hot paths when `cond` holds.
 */
export function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new AssertError(msg ?? "Assertion failure");
}

/**
 * D's `assert(0)` / `assert(false)` — the unconditional-halt / unreachable / internal-error
 * idiom (319 sites in the frontend, e.g. `dmd/mtype.d:430`; `dmd/errors.d:836 halt()` is
 * literally `assert(0)`). Returns `never`, so TS flow analysis treats following code as
 * dead — matching D's `assert(0)` no-return semantics. Optional `msg` carries the
 * "internal error: …" text from `assert(0, "…")` sites.
 */
export function assertUnreachable(msg = "Assertion failure"): never {
  throw new AssertError(msg);
}

/**
 * Project boundary-check helper (NOT an upstream DMD construct — the frontend uses bare
 * `assert` only, 10 §2.2). Validates an invariant at a system boundary (CLI ingress, etc.)
 * and throws `AssertError` on violation: fail
 * loud at the boundary, NEVER a silent `return false`. Same throw class as `assert` so the
 * shim's ICE discrimination is uniform; the `asserts cond` predicate narrows `cond` after.
 */
export function enforce(cond: unknown, msg = "enforce failed"): asserts cond {
  if (!cond) throw new AssertError(msg);
}
