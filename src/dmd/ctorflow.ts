// Port of dmd/ctorflow.d — primitive flow analysis for constructors (CSX flags).
//
// FAITHFUL 1:1 frontend module (NOT a root-runtime module — 00 §0.1 exemption does not apply):
// the enums, structs, and merge algorithms are mirrored line-for-line so the result stays
// diff-able against upstream.
//
// Doc map for the constructs here:
//   - `enum CSX : ushort` (a <=32-bit flag set)  -> TS numeric `enum`           (02 §4.2)
//   - `struct FieldInit` / `struct CtorFlow`      -> VALUE-type class + copy()    (02 §2, 03 §2)
//   - `mem.xcalloc` / `mem.xfree`                 -> erased (JS GC, fresh array)   (03 §8, 08 §13)
//   - `fieldinit.arraydup` (array of value structs) -> per-element `.copy()` map   (03 §4)
//   - `ref CSX a` parameters (mergeCallSuper/mergeFieldInit) -> in/out box `Ref<CSX>` (03 §3.2/3.3, 04 §7)
//   - `pure nothrow @safe`                        -> ERASE                         (04 §8)
//
// VERIFIED against ldc2-1.42.0:
//   - `|=` / `|` / `&` / `^` on a CSX value: in D the enum-typed `|=`/`cast(CSX)(...)` are
//     plain 16-bit bitwise; in TS a numeric enum is bidirectionally compatible with `number`
//     for bitwise ops, so `a |= b`, `a = b | (...)`, `(a ^ b) & ...` compile with NO `as CSX`
//     cast and stay 1:1. The D `cast(CSX)(b | (...))` (ctorflow.d:152) therefore becomes a
//     plain `b | (...)` — the cast was only D's int->enum narrowing, a no-op in TS.
//   - `bool ok = (b & CSX.this_ctor);` (ctorflow.d:198/...) relies on D's implicit int->bool
//     (nonzero -> true). TS has no implicit numeric truthiness, so each becomes `(...) !== 0`.
//   - `arraydup` of a `FieldInit[]` copies each value-struct element INDEPENDENTLY (the copy's
//     backing differs and mutating one element does not touch the source) -> `.copy()` per
//     element, NOT the shallow generic `arraydup` (which would alias the FieldInit objects).

import { assert as assert_ } from "../assert.js";
import { Loc } from "./location.js";

/**
 * Constructor flow-analysis state bits (ctorflow.d:19, `enum CSX : ushort`).
 *
 * A <=32-bit-based flag set: members are OR'd together (`any_ctor | label`, `(x & MASK) != 0`).
 * Per 02 §4.2 a <=32-bit enum is a TS numeric `enum` (it fits in `number`); the `ushort` base is
 * irrelevant to the representation — bitwise combinations stay in the `number` domain. (Contrast
 * the `: ulong` flag sets like `STC`, which must be a bigint const-object.)
 */
export enum CSX {
    none = 0,
    this_ctor = 0x01, /// called this()
    super_ctor = 0x02, /// called super()
    label = 0x04, /// seen a label
    return_ = 0x08, /// seen a return statement
    any_ctor = 0x10, /// either this() or super() was called
    halt = 0x20, /// assert(0)
}

/**
 * Individual field in the Ctor with information about its callees and location (ctorflow.d:31).
 *
 * VALUE TYPE (D `struct`): copies on assignment / by-value pass / array-element-read / return
 * (03 §1) — emit `.copy()` at those sites. `csx` is a primitive (the CSX flag bits), `loc` is a
 * nested `Loc` value struct (recurse on copy, 03 §2).
 */
export class FieldInit {
    csx: CSX = CSX.none; /// information about the field's callees (ctorflow.d:33)
    loc: Loc = Loc.initial.copy(); /// location of the field initialization (ctorflow.d:34)

    /// `.copy()` (03 §2): `csx` primitive by value; `loc` is a nested value struct -> recurse.
    copy(): FieldInit {
        const c = new FieldInit();
        c.csx = this.csx;
        c.loc = this.loc.copy();
        return c;
    }
}

/**
 * Primitive flow analysis for constructors (ctorflow.d:40, `struct CtorFlow`).
 *
 * VALUE TYPE (D `struct`): copies on assignment / by-value pass / return (03 §1). `callSuper` is a
 * CSX primitive; `fieldinit` is a `FieldInit[]` of value structs (the `clone()` deep-copies it).
 */
export class CtorFlow {
    callSuper: CSX = CSX.none; /// state of calling other constructors (ctorflow.d:42)

    fieldinit: FieldInit[] = []; /// state of field initializations (ctorflow.d:44)

    /**
     * Field constructor for the aggregate init used by `clone()` (`CtorFlow(callSuper, fieldinit)`
     * at ctorflow.d:66). Default-constructible too (D `CtorFlow cf;` zero-inits) — `new CtorFlow()`
     * mirrors that (callSuper = CSX.none, fieldinit = []).
     */
    constructor(callSuper: CSX = CSX.none, fieldinit: FieldInit[] = []) {
        this.callSuper = callSuper;
        this.fieldinit = fieldinit;
    }

    /**
     * `.copy()` (03 §2): `callSuper` primitive by value; `fieldinit` is a `FieldInit[]` of value
     * structs — a struct copy of `CtorFlow` shares the slice backing (03 §2, do NOT deep-copy the
     * array on a plain copy). The DEEP copy of `fieldinit` is `clone()` below, not `.copy()`.
     */
    copy(): CtorFlow {
        return new CtorFlow(this.callSuper, this.fieldinit);
    }

    /// (ctorflow.d:46) — allocate `dim` zero-initialized FieldInit entries.
    /// erased: `mem.xcalloc(FieldInit.sizeof, dim)` -> a fresh JS array of default-constructed
    /// FieldInit (each csx = CSX.none, loc = Loc.init) (03 §8, 08 §13). `size_t dim` -> number (09 §1.1).
    allocFieldinit(dim: number): void {
        this.fieldinit = Array.from({ length: dim }, () => new FieldInit());
    }

    /// (ctorflow.d:51) — release the FieldInit storage.
    /// erased: `mem.xfree(fieldinit.ptr)` -> NO-OP (GC reclaims). D sets the slice to `null`; the
    /// port uses the empty array (a D `null` char/struct slice has `.length == 0`, 02 §8).
    freeFieldinit(): void {
        // mem.xfree(this.fieldinit) — GC frees; intentionally no allocator call.
        this.fieldinit = [];
    }

    /***********************
     * Create a deep copy of `this` (ctorflow.d:64).
     * Returns:
     *  a copy
     *
     * D: `return CtorFlow(callSuper, fieldinit.arraydup);` — `arraydup` of a `FieldInit[]` copies
     * each VALUE-struct element independently (verified ldc2: mutating a copied element does not
     * touch the source). The generic `arraydup`/`.slice()` would SHARE the FieldInit objects
     * (shallow), which is wrong for value structs, so this maps `.copy()` per element (03 §4).
     */
    clone(): CtorFlow {
        return new CtorFlow(this.callSuper, this.fieldinit.map((fi) => fi.copy()));
    }

    /**********************************
     * Set CSX bits in flow analysis state (ctorflow.d:74).
     * Params:
     *  csx = bits to set
     *
     * `nothrow pure @safe` ERASED (04 §8). `foreach (ref u; fieldinit)` mutates each element in
     * place (03 §4) — the class instance IS the reference, so iterate directly and write `u.csx`.
     */
    orCSX(csx: CSX): void {
        this.callSuper |= csx;
        for (const u of this.fieldinit) {
            u.csx |= csx;
        }
    }

    /******************************
     * OR CSX bits to `this` (ctorflow.d:86).
     * Params:
     *  ctorflow = bits to OR in
     *
     * `const ref CtorFlow ctorflow` -> read-only alias, NO copy (03 §3.4). `auto fi = &fieldinit[i]`
     * (pointer to the i-th element) -> `const fi = this.fieldinit[i]` (the object reference; writes
     * through `fi.csx`/`fi.loc` mutate the element in place, 03 §7.2). `foreach (i, u; ctorflow.
     * fieldinit)` reads `u` only (u.csx, u.loc), so the per-element value copy is elided (03 §4/§9).
     */
    OR(ctorflow: CtorFlow): void {
        this.callSuper |= ctorflow.callSuper;
        if (this.fieldinit.length && ctorflow.fieldinit.length) {
            assert_(this.fieldinit.length === ctorflow.fieldinit.length);
            for (let i = 0; i < ctorflow.fieldinit.length; i++) {
                const u = ctorflow.fieldinit[i]; // read-only alias of the i-th element (copy elided, §9)
                const fi = this.fieldinit[i]; // &fieldinit[i] -> the element reference (03 §7.2)
                fi.csx |= u.csx;
                // `fi.loc is Loc.init` -> is the loc the default/unset value (index == 0) -> !isValid().
                if (!fi.loc.isValid()) {
                    fi.loc = u.loc.copy(); // store a value struct into the element -> copy (03 §1#5)
                }
            }
        }
    }
}

/****************************************
 * Merge `b` flow analysis results into `a` (ctorflow.d:112, `mergeCallSuper`).
 * Params:
 *      a = the path to merge `b` into (D `ref CSX a` -> in/out box, see below)
 *      b = the other path (D `const CSX b` -> by value)
 * Returns:
 *      false means one of the paths skips construction
 *
 * `ref CSX a` is an in/out parameter: the callee reads AND writes `a`, and the caller observes the
 * write. CSX is a `number`-domain enum (not an object), so address-of needs a one-slot box
 * `Ref<CSX>` (03 §3.2/§7.2, 04 §7). `pure nothrow @safe` ERASED (04 §8). Every `a`/`a |= …`/`a = …`
 * routes through `a.value`. The `cast(CSX)(b | (...))` (ctorflow.d:152) is a no-op in TS (numeric
 * enum <-> number), so it becomes a plain `b | (...)`.
 */
export function mergeCallSuper(a: Ref<CSX>, b: CSX): boolean {
    // This does a primitive flow analysis to support the restrictions
    // regarding when and how constructors can appear.
    // It merges the results of two paths.
    // The two paths are `a` and `b`; the result is merged into `a`.
    if (b === a.value) {
        return true;
    }

    // Have ALL branches called a constructor?
    const aAll = (a.value & (CSX.this_ctor | CSX.super_ctor)) !== 0;
    const bAll = (b & (CSX.this_ctor | CSX.super_ctor)) !== 0;
    // Have ANY branches called a constructor?
    const aAny = (a.value & CSX.any_ctor) !== 0;
    const bAny = (b & CSX.any_ctor) !== 0;
    // Have any branches returned?
    const aRet = (a.value & CSX.return_) !== 0;
    const bRet = (b & CSX.return_) !== 0;
    // Have any branches halted?
    const aHalt = (a.value & CSX.halt) !== 0;
    const bHalt = (b & CSX.halt) !== 0;
    if (aHalt && bHalt) {
        a.value = CSX.halt;
    } else if ((!bHalt && bRet && !bAny && aAny) || (!aHalt && aRet && !aAny && bAny)) {
        // If one has returned without a constructor call, there must not
        // be ctor calls in the other.
        return false;
    } else if (bHalt || (bRet && bAll)) {
        // If one branch has called a ctor and then exited, anything the
        // other branch has done is OK (except returning without a
        // ctor call, but we already checked that).
        a.value |= b & (CSX.any_ctor | CSX.label);
    } else if (aHalt || (aRet && aAll)) {
        // cast(CSX)(b | (a & (...))) -> plain bitwise (numeric enum <-> number, verified).
        a.value = b | (a.value & (CSX.any_ctor | CSX.label));
    } else if (aAll !== bAll) {
        // both branches must have called ctors, or both not
        return false;
    } else {
        // If one returned without a ctor, remember that
        if (bRet && !bAny) {
            a.value |= CSX.return_;
        }
        a.value |= b & (CSX.any_ctor | CSX.label);
    }
    return true;
}

/****************************************
 * Merge `b` flow analysis results into `a` (ctorflow.d:175, `mergeFieldInit`).
 * Params:
 *      a = the path to merge `b` into (D `ref CSX a` -> in/out box)
 *      b = the other path (D `const CSX b` -> by value)
 * Returns:
 *      false means either `a` or `b` skips initialization
 *
 * Same `ref CSX a` in/out box as `mergeCallSuper`. The D `bool ok = (b & CSX.this_ctor);` etc.
 * rely on int->bool implicit conversion (nonzero -> true); TS makes each `(... ) !== 0`. The
 * `ok = !((a ^ b) & CSX.this_ctor);` becomes `((a ^ b) & CSX.this_ctor) === 0` (the `!` of "bits
 * set"). `a = b;` is a CSX (number) value copy, not a struct copy.
 */
export function mergeFieldInit(a: Ref<CSX>, b: CSX): boolean {
    if (b === a.value) {
        return true;
    }

    // Have any branches returned?
    const aRet = (a.value & CSX.return_) !== 0;
    const bRet = (b & CSX.return_) !== 0;
    // Have any branches halted?
    const aHalt = (a.value & CSX.halt) !== 0;
    const bHalt = (b & CSX.halt) !== 0;

    if (aHalt && bHalt) {
        a.value = CSX.halt;
        return true;
    }

    // The logic here is to prefer the branch that neither halts nor returns.
    let ok: boolean;
    if (!bHalt && bRet) {
        // Branch b returns, no merging required.
        ok = (b & CSX.this_ctor) !== 0;
    } else if (!aHalt && aRet) {
        // Branch a returns, but b doesn't, b takes precedence.
        ok = (a.value & CSX.this_ctor) !== 0;
        a.value = b;
    } else if (bHalt) {
        // Branch b halts, no merging required.
        ok = (a.value & CSX.this_ctor) !== 0;
    } else if (aHalt) {
        // Branch a halts, but b doesn't, b takes precedence.
        ok = (b & CSX.this_ctor) !== 0;
        a.value = b;
    } else {
        // Neither branch returns nor halts, merge flags.
        ok = ((a.value ^ b) & CSX.this_ctor) === 0;
        a.value |= b;
    }
    return ok;
}

// ── support shims ────────────────────────────────────────────────────────────────────────────

/// The canonical one-slot box / ref-cell for a `ref`/`out` parameter over a non-object value
/// (03 §3.2/§7.2, 04 §7). `mergeCallSuper`/`mergeFieldInit` take `ref CSX a`; CSX is a `number`,
/// so the caller wraps it (`const a = { value: cf.callSuper }; mergeCallSuper(a, b); cf.callSuper
/// = a.value;`).
export interface Ref<T> {
    value: T;
}
