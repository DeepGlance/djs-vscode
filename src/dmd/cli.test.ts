import { describe, test, expect } from "vitest";
import { capitalize, Usage, CLIUsage } from "./cli.js";
import { ds, dsToJs, dsEquals } from "../dstring.js";

// dmd/cli.d has NO in-source `unittest{}` blocks, so there is nothing to port under 10 §1.
// Instead these are GOAL tests: they protect the two
// achievements of this module — (1) the IN_LLVM-resolved surviving subset is the right one,
// and (2) the CTFE-generated usage strings are byte-for-byte identical to `ldc2`'s output for
// the LDC (IN_LLVM=true) build. The expected strings below were captured verbatim from
// `ldc2 -run` on the surviving subset (see the port's provenance notes); if the ported
// `generateFeatureUsage` algorithm ever drifts, these fail loudly.

describe("cli.d capitalize", () => {
    // Behavior verified with ldc2 (/tmp/probe_cli2.d): only a leading lowercase ASCII byte is
    // uppercased; everything else (incl. empty and already-capital) is returned unchanged.
    test("lowercases-first-letter / leaves rest unchanged", () => {
        expect(dsToJs(capitalize(ds("language transitions")))).toBe("Language transitions");
    });
    test("already-capital unchanged", () => {
        expect(dsToJs(capitalize(ds("Already capital")))).toBe("Already capital");
    });
    test("empty string unchanged", () => {
        expect(dsToJs(capitalize(ds("")))).toBe("");
    });
    test("single lowercase char", () => {
        expect(dsToJs(capitalize(ds("a")))).toBe("A");
    });
    test("non-letter first char unchanged", () => {
        expect(dsToJs(capitalize(ds("123abc")))).toBe("123abc");
    });
    test("returns a fresh buffer on the lowercase path (does not mutate input)", () => {
        const input = ds("hello");
        const out = capitalize(input);
        expect(dsToJs(out)).toBe("Hello");
        expect(dsToJs(input)).toBe("hello"); // input untouched (D allocates `new char[]`)
    });
});

describe("cli.d surviving feature tables (IN_LLVM=true)", () => {
    // The IN_LLVM-resolved subset keeps exactly these three tables; their lengths/first names
    // pin that the right block survived and the `documented=false` rows are still present in the
    // DATA (the skip happens only when rendering, in generateFeatureUsage).
    test("transitions table", () => {
        expect(Usage.transitions.length).toBe(4);
        expect(dsToJs(Usage.transitions[0].name)).toBe("field");
    });
    test("reverts table", () => {
        expect(Usage.reverts.length).toBe(4);
        expect(dsToJs(Usage.reverts[0].name)).toBe("dip25");
    });
    test("previews table", () => {
        expect(Usage.previews.length).toBe(18);
        expect(dsToJs(Usage.previews[0].name)).toBe("dip25");
        expect(dsToJs(Usage.previews[17].name)).toBe("fastdfa"); // 1.43.0-beta1 addition
    });
    test("Feature copy() shares DString fields, copies primitives", () => {
        const f = Usage.previews[0];
        const c = f.copy();
        expect(dsEquals(c.name, f.name)).toBe(true);
        expect(c.documented).toBe(f.documented);
        expect(c.deprecated_).toBe(f.deprecated_);
    });
});

// The exact CTFE outputs from `ldc2 -run` on the surviving (IN_LLVM=true) subset of cli.d.
// These are the byte-for-byte contract for generateFeatureUsage — do NOT hand-edit; regenerate
// only from `ldc2` if upstream changes the feature tables.
const EXPECTED_TRANSITION_USAGE =
`Language transitions listed by -transition=name:
  =all              Enables all available language transitions
  =field            list all non-mutable fields which occupy an object instance
  =complex          give deprecation messages about all usages of complex or imaginary types [DEPRECATED]
  =tls              list all variables going into thread local storage
  =in               list all usages of 'in' on parameter
`;

const EXPECTED_REVERT_USAGE =
`Revertable language changes listed by -revert=name:
  =all              Enables all available revertable language changes
  =dip25            revert DIP25 changes [DEPRECATED] (https://github.com/dlang/DIPs/blob/master/DIPs/archive/DIP25.md)
  =dip1000          revert DIP1000 changes (Scoped Pointers) (https://github.com/dlang/DIPs/blob/master/DIPs/other/DIP1000.md)
  =intpromote       revert integral promotions for unary + - ~ operators
  =dtorfields       don't destruct fields of partially constructed objects
`;

const EXPECTED_PREVIEW_USAGE =
`Upcoming language changes listed by -preview=name:
  =all              Enables all available upcoming language changes
  =dip25            implement Sealed References DIP [DEPRECATED] (https://github.com/dlang/DIPs/blob/master/DIPs/archive/DIP25.md)
  =dip1000          implement Scoped Pointers DIP (https://github.com/dlang/DIPs/blob/master/DIPs/other/DIP1000.md)
  =dip1008          implement @nogc Throwable DIP (https://github.com/dlang/DIPs/blob/master/DIPs/other/DIP1008.md)
  =dip1021          implement Mutable Function Arguments DIP (https://github.com/dlang/DIPs/blob/master/DIPs/accepted/DIP1021.md)
  =bitfields        add C-like bitfields (https://github.com/dlang/dlang.org/pull/3190)
  =fieldwise        use fieldwise comparisons for struct equality (https://dlang.org/changelog/2.085.0.html#no-cmpsb)
  =fixAliasThis     when a symbol is resolved, check alias this scope before going to upper scopes (https://github.com/dlang/dmd/pull/8885)
  =rvaluerefparam   enable rvalue arguments to ref parameters (https://gist.github.com/andralex/e5405a5d773f07f73196c05f8339435a)
  =safer            more safety checks by default (https://github.com/WalterBright/documents/blob/38f0a846726b571f8108f6e63e5e217b91421c86/safer.md)
  =nosharedaccess   disable access to shared memory objects (https://dlang.org/spec/const3.html#shared)
  =in               \`in\` on parameters means \`scope const [ref]\` and accepts rvalues (https://dlang.org/spec/function.html#in-params)
  =inclusiveincontracts 'in' contracts of overridden methods must be a superset of parent contract (https://dlang.org/changelog/2.095.0.html#inclusive-incontracts)
  =fixImmutableConv disallow \`void[]\` data from holding immutable data (https://dlang.org/changelog/2.101.0.html#dmd.fix-immutable-conv, https://issues.dlang.org/show_bug.cgi?id=17148)
  =systemVariables  disable access to variables marked '@system' from @safe code (https://dlang.org/spec/attribute.html#system-variables)
  =fastdfa          Fast dataflow analysis engine, experimental
`;

describe("cli.d CTFE usage strings (byte-for-byte parity with ldc2)", () => {
    test("transitionUsage", () => {
        expect(dsToJs(CLIUsage.transitionUsage)).toBe(EXPECTED_TRANSITION_USAGE);
    });
    test("revertUsage", () => {
        expect(dsToJs(CLIUsage.revertUsage)).toBe(EXPECTED_REVERT_USAGE);
    });
    test("previewUsage", () => {
        expect(dsToJs(CLIUsage.previewUsage)).toBe(EXPECTED_PREVIEW_USAGE);
    });
});
