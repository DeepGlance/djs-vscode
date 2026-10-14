// Ported from dmd/constfold.d (module dmd.constfold) — "Perform constant folding of arithmetic expressions."
//
// FULL-FILE TRANSLATION (P5.0 wave 12). Every top-level D declaration of constfold.d is present here, in SOURCE
// ORDER: `LOG` (:42, dropped below), `expType` (:44), `cantExp` (:59), `Neg` (:69), `Com` (:92), `Not` (:100),
// `Add` (:111), `Min` (:216), `Mul` (:224), `Div` (:273), `Mod` (:348), `Pow` (:413), `Shl` (:493), `Shr` (:500),
// `Ushr` (:546), `And` (:586), `Or` (:593), `Xor` (:600), `Equal` (:610), `Identity` (:808), `Cmp` (:853),
// `Cast` (:917), `ArrayLength` (:1083), `Index` (:1117), `Slice` (:1217), `sliceBoundsCheck` (:1280),
// `sliceAssignArrayLiteralFromString` (:1291), `sliceAssignStringFromArrayLiteral` (:1305),
// `sliceAssignStringFromString` (:1317), `sliceCmpStringWithString` (:1330), `sliceCmpStringWithArray` (:1342),
// `copyElements` (:1365), `Cat` (:1400), `Ptr` (:1700). constfold.d has no `unittest` blocks and declares no
// visitor class (the visitor-word class census over the D module is 0).
//
// UnionExp (02-types.md §11.1). Every fold returns a `UnionExp` (ctfeexpr.ts): `UnionExp ue = void;` allocates the
// wrapper and `emplaceExp!(T)(&ue, args)` is `ue.emplace(new T(args))`. `emplaceExp!(UnionExp)(&ue, e)` memcpy's a
// SHALLOW CLONE of `e` (ctfeexpr.d:114-117) and is `ue.emplace(e.copy())` at all 14 sites (integrator ruling, wave 12,
// 02 §11.1). A local `ue = F(...)` rebinds the local to the callee's wrapper, which no other name aliases — except
// in `Pow`, see its comment.
//
// COMPILE-TIME RESOLUTION (07): `private enum LOG = false;` (:42) resolves every `static if (LOG)` block (:114,
// :1221) to its dead arm; the enum and both blocks are dropped. `//printf` lines are D comments.
//
// ERASED IMPORTS: `core.stdc.string` / `core.stdc.stdio` and `dmd.root.rmem` have no port-side call left.
// `mem.xmalloc(n)` is rewritten per 08 §13 to a fresh `Uint8Array(n)`, `memcpy` to `Uint8Array.set` over the
// same byte ranges, and `memcmp` to the file-local byte compare `memcmp` below (a C library routine, not a D
// declaration — the dmacro.ts precedent).
//
// NUMERICS (09). The integer carrier is `dinteger_t` (bigint), normalized by the `IntegerExp` constructor, so the
// folds pass the raw carrier result (09 §3). D locals declared `sinteger_t` read the carrier through `toInt64`,
// `dinteger_t`/`uinteger_t` locals through `toUint64` wherever D then orders, divides, shifts or compares them
// (09 §3.1). Division and modulo by zero cannot reach a BigInt `/`: D's own `divide by 0` diagnostic guards both
// integer arms (constfold.d:317, :382); the floating arms divide `number`s, which follow IEEE exactly as D does.
//
// JUMP SHAPES (06 §4). `Equal` — the jumps to `Lsa` (:700) and to `L1` (:773) are SHARED-ARM entries into the next
// `else if` arm's body: the arm body is a named closure (`Lsa` returns the "D returned `ue`" signal), called by both
// routes. `Cmp` — the jump to `L1` (:885), SHARED-ARM, closure `L1`. `Cast` — the jumps to `L1` (:943, :950,
// :958) are a BAIL into the terminal tail inside the array-literal arm (:963), `L1Tail`. `Cat` — the jump to `L3`
// (:1608) is a BAIL into the terminal tail of the next arm (:1613), `L3Tail`; the jump to `L1` (:1667) is a
// SHARED-ARM entry into the next arm's body (:1673), closure `L1`, after which both routes fall out to the common
// `assert`/`return`.

import { assert, assertUnreachable } from "../assert.js";
import { ds } from "../dstring.js";
import { toInt32, toInt64, toUint64, maskSignedN, maskUnsignedN } from "../numeric.js";

import {
    Expression, IntegerExp, RealExp, ComplexExp, SymOffExp, ErrorExp, StringExp, ArrayLiteralExp, NullExp,
    StructLiteralExp, CTFEExp, OwnedBy,
} from "./expression.js";
import { UnionExp, specificCmp, intUnsignedCmp, intSignedCmp, realCmp } from "./ctfeexpr.js";
import type { Expressions } from "./arraytypes.js";
import { Array as DArray } from "./root/array.js";
import { Type, isSomeChar } from "./mtype.js";
import type { Loc } from "./location.js";
import type { dinteger_t, sinteger_t, uinteger_t } from "./globals.js";
import { global } from "./globals.js";
import { EXP } from "./tokens.js";
import { TY, MATCH } from "./astenums.js";
import { error } from "./errors.js";
import {
    toReal, toImaginary, toComplex, toInteger, toUInteger, toBool, isIdentical, getField, castToSinteger,
    castToUinteger,
} from "./expressionsem.js";
import {
    toBasetype, isReal, isImaginary, isComplex, isFloating, isIntegral, isUnsigned, isScalar, nextOf, size,
    sarrayOf, equivalent, toDsymbol,
} from "./typesem.js";
import { castTo, implicitConvToType } from "./dcast.js";
import { hasSideEffect } from "./sideeffect.js";
import { complex_t, creall, cimagl } from "./root/complex.js";
import { CTFloat, type real_t } from "./root/ctfloat.js";
import { Port } from "./root/port.js";
import { utf_codeLength, utf_encode } from "./root/utf.js";
// last (01 §4.8): target.ts value-imports mtype/expression/typesem/hdrgen; read only inside Pow (constfold.d:483).
import { target } from "./target.js";

// dropped: `private enum LOG = false;` (constfold.d:42) — only read by `static if (LOG)` (:114, :1221), resolved
// to the dead arm at translation time (07).

/// dmd/constfold.d:44 — module-private. `e` itself when it already has `type`, else a shallow copy repainted.
function expType(type: Type, e: Expression): Expression {
    if (type !== e.type) {
        e = e.copy();
        e.type = type;
    }
    return e;
}

/**********************************
 * dmd/constfold.d:59 — `void cantExp(out UnionExp ue)`.
 * Initialize a EXP.cantExpression Expression.
 * Params:
 *      ue = where to write it
 * (`out` resets `ue` before the body; `emplace` overwrites the whole wrapper, which is the same effect.)
 */
export function cantExp(ue: UnionExp): void {
    ue.emplace(new CTFEExp(EXP.cantExpression));
}

/* =============================== constFold() ============================== */
/* The constFold() functions were redundant with the optimize() ones,
 * and so have been folded in with them.
 */
/* ========================================================================== */

/// dmd/constfold.d:69 — `UnionExp Neg(Type type, Expression e1)`
/// `-e1`, folded.
export function Neg(type: Type, e1: Expression): UnionExp {
    const ue = new UnionExp();
    const loc = e1.loc;
    if (isReal(e1.type!)) {
        ue.emplace(new RealExp(loc, -toReal(e1), type));
    } else if (isImaginary(e1.type!)) {
        ue.emplace(new RealExp(loc, -toImaginary(e1), type));
    } else if (isComplex(e1.type!)) {
        ue.emplace(new ComplexExp(loc, toComplex(e1).opNeg(), type));
    } else {
        ue.emplace(new IntegerExp(loc, -toInteger(e1), type));
    }
    return ue;
}

/// dmd/constfold.d:92 — `UnionExp Com(Type type, Expression e1)`
/// `~e1`, folded.
export function Com(type: Type, e1: Expression): UnionExp {
    const ue = new UnionExp();
    const loc = e1.loc;
    ue.emplace(new IntegerExp(loc, ~toInteger(e1), type));
    return ue;
}

/// dmd/constfold.d:100 — `UnionExp Not(Type type, Expression e1)`
/// `!e1`, folded.
export function Not(type: Type, e1: Expression): UnionExp {
    const ue = new UnionExp();
    const loc = e1.loc;
    // BUG: Should be replaced with e1.toBool().get(), but this is apparently
    //      executed for some expressions that cannot be const-folded
    //      To be fixed in another PR
    ue.emplace(new IntegerExp(loc, toBool(e1).hasValue(false) ? 1n : 0n, type));
    return ue;
}

/// dmd/constfold.d:111 — `UnionExp Add(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 + e2`, folded (also a SymOffExp plus an integer offset).
export function Add(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    if (isReal(type)) {
        ue.emplace(new RealExp(loc, toReal(e1) + toReal(e2), type));
    } else if (isImaginary(type)) {
        ue.emplace(new RealExp(loc, toImaginary(e1) + toImaginary(e2), type));
    } else if (isComplex(type)) {
        // This rigamarole is necessary so that -0.0 doesn't get
        // converted to +0.0 by doing an extraneous add with +0.0
        let c1 = new complex_t(CTFloat.zero);
        let r1: real_t = CTFloat.zero;
        let i1: real_t = CTFloat.zero;
        let c2 = new complex_t(CTFloat.zero);
        let r2: real_t = CTFloat.zero;
        let i2: real_t = CTFloat.zero;
        let v = new complex_t(CTFloat.zero);
        let x = 0; // D `int x;` (.init 0)
        if (isReal(e1.type!)) {
            r1 = toReal(e1);
            x = 0;
        } else if (isImaginary(e1.type!)) {
            i1 = toImaginary(e1);
            x = 3;
        } else {
            c1 = toComplex(e1);
            x = 6;
        }
        if (isReal(e2.type!)) {
            r2 = toReal(e2);
        } else if (isImaginary(e2.type!)) {
            i2 = toImaginary(e2);
            x += 1;
        } else {
            c2 = toComplex(e2);
            x += 2;
        }
        switch (x) {
            case 0 + 0:
                v = new complex_t(r1 + r2);
                break;
            case 0 + 1:
                v = new complex_t(r1, i2);
                break;
            case 0 + 2:
                v = new complex_t(r1 + creall(c2), cimagl(c2));
                break;
            case 3 + 0:
                v = new complex_t(r2, i1);
                break;
            case 3 + 1:
                v = new complex_t(CTFloat.zero, i1 + i2);
                break;
            case 3 + 2:
                v = new complex_t(creall(c2), i1 + cimagl(c2));
                break;
            case 6 + 0:
                // `cimagl(c2)` (not c1) is D's own text (constfold.d:188); c2 is still zero on this route.
                v = new complex_t(creall(c1) + r2, cimagl(c2));
                break;
            case 6 + 1:
                v = new complex_t(creall(c1), cimagl(c1) + i2);
                break;
            case 6 + 2:
                v = c1.opAdd(c2);
                break;
            default:
                assertUnreachable();
        }
        // copy elided (03 §9): the ComplexExp ctor stores its own copy of `v`, and `v` is dead afterwards.
        ue.emplace(new ComplexExp(loc, v, type));
    } else {
        const soe1 = e1.isSymOffExp();
        if (soe1 !== null) {
            // `soe.offset + e2.toInteger()` is a `dinteger_t` (ulong) add: wrap it into the offset's unsigned
            // carrier (09 §3); the SymOffExp ctor stores the offset without normalizing.
            ue.emplace(new SymOffExp(loc, soe1.var_, toUint64(soe1.offset + toInteger(e2))));
            ue.exp().type = type;
        } else {
            const soe2 = e2.isSymOffExp();
            if (soe2 !== null) {
                ue.emplace(new SymOffExp(loc, soe2.var_, toUint64(soe2.offset + toInteger(e1))));
                ue.exp().type = type;
            } else
                ue.emplace(new IntegerExp(loc, toInteger(e1) + toInteger(e2), type));
        }
    }
    return ue;
}

/// dmd/constfold.d:216 — `UnionExp Min(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 - e2`, folded as `e1 + (-e2)`.
export function Min(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    // Compute e1-e2 as e1+(-e2)
    const neg = Neg(e2.type!, e2);
    const ue = Add(loc, type, e1, neg.exp());
    return ue;
}

/// dmd/constfold.d:224 — `UnionExp Mul(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 * e2`, folded.
export function Mul(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    if (isFloating(type)) {
        let c = new complex_t(CTFloat.zero);
        let r: real_t = CTFloat.zero;
        if (isReal(e1.type!)) {
            r = toReal(e1);
            c = toComplex(e2);
            c = new complex_t(r * creall(c), r * cimagl(c));
        } else if (isImaginary(e1.type!)) {
            r = toImaginary(e1);
            c = toComplex(e2);
            c = new complex_t(-r * cimagl(c), r * creall(c));
        } else if (isReal(e2.type!)) {
            r = toReal(e2);
            c = toComplex(e1);
            c = new complex_t(r * creall(c), r * cimagl(c));
        } else if (isImaginary(e2.type!)) {
            r = toImaginary(e2);
            c = toComplex(e1);
            c = new complex_t(-r * cimagl(c), r * creall(c));
        } else
            c = toComplex(e1).opMul(toComplex(e2));
        if (isReal(type))
            ue.emplace(new RealExp(loc, creall(c), type));
        else if (isImaginary(type))
            ue.emplace(new RealExp(loc, cimagl(c), type));
        else if (isComplex(type))
            ue.emplace(new ComplexExp(loc, c, type)); // copy elided (03 §9): the ctor copies, `c` is dead after
        else
            assertUnreachable();
    } else {
        ue.emplace(new IntegerExp(loc, toInteger(e1) * toInteger(e2), type));
    }
    return ue;
}

/// dmd/constfold.d:273 — `UnionExp Div(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 / e2`, folded; `divide by 0` and the `min / -1` overflows are diagnosed here.
export function Div(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    if (isFloating(type)) {
        let c = new complex_t(CTFloat.zero);
        if (isReal(e2.type!)) {
            if (isReal(e1.type!)) {
                ue.emplace(new RealExp(loc, toReal(e1) / toReal(e2), type));
                return ue;
            }
            const r = toReal(e2);
            c = toComplex(e1);
            c = new complex_t(creall(c) / r, cimagl(c) / r);
        } else if (isImaginary(e2.type!)) {
            const r = toImaginary(e2);
            c = toComplex(e1);
            c = new complex_t(cimagl(c) / r, -creall(c) / r);
        } else {
            c = toComplex(e1).opDiv(toComplex(e2));
        }

        if (isReal(type))
            ue.emplace(new RealExp(loc, creall(c), type));
        else if (isImaginary(type))
            ue.emplace(new RealExp(loc, cimagl(c), type));
        else if (isComplex(type))
            ue.emplace(new ComplexExp(loc, c, type)); // copy elided (03 §9): the ctor copies, `c` is dead after
        else
            assertUnreachable();
    } else {
        // `sinteger_t n1 = e1.toInteger();` — the carrier read as signed (09 §3.1).
        const n1: sinteger_t = toInt64(toInteger(e1));
        const n2: sinteger_t = toInt64(toInteger(e2));
        let n: sinteger_t;
        if (n2 === 0n) {
            error(e2.loc, ds("divide by 0"));
            ue.emplace(new ErrorExp());
            return ue;
        }
        if (n2 === -1n && !isUnsigned(type)) {
            // Check for int.min / -1
            // The `UL` hex literals spell bit patterns: read them into the signed carrier (09 §3.1).
            if (n1 === toInt64(0xFFFFFFFF80000000n) && toBasetype(type).ty !== TY.Tint64) {
                error(e2.loc, ds("integer overflow: `int.min / -1`"));
                ue.emplace(new ErrorExp());
                return ue;
            } else if (n1 === toInt64(0x8000000000000000n)) { // long.min / -1
                error(e2.loc, ds("integer overflow: `long.min / -1L`"));
                ue.emplace(new ErrorExp());
                return ue;
            }
        }
        // Both quotients are re-read into `n`'s signed 64-bit carrier (09 §3); n2 != 0 is established above.
        if (isUnsigned(e1.type!) || isUnsigned(e2.type!))
            n = toInt64(toUint64(n1) / toUint64(n2));
        else
            n = toInt64(n1 / n2);
        ue.emplace(new IntegerExp(loc, n, type));
    }
    return ue;
}

/// dmd/constfold.d:348 — `UnionExp Mod(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 % e2`, folded; the zero and `min % -1` diagnostics mirror `Div`.
export function Mod(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    if (isFloating(type)) {
        let c = new complex_t(CTFloat.zero);
        // D `%` on `real_t` is C `fmod`; JS `%` on numbers is the same exact remainder (sign of the dividend).
        if (isReal(e2.type!)) {
            const r2 = toReal(e2);
            c = new complex_t(toReal(e1) % r2, toImaginary(e1) % r2);
        } else if (isImaginary(e2.type!)) {
            const i2 = toImaginary(e2);
            c = new complex_t(toReal(e1) % i2, toImaginary(e1) % i2);
        } else
            assertUnreachable();
        if (isReal(type))
            ue.emplace(new RealExp(loc, creall(c), type));
        else if (isImaginary(type))
            ue.emplace(new RealExp(loc, cimagl(c), type));
        else if (isComplex(type))
            ue.emplace(new ComplexExp(loc, c, type)); // copy elided (03 §9): the ctor copies, `c` is dead after
        else
            assertUnreachable();
    } else {
        const n1: sinteger_t = toInt64(toInteger(e1));
        const n2: sinteger_t = toInt64(toInteger(e2));
        let n: sinteger_t;
        if (n2 === 0n) {
            error(e2.loc, ds("divide by 0"));
            ue.emplace(new ErrorExp());
            return ue;
        }
        if (n2 === -1n && !isUnsigned(type)) {
            // Check for int.min % -1
            if (n1 === toInt64(0xFFFFFFFF80000000n) && toBasetype(type).ty !== TY.Tint64) {
                error(e2.loc, ds("integer overflow: `int.min %% -1`"));
                ue.emplace(new ErrorExp());
                return ue;
            } else if (n1 === toInt64(0x8000000000000000n)) { // long.min % -1
                error(e2.loc, ds("integer overflow: `long.min %% -1L`"));
                ue.emplace(new ErrorExp());
                return ue;
            }
        }
        // BigInt `%` truncates toward zero like D's (sign of the dividend); n2 != 0 is established above.
        if (isUnsigned(e1.type!) || isUnsigned(e2.type!))
            n = toInt64(toUint64(n1) % toUint64(n2));
        else
            n = n1 % n2;
        ue.emplace(new IntegerExp(loc, n, type));
    }
    return ue;
}

/**
 * dmd/constfold.d:413 — `UnionExp Pow(Loc loc, Type type, Expression e1, Expression e2)`
 * `e1 ^^ e2`, folded by square-and-multiply for an integral exponent.
 *
 * ALIASING (03 §1.1, reported as a §2 record): D's `Expression r = ur.exp(); Expression v = uv.exp();` (:451-452)
 * are pointers INTO the storage of `ur`/`uv`, and every later `uv = Mul(...)` / `ur = Mul(...)` / `uv = Div(...)`
 * overwrites that storage in place, so `v` and `r` observe each new result. With `UnionExp` collapsed to one
 * reference (02 §11.1), `v`/`r` are plain `Expression` locals; the port re-derives the alias (`v = uv.exp()`)
 * immediately after each overwrite, which is what every later read of `v`/`r` sees in D.
 */
export function Pow(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    //printf("Pow()\n");
    const ue = new UnionExp();
    // Handle integer power operations.
    if (isIntegral(e2.type!)) {
        // `dinteger_t n`: the unsigned carrier, because `n >>= 1` below is a ulong shift (09 §3.1).
        let n: dinteger_t = toUint64(toInteger(e2));
        let neg: boolean;
        if (!isUnsigned(e2.type!) && toInt64(n) < 0n) {
            if (isIntegral(e1.type!)) {
                cantExp(ue);
                return ue;
            }
            // Don't worry about overflow, from now on n is unsigned.
            neg = true;
            n = toUint64(-n);
        } else
            neg = false;
        let ur = new UnionExp();
        let uv = new UnionExp();
        if (isComplex(e1.type!)) {
            ur.emplace(new ComplexExp(loc, toComplex(e1), e1.type));
            uv.emplace(new ComplexExp(loc, new complex_t(CTFloat.one), e1.type));
        } else if (isFloating(e1.type!)) {
            ur.emplace(new RealExp(loc, toReal(e1), e1.type));
            uv.emplace(new RealExp(loc, CTFloat.one, e1.type));
        } else {
            ur.emplace(new IntegerExp(loc, toInteger(e1), e1.type!));
            uv.emplace(new IntegerExp(loc, 1n, e1.type!));
        }
        let r = ur.exp();
        let v = uv.exp();
        while (n !== 0n) {
            if ((n & 1n) !== 0n) {
                // v = v * r;
                uv = Mul(loc, v.type!, v, r);
                v = uv.exp(); // alias re-derived (see the function comment)
            }
            n >>= 1n;
            // r = r * r
            ur = Mul(loc, r.type!, r, r);
            r = ur.exp(); // alias re-derived (see the function comment)
        }
        if (neg) {
            // ue = 1.0 / v
            const one = new UnionExp();
            one.emplace(new RealExp(loc, CTFloat.one, v.type));
            uv = Div(loc, v.type!, one.exp(), v);
            v = uv.exp(); // alias re-derived (see the function comment)
        }
        if (isComplex(type))
            ue.emplace(new ComplexExp(loc, toComplex(v), type));
        else if (isIntegral(type))
            ue.emplace(new IntegerExp(loc, toInteger(v), type));
        else
            ue.emplace(new RealExp(loc, toReal(v), type));
    } else if (isFloating(e2.type!)) {
        // x ^^ y for x < 0 and y not an integer is not defined; so set result as NaN
        if (toReal(e1) < CTFloat.zero) {
            ue.emplace(new RealExp(loc, target.RealProperties.nan, type));
        } else
            cantExp(ue);
    } else
        cantExp(ue);
    return ue;
}

/// dmd/constfold.d:493 — `UnionExp Shl(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 << e2`, folded in the 64-bit carrier (the IntegerExp ctor narrows to `type`).
export function Shl(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    // `dinteger_t << dinteger_t`: a ulong shift, re-truncated to 64 bits (09 §4.2). The count's range is the
    // caller's contract (optimize.d:1031's shift check); no masking is added (09 §4.3).
    ue.emplace(new IntegerExp(loc, toUint64(toInteger(e1) << toUint64(toInteger(e2))), type));
    return ue;
}

/// dmd/constfold.d:500 — `UnionExp Shr(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 >> e2` (arithmetic on signed types), folded per the operand's width.
export function Shr(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    let value: dinteger_t = toInteger(e1);
    const dcount: dinteger_t = toUint64(toInteger(e2));
    assert(dcount <= 0xFFFFFFFFn);
    const count = Number(dcount); // `cast(uint)dcount` — exact: the assert above bounds it below 2^32
    // Each `cast(T)value >> count` narrows the carrier to T (09 §2.1) and shifts it; a BigInt `>>` on the narrowed
    // value is D's arithmetic shift for the signed types and its logical shift for the (non-negative) unsigned ones.
    switch (toBasetype(e1.type!).ty) {
        case TY.Tint8:
            value = maskSignedN(8, value) >> BigInt(count);
            break;
        case TY.Tuns8:
        case TY.Tchar:
            value = maskUnsignedN(8, value) >> BigInt(count);
            break;
        case TY.Tint16:
            value = maskSignedN(16, value) >> BigInt(count);
            break;
        case TY.Tuns16:
        case TY.Twchar:
            value = maskUnsignedN(16, value) >> BigInt(count);
            break;
        case TY.Tint32:
            value = maskSignedN(32, value) >> BigInt(count);
            break;
        case TY.Tuns32:
        case TY.Tdchar:
            value = maskUnsignedN(32, value) >> BigInt(count);
            break;
        case TY.Tint64:
            value = toInt64(value) >> BigInt(count);
            break;
        case TY.Tuns64:
            value = toUint64(value) >> BigInt(count);
            break;
        case TY.Terror:
            ue.emplace(new ErrorExp());
            return ue;
        default:
            assertUnreachable();
    }
    ue.emplace(new IntegerExp(loc, value, type));
    return ue;
}

/// dmd/constfold.d:546 — `UnionExp Ushr(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 >>> e2` (logical), folded per the operand's width.
export function Ushr(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    let value: dinteger_t = toInteger(e1);
    const dcount: dinteger_t = toUint64(toInteger(e2));
    assert(dcount <= 0xFFFFFFFFn);
    const count = Number(dcount); // `cast(uint)dcount` — exact: the assert above bounds it below 2^32
    // BigInt has no `>>>` (09 §4.2): each arm masks the carrier to a non-negative value first, where `>>` is the
    // logical shift.
    switch (toBasetype(e1.type!).ty) {
        case TY.Tint8:
        case TY.Tuns8:
        case TY.Tchar:
            // Possible only with >>>=. >>> always gets promoted to int.
            value = (value & 0xFFn) >> BigInt(count);
            break;
        case TY.Tint16:
        case TY.Tuns16:
        case TY.Twchar:
            // Possible only with >>>=. >>> always gets promoted to int.
            value = (value & 0xFFFFn) >> BigInt(count);
            break;
        case TY.Tint32:
        case TY.Tuns32:
        case TY.Tdchar:
            value = (value & 0xFFFFFFFFn) >> BigInt(count);
            break;
        case TY.Tint64:
        case TY.Tuns64:
            value = toUint64(value) >> BigInt(count);
            break;
        case TY.Terror:
            ue.emplace(new ErrorExp());
            return ue;
        default:
            assertUnreachable();
    }
    ue.emplace(new IntegerExp(loc, value, type));
    return ue;
}

/// dmd/constfold.d:586 — `UnionExp And(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 & e2`, folded.
export function And(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    ue.emplace(new IntegerExp(loc, toInteger(e1) & toInteger(e2), type));
    return ue;
}

/// dmd/constfold.d:593 — `UnionExp Or(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 | e2`, folded.
export function Or(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    ue.emplace(new IntegerExp(loc, toInteger(e1) | toInteger(e2), type));
    return ue;
}

/// dmd/constfold.d:600 — `UnionExp Xor(Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 ^ e2`, folded.
export function Xor(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    //printf("Xor(linnum = %d, e1 = %s, e2 = %s)\n", loc.linnum, e1.toChars(), e2.toChars());
    const ue = new UnionExp();
    ue.emplace(new IntegerExp(loc, toInteger(e1) ^ toInteger(e2), type));
    return ue;
}

/* dmd/constfold.d:610 — `UnionExp Equal(EXP op, Loc loc, Type type, Expression e1, Expression e2)`
 * `e1 == e2` / `e1 != e2`, folded.
 * Also returns EXP.cantExpression if cannot be computed.
 */
export function Equal(op: EXP, loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    let ue = new UnionExp();
    let cmp = 0;
    let r1: real_t = CTFloat.zero;
    let r2: real_t = CTFloat.zero;
    //printf("Equal(e1 = %s, e2 = %s)\n", e1.toChars(), e2.toChars());
    assert(op === EXP.equal || op === EXP.notEqual);

    // SHARED-ARM `Lsa:` (constfold.d:704) — the string/array-literal arm's body, reached by its own condition and
    // by the jump at :700 after the array-literal/string arm swaps the operands. Returns true where D returns `ue`.
    const Lsa = (): boolean => {
        const es1 = e1.isStringExp()!;
        const es2 = e2.isArrayLiteralExp()!;
        const dim1 = es1.len;
        const dim2 = es2.elements !== null ? es2.elements.length : 0;
        if (dim1 !== dim2)
            cmp = 0;
        else {
            cmp = 1; // if dim1 winds up being 0
            for (let i = 0; i < dim1; i++) {
                const c: uinteger_t = es1.getIndex(i);
                const ee2 = es2.opIndex(i)!;
                if (ee2.isConst() !== 1) {
                    cantExp(ue);
                    return true;
                }
                // `uinteger_t == dinteger_t`: both read through the unsigned carrier (09 §3.1).
                cmp = (toUint64(c) === toUint64(toInteger(ee2))) ? 1 : 0;
                if (cmp === 0)
                    break;
            }
        }
        return false;
    };

    // SHARED-ARM `L1:` (constfold.d:779) — the imaginary arm's unordered-aware compare, also entered from the real
    // arm by the jump at :773.
    const L1 = (): void => {
        if (CTFloat.isNaN(r1) || CTFloat.isNaN(r2)) { // if unordered
            cmp = 0;
        } else {
            cmp = (r1 === r2) ? 1 : 0;
        }
    };

    if (e1.op === EXP.null_) {
        if (e2.op === EXP.null_)
            cmp = 1;
        else {
            const es2 = e2.isStringExp();
            if (es2 !== null) {
                cmp = (0 === es2.len) ? 1 : 0;
            } else {
                const es2 = e2.isArrayLiteralExp();
                if (es2 !== null) {
                    cmp = (es2.elements === null || 0 === es2.elements.length) ? 1 : 0;
                } else {
                    cantExp(ue);
                    return ue;
                }
            }
        }
    } else if (e2.op === EXP.null_) {
        const es1 = e1.isStringExp();
        if (es1 !== null) {
            cmp = (0 === es1.len) ? 1 : 0;
        } else {
            const es1 = e1.isArrayLiteralExp();
            if (es1 !== null) {
                cmp = (es1.elements === null || 0 === es1.elements.length) ? 1 : 0;
            } else {
                cantExp(ue);
                return ue;
            }
        }
    } else if (e1.op === EXP.string_ && e2.op === EXP.string_) {
        const es1 = e1.isStringExp()!;
        const es2 = e2.isStringExp()!;
        if (es1.sz !== es2.sz) {
            assert(global.errors !== 0);
            cantExp(ue);
            return ue;
        }
        const data1 = es1.peekData();
        const data2 = es2.peekData();
        if (es1.len === es2.len && memcmp(data1, data2, es1.sz * es1.len) === 0)
            cmp = 1;
        else
            cmp = 0;
    } else if (e1.op === EXP.arrayLiteral && e2.op === EXP.arrayLiteral) {
        const es1 = e1.isArrayLiteralExp()!;
        const es2 = e2.isArrayLiteralExp()!;
        if ((es1.elements === null || es1.elements.length === 0) &&
            (es2.elements === null || es2.elements.length === 0))
            cmp = 1; // both arrays are empty
        else if (es1.elements === null || es2.elements === null)
            cmp = 0;
        else if (es1.elements.length !== es2.elements.length)
            cmp = 0;
        else {
            for (let i = 0; i < es1.elements.length; i++) {
                const ee1 = es1.opIndex(i)!;
                const ee2 = es2.opIndex(i)!;
                ue = Equal(EXP.equal, loc, Type.tint32, ee1, ee2);
                if (CTFEExp.isCantExp(ue.exp()))
                    return ue;
                cmp = Number(maskSignedN(32, toInteger(ue.exp()))); // `cast(int)` — the low 32 bits, signed
                if (cmp === 0)
                    break;
            }
        }
    } else if (e1.op === EXP.arrayLiteral && e2.op === EXP.string_) {
        // Swap operands and use common code
        const etmp = e1;
        e1 = e2;
        e2 = etmp;
        if (Lsa()) // goto Lsa (dmd/constfold.d:700)
            return ue;
    } else if (e1.op === EXP.string_ && e2.op === EXP.arrayLiteral) {
        if (Lsa()) // Lsa: (dmd/constfold.d:704)
            return ue;
    } else if (e1.op === EXP.structLiteral && e2.op === EXP.structLiteral) {
        const es1 = e1.isStructLiteralExp()!;
        const es2 = e2.isStructLiteralExp()!;
        if (es1.sd !== es2.sd)
            cmp = 0;
        else if ((es1.elements === null || es1.elements.length === 0) &&
                 (es2.elements === null || es2.elements.length === 0))
            cmp = 1; // both arrays are empty
        else if (es1.elements === null || es2.elements === null)
            cmp = 0;
        else if (es1.elements.length !== es2.elements.length)
            cmp = 0;
        else {
            cmp = 1;
            for (let i = 0; i < es1.elements.length; i++) {
                const ee1 = es1.elements.opIndex(i);
                const ee2 = es2.elements.opIndex(i);
                if (ee1 === ee2)
                    continue;
                if (ee1 === null || ee2 === null) {
                    cmp = 0;
                    break;
                }
                ue = Equal(EXP.equal, loc, Type.tint32, ee1, ee2);
                if (ue.exp().op === EXP.cantExpression)
                    return ue;
                cmp = Number(maskSignedN(32, toInteger(ue.exp()))); // `cast(int)` — the low 32 bits, signed
                if (cmp === 0)
                    break;
            }
        }
    } else if (e1.isConst() !== 1 || e2.isConst() !== 1) {
        cantExp(ue);
        return ue;
    } else if (isReal(e1.type!)) {
        r1 = toReal(e1);
        r2 = toReal(e2);
        L1(); // goto L1 (dmd/constfold.d:773)
    } else if (isImaginary(e1.type!)) {
        r1 = toImaginary(e1);
        r2 = toImaginary(e2);
        L1(); // L1: (dmd/constfold.d:779)
    } else if (isComplex(e1.type!)) {
        cmp = toComplex(e1).opEquals(toComplex(e2)) ? 1 : 0;
    } else if (isIntegral(e1.type!) || toBasetype(e1.type!).ty === TY.Tpointer) {
        // `dinteger_t == dinteger_t`: both carriers read unsigned, so pointers and integers compare by bits (09 §3.1).
        cmp = (toUint64(toInteger(e1)) === toUint64(toInteger(e2))) ? 1 : 0;
    } else {
        cantExp(ue);
        return ue;
    }
    if (op === EXP.notEqual)
        cmp ^= 1;
    ue.emplace(new IntegerExp(loc, BigInt(cmp), type));
    return ue;
}

/// dmd/constfold.d:808 — `UnionExp Identity(EXP op, Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 is e2` / `e1 !is e2`, folded; defers to `Equal` for non-floating values.
export function Identity(op: EXP, loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    //printf("Identity %s %s\n", e1.toChars(), e2.toChars());
    let ue = new UnionExp();
    let cmp = 0; // D `int cmp;` (.init 0)
    if (e1.op === EXP.null_) {
        cmp = (e2.op === EXP.null_) ? 1 : 0;
    } else if (e2.op === EXP.null_) {
        cmp = 0;
    } else if (e1.op === EXP.symbolOffset && e2.op === EXP.symbolOffset) {
        const es1 = e1.isSymOffExp()!;
        const es2 = e2.isSymOffExp()!;
        cmp = (es1.offset === es2.offset) ? 1 : 0;
        if (cmp !== 0) {
            cmp = (es1.var_ === es2.var_) ? 1 : 0;
            if (cmp === 0 && (es1.var_.isParameter() || es2.var_.isParameter())) {
                // because of ref's, they may still be the same, we cannot tell
                cantExp(ue);
                return ue;
            }
        }
    } else {
        if (isFloating(e1.type!))
            cmp = isIdentical(e1, e2) ? 1 : 0;
        else {
            ue = Equal((op === EXP.identity) ? EXP.equal : EXP.notEqual, loc, type, e1, e2);
            return ue;
        }
    }
    if (op === EXP.notIdentity)
        cmp ^= 1;
    ue.emplace(new IntegerExp(loc, BigInt(cmp), type));
    return ue;
}

/// dmd/constfold.d:853 — `UnionExp Cmp(EXP op, Loc loc, Type type, Expression e1, Expression e2)`
/// `e1 < e2` and the other ordered compares, folded.
export function Cmp(op: EXP, loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    let n: dinteger_t = 0n; // D `dinteger_t n;` (.init 0)
    let r1: real_t = CTFloat.zero;
    let r2: real_t = CTFloat.zero;

    // SHARED-ARM `L1:` (constfold.d:891) — the imaginary arm's compare, also entered from the real arm by the jump
    // at :885. `realCmp` answers `bool`; D stores it into the `dinteger_t n`.
    const L1 = (): void => {
        n = realCmp(op, r1, r2) ? 1n : 0n;
    };

    //printf("Cmp(e1 = %s, e2 = %s)\n", e1.toChars(), e2.toChars());
    if (e1.op === EXP.string_ && e2.op === EXP.string_) {
        const es1 = e1.isStringExp()!;
        const es2 = e2.isStringExp()!;
        const sz = es1.sz;
        assert(sz === es2.sz);
        let len = es1.len;
        if (es2.len < len)
            len = es2.len;
        const data1 = es1.peekData();
        const data2 = es1.peekData(); // sic: D reads `es1` twice (constfold.d:870), so `rawCmp` starts at 0
        let rawCmp = memcmp(data1, data2, sz * len);
        if (rawCmp === 0)
            rawCmp = toInt32(es1.len - es2.len); // `cast(int)(es1.len - es2.len)`: size_t difference, low 32 bits
        n = specificCmp(op, rawCmp) ? 1n : 0n;
    } else if (e1.isConst() !== 1 || e2.isConst() !== 1) {
        cantExp(ue);
        return ue;
    } else if (isReal(e1.type!)) {
        r1 = toReal(e1);
        r2 = toReal(e2);
        L1(); // goto L1 (dmd/constfold.d:885)
    } else if (isImaginary(e1.type!)) {
        r1 = toImaginary(e1);
        r2 = toImaginary(e2);
        L1(); // L1: (dmd/constfold.d:891)
    } else if (isComplex(e1.type!)) {
        assertUnreachable();
    } else {
        const n1: sinteger_t = toInt64(toInteger(e1));
        const n2: sinteger_t = toInt64(toInteger(e2));
        // `intUnsignedCmp` takes `dinteger_t`: D converts the signed locals implicitly (same bits, 09 §3.1).
        if (isUnsigned(e1.type!) || isUnsigned(e2.type!))
            n = intUnsignedCmp(op, toUint64(n1), toUint64(n2)) ? 1n : 0n;
        else
            n = intSignedCmp(op, n1, n2) ? 1n : 0n;
    }
    ue.emplace(new IntegerExp(loc, n, type));
    return ue;
}

/* dmd/constfold.d:917 — `UnionExp Cast(Loc loc, Type type, Type to, Expression e1)`
 * `cast(to) e1`, folded.
 * Also returns EXP.cantExpression if cannot be computed.
 *  to: type to cast to
 *  type: type to paint the result
 */
export function Cast(loc: Loc, type: Type, to: Type, e1: Expression): UnionExp {
    let ue = new UnionExp();
    const tb = toBasetype(to);
    const typeb = toBasetype(type);
    //printf("Cast(type = %s, to = %s, e1 = %s)\n", type.toChars(), to.toChars(), e1.toChars());
    //printf("\te1.type = %s\n", e1.type.toChars());

    // BAIL `L1:` (constfold.d:963) — the terminal tail inside the array-literal arm, also reached by the jumps at
    // :943, :950 and :958.
    const L1Tail = (): UnionExp => {
        const ex = expType(to, e1);
        ue.emplace(ex.copy());
        return ue;
    };

    if (e1.type!.equals(type) && type.equals(to)) {
        ue.emplace(e1.copy());
        return ue;
    }
    if (e1.op === EXP.vector && e1.type!.isTypeVector()!.basetype.equals(type) && type.equals(to)) {
        const ex = e1.isVectorExp()!.e1!;
        ue.emplace(ex.copy());
        return ue;
    }
    if (toBasetype(e1.type!).equals(type) && type.equals(to)) {
        ue.emplace(e1.copy()); // the clone D's memcpy makes (02 §11.1, wave-12 ruling): the repaint spares `e1`
        ue.exp().type = type;
        return ue;
    }
    if (implicitConvToType(e1.type!, to) >= MATCH.constant || implicitConvToType(to, e1.type!) >= MATCH.constant) {
        return L1Tail(); // goto L1 (dmd/constfold.d:943)
    }
    // Allow covariant converions of delegates
    // (Perhaps implicit conversion from pure to impure should be a MATCH.constant,
    // then we wouldn't need this extra check.)
    if (toBasetype(e1.type!).ty === TY.Tdelegate && implicitConvToType(e1.type!, to) === MATCH.convert) {
        return L1Tail(); // goto L1 (dmd/constfold.d:950)
    }
    /* Allow casting from one string type to another
     */
    if (e1.op === EXP.string_) {
        if (tb.ty === TY.Tarray && typeb.ty === TY.Tarray && size(nextOf(tb)!) === size(nextOf(typeb)!)) {
            return L1Tail(); // goto L1 (dmd/constfold.d:958)
        }
    }
    if (e1.op === EXP.arrayLiteral && typeb === tb) {
        return L1Tail(); // L1: (dmd/constfold.d:963)
    }
    if (e1.isConst() !== 1) {
        cantExp(ue);
    } else if (tb.ty === TY.Tbool) {
        const opt = toBool(e1);
        if (opt.isEmpty()) {
            cantExp(ue);
            return ue;
        }

        ue.emplace(new IntegerExp(loc, opt.get() ? 1n : 0n, type));
    } else if (isIntegral(type)) {
        if (isFloating(e1.type!)) {
            // Floating -> integer casts are the TARGET's (09 §6.2.1): arm64 fcvtzs/fcvtzu truncate toward zero,
            // SATURATE at the destination register's bounds, and map NaN to 0. The cast through a 64-bit type
            // saturates at 64 bits and then truncates; `cast(int)`/`cast(uint)` saturate at 32 bits. ldc2 1.43.0
            // -vcg-ast (pinned in constfold.test.ts): cast(int)3e9 -> 2147483647, cast(int)double.nan -> 0,
            // cast(uint)-1.5 -> 0u, cast(byte)300.7 -> 44, cast(ubyte)1e20 -> 255u, cast(ubyte)1e19 -> 0u.
            let result: dinteger_t;
            const r = toReal(e1);
            switch (typeb.ty) {
                case TY.Tint8:
                    result = maskSignedN(8, castToSinteger(r));
                    break;
                case TY.Tchar:
                case TY.Tuns8:
                    result = maskUnsignedN(8, castToUinteger(r)); // `cast(ubyte)cast(dinteger_t)r`
                    break;
                case TY.Tint16:
                    result = maskSignedN(16, castToSinteger(r));
                    break;
                case TY.Twchar:
                case TY.Tuns16:
                    result = maskUnsignedN(16, castToUinteger(r)); // `cast(ushort)cast(dinteger_t)r`
                    break;
                case TY.Tint32: {
                    // `cast(int)r` — fcvtzs into a W register: 32-bit saturation over the 64-bit one.
                    const s = castToSinteger(r);
                    result = s > 2147483647n ? 2147483647n : s < -2147483648n ? -2147483648n : s;
                    break;
                }
                case TY.Tdchar:
                case TY.Tuns32: {
                    // `cast(uint)r` — fcvtzu into a W register: negatives and NaN to 0, 32-bit saturation above.
                    const s = castToSinteger(r);
                    result = s > 4294967295n ? 4294967295n : s < 0n ? 0n : s;
                    break;
                }
                case TY.Tint64:
                    result = castToSinteger(r);
                    break;
                case TY.Tuns64:
                    result = castToUinteger(r); // `cast(ulong)r`
                    break;
                default:
                    assertUnreachable();
            }
            ue.emplace(new IntegerExp(loc, result, type));
        } else if (isUnsigned(type))
            ue.emplace(new IntegerExp(loc, toUInteger(e1), type));
        else
            ue.emplace(new IntegerExp(loc, toInteger(e1), type));
    } else if (isReal(tb)) {
        const value: real_t = toReal(e1);
        ue.emplace(new RealExp(loc, value, type));
    } else if (isImaginary(tb)) {
        const value: real_t = toImaginary(e1);
        ue.emplace(new RealExp(loc, value, type));
    } else if (isComplex(tb)) {
        const value: complex_t = toComplex(e1); // a fresh return value (03 §9): no copy
        ue.emplace(new ComplexExp(loc, value, type));
    } else if (isScalar(tb)) {
        ue.emplace(new IntegerExp(loc, toInteger(e1), type));
    } else if (tb.ty === TY.Tvoid) {
        cantExp(ue);
    } else if (tb.ty === TY.Tstruct && e1.op === EXP.int64) {
        // Struct = 0;
        const sd = toDsymbol(tb, null)!.isStructDeclaration();
        assert(sd !== null);
        const elements: Expressions = new DArray<Expression | null>();
        for (let i = 0; i < sd.fields.length; i++) {
            const v = sd.fields.opIndex(i)!;
            const zero = new UnionExp();
            zero.emplace(IntegerExp.fromValue(0n));
            ue = Cast(loc, v.type!, v.type!, zero.exp());
            if (ue.exp().op === EXP.cantExpression)
                return ue;
            elements.push(ue.exp().copy());
        }
        ue.emplace(new StructLiteralExp(loc, sd, elements));
        ue.exp().type = type;
    } else {
        if (type !== Type.terror) {
            // have to change to internal compiler error
            // all invalid casts should be handled already in Expression::castTo().
            error(loc, ds("cannot cast `%s` to `%s`"), e1.type!.toChars(), type.toChars());
        }
        ue.emplace(new ErrorExp());
    }
    return ue;
}

/// dmd/constfold.d:1083 — `UnionExp ArrayLength(Type type, Expression e1)`
/// `e1.length` for a literal, a static array or `null`.
export function ArrayLength(type: Type, e1: Expression): UnionExp {
    const ue = new UnionExp();
    const loc = e1.loc;
    const es1 = e1.isStringExp();
    if (es1 !== null) {
        ue.emplace(new IntegerExp(loc, BigInt(es1.len), type));
    } else {
        const ale = e1.isArrayLiteralExp();
        if (ale !== null) {
            const dim = ale.elements !== null ? ale.elements.length : 0;
            ue.emplace(new IntegerExp(loc, BigInt(dim), type));
        } else {
            const ale = e1.isAssocArrayLiteralExp();
            if (ale !== null) {
                const dim = ale.keys!.length;
                ue.emplace(new IntegerExp(loc, BigInt(dim), type));
            } else if (toBasetype(e1.type!).ty === TY.Tsarray) {
                const e = toBasetype(e1.type!).isTypeSArray()!.dim!;
                ue.emplace(e.copy());
            } else if (e1.isNullExp() !== null) {
                ue.emplace(new IntegerExp(loc, 0n, type));
            } else
                cantExp(ue);
        }
    }
    return ue;
}

/* dmd/constfold.d:1117 — `UnionExp Index(Type type, Expression e1, Expression e2, bool indexIsInBounds)`
 * `e1[e2]` for a literal `e1` and a constant index.
 * Also return EXP.cantExpression if this fails
 */
export function Index(type: Type, e1: Expression, e2: Expression, indexIsInBounds: boolean): UnionExp {
    let ue = new UnionExp();
    const loc = e1.loc;
    //printf("Index(e1 = %s, e2 = %s)\n", e1.toChars(), e2.toChars());
    assert(e1.type !== null);
    // Every `uinteger_t i` below is the index carrier read unsigned: D orders it against the lengths (09 §3.1).
    if (e1.op === EXP.string_ && e2.op === EXP.int64) {
        const es1 = e1.isStringExp()!;
        const i: uinteger_t = toUint64(toInteger(e2));
        if (i >= BigInt(es1.len)) {
            error(e1.loc, ds("string index %llu is out of bounds `[0 .. %llu]`"), i, BigInt(es1.len));
            ue.emplace(new ErrorExp());
        } else {
            ue.emplace(new IntegerExp(loc, es1.getIndex(Number(i)), type)); // `cast(size_t) i` — below `len`
        }
    } else if (toBasetype(e1.type).ty === TY.Tsarray && e2.op === EXP.int64) {
        const tsa = toBasetype(e1.type).isTypeSArray()!;
        const length: uinteger_t = toUint64(toInteger(tsa.dim!));
        const i: uinteger_t = toUint64(toInteger(e2));
        if (i >= length && (e1.op === EXP.arrayLiteral || !indexIsInBounds)) {
            // C code only checks bounds if an ArrayLiteralExp
            error(e1.loc, ds("array index %llu is out of bounds `%s[0 .. %llu]`"), i, e1.toChars(), length);
            ue.emplace(new ErrorExp());
        } else {
            const ale = e1.isArrayLiteralExp();
            if (ale !== null) {
                const e = ale.opIndex(Number(i))!; // `cast(size_t)i` — an in-bounds literal index
                e.type = type;
                e.loc = loc;
                if (hasSideEffect(e))
                    cantExp(ue);
                else
                    ue.emplace(e.copy());
            } else
                cantExp(ue);
        }
    } else if (toBasetype(e1.type).ty === TY.Tarray && e2.op === EXP.int64) {
        const i: uinteger_t = toUint64(toInteger(e2));
        const ale = e1.isArrayLiteralExp();
        if (ale !== null) {
            if (i >= BigInt(ale.elements!.length)) {
                error(e1.loc, ds("array index %llu is out of bounds `%s[0 .. %llu]`"), i, e1.toChars(),
                    BigInt(ale.elements!.length));
                ue.emplace(new ErrorExp());
            } else {
                const e = ale.opIndex(Number(i))!; // `cast(size_t)i` — below `elements.length`
                e.type = type;
                e.loc = loc;
                if (hasSideEffect(e))
                    cantExp(ue);
                else
                    ue.emplace(e.copy());
            }
        } else
            cantExp(ue);
    } else {
        const ae = e1.isAssocArrayLiteralExp();
        if (ae !== null) {
            /* Search the keys backwards, in case there are duplicate keys
             */
            for (let i = ae.keys!.length; i !== 0;) {
                i--;
                const ekey = ae.keys!.opIndex(i)!;
                ue = Equal(EXP.equal, loc, Type.tbool, ekey, e2);
                if (CTFEExp.isCantExp(ue.exp()))
                    return ue;
                if (toBool(ue.exp()).hasValue(true)) {
                    const e = ae.values!.opIndex(i)!;
                    e.type = type;
                    e.loc = loc;
                    if (hasSideEffect(e))
                        cantExp(ue);
                    else
                        ue.emplace(e.copy());
                    return ue;
                }
            }
            cantExp(ue);
        } else
            cantExp(ue);
    }
    return ue;
}

/* dmd/constfold.d:1217 — `UnionExp Slice(Type type, Expression e1, Expression lwr, Expression upr)`
 * `e1[lwr .. upr]` for a string or array literal and constant bounds.
 * Also return EXP.cantExpression if this fails
 */
export function Slice(type: Type, e1: Expression, lwr: Expression | null, upr: Expression | null): UnionExp {
    const ue = new UnionExp();
    const loc = e1.loc;

    if (lwr === null) {
        if (e1.op === EXP.string_)
            ue.emplace(e1.copy()); // `emplaceExp(&ue, e1)` — the UnionExp overload (ctfeexpr.d:116)
        else
            cantExp(ue);
    } else if (e1.op === EXP.string_ && lwr.op === EXP.int64 && upr!.op === EXP.int64) {
        const es1 = e1.isStringExp()!;
        const ilwr: uinteger_t = toUint64(toInteger(lwr));
        const iupr: uinteger_t = toUint64(toInteger(upr!));
        if (sliceBoundsCheck(0n, BigInt(es1.len), ilwr, iupr))
            cantExp(ue);   // https://issues.dlang.org/show_bug.cgi?id=18115
        else {
            // `cast(size_t)` of the bounds: sliceBoundsCheck just proved them within `[0 .. es1.len]`.
            const len = Number(iupr - ilwr);
            const sz = es1.sz;
            const s = new Uint8Array(len * sz); // `mem.xmalloc(len * sz)` (08 §13)
            const data1 = es1.peekData();
            const from = Number(ilwr) * sz;
            s.set(data1.subarray(from, from + len * sz), 0); // memcpy(s, data1.ptr + ilwr * sz, len * sz)
            ue.emplace(new StringExp(loc, globalThis.Array.from(s.subarray(0, len * sz)), len, sz, es1.postfix));
            const es = ue.exp().isStringExp()!;
            es.committed = es1.committed;
            es.type = type;
        }
    } else if (e1.op === EXP.arrayLiteral && lwr.op === EXP.int64 && upr!.op === EXP.int64 && !hasSideEffect(e1)) {
        const es1 = e1.isArrayLiteralExp()!;
        const ilwr: uinteger_t = toUint64(toInteger(lwr));
        const iupr: uinteger_t = toUint64(toInteger(upr!));
        if (sliceBoundsCheck(0n, BigInt(es1.elements!.length), ilwr, iupr))
            cantExp(ue);
        else {
            // `cast(size_t)` of the bounds: sliceBoundsCheck just proved them within `[0 .. elements.length]`.
            const n = Number(iupr - ilwr);
            const lo = Number(ilwr);
            const elements: Expressions = new DArray<Expression | null>(n);
            // memcpy(elements.tdata(), es1.elements.tdata() + ilwr, n * sizeof(Expression)) — element references
            for (let k = 0; k < n; k++)
                elements.opIndexAssign(es1.elements!.opIndex(lo + k), k);
            ue.emplace(ArrayLiteralExp.fromBasis(e1.loc, type, es1.basis, elements));
        }
    } else
        cantExp(ue);
    return ue;
}

/* dmd/constfold.d:1280
 * Check whether slice `[newlwr .. newupr]` is in the range `[lwr .. upr]`
 */
export function sliceBoundsCheck(lwr: uinteger_t, upr: uinteger_t, newlwr: uinteger_t, newupr: uinteger_t): boolean {
    assert(lwr <= upr);
    return !(newlwr <= newupr &&
             lwr <= newlwr &&
             newupr <= upr);
}

/* dmd/constfold.d:1291
 * Set a slice of char/integer array literal 'existingAE' from a string 'newval'.
 * existingAE[firstIndex..firstIndex+newval.length] = newval.
 */
export function sliceAssignArrayLiteralFromString(existingAE: ArrayLiteralExp, newval: StringExp,
                                                  firstIndex: number): void {
    const len = newval.len;
    const elemType = nextOf(existingAE.type!)!;
    for (let j = 0; j < len; j++) {
        const val = newval.getIndex(j);
        existingAE.elements!.opIndexAssign(new IntegerExp(newval.loc, val, elemType), j + firstIndex);
    }
}

/* dmd/constfold.d:1305
 * Set a slice of string 'existingSE' from a char array literal 'newae'.
 *   existingSE[firstIndex..firstIndex+newae.length] = newae.
 */
export function sliceAssignStringFromArrayLiteral(existingSE: StringExp, newae: ArrayLiteralExp,
                                                  firstIndex: number): void {
    assert(existingSE.ownedByCtfe !== OwnedBy.code);
    for (let j = 0; j < newae.elements!.length; j++) {
        // `cast(dchar)` of the carrier: its low 32 bits (09 §2.1), exact as a `number`.
        existingSE.setCodeUnit(firstIndex + j, Number(maskUnsignedN(32, toInteger(newae.opIndex(j)!))));
    }
}

/* dmd/constfold.d:1317
 * Set a slice of string 'existingSE' from a string 'newstr'.
 *   existingSE[firstIndex..firstIndex+newstr.length] = newstr.
 */
export function sliceAssignStringFromString(existingSE: StringExp, newstr: StringExp, firstIndex: number): void {
    assert(existingSE.ownedByCtfe !== OwnedBy.code);
    const sz = existingSE.sz;
    assert(sz === newstr.sz);
    const data1 = existingSE.borrowData();
    const data2 = newstr.peekData();
    data1.set(data2, firstIndex * sz); // memcpy(data1.ptr + firstIndex * sz, data2.ptr, data2.length)
}

/* dmd/constfold.d:1330
 * Compare a string slice with another string slice.
 * Conceptually equivalent to memcmp( se1[lo1..lo1+len],  se2[lo2..lo2+len])
 */
export function sliceCmpStringWithString(se1: StringExp, se2: StringExp, lo1: number, lo2: number,
                                         len: number): number {
    const sz = se1.sz;
    assert(sz === se2.sz);
    const data1 = se1.peekData();
    const data2 = se2.peekData();
    return memcmp(data1.subarray(sz * lo1), data2.subarray(sz * lo2), sz * len);
}

/* dmd/constfold.d:1342
 * Compare a string slice with an array literal slice
 * Conceptually equivalent to memcmp( se1[lo1..lo1+len],  ae2[lo2..lo2+len])
 */
export function sliceCmpStringWithArray(se1: StringExp, ae2: ArrayLiteralExp, lo1: number, lo2: number,
                                        len: number): number {
    for (let j = 0; j < len; j++) {
        // `const val2 = ae2[..].toInteger()` is a `dinteger_t`: the ordering below is unsigned (09 §3.1).
        const val2 = toUint64(toInteger(ae2.opIndex(j + lo2)!));
        const val1 = se1.getIndex(j + lo1);
        const c = (val1 > val2 ? 1 : 0) - (val1 < val2 ? 1 : 0);
        if (c !== 0)
            return c;
    }
    return 0;
}

/** dmd/constfold.d:1365 — module-private.
 * Copy element `Expressions` in the parameters when they're `ArrayLiteralExp`s.
 * Params:
 *      e1  = If it's ArrayLiteralExp, its `elements` will be copied.
 *            Otherwise, `e1` itself will be pushed into the new `Expressions`.
 *      e2  = If it's not `null`, it will be pushed/appended to the new
 *            `Expressions` by the same way with `e1`.
 * Returns:
 *      Newly allocated `Expressions`. Note that it points to the original
 *      `Expression` values in e1 and e2.
 */
function copyElements(e1: Expression, e2: Expression | null = null): Expressions {
    const elems: Expressions = new DArray<Expression | null>();

    const append = (ale: ArrayLiteralExp): void => {
        if (ale.elements === null)
            return;
        const d = elems.length;
        elems.append(ale.elements);
        // foreach (ref el; (*elems)[d .. elems.length]) — a write through each slot of the appended range
        for (let k = d; k < elems.length; k++) {
            if (elems.opIndex(k) === null)
                elems.opIndexAssign(ale.basis, k);
        }
    };

    const ale1 = e1.isArrayLiteralExp();
    if (ale1 !== null)
        append(ale1);
    else
        elems.push(e1);

    if (e2 !== null) {
        const ale2 = e2.isArrayLiteralExp();
        if (ale2 !== null)
            append(ale2);
        else
            elems.push(e2);
    }

    return elems;
}

/* dmd/constfold.d:1400 — `UnionExp Cat(Loc loc, Type type, Expression e1, Expression e2)`
 * `e1 ~ e2` for literal and null operands.
 * Also return EXP.cantExpression if this fails
 */
export function Cat(loc: Loc, type: Type, e1: Expression, e2: Expression): UnionExp {
    const ue = new UnionExp();
    let e: Expression = CTFEExp.cantexp!;
    let t: Type; // assigned on both routes into `L1` before it runs
    const t1 = toBasetype(e1.type!);
    const t2 = toBasetype(e2.type!);
    //printf("Cat(e1 = %s, e2 = %s)\n", e1.toChars(), e2.toChars());
    //printf("\tt1 = %s, t2 = %s, type = %s\n", t1.toChars(), t2.toChars(), type.toChars());

    /* e is the non-null operand, t is the type of the null operand
     */
    const catNull = (e: Expression, t: Type): UnionExp => {
        const tn = toBasetype(e.type!);
        if (isSomeChar(tn.ty)) {
            // Create a StringExp
            if (nextOf(t) !== null)
                t = toBasetype(nextOf(t)!);
            const sz = Number(maskUnsignedN(8, size(t))); // `cast(ubyte)t.size()`
            const v: dinteger_t = toInteger(e);
            const len = (t.ty === tn.ty) ? 1 : utf_codeLength(sz, Number(maskUnsignedN(32, v))); // `cast(dchar)v`
            const s = new Uint8Array(len * sz); // `mem.xmalloc(len * sz)` (08 §13)
            if (t.ty === tn.ty)
                Port.valcpy(s, 0, v, sz);
            else
                utf_encode(sz, s, 0, Number(maskUnsignedN(32, v))); // `cast(dchar)v`; utf.d:110
            ue.emplace(new StringExp(loc, globalThis.Array.from(s.subarray(0, len * sz)), len, sz));
            const es = ue.exp().isStringExp()!;
            es.type = type;
            es.committed = true;
        } else {
            // Create an ArrayLiteralExp
            const elements: Expressions = DArray.from<Expression | null>(e);
            ue.emplace(new ArrayLiteralExp(e.loc, type, elements));
        }
        assert(ue.exp().type !== null);
        return ue;
    };

    // BAIL `L3:` (constfold.d:1613) — the terminal tail of the null/array-literal arm, also reached by the jump at
    // :1608 from the array-literal/null arm.
    const L3Tail = (): UnionExp => {
        // Concatenate the array with null
        const elems = copyElements(e);

        ue.emplace(new ArrayLiteralExp(e.loc, null, elems));

        e = ue.exp();
        if (toBasetype(type).ty === TY.Tsarray) {
            e.type = sarrayOf(nextOf(t1)!, BigInt(elems.length));
        } else
            e.type = type;
        assert(ue.exp().type !== null);
        return ue;
    };

    // SHARED-ARM `L1:` (constfold.d:1673) — the string/null arm's body, also entered by the jump at :1667 from the
    // null/string arm; both routes then fall out to the common tail (:1696).
    const L1 = (): void => {
        const tb = toBasetype(t);
        if (tb.ty === TY.Tarray && equivalent(nextOf(tb)!, e.type!)) {
            const expressions: Expressions = DArray.from<Expression | null>(e);
            ue.emplace(new ArrayLiteralExp(loc, t, expressions));
            e = ue.exp();
        } else {
            ue.emplace(e.copy());
            e = ue.exp();
        }
        if (!e.type!.equals(type)) {
            const se = e.copy().isStringExp()!;
            e = castTo(se, null, type);
            ue.emplace(e.copy());
            e = ue.exp();
        }
    };

    if (e1.op === EXP.null_ && (e2.op === EXP.int64 || e2.op === EXP.structLiteral)) {
        return catNull(e2, t1);
    } else if ((e1.op === EXP.int64 || e1.op === EXP.structLiteral) && e2.op === EXP.null_) {
        return catNull(e1, t2);
    } else if (e1.op === EXP.null_ && e2.op === EXP.null_) {
        if (type === e1.type) {
            // Handle null ~= null
            if (t1.ty === TY.Tarray && t2 === nextOf(t1)) {
                ue.emplace(ArrayLiteralExp.fromExp(e1.loc, type, e2));
                assert(ue.exp().type !== null);
                return ue;
            } else {
                ue.emplace(e1.copy());
                assert(ue.exp().type !== null);
                return ue;
            }
        }
        if (type === e2.type) {
            ue.emplace(e2.copy());
            assert(ue.exp().type !== null);
            return ue;
        }
        ue.emplace(new NullExp(e1.loc, type));
        assert(ue.exp().type !== null);
        return ue;
    } else if (e1.op === EXP.string_ && e2.op === EXP.string_) {
        // Concatenate the strings
        const es1 = e1.isStringExp()!;
        const es2 = e2.isStringExp()!;
        const len = es1.len + es2.len;
        const sz = es1.sz;
        if (sz !== es2.sz) {
            /* Can happen with:
             *   auto s = "foo"d ~ "bar"c;
             */
            assert(global.errors !== 0);
            cantExp(ue);
            assert(ue.exp().type !== null);
            return ue;
        }
        const s = new Uint8Array(len * sz); // `mem.xmalloc(len * sz)` (08 §13)
        const data1 = es1.peekData();
        const data2 = es2.peekData();
        s.set(data1.subarray(0, es1.len * sz), 0); // memcpy(cast(char*)s, data1.ptr, es1.len * sz)
        s.set(data2.subarray(0, es2.len * sz), es1.len * sz); // memcpy(s + es1.len * sz, data2.ptr, es2.len * sz)
        ue.emplace(new StringExp(loc, globalThis.Array.from(s.subarray(0, len * sz)), len, sz));
        const es = ue.exp().isStringExp()!;
        es.committed = es1.committed || es2.committed; // D `|` over two bools
        es.type = type;
        assert(ue.exp().type !== null);
        return ue;
    } else if (e2.op === EXP.string_ && e1.op === EXP.arrayLiteral && isIntegral(nextOf(t1)!)) {
        // [chars] ~ string --> [chars]
        const es = e2.isStringExp()!;
        const ea = e1.isArrayLiteralExp()!;
        const len = es.len + ea.elements!.length;
        const elems: Expressions = new DArray<Expression | null>(len);
        for (let i = 0; i < ea.elements!.length; ++i) {
            elems.opIndexAssign(ea.opIndex(i), i);
        }
        ue.emplace(new ArrayLiteralExp(e1.loc, type, elems));
        const dest = ue.exp().isArrayLiteralExp()!;
        sliceAssignArrayLiteralFromString(dest, es, ea.elements!.length);
        assert(ue.exp().type !== null);
        return ue;
    } else if (e1.op === EXP.string_ && e2.op === EXP.arrayLiteral && isIntegral(nextOf(t2)!)) {
        // string ~ [chars] --> [chars]
        const es = e1.isStringExp()!;
        const ea = e2.isArrayLiteralExp()!;
        const len = es.len + ea.elements!.length;
        const elems: Expressions = new DArray<Expression | null>(len);
        for (let i = 0; i < ea.elements!.length; ++i) {
            elems.opIndexAssign(ea.opIndex(i), es.len + i);
        }
        ue.emplace(new ArrayLiteralExp(e1.loc, type, elems));
        const dest = ue.exp().isArrayLiteralExp()!;
        sliceAssignArrayLiteralFromString(dest, es, 0);
        assert(ue.exp().type !== null);
        return ue;
    } else if (e1.op === EXP.string_ && e2.op === EXP.int64) {
        // string ~ char --> string
        const es1 = e1.isStringExp()!;
        let es: StringExp;
        const sz = es1.sz;
        const v: dinteger_t = toInteger(e2);
        // Is it a concatenation of homogenous types?
        // (char[] ~ char, wchar[]~wchar, or dchar[]~dchar)
        const homoConcat = (BigInt(sz) === size(t2));
        const len = es1.len + (homoConcat ? 1 : utf_codeLength(sz, Number(maskUnsignedN(32, v)))); // `cast(dchar)v`
        const s = new Uint8Array(len * sz); // `mem.xmalloc(len * sz)` (08 §13)
        const data1 = es1.peekData();
        s.set(data1, 0); // memcpy(s, data1.ptr, data1.length)
        if (homoConcat)
            Port.valcpy(s, sz * es1.len, v, sz);
        else
            utf_encode(sz, s, sz * es1.len, Number(maskUnsignedN(32, v))); // `s + (sz * es1.len)`, `cast(dchar)v`
        ue.emplace(new StringExp(loc, globalThis.Array.from(s.subarray(0, len * sz)), len, sz));
        es = ue.exp().isStringExp()!;
        es.committed = es1.committed;
        es.type = type;
        assert(ue.exp().type !== null);
        return ue;
    } else if (e1.op === EXP.int64 && e2.op === EXP.string_) {
        // [w|d]?char ~ string --> string
        // We assume that we only ever prepend one char of the same type
        // (wchar,dchar) as the string's characters.
        const es2 = e2.isStringExp()!;
        const len = 1 + es2.len;
        const sz = es2.sz;
        const v: dinteger_t = toInteger(e1);
        const s = new Uint8Array(len * sz); // `mem.xmalloc(len * sz)` (08 §13)
        Port.valcpy(s, 0, v, sz);
        const data2 = es2.peekData();
        s.set(data2, sz); // memcpy(cast(char*)s + sz, data2.ptr, data2.length)
        ue.emplace(new StringExp(loc, globalThis.Array.from(s.subarray(0, len * sz)), len, sz));
        const es = ue.exp().isStringExp()!;
        es.sz = sz;
        es.committed = es2.committed;
        es.type = type;
        assert(ue.exp().type !== null);
        return ue;
    } else if (e1.op === EXP.arrayLiteral && e2.op === EXP.arrayLiteral && nextOf(t1)!.equals(nextOf(t2))) {
        // Concatenate the arrays
        const elems = copyElements(e1, e2);

        ue.emplace(new ArrayLiteralExp(e1.loc, null, elems));

        e = ue.exp();
        if (toBasetype(type).ty === TY.Tsarray) {
            e.type = sarrayOf(nextOf(t1)!, BigInt(elems.length));
        } else
            e.type = type;
        assert(ue.exp().type !== null);
        return ue;
    } else if (e1.op === EXP.arrayLiteral && e2.op === EXP.null_ && nextOf(t1)!.equals(nextOf(t2))) {
        e = e1;
        return L3Tail(); // goto L3 (dmd/constfold.d:1608)
    } else if (e1.op === EXP.null_ && e2.op === EXP.arrayLiteral && nextOf(t1)!.equals(nextOf(t2))) {
        e = e2;
        return L3Tail(); // L3: (dmd/constfold.d:1613)
    } else if ((e1.op === EXP.arrayLiteral || e1.op === EXP.null_) && nextOf(toBasetype(e1.type!)) !== null &&
               nextOf(toBasetype(e1.type!))!.equals(e2.type)) {
        const elems = (e1.op === EXP.arrayLiteral)
                ? copyElements(e1) : new DArray<Expression | null>();
        elems.push(e2);

        ue.emplace(new ArrayLiteralExp(loc, null, elems));

        e = ue.exp();
        if (toBasetype(type).ty === TY.Tsarray) {
            e.type = sarrayOf(e2.type!, BigInt(elems.length));
        } else
            e.type = type;
        assert(ue.exp().type !== null);
        return ue;
    } else if (e2.op === EXP.arrayLiteral && nextOf(toBasetype(e2.type!))!.equals(e1.type)) {
        const elems = copyElements(e1, e2);

        ue.emplace(new ArrayLiteralExp(loc, null, elems));

        e = ue.exp();
        if (toBasetype(type).ty === TY.Tsarray) {
            e.type = sarrayOf(e1.type!, BigInt(elems.length));
        } else
            e.type = type;
        assert(ue.exp().type !== null);
        return ue;
    } else if (e1.op === EXP.null_ && e2.op === EXP.string_) {
        t = e1.type!;
        e = e2;
        L1(); // goto L1 (dmd/constfold.d:1667)
    } else if (e1.op === EXP.string_ && e2.op === EXP.null_) {
        e = e1;
        t = e2.type!;
        L1(); // L1: (dmd/constfold.d:1673)
    } else
        cantExp(ue);
    assert(ue.exp().type !== null);
    return ue;
}

/// dmd/constfold.d:1700 — `UnionExp Ptr(Type type, Expression e1)`
/// `*(&structliteral + offset)`, folded to the addressed field.
export function Ptr(type: Type, e1: Expression): UnionExp {
    //printf("Ptr(e1 = %s)\n", e1.toChars());
    const ue = new UnionExp();
    const ae = e1.isAddExp();
    if (ae !== null) {
        const ade = ae.e1!.isAddrExp();
        if (ade !== null) {
            if (ae.e2!.op === EXP.int64) {
                const se = ade.e1!.isStructLiteralExp();
                if (se !== null) {
                    const offset = Number(maskUnsignedN(32, toInteger(ae.e2!))); // `cast(uint)` — the low 32 bits
                    const e = getField(se, type, offset);
                    if (e !== null) {
                        ue.emplace(e.copy());
                        return ue;
                    }
                }
            }
        }
    }
    cantExp(ue);
    return ue;
}

/**
 * C `memcmp` (core.stdc.string) over the first `n` bytes of two byte views: 0 when equal, else the difference of
 * the first unequal (unsigned) bytes — only its sign is part of the C contract. Not a D declaration.
 * Precondition: both views hold at least `n` bytes.
 */
function memcmp(a: Uint8Array, b: Uint8Array, n: number): number {
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i])
            return a[i]! - b[i]!;
    }
    return 0;
}
