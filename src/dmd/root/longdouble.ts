// Port of dmd/root/longdouble.d — the front-end's `longdouble` type.
//
// Upstream purpose (file header, longdouble.d:1-10): an 80-bit floating-point implementation
// for hosts whose C/D compiler cannot represent `real` natively — specifically the DMD/LDC
// *Windows* build (MSVC C runtime, where the x87 80-bit `real` is not available the same way).
//
// On THIS target the whole soft-float machinery collapses:
//   - real == double, real.sizeof == 8 (verified `ldc2 -run`: longdouble == real, real.sizeof == 8;
//     _ground-truth.md §3 / _probes.md §6). So `longdouble` maps to `number` (09-numerics.md §6).
//   - the soft-float section is gated OFF. 2.113 renamed the gate: upstream now self-sets
//     `version = EnableSoftfloat;` from either `version(LDC_real_softfloat)` (a new external LDC
//     driver flag) or `version(CRuntime_Microsoft)` (longdouble.d:14-28). BOTH are OFF for us
//     (_config.md rows `LDC_real_softfloat` / `EnableSoftfloat` / `CRuntime_Microsoft`), so
//     `EnableSoftfloat` is never set. The `version(EnableSoftfloat):` colon-label at
//     longdouble.d:34 scopes to end-of-module (verified: a `version(X):` label with X undefined
//     disables the rest of the module), so EVERYTHING below the alias — `longdouble_soft`,
//     `initFPU`/`ld_clearfpu`, every `ld_*` helper, the `__gshared` constant table,
//     `ld_type`/`ld_sprint`, and the unittest — is the DEAD branch and is dropped (see the
//     "dropped" inventory at the bottom of this file).
//
// LIVE content of this module on our target = exactly one declaration: `alias longdouble = real;`
// (longdouble.d:29, the POSIX `else` branch). The only live consumer is ctfloat.d:24
// `public import dmd.root.longdouble : real_t = longdouble;` — already realized in ctfloat.ts as
// `export type real_t = number` (it re-derives the alias directly rather than importing it, but
// the contract is the same number type).

/// longdouble — the front-end's widest floating-point type.
///
/// D: `version (LDC_real_softfloat) { version = EnableSoftfloat; alias longdouble = longdouble_soft; }
///      else version (CRuntime_Microsoft) { version = EnableSoftfloat;
///        static if (real.sizeof > 8) alias longdouble = real; else alias longdouble = longdouble_soft; }
///      else alias longdouble = real;` (longdouble.d:14-29).
/// resolved: version(LDC_real_softfloat) -> false and version(CRuntime_Microsoft) -> false
/// (target = POSIX, native 64-bit `real`) → the final `else` branch `alias longdouble = real;`
/// (longdouble.d:29). real == double on this target (real.sizeof == 8), so longdouble == double
/// == `number` (09-numerics.md §6, _probes.md §6).
export type longdouble = number;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dropped from longdouble.d (all under the dead `version(EnableSoftfloat):` section, line 34+):
//   - struct longdouble_soft (longdouble.d:103-217)       — 80-bit x87 soft-float; not needed (real==double)
//   - initFPU / ld_clearfpu (longdouble.d:47-99)          — x87 FPU control-word setup (inline asm)
//   - version(unittest) shared static this (longdouble.d:83-87) — FPU init for the soft-float unittest.
//     2.113 dropped the extra `version(CRuntime_Microsoft)` on this guard (it is now plain
//     `version(unittest)`), but it still sits inside the dead EnableSoftfloat section → still dropped.
//   - fld_arg/fstp_arg/… asm mixin enums (longdouble.d:222-252) — x87 load/store glue
//   - ld_read/ld_readll/ld_readull/ld_set/ld_setll/ld_setull (longdouble.d:253-352) — x87 read/set
//   - ldexpl/ld_add/ld_sub/ld_mul/ld_div/ld_mod/fmodl (longdouble.d:354-686) — x87 arithmetic
//   - ld_cmp* family / _isnan / fabsl / sqrtl/sqrt / sinl/cosl/tanl (longdouble.d:434-653) — x87 ops.
//     2.113 added the missing `return res;` at the tail of ld_cmp (longdouble.d:582) — a real
//     upstream bugfix, but in dead code here.
//   - ld_statusfpu (longdouble.d:289-300)                 — x87 status word
//   - __gshared const ld_qnan/ld_inf/…/twoPow63 (longdouble.d:688-706) — 80-bit constant bit patterns
//   - LD_TYPE_* enums + ld_type (longdouble.d:710-732)    — 80-bit classification
//   - snprintf binding + ld_sprint (longdouble.d:735-799) — 80-bit hex/`g` formatting
//   - static assert(longdouble_soft.alignof/sizeof == longdouble.…) (longdouble.d:218-219) — layout check
//   - @system unittest (longdouble.d:803-869)             — exercises longdouble_soft only
// All are dead on POSIX (LDC_real_softfloat and CRuntime_Microsoft both OFF → EnableSoftfloat never
// set); none has a non-Windows consumer in the frontend scope (ctfloat.d:32 imports
// longdouble_soft/ld_sprint only inside the same dead version block; main.d's
// `import dmd.root.longdouble;` is driver glue, out of scope).
// ─────────────────────────────────────────────────────────────────────────────────────────────
