// Co-located tests for src/dmd/initsem.ts (dmd/initsem.d).
//
// `dmd/initsem.d` contains ZERO in-source `unittest` blocks (verified: `grep -c 'unittest'` on
// dmd/initsem.d returns 0), so per 10 §1.6b this file is the thin test file: one module-load
// smoke test plus one behaviour pin per risky RESOLVED CONSTRUCT — one `test()`/`it()` per CONCERN
// so a red gate names the right pin. No new harness machinery is built here; every pin uses the
// existing conventions (the 10 §1.5 init snippet, `ErrorSinkNull`).
//
// The risky constructs this file resolves, and where each is pinned below:
//   - the CTFE mixin `VisitInitializer!Result` (dmd/init.d:369) resolved INLINE at all THREE of
//     this module's instantiation sites (13 §7.6 rule 1) — pinned once per site, per arm;
//   - the two `Result` instantiations differ: `Initializer` (initializerSemantic, inferType) vs
//     `Expression` (initializerToExpression), so their `Result.init` fall-throughs differ;
//   - `initializerSemantic`'s `ref Type tx` box is written ONLY where D writes it (:318/:506) —
//     never flushed on exit;
//   - `toAssocArrayLiteral`'s empty-initializer diagnostic, which renders the initializer through
//     `toChars(const Initializer)` (dmd/hdrgen.d:212, `initializerToChars`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Loc } from "./location.js";
import { initTokens, EXP } from "./tokens.js";
import { Id } from "./id.js";
import { Type } from "./mtype.js";
import { TY, InitKind } from "./astenums.js";
import { global } from "./globals.js";
import { ErrorSinkNull } from "./errorsink.js";
import { setDiagnosticHandler } from "./errors.js";
import { dmdformat } from "./root/dmdformat.js";
import { dsToJs } from "../dstring.js";
import { IntegerExp, NullExp } from "./expression.js";
import {
    ArrayInitializer,
    CInitializer,
    DefaultInitializer,
    ErrorInitializer,
    ExpInitializer,
    INITnointerpret,
    StructInitializer,
    VoidInitializer,
} from "./init.js";
import {
    inferTypeInitializer,
    initializerSemantic,
    initializerToExpression,
    toAssocArrayLiteral,
} from "./initsem.js";
import type { Initializer } from "./init.js";
import { Scope } from "./dscope.js";
import { moduleFromParse } from "./dmodule.js";
import { Array as DArray } from "./root/array.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Dsymbols } from "./arraytypes.js";
import { Type_init } from "./typesem.js";
import { scopeCreateGlobal } from "./dsymbolsem.js";

beforeEach(() => {
    // 10 §1.5 — the canonical init snippet, in the ORDER contract of 01 §5.2.
    Loc._init();
    initTokens();
    Id.initialize();
    Type_init();
    global.errorSink = new ErrorSinkNull();
    global.errors = 0;
});

const loc = () => Loc.initial;

/**
 * A real global `Scope` over a bare module — the tree's existing convention (precedent:
 * sema.var.test.ts `globalScope()`, sema.expr.test.ts). None of the arms pinned below actually
 * dereferences `sc`, but the parameter is fed a genuine value rather than a placeholder cast:
 * 10 §1.9 forbids `undefined as unknown as T` arguments outright.
 */
function globalScope(): Scope {
    const members: Dsymbols = new DArray<Dsymbol | null>();
    const m = moduleFromParse(members, null);
    return scopeCreateGlobal(m, global.errorSink!);
}

describe("initsem.d — module load", () => {
    it("module loads and its four exported free functions are callable values", () => {
        // Importing the module already executed its top level; these reads catch a load-order /
        // import-cycle regression at the earliest possible point (initsem sits in the core SCC and
        // imports expressionsem / dcast / typesem / dsymbolsem, all of which import back).
        expect(typeof toAssocArrayLiteral).toBe("function");
        expect(typeof initializerSemantic).toBe("function");
        expect(typeof inferTypeInitializer).toBe("function");
        expect(typeof initializerToExpression).toBe("function");
    });
});

describe("initializerSemantic — the resolved `mixin VisitInitializer!Initializer` dispatch (initsem.d:1207)", () => {
    it("the `semanticDone` short-circuit returns the node before any dispatch (initsem.d:108)", () => {
        const i = new VoidInitializer(loc());
        i.semanticDone = true;
        const tx = { value: Type.tint32! };
        expect(initializerSemantic(i, globalScope(), tx, INITnointerpret)).toBe(i);
        // The short-circuit returns BEFORE `let t = tx.value`, so nothing is written.
        expect(i.type).toBe(null);
    });

    it("the void arm sets `i.type = t` and marks the node done (initsem.d:118 via init.d:375)", () => {
        const i = new VoidInitializer(loc());
        const tx = { value: Type.tint32! };
        const r = initializerSemantic(i, globalScope(), tx, INITnointerpret);
        expect(r).toBe(i);
        expect(i.type).toBe(Type.tint32);
        // initsem.d:1209 — `result.semanticDone = true;` runs on the mixin's result.
        expect(i.semanticDone).toBe(true);
    });

    it("the default arm sets `i.type = t` and marks the node done (initsem.d:124 via init.d:376)", () => {
        const i = new DefaultInitializer(loc());
        const tx = { value: Type.tint32! };
        const r = initializerSemantic(i, globalScope(), tx, INITnointerpret);
        expect(r).toBe(i);
        expect(i.type).toBe(Type.tint32);
        expect(i.semanticDone).toBe(true);
    });

    it("the error arm returns the node unchanged (initsem.d:130 via init.d:377)", () => {
        const i = new ErrorInitializer();
        const tx = { value: Type.tint32! };
        expect(initializerSemantic(i, globalScope(), tx, INITnointerpret)).toBe(i);
        expect(i.semanticDone).toBe(true);
    });

    it("`ref Type tx` is written ONLY where D writes it (:318/:506) — never flushed on exit", () => {
        // The void arm mutates the LOCAL `t` nowhere and never reaches :318/:506, so the caller's
        // box must come back untouched. (The pre-fill port flushed `tx.value = t` unconditionally
        // at the end of the function; that is a side effect dmd does not have.)
        const tx = { value: Type.tint32! };
        initializerSemantic(new VoidInitializer(loc()), globalScope(), tx, INITnointerpret);
        expect(tx.value).toBe(Type.tint32);
    });
});

describe("inferType — the resolved `mixin VisitInitializer!Initializer` dispatch (initsem.d:1356)", () => {
    it("the void / default / struct / C arms each yield a fresh ErrorInitializer", () => {
        const cases: Initializer[] = [
            new VoidInitializer(loc()),      // initsem.d:1223
            new DefaultInitializer(loc()),   // initsem.d:1229
            new StructInitializer(loc()),    // initsem.d:1240
            new CInitializer(loc()),         // initsem.d:1349
        ];
        for (const i of cases) {
            const r = inferTypeInitializer(i, globalScope());
            expect(r).not.toBe(i);
            expect(r.kind).toBe(InitKind.error);
        }
    });

    it("the error arm returns the SAME node (initsem.d:1235) — identity, not a fresh error node", () => {
        const i = new ErrorInitializer();
        expect(inferTypeInitializer(i, globalScope())).toBe(i);
    });
});

describe("initializerToExpression — the resolved `mixin VisitInitializer!Expression` dispatch (initsem.d:1589)", () => {
    it("void / struct / C arms return null, and the fall-through `Result.init` is a null EXPRESSION", () => {
        // This is the tree's ONLY `Result = Expression` instantiation of the mixin, so each arm's
        // early-exit test is `r !is null` against an EXPRESSION and the trailing `return Result.init;`
        // (init.d:384) is a null Expression — not the null Initializer of the other two sites.
        expect(initializerToExpression(new VoidInitializer(loc()))).toBe(null);   // :1374
        expect(initializerToExpression(new StructInitializer(loc()))).toBe(null); // :1394
        expect(initializerToExpression(new CInitializer(loc()))).toBe(null);      // :1583
    });

    it("the error arm returns an ErrorExp (initsem.d:1384)", () => {
        const e = initializerToExpression(new ErrorInitializer());
        expect(e).not.toBe(null);
        expect(e!.op).toBe(EXP.error);
    });

    it("the default arm is `di.type ? di.type.defaultInit(...) : null` (initsem.d:1379)", () => {
        // Untyped DefaultInitializer -> the ternary's null arm; no call into typesem at all.
        expect(initializerToExpression(new DefaultInitializer(loc()))).toBe(null);
    });

    it("the exp arm with no `itype` returns `i.exp` itself (initsem.d:1580)", () => {
        // `itype === null` skips the whole static-array-repeat block, so the tail `return i.exp;`
        // is the identity D specifies — the pin proves the arm is wired to visitExp, not to a
        // neighbouring handler (13 §7.6 rule 3: a mis-routed arm compiles and miscompiles).
        const inner = new NullExp(loc(), Type.tvoidptr ?? null);
        const i = new ExpInitializer(loc(), inner);
        expect(initializerToExpression(i)).toBe(inner);
    });

    it("an ArrayInitializer with an int-keyed element takes the AA-literal route (initsem.d:1408-1411)", () => {
        // `itype === null` && `init.type === null` && `isAssociativeArray()` -> toAssocArrayLiteral.
        // The element's value is an ExpInitializer, so `initializerToExpression` on it is the
        // identity above and the AA literal is built without touching any unported callee.
        const ai = new ArrayInitializer(loc());
        const key = new IntegerExp(loc(), 1n, Type.tint32!);
        const val = new NullExp(loc(), Type.tvoidptr ?? null);
        ai.addInit(key, new ExpInitializer(loc(), val));
        const e = initializerToExpression(ai);
        expect(e).not.toBe(null);
        expect(e!.op).toBe(EXP.assocArrayLiteral);
    });
});

describe("toAssocArrayLiteral — the empty-initializer diagnostic (initsem.d:71 -> :65)", () => {
    it("an empty ArrayInitializer reports D's diagnostic with `[]` and returns ErrorExp", () => {
        // RE-PIN (10 §1.8 rule 7): this was the pinned wall on `toChars(const Initializer)`
        // (hdrgen.d:212), now live as hdrgen.ts `initializerToChars`. Path: `const dim =
        // ai.value.length;` is 0, so dmd/initsem.d:70-71 takes `return no("invalid associative array
        // initializer ...", ai);`, whose body (initsem.d:65-66) errors and returns `ErrorExp.get()`.
        // ldc2 on `int[int] aa = [];`: "Error: invalid associative array initializer `[]`, use `null`
        // instead".
        const diags: string[] = [];
        setDiagnosticHandler((_loc, _color, header, messageFormat, args) => {
            diags.push(dsToJs(header) + dsToJs(dmdformat(messageFormat, [...args])));
            return true;
        });
        try {
            const ai = new ArrayInitializer(loc());
            const e = toAssocArrayLiteral(ai);
            expect(e.op).toBe(EXP.error);
            expect(diags).toEqual(["Error: invalid associative array initializer `[]`, use `null` instead"]);
        } finally {
            setDiagnosticHandler(null);
        }
    });
});

describe("initializerSemantic — the ArrayInitializer `goto default;` shared arm (initsem.d:242/:248)", () => {
    it("a non-array target type falls to the extracted default arm and returns an ErrorInitializer", () => {
        // `switch (t.ty)` with `t.ty == Tint32` hits `default:` (initsem.d:248), which errors and
        // `return err()`. This pins the SHARED-ARM extraction: `arrayDefaultArm()` must RETURN its
        // result at both the `goto default;` site (:242) and at `default:` — a bare `break` there
        // would silently continue into the element loop (06 §3.6 "the trap").
        const ai = new ArrayInitializer(loc());
        const tx = { value: Type.tint32! };
        const r = initializerSemantic(ai, globalScope(), tx, INITnointerpret);
        expect(r.kind).toBe(InitKind.error);
        expect(global.errors).toBeGreaterThan(0);
    });

    it("a Terror target type short-circuits before the default arm (initsem.d:245)", () => {
        const ai = new ArrayInitializer(loc());
        const tx = { value: Type.terror! };
        const r = initializerSemantic(ai, globalScope(), tx, INITnointerpret);
        expect(r.kind).toBe(InitKind.error);
        // The Terror arm returns `err()` WITHOUT emitting a diagnostic — that is the whole point of
        // it being a separate case ahead of `default:`.
        expect(global.errors).toBe(0);
        expect(tx.value.ty).toBe(TY.Terror);
    });
});

/** One ldc2-shaped `-c -o-` compile through the shim in a fresh module registry (a new ldmd2 process starts from
 * load-time globals, djs.test.ts); returns the exit code and everything written to stderr. */
async function shimCompile(file: string): Promise<{ code: number; stderr: string }> {
    vi.resetModules();
    const { djsMain } = await import("../djs.js");
    const err: string[] = [];
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array): boolean => {
        err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
        return true;
    });
    try {
        return { code: djsMain(["-c", "-o-", file]), stderr: err.join("") };
    } finally {
        e.mockRestore();
    }
}

// dmd/initsem.d:364 calls `arrayFuncConv` (importc.d:83) when the target is a pointer; outside a C file it is the
// identity, so D keeps rejecting the static-array-to-pointer initializer the C decay would accept.
// Expected: ldc2 1.43.0 `-c -o-` on the same file, byte for byte.
describe("visitExp — arrayFuncConv outside ImportC (initsem.d:364)", () => {
    it("`int* p = a;` with `int[3] a` is still an implicit-conversion error", async () => {
        const dir = mkdtempSync(join(tmpdir(), "djs-initafc-"));
        try {
            const f = join(dir, "ia.d");
            const line = "void f() { int[3] a; int* p = a; }";
            writeFileSync(f, `module ia;\n${line}\n`);
            expect(await shimCompile(f)).toEqual({
                code: 1,
                stderr: `${f}(2): Error: cannot implicitly convert expression \`a\` of type \`int[3]\` to \`int*\`\n`
                    + `${line}\n${" ".repeat(30)}^\n`,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
