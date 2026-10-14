// Ported from dmd/root/complex.d (module dmd.root.complex).
// Contract: 08-runtime-lib.md §15.2; canonical operator names owned by 05-operators.md §4/§9/§10
// and matched by the full worked example 12-worked-examples.md (c). Value-copy discipline:
// 03-value-semantics.md §2. Numeric domain: 09-numerics.md §6.
//
// extern(C++) struct complex_t  ->  VALUE-type class (02-types.md §2). A `struct` is copied on
// every value-move (assignment, by-value param, return, array/field read/write); the agent at the
// CALL SITE emits `.copy()` (03-value-semantics.md §1). This file provides `copy()` so it can.
//
// Numeric domain (decisive): components are `real_t = number`. On this target `real == double`
// (_ground-truth.md §3, _probes.md §6) so JS `number` is the EXACT precision the local compiler
// folds with — component arithmetic is plain `+`/`-`/`*`/`/`, NEVER `Math.fround` and NEVER
// extended precision. Inserting f32-rounding would make the port DIVERGE from the compiler we
// match (09-numerics.md §6). Verified against ldc2-1.42.0 (/tmp/probe_complex2.d, with
// CTFloat.initialize() run): a/b division yields the exact doubles 2.2000000000000002 /
// -0.40000000000000002 — i.e. the JS `number` result is bit-identical.

import { CTFloat } from "./ctfloat.js";
import type { real_t } from "./ctfloat.js"; // type-only: real_t = number (verbatimModuleSyntax ON)

/**
 * Complex number (`dmd/root/complex.d:18`, `extern (C++) struct complex_t`).
 *
 * A value struct of two `real_t` components. Used only in CTFE constant-folding of complex
 * literals (`constfold.d`, `ctfeexpr.d`, `dinterpret.d`, `mtype.d`'s `ComplexExp`); low volume
 * but precision-sensitive, so every arithmetic body is a verbatim translation of the D source.
 *
 * Construction contract — `this() @disable` (complex.d:25): there is NO zero-arg construction.
 * The two D real ctors (`this(re)` with `im = CTFloat.zero`, complex.d:27; and `this(re, im)`,
 * complex.d:32) collapse to ONE ctor with a default `im` (04-functions.md §2). `@disable this()`
 * means the frontend NEVER writes `new complex_t()` with no args and NEVER relies on a default
 * all-zero value (03-value-semantics.md §6.2) — a missing `re` is a bug, not the origin. TS
 * cannot forbid the zero-arg call, so this is a documented contract, not an enforced one.
 *
 * Operator contract — TS has no operator overloading, so EVERY `+`/`-`/`*`/`/`/`-`(unary)/`==`/
 * `!=`/`cast(bool)`/`if(z)` on a `complex_t` MUST be rewritten by the call-site agent to the
 * named method below (05-operators.md §0). The method set here is COMPLETE and is the single
 * place a CTFE translator finds every `complex_t` operation (08 §15.2 invariant): do not add,
 * remove, or rename a member. `creall`/`cimagl` are FREE functions (module scope), never methods.
 */
export class complex_t {
    // D `real_t re; real_t im;` (complex.d:20-21) — two double components, public & mutable.
    // Declared explicitly (not constructor parameter-properties) so the @disable-driven
    // single-ctor-with-default shape reads exactly as the worked example (12 (c)).
    re: real_t;
    im: real_t;

    // D `this(real_t re)` (im = CTFloat.zero, :27) + `this(real_t re, real_t im)` (:32) -> one
    // ctor + default param. CTFloat.zero === 0 in the port (08 §15.1; the D __gshared `zero` is
    // filled to real_t(0) by CTFloat.initialize() at compiler startup — ctfloat.d:302).
    constructor(re: real_t, im: real_t = CTFloat.zero) {
        this.re = re;
        this.im = im;
    }

    // opBinary!"+"(complex_t) (complex.d:38) -> opAdd. Componentwise add.
    opAdd(y: complex_t): complex_t {
        return new complex_t(this.re + y.re, this.im + y.im);
    }

    // opBinary!"-"(complex_t) (complex.d:44) -> opSub. Componentwise subtract.
    opSub(y: complex_t): complex_t {
        return new complex_t(this.re - y.re, this.im - y.im);
    }

    // opUnary!"-"() (complex.d:50) -> opNeg. Negate both components.
    opNeg(): complex_t {
        return new complex_t(-this.re, -this.im);
    }

    // opBinary!"*"(complex_t) (complex.d:56) -> opMul (complex * complex). The SELF-TYPE form
    // keeps the canonical name (05-operators.md "Multiple overloads of the same operator").
    opMul(y: complex_t): complex_t {
        return new complex_t(this.re * y.re - this.im * y.im, this.im * y.re + this.re * y.im);
    }

    // opBinaryRight!"*"(real_t) (complex.d:62) -> opMul_r (real * complex). REVERSED form: called
    // on the RIGHT operand with the left (real) operand as the arg (05-operators.md §4). Body is
    // `complex_t(x) * this` — the inner `*` is itself an operator -> rewritten to `.opMul(this)`.
    // DISTINCT from opMul_real_t (do not conflate, 08 §15.2). Result equals opMul_real_t for the
    // same scalar (multiplication commutes), but the method identity follows the D overload set.
    opMul_r(x: real_t): complex_t {
        return new complex_t(x).opMul(this);
    }

    // opBinary!"*"(real_t) (complex.d:68) -> opMul_real_t (complex * real). The real_t overload is
    // suffixed with the operand type (05-operators.md "Multiple overloads of the same operator").
    // Body `this * complex_t(y)` -> `this.opMul(new complex_t(y))`.
    opMul_real_t(y: real_t): complex_t {
        return this.opMul(new complex_t(y));
    }

    // opBinary!"/"(real_t) (complex.d:74) -> opDiv_real_t (complex / real). Body `this /
    // complex_t(y)` -> `this.opDiv(new complex_t(y))`.
    opDiv_real_t(y: real_t): complex_t {
        return this.opDiv(new complex_t(y));
    }

    // opBinary!"/"(complex_t) (complex.d:80) -> opDiv (complex / complex). VERBATIM translation of
    // the Smith branch-by-magnitude algorithm: it scales by the LARGER-magnitude denominator
    // component to avoid intermediate overflow. Do NOT "simplify" to
    // (a*conj(b))/|b|^2 — the chosen branch changes the rounding and thus the folded CTFE result
    // (08 §15.2 invariant; verified vs ldc2: first branch gives 2.2000000000000002/-0.4..., the
    // else branch gives 1.2999999999999998/0.8999999999999999). CTFloat.fabs -> Math.abs.
    opDiv(y: complex_t): complex_t {
        if (CTFloat.fabs(y.re) < CTFloat.fabs(y.im)) {
            const r = y.re / y.im;
            const den = y.im + r * y.re;
            return new complex_t((this.re * r + this.im) / den, (this.im * r - this.re) / den);
        } else {
            const r = y.im / y.re;
            const den = y.re + r * y.im;
            return new complex_t((this.re + r * this.im) / den, (this.im - r * this.re) / den);
        }
    }

    // opCast(T : bool) (complex.d:97) -> opCastBool (05-operators.md §10). TS objects are ALWAYS
    // truthy, so EVERY truthiness use (`if (z)`, `while (z)`, `z && ...`, `!z`, `cast(bool)z`)
    // MUST be rewritten to `.opCastBool()` — a bare `if (z)` is a silent miscompile. D's
    // `return re || im;` is NUMERIC `||` over two real_t (each side is an implicit `!= 0`), NOT a
    // JS short-circuit that would return a number — make the zero-test explicit (09-numerics.md
    // "Numeric truthiness"). Verified vs ldc2: 0+0i -> false; 0+5i, 5+0i -> true.
    opCastBool(): boolean {
        return this.re !== 0 || this.im !== 0;
    }

    // opEquals(complex_t) (complex.d:102) returns D `int` (1/0); NORMALIZE to `boolean`
    // (05-operators.md "opEquals returning int" — the `&&` already yields bool here). `==` on a
    // complex_t is rewritten to `a.opEquals(b)`, `!=` to `!a.opEquals(b)` (05 §2): TS `===` on
    // objects is reference identity, not value equality. Bitwise float equality (`===`): NaN
    // components compare unequal, and +0.0 === -0.0, matching D's `==`.
    opEquals(y: complex_t): boolean {
        return this.re === y.re && this.im === y.im;
    }

    // VALUE-struct copy contract (03-value-semantics.md §2): two primitive `number` fields ->
    // a per-field shallow copy is a full copy. The call-site agent emits this on every value-move.
    copy(): complex_t {
        return new complex_t(this.re, this.im);
    }
}

// creall (complex.d:108) — FREE function returning the real part. In D `extern (C++) real_t
// creall(complex_t)`; CTFE calls it as a free function `creall(c)` (constfold.d:176/:235), NOT a
// method `c.creall()`. Keep it module-level — never fold it into the class (08 §15.2 invariant).
export function creall(x: complex_t): real_t {
    return x.re;
}

// cimagl (complex.d:113) — FREE function returning the imaginary part. Same free-function
// contract as creall.
export function cimagl(x: complex_t): real_t {
    return x.im;
}
