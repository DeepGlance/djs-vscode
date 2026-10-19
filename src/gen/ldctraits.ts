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
// * THE TARGET MACHINE. Both C++ bodies query `gTargetMachine` (gen/irstate.h:44), which `cppmain` creates from the
//   triple, the CPU and the feature string (driver/main.cpp:1229, driver/targetmachine.cpp:441). The part of it they
//   observe is its subtarget: the CPU name and the feature bits of its `MCSubtargetInfo`. `createTargetMachine` below
//   ports what decides those two (targetmachine.cpp's default CPU and `+cx16`, LLVM's CPU lookup and feature flags,
//   with their stderr warnings) over tables of the LLVM data they depend on (LLVM 22.1.8, the one ldc2 1.43.0 is
//   built with), all probed on ldc2:
//   - every feature name each backend recognises: the "Available features" list of `ldc2 [-mtriple=<t>] -mattr=help`
//     (349 AArch64 names, 198 X86 names);
//   - per modelled CPU, the names `__traits(targetHasFeature)` answers true for under `ldmd2 -mcpu=<cpu>`, every
//     name of the arch probed; on AArch64 the same under arm64-apple-darwin and aarch64-linux-gnu. LLVM builds
//     these bits with every implied feature added, so each table is closed under implication;
//   - the bits of a CPU name the backend does not recognise, and the closure of each feature the driver can set.
//   A CPU name outside the tables is refused by the driver (src/djs.ts), never guessed: LLVM recognises names its
//   `-mcpu=help` list omits (`apple-latest` on AArch64), so an unlisted name cannot be told unrecognised without a
//   probe. Without `createTargetMachine` (a test harness) the subtarget is the triple's default.
//   The C++ two-step test of `traitsTargetHasFeature` is kept over that model; see `applyFeatureFlag` for what of
//   LLVM's `ApplyFeatureFlag` the model keeps.

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
import type { Triple } from "../dmd/target.js";
import { assert } from "../assert.js";

import type { Scope } from "../dmd/dscope.js";

// dropped: `extern(C++) struct Dstring` (ldctraits.d:22-26) — the C ABI slice carrier; see header.

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
 * The feature bits of each modelled AArch64 CPU (LLVM 22), probed as the header says: `generic`, the default; the
 * Apple silicon Macs, `apple-m2` being the one `-mcpu=native` resolves to on the probing host; the Arm cores of the
 * Raspberry Pi 3 and Zero 2 W (cortex-a53), 4 (cortex-a72) and 5 (cortex-a76), and of the Jetson Orin (cortex-a78ae).
 */
const AARCH64_CPUS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["generic", new Set([
        "enable-select-opt", "ete", "fp-armv8", "fuse-adrp-add", "fuse-aes", "neon", "trbe", "use-postra-scheduler",
    ])],
    ["apple-m1", new Set([
        "CONTEXTIDREL2", "aes", "aggressive-fma", "alternate-sextload-cvt-f32-pattern", "altnzcv", "am", "apple-a14",
        "arith-bcc-fusion", "arith-cbz-fusion", "ccdp", "ccpp", "complxnum", "crc", "disable-latency-sched-heuristic",
        "dit", "dotprod", "el2vmsa", "el3", "flagm", "fp-armv8", "fp16fml", "fptoint", "fullfp16", "fuse-address",
        "fuse-aes", "fuse-arith-logic", "fuse-crypto-eor", "fuse-csel", "fuse-literals", "jsconv", "lor", "lse",
        "lse2", "max-interleave-factor-4", "mpam", "neon", "no-zcz-fpr64", "nv", "pan", "pan-rwv", "pauth", "perfmon",
        "predres", "ras", "rcpc", "rcpc-immo", "rdm", "sb", "sel2", "sha2", "sha3", "specrestrict", "ssbs",
        "store-pair-suppress", "tlb-rmi", "tracev8.4", "uaops", "v8.1a", "v8.2a", "v8.3a", "v8.4a", "v8a", "vh",
        "zcm-fpr128", "zcm-gpr64", "zcz-fpr128", "zcz-gpr32", "zcz-gpr64",
    ])],
    ["apple-m2", new Set([
        "CONTEXTIDREL2", "aes", "alternate-sextload-cvt-f32-pattern", "altnzcv", "am", "amvs", "apple-a15",
        "arith-bcc-fusion", "arith-cbz-fusion", "bf16", "bti", "ccdp", "ccpp", "complxnum", "crc",
        "disable-latency-sched-heuristic", "dit", "dotprod", "ecv", "el2vmsa", "el3", "fgt", "flagm", "fp-armv8",
        "fp16fml", "fpac", "fptoint", "fullfp16", "fuse-address", "fuse-adrp-add", "fuse-aes", "fuse-arith-logic",
        "fuse-crypto-eor", "fuse-csel", "fuse-literals", "i8mm", "jsconv", "lor", "lse", "lse2",
        "max-interleave-factor-4", "mpam", "neon", "no-zcz-fpr64", "nv", "pan", "pan-rwv", "pauth", "perfmon",
        "predres", "ras", "rcpc", "rcpc-immo", "rdm", "sb", "sel2", "sha2", "sha3", "specrestrict", "ssbs",
        "store-pair-suppress", "tlb-rmi", "tracev8.4", "uaops", "v8.1a", "v8.2a", "v8.3a", "v8.4a", "v8.5a", "v8.6a",
        "v8a", "vh", "zcm-fpr128", "zcm-gpr64", "zcz-fpr128", "zcz-gpr32", "zcz-gpr64",
    ])],
    ["apple-m3", new Set([
        "CONTEXTIDREL2", "aes", "alternate-sextload-cvt-f32-pattern", "altnzcv", "am", "amvs", "apple-a16",
        "arith-bcc-fusion", "arith-cbz-fusion", "bf16", "bti", "ccdp", "ccpp", "complxnum", "crc",
        "disable-latency-sched-heuristic", "dit", "dotprod", "ecv", "el2vmsa", "el3", "fgt", "flagm", "fp-armv8",
        "fp16fml", "fpac", "fptoint", "fullfp16", "fuse-address", "fuse-adrp-add", "fuse-aes", "fuse-arith-logic",
        "fuse-crypto-eor", "fuse-csel", "fuse-literals", "hcx", "i8mm", "jsconv", "lor", "lse", "lse2",
        "max-interleave-factor-4", "mpam", "neon", "no-zcz-fpr64", "nv", "pan", "pan-rwv", "pauth", "perfmon",
        "predres", "ras", "rcpc", "rcpc-immo", "rdm", "sb", "sel2", "sha2", "sha3", "specrestrict", "ssbs",
        "store-pair-suppress", "tlb-rmi", "tracev8.4", "uaops", "v8.1a", "v8.2a", "v8.3a", "v8.4a", "v8.5a", "v8.6a",
        "v8a", "vh", "zcm-fpr128", "zcm-gpr64", "zcz-fpr128", "zcz-gpr32", "zcz-gpr64",
    ])],
    ["apple-m4", new Set([
        "CONTEXTIDREL2", "aes", "alternate-sextload-cvt-f32-pattern", "altnzcv", "am", "amvs", "apple-m4",
        "arith-bcc-fusion", "arith-cbz-fusion", "bf16", "bti", "ccdp", "ccpp", "complxnum", "crc",
        "disable-latency-sched-heuristic", "dit", "dotprod", "ecv", "el2vmsa", "el3", "fgt", "flagm", "fp-armv8",
        "fp16fml", "fpac", "fptoint", "fullfp16", "fuse-address", "fuse-adrp-add", "fuse-aes", "fuse-arith-logic",
        "fuse-crypto-eor", "fuse-csel", "fuse-literals", "hcx", "i8mm", "jsconv", "lor", "lse", "lse2",
        "max-interleave-factor-4", "mpam", "neon", "no-zcz-fpr64", "nv", "pan", "pan-rwv", "pauth", "perfmon",
        "predres", "ras", "rcpc", "rcpc-immo", "rdm", "sb", "sel2", "sha2", "sha3", "sme", "sme-f64f64", "sme-i16i64",
        "sme2", "specrestrict", "tlb-rmi", "tracev8.4", "uaops", "v8.1a", "v8.2a", "v8.3a", "v8.4a", "v8.5a", "v8.6a",
        "v8.7a", "v8a", "vh", "wfxt", "xs", "zcm-fpr128", "zcm-gpr64", "zcz-fpr128", "zcz-gpr32", "zcz-gpr64",
    ])],
    ["apple-m5", new Set([
        "CONTEXTIDREL2", "aes", "alternate-sextload-cvt-f32-pattern", "altnzcv", "am", "amvs", "apple-m5",
        "arith-bcc-fusion", "arith-cbz-fusion", "bf16", "bti", "ccdp", "ccpp", "complxnum", "crc", "cssc",
        "disable-latency-sched-heuristic", "dit", "dotprod", "ecv", "el2vmsa", "el3", "fgt", "flagm", "fp-armv8",
        "fp16fml", "fpac", "fptoint", "fullfp16", "fuse-address", "fuse-adrp-add", "fuse-aes", "fuse-arith-logic",
        "fuse-crypto-eor", "fuse-csel", "fuse-literals", "hbc", "hcx", "i8mm", "jsconv", "lor", "lse", "lse2",
        "max-interleave-factor-4", "mpam", "mte", "neon", "no-zcz-fpr64", "nv", "pan", "pan-rwv", "pauth", "perfmon",
        "predres", "ras", "rcpc", "rcpc-immo", "rdm", "sb", "sel2", "sha2", "sha3", "sme", "sme-b16b16", "sme-f16f16",
        "sme-f64f64", "sme-i16i64", "sme2", "sme2p1", "specres2", "specrestrict", "sve-b16b16", "tlb-rmi", "tracev8.4",
        "uaops", "v8.1a", "v8.2a", "v8.3a", "v8.4a", "v8.5a", "v8.6a", "v8.7a", "v8a", "vh", "wfxt", "xs",
        "zcm-fpr128", "zcm-gpr64", "zcz-fpr128", "zcz-gpr32", "zcz-gpr64",
    ])],
    ["cortex-a53", new Set([
        "a53", "aes", "balance-fp-ops", "crc", "el2vmsa", "el3", "fp-armv8", "fuse-adrp-add", "fuse-aes", "neon",
        "perfmon", "sha2", "use-postra-scheduler", "use-wzr-to-vec-move", "v8a",
    ])],
    ["cortex-a72", new Set([
        "a72", "addr-lsl-slow-14", "aes", "crc", "el2vmsa", "el3", "enable-select-opt", "fp-armv8", "fuse-adrp-add",
        "fuse-aes", "fuse-literals", "neon", "perfmon", "predictable-select-expensive", "sha2", "v8a",
    ])],
    ["cortex-a76", new Set([
        "CONTEXTIDREL2", "a76", "addr-lsl-slow-14", "aes", "alu-lsl-fast", "ccpp", "crc", "dotprod", "el2vmsa", "el3",
        "enable-select-opt", "fp-armv8", "fullfp16", "fuse-adrp-add", "fuse-aes", "lor", "lse", "neon", "pan",
        "pan-rwv", "perfmon", "predictable-select-expensive", "ras", "rcpc", "rdm", "sha2", "ssbs", "uaops", "v8.1a",
        "v8.2a", "v8a", "vh",
    ])],
    ["cortex-a78ae", new Set([
        "CONTEXTIDREL2", "a78ae", "addr-lsl-slow-14", "aes", "alu-lsl-fast", "ccpp", "cmp-bcc-fusion", "crc",
        "dotprod", "el2vmsa", "el3", "enable-select-opt", "fp-armv8", "fullfp16", "fuse-adrp-add", "fuse-aes",
        "fuse-csel", "fuse-cset", "lor", "lse", "neon", "pan", "pan-rwv", "perfmon", "predictable-select-expensive",
        "ras", "rcpc", "rdm", "sha2", "spe", "ssbs", "uaops", "use-postra-scheduler", "v8.1a", "v8.2a", "v8a", "vh",
    ])],
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
 * The feature bits of each modelled X86 CPU (LLVM 22) under x86_64-linux-gnu, probed as the header says: `x86-64`,
 * the default, and the x86-64 psABI levels v2, v3 and v4. `x86-64` is LLVM's own bits, probed with
 * `-mattr=-cx16`: without it the driver adds `+cx16` (`createTargetMachine`).
 */
const X86_CPUS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["x86-64", new Set([
        "64bit", "64bit-mode", "cmov", "cx8", "fxsr", "idivq-to-divl", "macrofusion", "mmx", "nopl", "slow-3ops-lea",
        "slow-incdec", "sse", "sse2", "vzeroupper", "x87",
    ])],
    ["x86-64-v2", new Set([
        "64bit", "64bit-mode", "cmov", "crc32", "cx16", "cx8", "false-deps-popcnt", "fast-15bytenop",
        "fast-scalar-fsqrt", "fast-shld-rotate", "fxsr", "idivq-to-divl", "macrofusion", "mmx", "nopl", "popcnt",
        "sahf", "slow-3ops-lea", "slow-unaligned-mem-32", "sse", "sse2", "sse3", "sse4.1", "sse4.2", "ssse3",
        "vzeroupper", "x87",
    ])],
    ["x86-64-v3", new Set([
        "64bit", "64bit-mode", "allow-light-256-bit", "avx", "avx2", "bmi", "bmi2", "cmov", "crc32", "cx16", "cx8",
        "f16c", "false-deps-lzcnt-tzcnt", "false-deps-popcnt", "fast-15bytenop", "fast-scalar-fsqrt",
        "fast-shld-rotate", "fast-variable-crosslane-shuffle", "fast-variable-perlane-shuffle", "fma", "fxsr",
        "idivq-to-divl", "lzcnt", "macrofusion", "mmx", "movbe", "nopl", "popcnt", "sahf", "slow-3ops-lea", "sse",
        "sse2", "sse3", "sse4.1", "sse4.2", "ssse3", "vzeroupper", "x87", "xsave",
    ])],
    ["x86-64-v4", new Set([
        "64bit", "64bit-mode", "allow-light-256-bit", "avx", "avx2", "avx512bw", "avx512cd", "avx512dq", "avx512f",
        "avx512vl", "bmi", "bmi2", "cmov", "crc32", "cx16", "cx8", "f16c", "false-deps-popcnt", "fast-15bytenop",
        "fast-gather", "fast-scalar-fsqrt", "fast-shld-rotate", "fast-variable-crosslane-shuffle",
        "fast-variable-perlane-shuffle", "fast-vector-fsqrt", "fma", "fxsr", "idivq-to-divl", "lzcnt", "macrofusion",
        "mmx", "movbe", "nopl", "popcnt", "prefer-256-bit", "sahf", "slow-3ops-lea", "sse", "sse2", "sse3", "sse4.1",
        "sse4.2", "ssse3", "vzeroupper", "x87", "xsave",
    ])],
]);

/**
 * The feature bits LLVM gives a CPU name the backend does not recognise, probed with `-mcpu=<name>` (`foo`, `haswell`
 * and the X86 names below on AArch64; `foo` and the AArch64 names below on X86): none on AArch64, three on X86.
 */
const AARCH64_UNRECOGNISED_CPU: ReadonlySet<string> = new Set();
const X86_UNRECOGNISED_CPU: ReadonlySet<string> = new Set(["64bit-mode", "sse", "sse2"]);

/**
 * The implication closure of each feature the driver can set on X86 (ldmd2's `-mcpu=avx` and `-mcpu=avx2` as
 * `-mattr=+avx[2]`, ldmd.cpp:625-628; LDC's `+cx16`, targetmachine.cpp:526), probed as the bits each adds to
 * `X86_UNRECOGNISED_CPU` and to every table of `X86_CPUS` (`ldmd2 -mcpu=<cpu> -mcpu=avx[2]`, `ldc2 -mcpu=foo
 * -mattr=+cx16`). `sse` and `sse2`, which LLVM's `avx` also implies, are in every X86 table here, so the probes cannot
 * show them and the model needs neither.
 */
const X86_IMPLIED: ReadonlyMap<string, readonly string[]> = new Map([
    ["avx", ["avx", "sse4.2", "sse4.1", "ssse3", "sse3"]],
    ["avx2", ["avx2", "avx", "sse4.2", "sse4.1", "ssse3", "sse3"]],
    ["cx16", ["cx16", "cx8"]],
]);
const AARCH64_IMPLIED: ReadonlyMap<string, readonly string[]> = new Map();

/** One backend of the model: its feature names, its CPU tables, and what an unrecognised CPU name gets. */
interface Backend {
    readonly features: ReadonlySet<string>;
    readonly cpus: ReadonlyMap<string, ReadonlySet<string>>;
    readonly unrecognisedCpu: ReadonlySet<string>;
    /** CPU names probed unrecognised by this backend: the other backend's modelled CPUs but `generic`. */
    readonly notCpus: ReadonlySet<string>;
    readonly implied: ReadonlyMap<string, readonly string[]>;
}

const AARCH64: Backend = {
    features: AARCH64_FEATURES, cpus: AARCH64_CPUS, unrecognisedCpu: AARCH64_UNRECOGNISED_CPU,
    notCpus: new Set([...X86_CPUS.keys()]), implied: AARCH64_IMPLIED,
};
const X86: Backend = {
    features: X86_FEATURES, cpus: X86_CPUS, unrecognisedCpu: X86_UNRECOGNISED_CPU,
    notCpus: new Set([...AARCH64_CPUS.keys()].filter((c) => c !== "generic")), implied: X86_IMPLIED,
};

function backendOf(triple: Triple): Backend {
    return triple.arch === "x86_64" ? X86 : AARCH64;
}

/** targetmachine.cpp:269 `getTargetCPU` over the modelled triples (:190 `getX86TargetCPU`, :248). */
function getTargetCPU(triple: Triple): string {
    return triple.arch === "x86_64" ? "x86-64" : "generic";
}

/**
 * Whether the model covers `-mcpu=<cpu>` on `triple` (`cpu` is `codegen::getCPUStr()`, `native` already resolved):
 * the empty string and `generic` (the triple's default CPU), a CPU of the backend's table, or a name probed
 * unrecognised by it. The driver refuses any other name.
 */
export function isModelledCPU(triple: Triple, cpu: string): boolean {
    const b = backendOf(triple);
    return cpu === "" || cpu === "generic" || b.cpus.has(cpu) || b.notCpus.has(cpu);
}

/** The subtarget of a target machine: its CPU name and its feature bits, as names, closed under implication. */
interface Subtarget {
    readonly cpu: string;
    readonly bits: ReadonlySet<string>;
}

/** gen/irstate.h:44 `gTargetMachine`, the part the traits read; null until a driver calls `createTargetMachine`. */
let gTargetMachine: Subtarget | null = null;

/**
 * The subtarget the traits query: the driver's, or without one (a test harness) the triple's default, which prints
 * no warning.
 */
function subtarget(): Subtarget {
    return gTargetMachine ?? buildSubtarget(targetTriple(), "", []);
}

/**
 * driver/targetmachine.cpp:441 `createTargetMachine`, the part that decides the subtarget the frontend observes, with
 * the `MCSubtargetInfo` LLVM's `createTargetMachine` builds from it (llvm/lib/MC/MCSubtargetInfo.cpp `getFeatures`).
 * `cpu` is `opts::getCPUStr()` and `features` the flags of `opts::getFeaturesStr()` (`+<name>`), in order; the
 * triple is `targetTriple()`. Sets the subtarget every later trait reads, until the next call.
 *
 * Precondition: `isModelledCPU(targetTriple(), cpu)`, which the driver checks while parsing the command line, and
 * every flag a `+` one whose name the backend either does not recognise or has a closure in its `implied` table (the
 * driver sets only `+avx` and `+avx2`).
 * Prints LLVM's warnings to stderr as ldc2 does, before the frontend runs: for a CPU name the backend does not
 * recognise, `'<cpu>' is not a recognized processor for this target (ignoring processor)`, then one
 * `'<flag>' is not a recognized feature for this target (ignoring feature)` per unrecognised feature in order, then
 * the CPU line again (ldc2 1.43.0: `ldmd2 -mcpu=foo -mcpu=avx -mcpu=avx2` on arm64-apple-darwin).
 */
export function createTargetMachine(cpu: string, features: readonly string[]): void {
    gTargetMachine = buildSubtarget(targetTriple(), cpu, features);
}

/** `createTargetMachine`'s body for `triple`: returns the subtarget instead of setting it. */
function buildSubtarget(triple: Triple, cpu: string, features: readonly string[]): Subtarget {
    const backend = backendOf(triple);
    assert(isModelledCPU(triple, cpu), `createTargetMachine: -mcpu=${cpu} is outside the model`);

    // With an empty CPU string, LLVM will default to the host CPU, which is
    // usually not what we want (expected behavior from other compilers is
    // to default to "generic").
    if (cpu === "" || cpu === "generic") {
        cpu = getTargetCPU(triple);   // never empty on the modelled triples
    }

    // Package up features to be passed to target/subtarget.
    // `getDefaultSubtargetFeatures(triple)` (:509) adds none for the modelled triples: no probe shows one.
    const flags = [...features];

    // cmpxchg16b is not available on old 64bit CPUs. Enable code generation
    // if the user did not make an explicit choice.
    // (the arch is not checked: `-mcpu=x86-64` on AArch64 warns about `+cx16`, probed)
    if (cpu === "x86-64" && !flags.some((f) => f.slice(1) === "cx16")) {
        flags.push("+cx16");
    }
    // :530-545 RISC-V and LoongArch; :556-593 relocation model and float ABI: nothing the frontend reads here.

    // MCSubtargetInfo.cpp `getFeatures`: the CPU's implied bits, or a warning; the feature flags in order. An
    // unrecognised CPU is warned about once more after the flags (probed; the C++ is not in this tree).
    const recognised = backend.cpus.has(cpu);
    const cpuWarning = dsConcat(ds("'"), ds(cpu), ds("' is not a recognized processor for this target"),
        ds(" (ignoring processor)\n"));
    if (!recognised)
        process.stderr.write(cpuWarning);
    let bits: ReadonlySet<string> = recognised ? backend.cpus.get(cpu)! : backend.unrecognisedCpu;
    for (const f of flags) {
        assert(f[0] === "+" && (!backend.features.has(f.slice(1)) || backend.implied.has(f.slice(1))),
            `createTargetMachine: ${f} has no closure in the model`);
        bits = applyFeatureFlag(backend, bits, ds(f));
    }
    if (!recognised)
        process.stderr.write(cpuWarning);
    return { cpu, bits };
}

/**
 * `MCSubtargetInfo::ApplyFeatureFlag` (llvm/lib/MC/MCSubtargetInfo.cpp) over the folded model:
 * returns the feature bits after applying `flag` (`+name` or `-name`) to `bits`, which it does not
 * modify, against `backend`'s table of names. An unrecognised name leaves the bits
 * unchanged and prints LLVM's warning to stderr, as ldc2 does
 * (`'-sse2' is not a recognized feature for this target (ignoring feature)`).
 *
 * LLVM also sets (on `+`) the features the named one implies and clears (on `-`) the features that
 * imply it. The model sets the closure of the features in `backend.implied` (the ones the driver sets) and
 * the name alone for any other, and clears the name alone. That is enough for the trait's question:
 * `bits` is implication-closed, so `+name` leaves it unchanged exactly when `name` is in it, and
 * `-name` changes it exactly when `name` is in it — the answers the full graph gives.
 */
function applyFeatureFlag(backend: Backend, bits: ReadonlySet<string>, flag: DString): Set<string> {
    const result = new Set(bits);
    const feature = flag.subarray(1); // `SubtargetFeatures::StripFlag`: the caller always prefixes a flag
    // WHY bytes, not `dsToJs`: LLVM's `Find` compares the StringRef's bytes. One char code per byte
    // keeps the key injective over bytes and equal to the (ASCII) table name exactly when the bytes
    // are; a UTF-8 decode drops a leading BOM, so "\uFEFFneon" would find "neon" (ldc2 warns, false).
    let name = "";
    for (let i = 0; i < feature.length; i++)
        name += String.fromCharCode(feature[i]);
    if (!backend.features.has(name)) {
        // `errs() << "'" << Feature << "' is not a recognized feature for this target" << " (ignoring feature)\n"`.
        // raw_ostream writes the StringRef whole, so the bytes go out as they are: no printf `%.*s`
        // (it stops at an embedded NUL) and no UTF-8 decode (10 §4.4's `dsToJs` drops a BOM and turns
        // invalid bytes into U+FFFD). One write, as 10 §4.4 asks.
        const tail = ds("' is not a recognized feature for this target (ignoring feature)\n");
        process.stderr.write(dsConcat(ds("'"), flag, tail));
        return result;
    }
    if (flag[0] === 0x2B) { // '+'
        for (const f of backend.implied.get(name) ?? [name])
            result.add(f);
    } else {
        result.delete(name);
    }
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
 * gen/ldctraits.d:28 (declaration), gen/ldctraits.cpp:15 (body) — the target machine's CPU name: the `-mcpu` one
 * as given (`native` resolved), an unrecognised one included, or the triple's default (`createTargetMachine`).
 */
function traitsGetTargetCPU(): DString {
    return ds(subtarget().cpu);
}

/**
 * gen/ldctraits.d:29 (declaration), gen/ldctraits.cpp:20 (body) — whether the target machine has
 * `feature` enabled (together with every feature it implies). Unknown names answer false, after
 * LLVM's stderr warning. Also called by the driver for `D_AVX`/`D_AVX2` (driver/main.cpp:805-808).
 */
export function traitsTargetHasFeature(feature: DString): boolean {
    const feat = feature;

    // This is a work-around to a missing interface in LLVM to query whether a
    // feature is set.

    // Copy MCSubtargetInfo so we can modify it.
    // resolved: `#if LLVM_VERSION_MAJOR >= 23` (ldctraits.cpp:27) -> false (LLVM 22.1.8): the copy is of
    // `*gTargetMachine->getMCSubtargetInfo()`, whose feature bits are the subtarget's.
    const backend = backendOf(targetTriple());
    const savedFeatbits = subtarget().bits;

    // Nothing will change if the feature string is not recognized or if the
    // feature is disabled.
    {
        const newFeatbits = applyFeatureFlag(backend, savedFeatbits, dsConcat(ds("-"), feat));
        if (featureBitsEqual(savedFeatbits, newFeatbits)) {
            return false;
        }
        // `mcinfo.setFeatureBits(savedFeatbits);` — the model never mutates `savedFeatbits`.
    }
    {
        // Now that unrecognized feature strings are excluded,
        // nothing will change iff the feature and its implied features are enabled.
        const newFeatbits = applyFeatureFlag(backend, savedFeatbits, dsConcat(ds("+"), feat));
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
