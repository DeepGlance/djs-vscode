// Ported from dmd/root/optional.d (module dmd.root.optional).
// Contract: 08-runtime-lib.md §10, worked form 12-worked-examples.md (a).
//
// extern(C++) struct Optional(T) -> a VALUE type backed by a TS class (02-types.md §2),
// NOT collapsed to `T | undefined`. The frontend calls .isPresent()/.isEmpty()/.get()/
// .hasValue() explicitly, and the sole frontend instantiation is `Optional!bool` (verified:
// 13 sites, all bool), which is genuinely TRI-STATE: absent / present-true / present-false.
// A `boolean | undefined` would conflate "absent" with "present-false" — verified against
// ldc2 that `Optional!bool().hasValue(false) == false` but `Optional!bool(false).hasValue(false)
// == true`, so the present flag is load-bearing and must be a real field.
import { assert, AssertError } from "../../assert.js"; // 08 §12; AssertError re-exported for the unittest port

/**
 * Optional type that is either empty or contains a value of type `T` (dmd/root/optional.d:42).
 *
 * Value-struct semantics: immutable after construction (no public mutators). Two construction
 * paths mirror D: `new Optional<T>()` reproduces D default-init `Optional!T x;` (empty), and
 * `new Optional<T>(v)` reproduces the value ctor `this(T value)` (present). Branch on
 * `arguments.length` so an explicit `new Optional<T>(undefined)` for a `T` that can hold
 * `undefined` is still "present" (03-value-semantics.md §6.4 "Default construction of a
 * value-constructor-only struct").
 *
 * primitive-T only: instantiated solely with `bool` in the frontend, so `hasValue`'s `===` is
 * value equality and `copy`'s `c.value = this.value` is a correct shallow copy. A value-struct
 * `T` would need `opEquals`/`value.copy()` and a Copyable bound — escalate (11) if encountered.
 */
export class Optional<T> {
  // D `private T value;` — left UNASSIGNED in the empty case: T is erased, so a generic T.init
  // literal is not expressible (03 §6.4 / 08 §2.0). The `present === false` gate guarantees
  // `value` is never read while unset, so the definite-assignment `!` is faithful, not a hole.
  private value!: T;

  // D `private bool present;` — .init is `false`, so default construction yields the empty value.
  private present = false;

  // D `this(T value)` (optional.d:53) AND D default-init `Optional!T x;` in one body.
  // arguments.length === 0 -> default-init (empty); otherwise the value path (present).
  constructor(value?: T) {
    // value path: mirrors `this(value)` { this.value = value; this.present = true; }
    if (arguments.length !== 0) {
      this.value = value as T;
      this.present = true;
    }
    // else: default-init (D `Optional!T x;`) — present stays false, value stays unset.
  }

  // D `static Optional!T create(T val)` (optional.d:61) — a C++-interop ctor wrapper, same as
  // `this(value)`. Plain static factory (04-functions.md §1).
  static create<T>(val: T): Optional<T> {
    return new Optional<T>(val);
  }

  // `const`/`inout` qualifiers erase. (optional.d:67)
  isPresent(): boolean {
    return this.present;
  }

  // (optional.d:73)
  isEmpty(): boolean {
    return !this.present;
  }

  // D `inout(T) get() inout { assert(present); return value; }` (optional.d:80).
  // assert(present) -> assert() which THROWS AssertError on empty (08 §12, 10 §2). get() on an
  // empty Optional MUST throw, never return the unset `value` — the unittest's catch(AssertError)
  // depends on the throw, and a return-undefined would be a silent miscompile (02 §11 invariant).
  get(): T {
    assert(this.present);
    return this.value;
  }

  // D `bool hasValue(const T exp) const { return present && value == exp; }` (optional.d:87).
  // `present &&` short-circuits: empty -> false even for `exp` equal to T.init (verified vs ldc2:
  // Optional!bool().hasValue(false) == false). `value == exp` on a primitive T -> `===` value
  // equality (05-operators.md "Operators on a generic type parameter"). primitive-T only.
  hasValue(exp: T): boolean {
    return this.present && this.value === exp;
  }

  // VALUE-struct copy contract (03 §2b "copy() of a generic field"): per-field shallow copy.
  // Optional is a plain struct (no postblit/opAssign/@disable) -> mechanical field copy.
  // primitive-T only: copying the `value` binding is correct for bool/int. A value-struct T
  // would need `value.copy()` and a Copyable bound — escalate (11).
  copy(): Optional<T> {
    const c = new Optional<T>();
    c.value = this.value; // primitive-T only (instantiations verified: Optional!bool)
    c.present = this.present;
    return c;
  }
}

// Re-export so the unittest port (optional.test.ts) and call sites can catch the assert class
// without reaching across to ../../assert.js (the throw class is part of get()'s contract).
export { AssertError };
