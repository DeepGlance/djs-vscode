// Ported from dmd/common/bitfields.d (module dmd.common.bitfields).
//
// A library bitfields utility: a COMPILE-TIME code generator. The D source declares
//   extern (D) string generateBitFields(S, T, ...)()
// a CTFE function returning a string of D source, used as `mixin(generateBitFields!(BitFields, T))`
// inside a struct/class body to pack a set of boolean/small-int members into one unsigned
// integer with generated shift/mask getter+setter accessors.
//
// Copyright: Copyright (C) 1999-2025 by The D Language Foundation, All Rights Reserved.
// Authors:   Dennis Korpel.  License: Boost License 1.0.
//
// ---------------------------------------------------------------------------------------------
// HOW THIS MODULE IS PORTED (07-compile-time.md, §0 + §5 string-mixin + §11 escalate; 11 §3.6)
// ---------------------------------------------------------------------------------------------
// `generateBitFields` is a CT string-mixin code generator. Per 07-compile-time.md it DISAPPEARS
// at translation time: at each `mixin(generateBitFields!(BitFields, T))` use site (expression.d,
// dscope.d, func.d, denum.d, dsymbol.d, declaration.d, mtype.d, statement.d, dstruct.d) the
// translation agent evaluates the generator against the concrete `BitFields` struct + storage
// type `T` and emits the CONCRETE resolved accessors directly into that consumer's TS class.
// Emitting a runtime `string generateBitFields(...)` that returns D/TS code text would be
// "emitting metaprogramming into the output" — forbidden by 07 §11. So this module carries NO
// runtime port of `generateBitFields` itself.
//
// resolved: version = Has_Bitfields (bitfields.d:13) -> OFF (commented out upstream; _config.md).
// resolved: version(Debugger_friendly) (bitfields.d:15) -> OFF (gated on Has_Bitfields; _config.md).
//   => the LIVE branch is the shift/mask getter/setter `else` block (bitfields.d:89-98).
//
// WHY THE PACKED STORAGE IS PRESERVED (NOT discarded — 11 §3.6 escalation criterion):
// 11 §3.6 permits discarding the packed integer ONLY IF nothing reads it directly. It IS read
// directly by consumers, verified by grep against the source tree:
//   - dscope.d:285  `this.bitFields = other.bitFields;`   (copy the whole packed word)
//   - dscope.d:291  `this.bitFields = 0;`                  (reset all flags at once)
//   - func.d:609/614/615  `return bitFields;` / `bitFields = f;`  (read/write the whole word)
// So AT THOSE SITES the packing is OBSERVABLE and the resolved accessors keep a real packed
// integer field with shift/mask accessors. THE POLICY IS CONDITIONAL, exactly 11 §3.6: a
// consumer whose packed word is read by NOTHING (verified by tree-wide grep — e.g. denum.ts,
// dsymbol.ts) discards the packed storage and keeps plain boolean fields; a consumer whose
// packed word IS read (dscope, func, declaration, dstruct sites above) keeps it. Both forms
// are canonical for their case; neither is a deviation.
//
// ---------------------------------------------------------------------------------------------
// NUMERIC DOMAIN (09-numerics.md)
// ---------------------------------------------------------------------------------------------
// Every storage type the frontend uses with this mixin is `ubyte` / `ushort` / `uint` — all
// <= 32-bit -> the `number` domain (09 §0/§1). The packed word is held UNSIGNED: each write
// re-truncates with `>>> 0` so the `uint` high-bit (bit 31) case stores 2^31 correctly rather
// than a negative signed-32 value. VERIFIED bit-for-bit against ldc2-1.42.0 (DMD v2.112.1):
//   - generateBitFields!(B, ushort) generated accessors + init `bitFields = 2488` (unittest),
//   - a `uint`-storage struct with a flag at bit 31 (set->2147483648, get->1, clear->0),
//   - the `&= ~(mask << shift); |= v << shift` clear/set sequence for an 8-bit field.
// (probes /tmp/probe_bitfields.d, /tmp/probe_funcflag.d, /tmp/probe_js.mjs.)
//
// D module attributes erased per 04-functions.md §8: the generated block is
// `extern (C++) pure nothrow @nogc @safe final` — none carry an observable contract in TS.

// =============================================================================================
// Runtime primitives for the resolved (`else`-branch) bit-field accessor pattern.
//
// These are the single, tested home for the shift/mask arithmetic that the CT generator emits
// per member (bitfields.d:91-98). A consumer's resolved getter/setter is a one-liner over these
// instead of re-deriving `(store >>> shift) & mask` and `store &= ~(mask<<shift); store |= ...`
// at each of the ~12 use sites. They are plain bit manipulation — NOT a code-string generator,
// so they do not "emit metaprogramming" (07 §11 is about emitting version/static-if/mixin/__traits
// tokens, not about runtime helpers that do the arithmetic the generated code would have done).
// =============================================================================================

/// Read a packed bit field out of an unsigned-integer store.
///
/// Mirrors the generated getter body (bitfields.d:92):
///   `cast(typeName) ((fieldName >>> shift) & sizeMask)`
/// The `cast(typeName)` truncation is a no-op here because `mask` already restricts the result to
/// the field's width (mask == (1 << bitSize) - 1); the caller holds the value in the `number`
/// domain (a `bool` field reads as 0/1, an enum/ubyte field as its small integer).
///
/// Preconditions (guaranteed by the resolved call sites, not re-checked — boundary-validation.md):
///   - `store` is a non-negative integer < 2^32 (the packed word held unsigned),
///   - `shift` in 0..31, `mask` is a contiguous low-bit mask `(1<<bitSize)-1`.
/// Cost: three integer ops, no allocation; safe to call in hot accessor paths.
export function bitFieldGet(store: number, shift: number, mask: number): number {
    return (store >>> shift) & mask;
}

/// Write a value into a packed bit field, returning the new store word.
///
/// Mirrors the generated setter body (bitfields.d:93-98):
///   `fieldName &= ~(sizeMask << shift); fieldName |= v << shift;`
/// performed in the `number` domain. The `>>> 0` after each step re-truncates to unsigned 32-bit
/// so a field whose top bit lands at bit 31 (a `uint` storage) stores 2^31 rather than a negative
/// signed value — `~(mask << shift)` yields a signed-32 intermediate in JS, and `v << shift` can
/// set bit 31. Returns the updated word; the resolved setter assigns it back to the packed field
/// (the D setter mutates `fieldName` in place and returns `v`; here the caller does the assignment).
///
/// Preconditions (guaranteed at the call site): as `bitFieldGet`, plus `0 <= v <= mask` so `v`
/// occupies only the field's bits (the D generator never masks `v` on write — it trusts the typed
/// accessor parameter; we trust it likewise rather than add a silent guard).
/// Cost: four integer ops, no allocation.
export function bitFieldSet(store: number, shift: number, mask: number, v: number): number {
    store = (store & ~(mask << shift)) >>> 0;
    store = (store | ((v << shift) >>> 0)) >>> 0;
    return store;
}
