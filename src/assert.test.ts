import { describe, it, expect } from "vitest";
import {
  DThrowable,
  DException,
  DError,
  AssertError,
  SwitchError,
  assert,
  assertUnreachable,
  enforce,
} from "./assert.js";

describe("exception hierarchy (06-control-flow.md §8.3)", () => {
  it("DThrowable is the root and extends the JS Error (for stack traces)", () => {
    const t = new DThrowable("root");
    expect(t).toBeInstanceOf(Error);
    expect(t).toBeInstanceOf(DThrowable);
    expect(t.name).toBe("DThrowable");
    expect(t.message).toBe("root");
    expect(typeof t.stack).toBe("string");
  });

  it("DException extends DThrowable (recoverable branch)", () => {
    const e = new DException("recoverable");
    expect(e).toBeInstanceOf(DException);
    expect(e).toBeInstanceOf(DThrowable);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(DError);
    expect(e.name).toBe("DException");
  });

  it("DError extends DThrowable but is NOT DException (unrecoverable branch)", () => {
    const e = new DError("unrecoverable");
    expect(e).toBeInstanceOf(DError);
    expect(e).toBeInstanceOf(DThrowable);
    expect(e).not.toBeInstanceOf(DException);
    expect(e.name).toBe("DError");
  });

  it("AssertError extends DError extends DThrowable", () => {
    const e = new AssertError("boom");
    expect(e).toBeInstanceOf(AssertError);
    expect(e).toBeInstanceOf(DError);
    expect(e).toBeInstanceOf(DThrowable);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(DException);
    expect(e.name).toBe("AssertError");
  });

  it("SwitchError extends DError, distinct from AssertError", () => {
    const e = new SwitchError();
    expect(e).toBeInstanceOf(SwitchError);
    expect(e).toBeInstanceOf(DError);
    expect(e).not.toBeInstanceOf(AssertError);
    expect(e.name).toBe("SwitchError");
    // default message (06 §3.2 final-switch default arm)
    expect(e.message).toBe("No appropriate switch clause found");
    expect(new SwitchError("custom").message).toBe("custom");
  });
});

describe("assert(cond, msg?) — ldc2-verified message semantics (10 §2.1)", () => {
  it("passes silently on a truthy cond", () => {
    expect(() => assert(true)).not.toThrow();
    expect(() => assert(1)).not.toThrow();
    expect(() => assert("non-empty")).not.toThrow();
    expect(() => assert({})).not.toThrow();
    expect(() => assert([])).not.toThrow(); // [] is truthy in JS
    expect(() => assert(1n)).not.toThrow();
  });

  it("assert(false) throws AssertError with default message 'Assertion failure'", () => {
    // ldc2: core.exception.AssertError ... Assertion failure
    expect(() => assert(false)).toThrow(AssertError);
    try {
      assert(false);
      expect.unreachable("assert(false) must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AssertError);
      expect((e as AssertError).message).toBe("Assertion failure");
    }
  });

  it("assert(false, 'msg') throws AssertError carrying the verbatim message", () => {
    // ldc2: core.exception.AssertError ... x must be six
    const x: number = 5; // widened to number so tsc does not fold the comparison
    try {
      assert(x === 2, "x must be six");
      expect.unreachable("assert(false, msg) must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AssertError);
      expect((e as AssertError).message).toBe("x must be six");
    }
  });

  it("treats every falsy value as a failed assertion", () => {
    for (const falsy of [false, 0, "", null, undefined, NaN, 0n]) {
      expect(() => assert(falsy)).toThrow(AssertError);
    }
  });

  it("a thrown AssertError is instanceof-discriminable as DError/DThrowable (10 §2.3)", () => {
    try {
      assert(false);
    } catch (e) {
      expect(e instanceof AssertError).toBe(true);
      expect(e instanceof DError).toBe(true);
      expect(e instanceof DThrowable).toBe(true);
      expect(e instanceof DException).toBe(false);
    }
  });
});

describe("assert narrows the type (asserts cond predicate, 10 §2.2)", () => {
  it("lets TS treat the value as non-null after a passing assert", () => {
    const maybe: string | null = "value" as string | null;
    assert(maybe !== null);
    // If `assert` were not `asserts cond`, the next line would be a TS error under strict.
    expect(maybe.length).toBe(5);
  });
});

describe("assertUnreachable() — assert(0)/assert(false) idiom (10 §2.2)", () => {
  it("always throws AssertError with the default 'Assertion failure'", () => {
    try {
      assertUnreachable();
      expect.unreachable("assertUnreachable must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AssertError);
      expect((e as AssertError).message).toBe("Assertion failure");
    }
  });

  it("carries the internal-error message from assert(0, '...') sites", () => {
    try {
      assertUnreachable("internal error: unhandled TY");
      expect.unreachable("assertUnreachable must throw");
    } catch (e) {
      expect((e as AssertError).message).toBe("internal error: unhandled TY");
    }
  });

  it("its return type is never, so following code is dead (flow-analysis check)", () => {
    // This function would not type-check (missing return) if assertUnreachable were
    // not typed `never`. Its existence under strict tsc is the contract assertion.
    const pick = (n: number): string => {
      if (n === 1) return "one";
      assertUnreachable("only 1 supported");
    };
    expect(() => pick(2)).toThrow(AssertError);
    expect(pick(1)).toBe("one");
  });
});

describe("enforce(cond, msg) — boundary check (boundary-validation.md, 10 §2.2)", () => {
  it("passes on truthy cond", () => {
    expect(() => enforce(true)).not.toThrow();
    expect(() => enforce("ok", "should not fire")).not.toThrow();
  });

  it("throws AssertError (same class as assert) with the given message on violation", () => {
    try {
      enforce(0, "participant code required");
      expect.unreachable("enforce(false) must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AssertError);
      expect((e as AssertError).message).toBe("participant code required");
    }
  });

  it("uses a default message when none is supplied", () => {
    expect(() => enforce(false)).toThrow(AssertError);
    try {
      enforce(false);
    } catch (e) {
      expect((e as AssertError).message).toBe("enforce failed");
    }
  });

  it("narrows the type after a passing enforce (asserts cond)", () => {
    const code: string | null = "ABC" as string | null;
    enforce(code !== null, "code required");
    expect(code.length).toBe(3);
  });
});
