// Ported from dmd/root/optional.d unittest (optional.d:16). 10-tests-diagnostics.md §1.
// Covers the §10 contract + the ldc2-verified edge cases (probe /tmp/probe_opt.d):
//   empty -> isEmpty, get() throws AssertError, hasValue always false (even hasValue(T.init));
//   present-with-falsy-value (Optional!bool(false)) distinguished from empty;
//   create == value ctor; copy() is an independent shallow copy.
import { describe, it, expect } from "vitest";
import { Optional, AssertError } from "./optional.js";

describe("optional", () => {
  // Faithful port of the in-source D `unittest` (optional.d:16-39) over Optional!int.
  it("Optional!int (D unittest port)", () => {
    // `Optional!int opt;` (optional.d:20) -> default construction, NO copy (03 §1 non-copy).
    const opt0 = new Optional<number>(); // empty (present defaults to false)
    expect(opt0.isEmpty()).toBe(true); // D `assert(opt.isEmpty())`
    expect(opt0.isPresent()).toBe(false); // D `assert(!opt.isPresent())`
    expect(opt0.hasValue(1)).toBe(false); // D `assert(!opt.hasValue(1))`
    expect(opt0.hasValue(2)).toBe(false); // D `assert(!opt.hasValue(2))`

    // typed `catch (AssertError)` -> single catch + instanceof + rethrow (06 §8.2).
    // `cast(void) opt.get();` -> the cast-to-void erases; we call only for the throw side effect.
    let caught = false;
    try {
      opt0.get();
    } catch (e) {
      if (!(e instanceof AssertError)) throw e; // mandatory rethrow of non-matches (06 §8.2)
      caught = true;
    }
    expect(caught).toBe(true); // D `assert(caught)`

    // `opt = Optional!int(1);` (optional.d:33). RHS is a FRESH rvalue used once -> copy elided
    // (03 §9: a fresh temporary cannot alias). Plain construction (03 §1 non-copy).
    const opt = new Optional<number>(1);
    expect(opt.isEmpty()).toBe(false);
    expect(opt.isPresent()).toBe(true);
    expect(opt.get()).toBe(1);
    expect(opt.hasValue(1)).toBe(true);
    expect(opt.hasValue(2)).toBe(false);
  });

  it("get() on empty throws AssertError (terse form)", () => {
    const opt = new Optional<number>();
    expect(() => opt.get()).toThrow(AssertError);
  });

  it("create() is the value ctor (present)", () => {
    const opt = Optional.create<number>(42);
    expect(opt.isPresent()).toBe(true);
    expect(opt.isEmpty()).toBe(false);
    expect(opt.get()).toBe(42);
    expect(opt.hasValue(42)).toBe(true);
  });

  // The core reason Optional is NOT `T | undefined`: a present FALSY value is distinct from empty.
  // Verified vs ldc2: Optional!bool().hasValue(false)==false, Optional!bool(false).hasValue(false)==true.
  it("present-with-falsy-value is distinct from empty (Optional!bool tri-state)", () => {
    const empty = new Optional<boolean>();
    expect(empty.isPresent()).toBe(false);
    expect(empty.hasValue(false)).toBe(false); // empty: present && ... short-circuits to false
    expect(empty.hasValue(true)).toBe(false);

    const presentFalse = new Optional<boolean>(false);
    expect(presentFalse.isPresent()).toBe(true); // present even though the value is falsy
    expect(presentFalse.isEmpty()).toBe(false);
    expect(presentFalse.get()).toBe(false); // get() returns the stored false, does NOT throw
    expect(presentFalse.hasValue(false)).toBe(true);
    expect(presentFalse.hasValue(true)).toBe(false);
  });

  // present value 0 (another falsy value) must also be distinguishable from empty.
  it("present-with-zero is distinct from empty (Optional!int falsy)", () => {
    const presentZero = new Optional<number>(0);
    expect(presentZero.isPresent()).toBe(true);
    expect(presentZero.get()).toBe(0); // does not throw despite 0 being falsy
    expect(presentZero.hasValue(0)).toBe(true);

    const empty = new Optional<number>();
    expect(empty.hasValue(0)).toBe(false); // empty.hasValue(0) is false (present gate)
  });

  it("copy() of empty stays empty; copy() of present stays present", () => {
    const e = new Optional<number>().copy();
    expect(e.isEmpty()).toBe(true);
    expect(() => e.get()).toThrow(AssertError);

    const p = new Optional<number>(7).copy();
    expect(p.isPresent()).toBe(true);
    expect(p.get()).toBe(7);
    expect(p.hasValue(7)).toBe(true);
  });

  it("copy() returns a distinct instance (independent identity)", () => {
    const orig = new Optional<number>(5);
    const dup = orig.copy();
    expect(dup).not.toBe(orig); // fresh object (03 §2 invariant)
    expect(dup.get()).toBe(orig.get()); // same observed value
  });
});
