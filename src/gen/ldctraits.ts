// Ported from gen/ldctraits.d (module gen.ldctraits), with the bodies of gen/ldctraits.cpp it binds.
//
// ---------------------------------------------------------------------------------------------
// TRANSLATION NOTES
// ---------------------------------------------------------------------------------------------
// * HOME (01 Rule 1.1, 07 §1.3, 11 §2.5): `gen/ldctraits.d` is a D binding module declaring two
//   `extern (C++)` functions whose bodies live in gen/ldctraits.cpp; like gen/dpragma.ts, the D
//   module and its C++ bodies are ported together here. The frontend reaches it through
//   `dmd.hooks.semanticTraitsHook` (hooks.d:16), called from `semanticTraits` (traits.d:2072).
// * `extern(C++) struct Dstring { size_t length; const(char)* ptr; }` (ldctraits.d:22) is the C ABI
//   carrier of a D slice across the D/C++ boundary. With both sides ported that boundary is gone:
//   a `DString` is the slice itself, so the struct is dropped and the two functions take and return
//   `DString`.
// * TARGET FOLD. Both C++ bodies query `gTargetMachine`, which no `-mcpu` and no `-mattr` (neither is in the
//   shim's table) leaves at the triple's default CPU, so the answers depend on the triple's arch only
//   (target.ts `Triple`, 10 §4.8):
//   - `traitsGetTargetCPU` returns `"generic"` on aarch64 (the host and aarch64-linux-gnu) and `"x86-64"` on
//     x86_64 (ldc2 1.43.0: `pragma(msg, __traits(targetCPU));`).
//   - `traitsTargetHasFeature` asks LLVM's `MCSubtargetInfo` whether a feature is enabled. The LLVM
//     data the answer depends on (LLVM 22.1.8, the one ldc2 1.43.0 is built with) is folded into two
//     tables per arch below: every feature name the backend recognises (the "Available features" list of
//     `ldc2 [-mtriple=<t>] -mattr=help`: 349 AArch64 names, 198 X86 names), and the ones the default CPU
//     enables (each name probed with `__traits(targetHasFeature)` on ldc2: 8 true on aarch64, the same 8
//     under arm64-apple-darwin and aarch64-linux-gnu; 16 true on x86_64-linux-gnu). The C++ two-step test is
//     kept over that model; see `applyFeatureFlag` for what of LLVM's `ApplyFeatureFlag` the model keeps.

import { ErrorExp, IntegerExp, StringExp } from "../dmd/expression.js";
import type { Expression, TraitsExp } from "../dmd/expression.js";
import { error, warning } from "../dmd/errors.js";
import { Id } from "../dmd/id.js";
import { Type } from "../dmd/mtype.js";
import { ctfeInterpret } from "../dmd/dinterpret.js";
import { expressionSemantic, toStringExp, toUTF8 } from "../dmd/expressionsem.js";
import { isExpression } from "../dmd/dtemplate.js";
import { ds, dsConcat, type DString } from "../dstring.js";
import { targetTriple } from "../dmd/target.js";

import type { Scope } from "../dmd/dscope.js";

// dropped: `extern(C++) struct Dstring` (ldctraits.d:22-26) — the C ABI slice carrier; see header.

/**
 * gen/ldctraits.d:28 (declaration), gen/ldctraits.cpp:15 (body) — the target machine's CPU name.
 * Folded: `gTargetMachine->getTargetCPU()` with no `-mcpu` is the default CPU of the triple's arch.
 */
function traitsGetTargetCPU(): DString {
    return targetTriple().arch === "x86_64" ? ds("x86-64") : ds("generic");
}

/**
 * Every feature name the LLVM 22 AArch64 backend recognises, in LLVM's table order (byte order,
 * the order `Find` binary-searches). Source: `ldc2 -mattr=help` of ldc2 1.43.0.
 */
const AARCH64_FEATURES: ReadonlySet<string> = new Set([
    "CONTEXTIDREL2", "a320", "a35", "a510", "a520", "a520ae", "a53", "a55", "a57", "a64fx", "a65", "a710", "a715",
    "a72", "a720", "a720ae", "a73", "a75", "a76", "a77", "a78", "a78ae", "a78c", "addr-lsl-slow-14", "aes",
    "aggressive-fma", "aggressive-interleaving", "all", "alternate-sextload-cvt-f32-pattern", "altnzcv",
    "alu-lsl-fast", "am", "ampere1", "ampere1a", "ampere1b", "ampere1c", "amvs", "apple-a10", "apple-a11",
    "apple-a12", "apple-a13", "apple-a14", "apple-a15", "apple-a16", "apple-a17", "apple-a7", "apple-m4", "apple-m5",
    "arith-bcc-fusion", "arith-cbz-fusion", "ascend-store-address", "avoid-ldapur", "balance-fp-ops", "bf16", "brbe",
    "bti", "btie", "c1-nano", "c1-premium", "c1-pro", "c1-ultra", "call-saved-x10", "call-saved-x11",
    "call-saved-x12", "call-saved-x13", "call-saved-x14", "call-saved-x15", "call-saved-x18", "call-saved-x8",
    "call-saved-x9", "carmel", "ccdp", "ccidx", "ccpp", "chk", "clrbhb", "cmh", "cmp-bcc-fusion", "cmpbr",
    "complxnum", "cortex-a725", "cortex-r82", "cortex-r82ae", "cortex-x1", "cortex-x2", "cortex-x3", "cortex-x4",
    "cortex-x925", "cpa", "crc", "crypto", "cssc", "d128", "disable-fast-inc-vl", "disable-latency-sched-heuristic",
    "disable-ldp", "disable-maximize-scalable-bandwidth", "disable-stp", "disable-unpredicated-ld-st-lower", "dit",
    "dotprod", "ecv", "el2vmsa", "el3", "enable-select-opt", "ete", "execute-only", "exynos-cheap-as-move",
    "exynosm3", "exynosm4", "f16f32dot", "f16f32mm", "f16mm", "f32mm", "f64mm", "f8f16mm", "f8f32mm", "falkor",
    "faminmax", "fgt", "fix-cortex-a53-835769", "flagm", "fmv", "force-32bit-jump-tables", "fp-armv8", "fp16fml",
    "fp8", "fp8dot2", "fp8dot4", "fp8fma", "fpac", "fprcvt", "fptoint", "fujitsu-monaka", "fullfp16", "fuse-address",
    "fuse-addsub-2reg-const1", "fuse-adrp-add", "fuse-aes", "fuse-arith-logic", "fuse-crypto-eor", "fuse-csel",
    "fuse-cset", "fuse-literals", "gcie", "gcs", "harden-sls-blr", "harden-sls-nocomdat", "harden-sls-retbr", "hbc",
    "hcx", "i8mm", "ite", "jsconv", "kryo", "ldp-aligned-only", "lor", "ls64", "lscp", "lse", "lse128", "lse2",
    "lsfe", "lsui", "lut", "max-interleave-factor-4", "mec", "mops", "mops-go", "mpam", "mpamv2", "mte", "mtetc",
    "neon", "neoverse512tvb", "neoversee1", "neoversen1", "neoversen2", "neoversen3", "neoversev1", "neoversev2",
    "neoversev3", "neoversev3AE", "nmi", "no-bti-at-return-twice", "no-neg-immediates", "no-sve-fp-ld1r",
    "no-zcz-fpr64", "nv", "occmo", "olympus", "oryon-1", "outline-atomics", "pan", "pan-rwv", "pauth", "pauth-lr",
    "pcdphint", "perfmon", "poe2", "pops", "predictable-select-expensive", "predres", "prfm-slc-target", "rand",
    "ras", "rasv2", "rcpc", "rcpc-immo", "rcpc3", "rdm", "reserve-lr-for-ra", "reserve-x1", "reserve-x10",
    "reserve-x11", "reserve-x12", "reserve-x13", "reserve-x14", "reserve-x15", "reserve-x18", "reserve-x2",
    "reserve-x20", "reserve-x21", "reserve-x22", "reserve-x23", "reserve-x24", "reserve-x25", "reserve-x26",
    "reserve-x27", "reserve-x28", "reserve-x3", "reserve-x4", "reserve-x5", "reserve-x6", "reserve-x7", "reserve-x9",
    "rme", "saphira", "sb", "sel2", "sha2", "sha3", "slow-misaligned-128store", "slow-paired-128",
    "slow-strqro-store", "sm4", "sme", "sme-b16b16", "sme-f16f16", "sme-f64f64", "sme-f8f16", "sme-f8f32", "sme-fa64",
    "sme-i16i64", "sme-lutv2", "sme-mop4", "sme-tmop", "sme2", "sme2p1", "sme2p2", "sme2p3", "spe", "spe-eef",
    "specres2", "specrestrict", "ssbs", "ssve-aes", "ssve-bitperm", "ssve-fexpa", "ssve-fp8dot2", "ssve-fp8dot4",
    "ssve-fp8fma", "store-pair-suppress", "stp-aligned-only", "strict-align", "sve", "sve-aes", "sve-aes2",
    "sve-b16b16", "sve-b16mm", "sve-bfscale", "sve-bitperm", "sve-f16f32mm", "sve-sha3", "sve-sm4", "sve2",
    "sve2-aes", "sve2-bitperm", "sve2-sha3", "sve2-sm4", "sve2p1", "sve2p2", "sve2p3", "tagged-globals", "tev", "the",
    "thunderx", "thunderx2t99", "thunderx3t110", "thunderxt81", "thunderxt83", "thunderxt88", "tlb-rmi", "tlbid",
    "tlbiw", "tpidr-el1", "tpidr-el2", "tpidr-el3", "tpidrro-el0", "tracev8.4", "trbe", "tsv110", "uaops",
    "use-experimental-zeroing-pseudos", "use-fixed-over-scalable-if-equal-cost", "use-postra-scheduler",
    "use-reciprocal-square-root", "use-wzr-to-vec-move", "v8.1a", "v8.2a", "v8.3a", "v8.4a", "v8.5a", "v8.6a",
    "v8.7a", "v8.8a", "v8.9a", "v8a", "v8r", "v9.1a", "v9.2a", "v9.3a", "v9.4a", "v9.5a", "v9.6a", "v9.7a", "v9a",
    "vh", "wfxt", "xs", "zcm-fpr128", "zcm-fpr32", "zcm-fpr64", "zcm-gpr32", "zcm-gpr64", "zcz-fp-workaround",
    "zcz-fpr128", "zcz-gpr32", "zcz-gpr64",
]);

/**
 * The feature bits of the default AArch64 CPU (`generic`, LLVM 22): the names among `AARCH64_FEATURES` for
 * which ldc2 1.43.0 answers `__traits(targetHasFeature, name)` with `true`, under arm64-apple-darwin and
 * aarch64-linux-gnu alike. LLVM builds this set with every implied feature added, so it is closed under
 * implication.
 */
const DEFAULT_FEATURE_BITS: ReadonlySet<string> = new Set([
    "enable-select-opt", "ete", "fp-armv8", "fuse-adrp-add", "fuse-aes", "neon", "trbe", "use-postra-scheduler",
]);

/**
 * Every feature name the LLVM 22 X86 backend recognises. Source: `ldc2 -mtriple=x86_64-linux-gnu -mattr=help`
 * of ldc2 1.43.0.
 */
const X86_FEATURES: ReadonlySet<string> = new Set([
    "16bit-mode", "32bit-mode", "64bit", "64bit-mode", "adx", "aes", "allow-light-256-bit", "amx-avx512",
    "amx-bf16", "amx-complex", "amx-fp16", "amx-fp8", "amx-int8", "amx-movrs", "amx-tf32", "amx-tile", "avx",
    "avx10.1", "avx10.1-512", "avx10.2", "avx10.2-512", "avx2", "avx512bf16", "avx512bitalg", "avx512bw",
    "avx512cd", "avx512dq", "avx512f", "avx512fp16", "avx512ifma", "avx512vbmi", "avx512vbmi2", "avx512vl",
    "avx512vnni", "avx512vp2intersect", "avx512vpopcntdq", "avxifma", "avxneconvert", "avxvnni", "avxvnniint16",
    "avxvnniint8", "bmi", "bmi2", "branch-hint", "branchfusion", "ccmp", "cf", "cldemote", "clflushopt", "clwb",
    "clzero", "cmov", "cmpccxadd", "crc32", "cx16", "cx8", "egpr", "enqcmd", "ermsb", "evex512", "f16c",
    "false-deps-getmant", "false-deps-lzcnt-tzcnt", "false-deps-mulc", "false-deps-mullq", "false-deps-perm",
    "false-deps-popcnt", "false-deps-range", "fast-11bytenop", "fast-15bytenop", "fast-7bytenop", "fast-bextr",
    "fast-dpwssd", "fast-gather", "fast-hops", "fast-imm16", "fast-lzcnt", "fast-movbe", "fast-scalar-fsqrt",
    "fast-scalar-shift-masks", "fast-shld-rotate", "fast-variable-crosslane-shuffle",
    "fast-variable-perlane-shuffle", "fast-vector-fsqrt", "fast-vector-shift-masks", "faster-shift-than-shuffle",
    "fma", "fma4", "fsgsbase", "fsrm", "fxsr", "gfni", "harden-sls-ijmp", "harden-sls-ret", "hreset",
    "idivl-to-divb", "idivq-to-divl", "inline-asm-use-gpr32", "invpcid", "kl", "lea-sp", "lea-uses-ag", "lvi-cfi",
    "lvi-load-hardening", "lwp", "lzcnt", "macrofusion", "mmx", "movbe", "movdir64b", "movdiri", "movrs", "mwaitx",
    "ndd", "nf", "no-bypass-delay", "no-bypass-delay-blend", "no-bypass-delay-mov", "no-bypass-delay-shuffle",
    "nopl", "pad-short-functions", "pclmul", "pconfig", "pku", "popcnt", "ppx", "prefer-128-bit", "prefer-256-bit",
    "prefer-legacy-setcc", "prefer-mask-registers", "prefer-movmsk-over-vtest", "prefer-no-gather",
    "prefer-no-scatter", "prefetchi", "prfchw", "ptwrite", "push2pop2", "raoint", "rdpid", "rdpru", "rdrnd",
    "rdseed", "retpoline", "retpoline-external-thunk", "retpoline-indirect-branches", "retpoline-indirect-calls",
    "rtm", "sahf", "sbb-dep-breaking", "serialize", "seses", "sgx", "sha", "sha512", "shstk", "slow-3ops-lea",
    "slow-incdec", "slow-lea", "slow-pmaddwd", "slow-pmulld", "slow-pmullq", "slow-shld", "slow-two-mem-ops",
    "slow-unaligned-mem-16", "slow-unaligned-mem-32", "sm3", "sm4", "soft-float", "sse", "sse-unaligned-mem",
    "sse2", "sse3", "sse4.1", "sse4.2", "sse4a", "ssse3", "tagged-globals", "tbm", "tsxldtrk",
    "tuning-fast-imm-vector-shift", "uintr", "use-glm-div-sqrt-costs", "use-slm-arith-costs", "usermsr", "vaes",
    "vpclmulqdq", "vzeroupper", "waitpkg", "wbnoinvd", "widekl", "x32", "x87", "xop", "xsave", "xsavec", "xsaveopt",
    "xsaves", "zu",
]);

/**
 * The feature bits of the default x86_64 CPU (`x86-64`, LLVM 22) under x86_64-linux-gnu, probed as
 * `DEFAULT_FEATURE_BITS` is; closed under implication for the same reason.
 */
const X86_64_DEFAULT_FEATURE_BITS: ReadonlySet<string> = new Set([
    "64bit", "64bit-mode", "cmov", "cx16", "cx8", "fxsr", "idivq-to-divl", "macrofusion", "mmx", "nopl",
    "slow-3ops-lea", "slow-incdec", "sse", "sse2", "vzeroupper", "x87",
]);

/**
 * `MCSubtargetInfo::ApplyFeatureFlag` (llvm/lib/MC/MCSubtargetInfo.cpp) over the folded model:
 * returns the feature bits after applying `flag` (`+name` or `-name`) to `bits`, which it does not
 * modify, against the backend's table of names `features`. An unrecognised name leaves the bits
 * unchanged and prints LLVM's warning to stderr, as ldc2 does
 * (`'-sse2' is not a recognized feature for this target (ignoring feature)`).
 *
 * LLVM also sets (on `+`) the features the named one implies and clears (on `-`) the features that
 * imply it. The model has no implication graph and needs none for the only question asked of it:
 * `bits` is implication-closed, so `+name` leaves it unchanged exactly when `name` is in it, and
 * `-name` changes it exactly when `name` is in it — the answers the full graph gives.
 */
function applyFeatureFlag(features: ReadonlySet<string>, bits: ReadonlySet<string>, flag: DString): Set<string> {
    const result = new Set(bits);
    const feature = flag.subarray(1); // `SubtargetFeatures::StripFlag`: the caller always prefixes a flag
    // WHY bytes, not `dsToJs`: LLVM's `Find` compares the StringRef's bytes. One char code per byte
    // keeps the key injective over bytes and equal to the (ASCII) table name exactly when the bytes
    // are; a UTF-8 decode drops a leading BOM, so "\uFEFFneon" would find "neon" (ldc2 warns, false).
    let name = "";
    for (let i = 0; i < feature.length; i++)
        name += String.fromCharCode(feature[i]);
    if (!features.has(name)) {
        // `errs() << "'" << Feature << "' is not a recognized feature for this target" << " (ignoring feature)\n"`.
        // raw_ostream writes the StringRef whole, so the bytes go out as they are: no printf `%.*s`
        // (it stops at an embedded NUL) and no UTF-8 decode (10 §4.4's `dsToJs` drops a BOM and turns
        // invalid bytes into U+FFFD). One write, as 10 §4.4 asks.
        const tail = ds("' is not a recognized feature for this target (ignoring feature)\n");
        process.stderr.write(dsConcat(ds("'"), flag, tail));
        return result;
    }
    if (flag[0] === 0x2B) // '+'
        result.add(name);
    else
        result.delete(name);
    return result;
}

function featureBitsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size)
        return false;
    for (const f of a)
        if (!b.has(f))
            return false;
    return true;
}

/**
 * gen/ldctraits.d:29 (declaration), gen/ldctraits.cpp:20 (body) — whether the target machine has
 * `feature` enabled (together with every feature it implies). Unknown names answer false, after
 * LLVM's stderr warning.
 */
function traitsTargetHasFeature(feature: DString): boolean {
    const feat = feature;

    // This is a work-around to a missing interface in LLVM to query whether a
    // feature is set.

    // Copy MCSubtargetInfo so we can modify it.
    // resolved: `#if LLVM_VERSION_MAJOR >= 23` (ldctraits.cpp:27) -> false (LLVM 22.1.8): the copy is of
    // `*gTargetMachine->getMCSubtargetInfo()`, whose feature bits are the folded default set.
    const isX86_64 = targetTriple().arch === "x86_64";
    const features = isX86_64 ? X86_FEATURES : AARCH64_FEATURES;   // the backend's feature table
    const savedFeatbits = isX86_64 ? X86_64_DEFAULT_FEATURE_BITS : DEFAULT_FEATURE_BITS;

    // Nothing will change if the feature string is not recognized or if the
    // feature is disabled.
    {
        const newFeatbits = applyFeatureFlag(features, savedFeatbits, dsConcat(ds("-"), feat));
        if (featureBitsEqual(savedFeatbits, newFeatbits)) {
            return false;
        }
        // `mcinfo.setFeatureBits(savedFeatbits);` — the model never mutates `savedFeatbits`.
    }
    {
        // Now that unrecognized feature strings are excluded,
        // nothing will change iff the feature and its implied features are enabled.
        const newFeatbits = applyFeatureFlag(features, savedFeatbits, dsConcat(ds("+"), feat));
        return featureBitsEqual(savedFeatbits, newFeatbits);
    }
}

/**
 * gen/ldctraits.d:31 — LDC's own `__traits`: `targetCPU` and `targetHasFeature`.
 *
 * Returns the analysed result for those two, or `null` for any other trait (the caller,
 * `semanticTraits` via `semanticTraitsHook`, carries on). Diagnostics are ldc2's verbatim.
 */
export function semanticTraitsLDC(e: TraitsExp, sc: Scope): Expression | null {
    const arg_count: number = e.args !== null ? e.args.length : 0;

    if (e.ident === Id.targetCPU) {
        if (arg_count !== 0) {
            warning(e.loc, ds("ignoring arguments for __traits %s"), e.ident!.toChars());
        }

        const cpu = traitsGetTargetCPU();
        const se = new StringExp(e.loc, [...cpu]); // `cpu.ptr[0 .. cpu.length]`
        return expressionSemantic(se, sc);
    }
    if (e.ident === Id.targetHasFeature) {
        if (arg_count !== 1) {
            error(e.loc, ds("__traits %s expects one argument, not %u"), e.ident!.toChars(), arg_count);
            return ErrorExp.get();
        }

        let ex = isExpression(e.args!.opIndex(0));
        if (ex === null) {
            error(e.loc, ds("expression expected as argument of __traits %s"), e.ident!.toChars());
            return ErrorExp.get();
        }
        ex = ctfeInterpret(ex);

        let se = toStringExp(ex);
        if (se === null || se.len === 0) {
            error(e.loc,
                ds("string expected as argument of __traits %s instead of %s"),
                e.ident!.toChars(), ex.toChars());
            return ErrorExp.get();
        }

        se = toUTF8(se, sc);
        const str = se.peekString();
        const featureFound = traitsTargetHasFeature(str); // `Dstring(str.length, str.ptr)`: see header
        return new IntegerExp(e.loc, featureFound ? 1n : 0n, Type.tbool);
    }
    return null;
}
