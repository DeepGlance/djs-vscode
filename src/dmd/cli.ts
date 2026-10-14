// Ported from dmd/cli.d (module dmd.cli).
//
// Defines the help texts for the CLI options offered by DMD. Self-contained option-spec /
// feature-spec data tables with no dmd.* dependencies (translation-order.md Bucket 0).
//
// ===========================================================================================
// IN_LLVM RESOLUTION — this is the dominant structural fact of this file.
// ===========================================================================================
// The bulk of dmd/cli.d is wrapped in `version (IN_LLVM) {} else { ... }` blocks. Our target
// is LDC, so `IN_LLVM` resolves ON (_config.md §1, 07-compile-time.md §1.2): the IN_LLVM
// branch is the EMPTY `{}` and every `else` branch is DEAD CODE — DROPPED. The blocks dropped
// in full (all gated `version (IN_LLVM) {} else`):
//   - dropped: enum `TargetOS`, `targetOS`, `isCurrentTargetOS` (cli.d:17-90) — !IN_LLVM only.
//   - dropped: `Usage.Option` struct + `Usage.options` table (cli.d:122-995) — !IN_LLVM only.
//   - dropped: `CLIUsage.usage()` + `CLIUsage.mcpuUsage` (cli.d:1091-1141) — !IN_LLVM only.
//   - dropped: `CLIUsage.checkActionUsage/checkUsage/externStdUsage/hcUsage/gdwarfUsage`
//     (cli.d:1179-1230) — !IN_LLVM only.
// What SURVIVES (NOT version-guarded): `capitalize`, `Usage.Feature` + the `transitions` /
// `reverts` / `previews` feature tables, and `CLIUsage.generateFeatureUsage` +
// `transitionUsage` / `revertUsage` / `previewUsage`. That surviving subset is this module.
//
// TYPE MODEL (02-types.md §1.3, 08-runtime-lib.md §0): D `string` / `const(char)[]` is a UTF-8
// BYTE array (`DString`), NOT a JS string — same decision as the sibling Bucket-0 table module
// `imphint.ts`. So `Feature` fields, `capitalize`'s parameter/return, and the usage strings are
// all `DString`. Every literal here is ASCII, so `ds(...)` (one byte per char code) is the
// correct builder.
//
// CTFE USAGE STRINGS (07-compile-time.md §9): `transitionUsage`/`revertUsage`/`previewUsage` are
// manifest `enum`s — CTFE function calls evaluated at translation time. Rather than baking a
// hand-transcribed multi-line literal (error-prone), this port keeps `generateFeatureUsage` as
// faithful ported code and computes the three constants by RUNNING the same algorithm at module
// load (a TS `static` field initializer reproduces D's CTFE-at-build-time). The exact ldc2
// CTFE output is pinned byte-for-byte by the co-located test (cli.test.ts), so any drift in the
// algorithm is caught — this is both faithful and self-protecting.
//
// 1.42 -> 1.43.0-beta1 DRIFT FOLD: the 259-line upstream diff is almost entirely inside the
// `version (IN_LLVM) {} else { ... }` `Usage.options` block (cli.d:119-999 in 1.43) that this
// port already drops in full (see IN_LLVM RESOLUTION above) — not-applicable, no port site exists
// for that table's rewritten help strings. Two hunks fall outside that block:
//   - `capitalize` was refactored (`private`, `@trusted`, inlined the `c1`/`adjustment` locals)
//     but is behaviorally identical (same lowercase-first-byte-only contract). `private` is
//     module-scoped in D (01-conventions.md Rule 2.5) and `@trusted`/`nothrow`/module-level
//     `nothrow @safe:` erase (04-functions.md); not-applicable, no port change.
//   - `Usage.previews` gained one entry, the `fastdfa` preview Feature (applied below via the
//     existing 3-arg `Feature` ctor — no new field needed, so the port's table shape is unchanged).


import { ds, dsConcat } from "../dstring.js";
import type { DString } from "../dstring.js";

/**
 * Capitalize the first character of an ASCII string (faithful port of cli.d:98-113).
 *
 * Contract (verified with ldc2): if the first byte is a lowercase ASCII letter (`a`..`z`), a
 * FRESH buffer is returned with that byte uppercased and the rest copied; otherwise the input
 * is returned UNCHANGED (including the empty string). Only the first byte is ever touched.
 *
 * D `enum adjustment = 'A' - 'a';` is the manifest constant -32 (verified). `result[1 .. $] =
 * w[1 .. $]` copies the tail. We allocate a new `Uint8Array` only on the lowercase path,
 * mirroring D's `new char[](w.length)`.
 */
export function capitalize(w: DString): DString {
    let result: DString = w;                          // D `char[] result = cast(char[]) w;`
    const c1 = w.length ? w[0] : 0;                   // D `char c1 = w.length ? w[0] : '\0';`

    if (c1 >= 0x61 /* 'a' */ && c1 <= 0x7a /* 'z' */) {
        const adjustment = -32;                       // resolved: enum adjustment = 'A' - 'a' -> -32
        result = new Uint8Array(w.length);            // D `new char[](w.length)`
        result[0] = (c1 + adjustment) & 0xff;         // D `cast(char)(c1 + adjustment)` (09-numerics)
        result.set(w.subarray(1), 1);                 // D `result[1 .. $] = w[1 .. $];`
    }

    return result;                                    // D `cast(string) result;`
}

/**
 * Representation of a CLI feature (cli.d:998). D `struct Usage.Feature` -> a TS class (value
 * type, 02 §2). It is nested in `struct Usage` in D; the existing port models nested structs as
 * TOP-LEVEL classes (cf. `location.ts` `Loc`/`SourceLoc`/`BaseLoc`), and `Usage` re-exposes it as
 * `Usage.Feature` so the D access spelling is preserved.
 */
export class Feature {
    name: DString;          /// name of the feature
    paramName: DString;     // internal transition parameter name
    helpText: DString;      // detailed description of the feature
    link: DString;          // link for more info
    documented: boolean;    // whether this option should be shown in the documentation
    deprecated_: boolean;   /// whether the feature is still in use (D `deprecated_`)

    // D positional ctor: this(name, paramName, helpText, link = null, documented = true,
    // deprecated_ = false). `link` default is D's null slice (verified: length 0) -> empty
    // DString. Trailing-default args map 1:1 to TS optional params (04-functions.md §2).
    constructor(
        name: DString,
        paramName: DString,
        helpText: DString,
        link: DString = ds(""),
        documented = true,
        deprecated_ = false,
    ) {
        this.name = name;
        this.paramName = paramName;
        this.helpText = helpText;
        this.link = link;
        this.documented = documented;
        this.deprecated_ = deprecated_;
    }

    // Faithful struct copy() (03-value-semantics.md §2): per-field, primitives by value and
    // DString slices SHARED (D char-slice fields share their backing store on copy).
    copy(): Feature {
        return new Feature(this.name, this.paramName, this.helpText, this.link,
            this.documented, this.deprecated_);
    }
}

/**
 * Contains all available CLI options (cli.d:120). In IN_LLVM the `Option` struct and the
 * `options` table are DROPPED (see file header); only the `Feature` struct (above) and the
 * `transitions` / `reverts` / `previews` feature tables survive.
 */
export class Usage {
    // -----------------------------------------------------------------------------------------
    // dropped: `Usage.Option` struct + `Usage.options` table (cli.d:122-995) — `version
    // (IN_LLVM) {} else` !IN_LLVM-only block (DMD-driver help text, not built into LDC).
    // -----------------------------------------------------------------------------------------

    /// Re-expose the (top-level) `Feature` class as `Usage.Feature`, preserving D's spelling.
    static readonly Feature = Feature;

    /// Returns all available transitions (cli.d:1009).
    static readonly transitions: readonly Feature[] = [
        new Feature(ds("field"), ds("v.field"),
            ds("list all non-mutable fields which occupy an object instance")),
        new Feature(ds("complex"), ds("v.complex"),
            ds("give deprecation messages about all usages of complex or imaginary types"),
            ds(""), true, true),
        new Feature(ds("tls"), ds("v.tls"),
            ds("list all variables going into thread local storage")),
        new Feature(ds("in"), ds("v.vin"),
            ds("list all usages of 'in' on parameter")),
    ];

    /// Returns all available reverts (cli.d:1021).
    static readonly reverts: readonly Feature[] = [
        new Feature(ds("dip25"), ds("useDIP25"), ds("revert DIP25 changes"),
            ds("https://github.com/dlang/DIPs/blob/master/DIPs/archive/DIP25.md"), true, true),
        new Feature(ds("dip1000"), ds("useDIP1000"),
            ds("revert DIP1000 changes (Scoped Pointers)"),
            ds("https://github.com/dlang/DIPs/blob/master/DIPs/other/DIP1000.md")),
        new Feature(ds("intpromote"), ds("fix16997"),
            ds("revert integral promotions for unary + - ~ operators")),
        new Feature(ds("dtorfields"), ds("dtorFields"),
            ds("don't destruct fields of partially constructed objects")),
    ];

    /// Returns all available previews (cli.d:1032).
    // Note: generally changelog entries should be added to the spec
    static readonly previews: readonly Feature[] = [
        new Feature(ds("dip25"), ds("useDIP25"),
            ds("implement Sealed References DIP"),
            ds("https://github.com/dlang/DIPs/blob/master/DIPs/archive/DIP25.md"), true, true),
        new Feature(ds("dip1000"), ds("useDIP1000"),
            ds("implement Scoped Pointers DIP"),
            ds("https://github.com/dlang/DIPs/blob/master/DIPs/other/DIP1000.md")),
        new Feature(ds("dip1008"), ds("ehnogc"),
            ds("implement @nogc Throwable DIP"),
            ds("https://github.com/dlang/DIPs/blob/master/DIPs/other/DIP1008.md")),
        new Feature(ds("dip1021"), ds("useDIP1021"),
            ds("implement Mutable Function Arguments DIP"),
            ds("https://github.com/dlang/DIPs/blob/master/DIPs/accepted/DIP1021.md")),
        new Feature(ds("bitfields"), ds("bitfields"), ds("add C-like bitfields"),
            ds("https://github.com/dlang/dlang.org/pull/3190")),
        new Feature(ds("fieldwise"), ds("fieldwise"),
            ds("use fieldwise comparisons for struct equality"),
            ds("https://dlang.org/changelog/2.085.0.html#no-cmpsb")),
        new Feature(ds("fixAliasThis"), ds("fixAliasThis"),
            ds("when a symbol is resolved, check alias this scope before going to upper scopes"),
            ds("https://github.com/dlang/dmd/pull/8885")),
        new Feature(ds("intpromote"), ds("fix16997"),
            ds("fix integral promotions for unary + - ~ operators"),
            ds("https://dlang.org/changelog/2.078.0.html#fix16997"), false, true),
        new Feature(ds("dtorfields"), ds("dtorFields"),
            ds("destruct fields of partially constructed objects"),
            ds("https://dlang.org/changelog/2.098.0.html#dtorfileds"), false, false),
        new Feature(ds("rvaluerefparam"), ds("rvalueRefParam"),
            ds("enable rvalue arguments to ref parameters"),
            ds("https://gist.github.com/andralex/e5405a5d773f07f73196c05f8339435a")),
        new Feature(ds("safer"), ds("safer"),
            ds("more safety checks by default"),
            ds("https://github.com/WalterBright/documents/blob/38f0a846726b571f8108f6e63e5e217b91421c86/safer.md"),
            true, false),
        new Feature(ds("nosharedaccess"), ds("noSharedAccess"),
            ds("disable access to shared memory objects"),
            ds("https://dlang.org/spec/const3.html#shared")),
        new Feature(ds("in"), ds("previewIn"),
            ds("`in` on parameters means `scope const [ref]` and accepts rvalues"),
            ds("https://dlang.org/spec/function.html#in-params")),
        new Feature(ds("inclusiveincontracts"), ds("inclusiveInContracts"),
            ds("'in' contracts of overridden methods must be a superset of parent contract"),
            ds("https://dlang.org/changelog/2.095.0.html#inclusive-incontracts")),
        new Feature(ds("shortenedMethods"), ds("shortenedMethods"),
            ds("allow use of => for methods and top-level functions in addition to lambdas"),
            ds("https://dlang.org/spec/function.html#ShortenedFunctionBody"), false, true),
        new Feature(ds("fixImmutableConv"), ds("fixImmutableConv"),
            ds("disallow `void[]` data from holding immutable data"),
            ds("https://dlang.org/changelog/2.101.0.html#dmd.fix-immutable-conv, https://issues.dlang.org/show_bug.cgi?id=17148")),
        new Feature(ds("systemVariables"), ds("systemVariables"),
            ds("disable access to variables marked '@system' from @safe code"),
            ds("https://dlang.org/spec/attribute.html#system-variables")),
        new Feature(ds("fastdfa"), ds("useFastDFA"),
            ds("Fast dataflow analysis engine, experimental")),
    ];
}

/**
 * Formats the `Options` for CLI printing (cli.d:1089). In IN_LLVM, `usage()`, `mcpuUsage`,
 * and the `checkAction/check/externStd/hc/gdwarf` usage enums are DROPPED (file header);
 * only `generateFeatureUsage` and the three feature-usage constants survive.
 */
export class CLIUsage {
    // -----------------------------------------------------------------------------------------
    // dropped: `usage()` static method + `mcpuUsage` enum (cli.d:1091-1141) — `version
    // (IN_LLVM) {} else` !IN_LLVM-only block.
    // -----------------------------------------------------------------------------------------

    /**
     * Build the `-flagName=name` listing for a feature table (faithful port of cli.d:1143-1168).
     *
     * `description.capitalize` -> `capitalize(description)` (D's UFCS `.capitalize`,
     * 04-functions.md §6). The list is `[Feature("all", null, "Enables all available " ~
     * description)] ~ features` — a fresh "all" row prepended (its `link` defaults empty, its
     * `documented` defaults true, so it is always emitted with no link suffix). The
     * `foreach (i; lineLength .. maxFlagLength)` pads to column `maxFlagLength` (20); when
     * `lineLength >= maxFlagLength` (long names like `inclusiveincontracts`) the range is empty
     * and only the single separating space appears (verified with ldc2).
     */
    static generateFeatureUsage(features: readonly Feature[], flagName: DString,
                                description: DString): DString {
        const maxFlagLength = 20;
        // D: `description.capitalize ~ " listed by -" ~ flagName ~ "=name:\n"`
        let buf: DString = dsConcat(capitalize(description), ds(" listed by -"), flagName,
            ds("=name:\n"));
        // D: `[Usage.Feature("all", null, "Enables all available " ~ description)] ~ features`
        const allTransitions: Feature[] = [
            new Feature(ds("all"), ds(""), dsConcat(ds("Enables all available "), description)),
            ...features,
        ];
        for (const t of allTransitions) {
            if (!t.documented)
                continue;
            buf = dsConcat(buf, ds("  ="));
            buf = dsConcat(buf, t.name);
            buf = dsConcat(buf, ds(" "));                 // at least one separating space
            const lineLength = 3 /* "  =".length */ + t.name.length + 1 /* " ".length */;
            for (let i = lineLength; i < maxFlagLength; i++)
                buf = dsConcat(buf, ds(" "));
            buf = dsConcat(buf, t.helpText);
            if (t.deprecated_)
                buf = dsConcat(buf, ds(" [DEPRECATED]"));
            if (t.link.length)
                buf = dsConcat(buf, ds(" ("), t.link, ds(")"));
            buf = dsConcat(buf, ds("\n"));
        }
        return buf;
    }

    // The three manifest-enum usage constants (cli.d:1171/1174/1177). Per 07-compile-time.md §9
    // they are CTFE function calls; we evaluate them at module load by running the ported
    // `generateFeatureUsage` over the surviving feature tables. Static-field initializers run at
    // class-definition time (after `Usage` is defined), reproducing D's build-time CTFE order.

    /// Language changes listed by -transition=id (cli.d:1171).
    static readonly transitionUsage: DString =
        CLIUsage.generateFeatureUsage(Usage.transitions, ds("transition"), ds("language transitions"));

    /// Language changes listed by -revert (cli.d:1174).
    static readonly revertUsage: DString =
        CLIUsage.generateFeatureUsage(Usage.reverts, ds("revert"), ds("revertable language changes"));

    /// Language previews listed by -preview (cli.d:1177).
    static readonly previewUsage: DString =
        CLIUsage.generateFeatureUsage(Usage.previews, ds("preview"), ds("upcoming language changes"));

    // -----------------------------------------------------------------------------------------
    // dropped: `checkActionUsage`/`checkUsage`/`externStdUsage`/`hcUsage`/`gdwarfUsage` enums
    // (cli.d:1179-1230) — `version (IN_LLVM) {} else` !IN_LLVM-only block.
    // -----------------------------------------------------------------------------------------
}

// dropped: the `version (IN_LLVM) {} else { TargetOS, targetOS, isCurrentTargetOS }` block
// (cli.d:17-90) — !IN_LLVM-only TargetOS bit-decoding, not built into LDC.
