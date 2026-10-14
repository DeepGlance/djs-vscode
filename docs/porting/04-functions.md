# 04 — Functions & Callables

> **STOP rule:** if you meet a callable construct not covered here, or any ambiguity in
> overload/variadic/delegate resolution, **STOP and escalate** (`11-escalate.md`). Never
> guess. A plausible-but-wrong callable translation in a compiler corrupts every call site
> downstream.

Read `_ground-truth.md` first. This doc owns: function/method **overloading**, **default
arguments**, **variadics** (all three kinds), **delegates / closures / function pointers**
(with the `this`-capture pitfall), **nested functions**, **UFCS**, **contracts**
(`in`/`out`/`do`/`invariant`), **attribute erasure**, and **`@property`**.

Adjacent topics owned elsewhere — cross-reference, do not duplicate:
- Operator-overload methods (`opXxx`) and their call-site rewrites → `05-operators.md`.
- `scope(exit/success/failure)` statement guards → `06-control-flow.md` (NOT the `scope`
  storage-class *attribute*, which is covered here under attribute erasure).
- `assert` helper semantics, error-message format strings, printf-style diagnostics →
  `10-tests-diagnostics.md`.
- Numeric domains (`number` vs `BigInt`) for params/returns → `09-numerics.md`.
- Struct value-copy on by-value params and returns → `03-value-semantics.md`.
- `static if`/`version`/`__VERSION__` resolution inside function bodies → `07-compile-time.md`.

---

## 0. The one invariant that governs callables

D resolves overloads, default arguments, UFCS, and template-variadic instantiations **at
compile time**. The frontend source is already monomorphic per call site once the D compiler
has chosen. **Your job is to bake in the choice D's frontend made, not to recreate D's
overload-resolution at JS runtime.** TypeScript/JS has *no* runtime overloading: one name
binds one function object. Therefore every D overload set collapses to either distinct names
or one dispatching body — decided per the rules below, deterministically.

### 0.1 A function's PROTOCOL is part of its interface — preserve it verbatim

A D function's signature shape — what it returns, what it writes through `ref`/`out`, what it
does NOT know about its callers — is itself ported 1:1. Concretely, all of these are forbidden
re-designs, not translations:

- **Never change the return protocol.** A `Expression`-returning helper stays
  `Expression`-returning; do not re-protocol it to `boolean` + a write into some visitor's
  `result` field. (This shipped once: `binSemantic`/`binSemanticProp` re-protocoled to
  `boolean` + visitor-write, which made every OTHER D caller of those helpers untranslatable.)
- **Never fold a caller's assignment into the callee**, and **never add a visitor/context
  parameter** a D free function does not have.
- If TS ergonomics genuinely push against the D protocol, that is a **STOP-and-escalate**
  (`11-escalate.md`), not a local redesign.

---

## 1. Function / method overloading

**Fact (verified):** D allows multiple functions/methods with the same name differing by
parameter list, in the same scope. Sizing across the frontend: the common overload sets are
**constructors** (`this(...)`), **static factory methods** (`create(...)`, 62 sites), and a
handful of free/method helpers (`error`, `foreachDsymbol`). Most are 2–3 overloads; sets
wider than ~4 are rare.

Real overload sets (verifiable):
- `ScopeDsymbol` ctors: `this()`, `this(Identifier)`, `this(Loc, Identifier)` —
  dmd/dsymbol.d:1100, dmd/dsymbol.d:1105, dmd/dsymbol.d:1110.
- `StringExp.create`: `create(Loc, const(char)*)` vs `create(Loc, const(void)*, size_t)` —
  dmd/expression.d:1337, dmd/expression.d:1342.
- `foreachDsymbol`: `int delegate` vs `void delegate` variant — dmd/dsymbol.d:73,
  dmd/dsymbol.d:99.
- `Lexer.error`: `error(T...)(format, args)` vs `error(T...)(Loc, format, args)` —
  dmd/lexer.d:3120, dmd/lexer.d:3125.

### Canonical rule — DECIDE per shape

There are exactly two legal translations. Pick by this test, with **NO exceptions**:

> **If the overloads can be distinguished by `arguments.length` alone AND every overload's
> body is essentially the same logic on a prefix of the params → ONE function with optional
> params (arity dispatch). Otherwise → RENAME each overload with a type-suffix.**

This split is decidable mechanically: count the params; if the shorter overloads are
literally "call the longer one with defaults filled in" (the frontend ctor idiom — see
dmd/dsymbol.d:1100-1112 where each ctor just `super(...)` with fewer args), it is arity
dispatch. If two overloads take the *same arity but different types* (dmd/expression.d:1337
vs dmd/expression.d:1342: both `(Loc, X)` but `X` differs), it is rename-with-suffix.

#### Form A — arity dispatch (overloads = prefixes, distinguishable by count)

The Dsymbol ctor set is the canonical example. D picks by arg count; the shorter forms just
forward.

**BEFORE (D)** — dmd/dsymbol.d:1100
```d
final this() nothrow @safe                    { super(DSYM.scopeDsymbol); }
final this(Identifier ident) nothrow @safe    { super(DSYM.scopeDsymbol, ident); }
final this(Loc loc, Identifier ident) @safe   { super(DSYM.scopeDsymbol, loc, ident); }
```

**AFTER (TS)** — one constructor, optional trailing params in D-declaration order
```ts
// overload set collapsed by arity: this() / this(ident) / this(loc, ident)
constructor(loc?: Loc, ident?: Identifier) {
  super(DSYM.scopeDsymbol, loc, ident); // pass undefined through; super handles its own arity
}
```
> Use TS *call-signature overloads* (the `foo(a): R; foo(a, b): R; foo(...): R {}` triple) ONLY
> when the public signatures must read distinctly for callers. For faithful internal ports,
> the single optional-param body is canonical — it diffs cleanly against upstream and avoids a
> second source of truth.

#### Form B — rename-with-suffix (same arity, different types)

**Invariant to preserve:** the D compiler already chose ONE overload at each call site by the
*static type* of the arguments. You must reproduce that choice by **rewriting each call site to
the renamed target it resolved to** — do NOT emit a runtime type test.

**BEFORE (D)** — dmd/expression.d:1337
```d
static StringExp create(Loc loc, const(char)* s)               { return new StringExp(loc, s.toDString()); }
static StringExp create(Loc loc, const(void)* string, size_t len) { return new StringExp(loc, string[0 .. len]); }
```

**AFTER (TS)** — distinct names; rename by the disambiguating param type
```ts
// overload set: create(Loc, cstr) | create(Loc, ptr, len)  -> renamed by 2nd-arg shape
static createFromCStr(loc: Loc, s: CStr): StringExp { return new StringExp(loc, toDString(s)); }
static createFromBuf(loc: Loc, buf: Uint8Array, len: number): StringExp { ... }
```
Suffix scheme (deterministic — ONE tie-break, learned in the pilot where three schemes
collided in one file):
1. **Which overload keeps the BARE name:** the one **existing TS dependents already import**
   (grep the tree first); absent any dependent, the most-called D form. **The dependent search
   runs over the D SOURCE tree as well as the TS tree, and a CROSS-MODULE D caller outranks an
   in-module one** — "most-called" decides nothing when both forms are called once in-module,
   whereas the form another D module calls is the one whose name is a contract. Live case:
   statementsem.d's two `checkLabel` overloads, where the `GotoStatement` form keeps the bare
   name because `semantic3.d:1340` calls it. When this still ties (all callers in-module, equal
   counts), the first-declared form keeps the bare name (dfa/fast/structure.ts `opApply`).
2. **FIRST-parameter (receiver) splits** — the UFCS-family shape — take the **bare
   receiver-type suffix** per §6.1 (`checkAccessAggregate`, `hasPointersDsymbol`,
   `callSideEffectLevelType` for sideeffect.d:130's `Type` form against the `FuncDeclaration` form
   at :105). A **slice receiver** `T[]` takes `<name><T>Slice` (`doCondExpressionSlice` for
   visitor/postorder.d:63's `doCond(Expression[])`); never the `Array` alias name (`Expressions`),
   which names the container type, not the slice. **Exception: `hdrgen.d`'s printer sets**
   (`toChars`, `toCBuffer`, `toErrMsg`) take PREFIX names (`typeToChars`, `expToCBuffer`,
   `rootObjectToErrMsg`), the spelling the tree exports; §6.1 holds their table.
3. **Later-parameter value-type splits** take `<name>From<DistinguishingType>` (`Of` for
   converters). An overload that differs by an **inserted** parameter (an extra parameter the
   other form lacks, not a different type at the same position) takes `<name><ParamName>` on the
   non-bare form: safe.d:475 `setUnsafe(sc, gag, loc, scopeVar, format, args...)` →
   `setUnsafeScopeVar`, safe.d:553 → `setUnsafePreviewScopeVar`, and the ctor precedent func.d:1277
   → `AttributeViolation.fromFormatScopeVar`. Rule 1 still decides which form keeps the bare name;
   when it gives the bare name to the form CARRYING the inserted parameter, the other form takes
   `<name>No<ParamName>` (`errorNoLoc`, §1.1(a); ctfeexpr.d:380 → `paintTypeOntoLiteralNoPue`).
   When the rule-3 name collides with an existing member (`getContext(out var)` →
   `getContextVar`, already a D method), collapse by arity (Form A) if the arities differ and the
   shorter form is the longer one with defaults filled in; otherwise escalate.
4. **Overloads whose parameter types ALL map to ONE TS type** (`const(char)*` /
   `const(char)[]` / `string` → `DString`) collapse to a single function — state the collapse
   in the interface comment, do not emit ghost variants.
5. **A `deprecated` C++-ABI-only overload whose only callers are out-of-scope** (driver C++,
   `main.cpp`) is **DROPPED with a `// dropped:` record at the site** (07 convention) — never
   renamed into a dead export. Any NUL-truncation such a shim performed is noted in the drop
   comment so a future in-scope caller knows to pre-truncate.
**Always** record the mapping in a one-line comment on each renamed function so the call-site
rewrite is auditable against upstream (house style §5).

> Constructors that are Form B (same arity, different param *types*) cannot use TS overloaded
> `constructor`. Promote them to named static factory methods (`StringExp.fromCStr(...)`,
> `StringExp.fromBuf(...)`) and rewrite `new StringExp(...)` call sites accordingly. The
> frontend often *already* provides such factories (`create`), so prefer routing through the
> existing one.

**Templated overloads** (`Lexer.error(T...)` vs `error(T...)(Loc, ...)`, dmd/lexer.d:3120) are
Form B distinguished by whether the first arg is a `Loc`. This is the **leading-`Loc` C-variadic
pair** edge case — translate per §1.1(a): the **with-`Loc`** form keeps the canonical name
(`error(loc, …)`), the **no-`Loc`** form gets the `NoLoc` suffix (`errorNoLoc(…)`). See §3.3 for
the variadic part.

### Static factory on a generic type

**Fact (verified):** the frontend has static factories declared *inside* a generic aggregate that
return the enclosing type — e.g. `static Optional!T create(T val)` on `struct Optional(T)`
(dmd/root/optional.d:61). In D the static method simply uses the enclosing struct's `T`.

**The trap:** TypeScript does NOT let a `static` member reference the *class's* type parameter — a
class type parameter is bound per-instance, and a static method has no instance. The class `T` is
out of scope in a static method body. Therefore the static factory MUST declare **its own** type
parameter, which deliberately **shadows** the class `T`:

**BEFORE (D)** — dmd/root/optional.d:61
```d
struct Optional(T)
{
    static Optional!T create(T val) { return Optional!T(val); }
}
```

**AFTER (TS)** — the static factory introduces its own `<T>`; shadowing the class `T` is intended
```ts
class Optional<T> {
  // static factory declares its own <T> (shadows class T by design — static has no class T)
  static create<T>(val: T): Optional<T> { return new Optional<T>(val); }
}
```
**Invariant:** the method-level `<T>` and the class-level `<T>` are *distinct* type parameters that
happen to share a name; at a call site `Optional.create(x)` the method `<T>` is inferred from `x`,
exactly reproducing D's `Optional!T.create`. Add the one-line shadowing comment at each such site so
the intent is auditable. This is the same shadow-the-class-parameter pattern used for any generic
static factory (`create`, `fromX`); cross-reference `03-value-semantics.md` "Default construction of
a value-constructor-only struct" when the factory is the only constructor entry point.

### 1.1 Overload edge cases — the three Form-B shapes you WILL hit

Form A (§1, arity dispatch) and the generic-static-factory case above cover the bulk. Three
specific Form-B shapes recur across the real frontend and have **one canonical naming each** — do
not improvise a different suffix. All three are *same-arity* overloads (so arity dispatch is
impossible) and each is resolved by **renaming**, then rewriting every call site to the chosen
target (the D compiler already picked one statically — §1 Form B invariant).

#### (a) Two C-variadics differing only by a leading `Loc` → `NoLoc` suffix

**Shape:** a diagnostic helper exists in two forms whose argument lists differ *only* by a leading
`Loc` parameter — `error(format, args…)` vs `error(loc, format, args…)`. Same trailing variadic,
distinguished solely by the presence of the `Loc`.

**Canonical:** the **with-`Loc`** form **keeps the canonical name**; the **no-`Loc`** form gets the
**`NoLoc` suffix**. (`error(loc, …)` stays `error`; the location-free form becomes `errorNoLoc`.)
The with-`Loc` form is the richer, primary one — it carries the diagnostic location — so it earns
the unsuffixed name; the convenience no-`Loc` form is the variant.

**BEFORE (D)** — dmd/lexer.d:3120
```d
void error(T...)(const(char)* format, T args)            { eSink.error(token.loc, format, args); }
void error(T...)(Loc loc, const(char)* format, T args)   { eSink.error(loc, format, args); }
```

**AFTER (TS)** — with-`Loc` keeps `error`; no-`Loc` gets the `NoLoc` suffix
```ts
// overload pair: error(loc, fmt, …) | error(fmt, …)  -> with-Loc canonical, no-Loc suffixed
error(loc: Loc, format: DString, ...args: unknown[]): void { this.eSink.error(loc, format, ...args); }
errorNoLoc(format: DString, ...args: unknown[]): void { this.eSink.error(this.token.loc, format, ...args); }
```
> Apply the suffix to the **no-`Loc`** member only; never suffix the with-`Loc` form. The same rule
> generalises to the sibling diagnostic pairs (`warning`/`warningNoLoc`,
> `deprecation`/`deprecationNoLoc`, …). The variadic part is owned by §3.3; this rule only fixes the
> **names**. Rewrite each call site to the form whose argument list it matched in D.

#### (b) Same-arity free/static overloads differing by 2nd-param type/return → Form-B suffix rename

**Shape:** two (or more) overloads of one name share arity but differ by the **type of a parameter**
(or by return type) — so neither `Loc`-presence nor arity separates them. The canonical frontend
example is `Identifier.idPool`, which has three same-name forms: a ptr+len slice form, the primary
`(slice, isAnonymous)` interning form, and a `(slice, TOK)` keyword-insert form.

**Canonical:** keep the **primary/most-used** form under the bare name; give every other form a
**type-descriptive suffix** naming what disambiguates it (`idPoolLen`, `idPoolKeyword`). This is the
ordinary Form-B rename (§1 Form B) applied to a >2-member set — the suffix names the *distinguishing
dimension*, not a running index.

**BEFORE (D)** — dmd/identifier.d:291
```d
static Identifier idPool(scope const(char)* s, uint len);          // ptr + length     (identifier.d:291)
static Identifier idPool(const(char)[] s, bool isAnonymous = false);// primary interning (identifier.d:296)
static void       idPool(const(char)[] s, TOK value);              // keyword insert    (identifier.d:314)
```

**AFTER (TS)** — primary keeps `idPool`; the others get distinguishing suffixes
```ts
// overload set: idPool(ptr,len) | idPool(slice,isAnon) | idPool(slice,TOK)
static idPoolLen(s: DString, len: number): Identifier { return Identifier.idPool(s.subarray(0, len)); }
static idPool(s: DString, isAnonymous = false): Identifier { /* primary interning path */ }
static idPoolKeyword(s: DString, value: TOK): void { /* keyword insert */ }
```
> Pick the bare name for the form the frontend calls most (here the `(slice, isAnonymous)` interning
> path); record the chosen mapping in a one-line comment on each renamed member (house style §5) so
> the call-site rewrite is auditable. Each call site resolves to exactly one form by the *static
> type* of its argument — rewrite it to that renamed target; **never** emit a runtime type test.

#### (c) Two same-arity constructors → one constructor + one static factory

**Shape:** an aggregate has two `this(...)` overloads of the **same arity** that differ only by a
parameter *type* — e.g. `SourceLoc(const(char)[] filename, …)` (the field ctor) vs `SourceLoc(Loc
loc)` (both arity-1 at the disambiguating position). TS `constructor` cannot be overloaded by
parameter type, so the two cannot both be constructors.

**Canonical:** the **field/primary** ctor stays the TS `constructor`; the other form is promoted to a
**named `static` factory** (`SourceLoc.fromLoc(loc)`), and every `new SourceLoc(loc)` call site that
matched the second form is rewritten to the factory. This is the constructor-specialisation of Form B
(the §1 note "Constructors that are Form B … Promote them to named static factory methods").

**BEFORE (D)** — dmd/location.d:254
```d
this(const(char)[] filename, uint line, uint column, uint fileOffset = 0, const(char)[] fileContent = null);
this(Loc loc);   // location.d:254 (field ctor) vs location.d:263 (from-Loc ctor)
```

**AFTER (TS)** — field ctor stays `constructor`; the `Loc` form becomes `static fromLoc`
```ts
constructor(filename: DString, line: number, column: number, fileOffset = 0,
            fileContent: DString | null = null) { /* field init */ }

// same-arity-different-type ctor -> named factory; rewrite `new SourceLoc(loc)` -> `SourceLoc.fromLoc(loc)`
static fromLoc(loc: Loc): SourceLoc { /* resolve loc against the file table */ }
```
> Choose the **field/data** ctor as the surviving `constructor`; route the type-specialised form
> through a `static fromX` factory named by the distinguishing type (`fromLoc`, `fromCStr`). If the
> frontend already provides such a factory (`create`, `fromX`), reuse it rather than minting a second
> entry point. Rewrite the matching `new T(...)` call sites to the factory; the unmatched ones keep
> `new T(...)`.

#### (d) super()-reachable sets where Form A/B/C are all unavailable (RATIFIED shapes)

Two recurring shapes escape (a)-(c) because the LONGER form must remain the literal
`constructor` (subclasses reach it via `super(...)`, which cannot route through a factory):

- **Middle-position extra param, same tail** (`AssignExp`: `this(loc,e1,e2)` vs
  `this(loc,e1,tok,e2)`): canonical = ONE constructor with the extra param moved to a
  TRAILING optional (`(loc, e1, e2, tok = EXP.assign)`), with the comment
  `// D param order broken: tok is positional-2 upstream (expression.d:<line>)`. The D
  order is knowingly broken; the comment is mandatory.
- **Arity-distinct, middle-position, DISJOINT TS types** (`StaticCtorDeclaration`:
  `(loc,endloc,stc)` vs `(loc,endloc,name,stc)`): canonical = ONE constructor with union
  call signatures decoded by a TOTAL, DISJOINT `typeof` test on the middle argument — this
  is expressly exempted from the no-runtime-test rule BECAUSE the domains are disjoint and
  the decode is total (an explicit `undefined` must throw, not pick a branch). NEVER decode
  by `arguments.length` here (an explicit undefined 4th arg silently takes the wrong branch
  — the exact silent-miscompile 04 §1.1(c) names).

**Side-effect-divergent ctor overloads — implement both or THROW on the unported form.** Some D
ctor pairs differ not just by type but by **behavior**: `BlitExp`/`ConstructExp` have
`this(Loc, Expression e1, e2)` (plain) *and* `this(Loc, VarDeclaration v, e2)`
(dmd/expression.d:3875/3904 — wraps `v` in `new VarExp(loc, v)` **and may set
`memset = MemorySet.referenceInit`**). If only one form is ported, accepting the union type and
casting is a **silent skip in disguise**: a caller passing the `VarDeclaration` gets a corrupt
node (`e1` holding a Dsymbol) with no diagnostic. The unported form must throw:

```ts
// BAD — accepts the D overload's argument type but silently miscompiles it:
constructor(loc: Loc, e1OrV: Expression | VarDeclaration | null, e2: Expression | null) {
    super(loc, EXP.blit, e1OrV as Expression | null, e2);   // a VarDeclaration lands in e1
}

// GOOD — the unported overload is a loud TODO-BODY wall, like any other unported D branch:
constructor(loc: Loc, e1OrV: Expression | VarDeclaration | null, e2: Expression | null) {
    if (e1OrV !== null && !(e1OrV instanceof Expression))
        throw new Error("TODO-BODY: BlitExp(Loc, VarDeclaration, Expression) ctor (dmd/expression.d:3904 — memset/referenceInit unported; build the VarExp at the call site)");
    super(loc, EXP.blit, e1OrV, e2);
}
```

> Mind D's **overload selection** at each call site: `new BlitExp(loc, new VarExp(loc, v), e)`
> selects the *(Loc, Expression, Expression)* ctor — the `memset` logic does **not** run there
> (verified for the zeroInit default-init synthesis, dmd/dsymbolsem.d:2211). A port that funnels
> both shapes through one behavior changes semantics silently in one direction or the other.
>
> **The `null` trap in a runtime-discriminated collapse (why Form B forbids `instanceof`):**
> `null` satisfies the STATIC type of BOTH D overloads — D call sites disambiguate with an
> explicit `cast(T)null` (parse.d:6145/:6264) — but `null instanceof T` is always `false`, so
> an `instanceof`-discriminated collapsed ctor routes **every null argument to the wrong
> branch** and builds a wrong-but-valid node with no diagnostic. This shipped once
> (statement.ts ExpStatement). The D compiler already chose the overload statically: rewrite
> each call site to the named form it selected; never test at runtime.

---

## 2. Default arguments

**Fact (verified by probe):** an omitted trailing argument takes its declared default;
`f(int a, int b = 10)` called `f(5)` returns `15`. ~200 default-valued param sites in the
frontend (`= null`, `= false`, `= 0`, `= STC.none`, `= NoPostfix` …).

**Canonical rule:** map D defaults **1:1 to TS default parameters**, same value, same order.
TS evaluates defaults at call time exactly like D — no wrapper needed.

**BEFORE (D)** — dmd/declaration.d:521
```d
static VarDeclaration create(Loc loc, Type type, Identifier ident, Initializer _init,
                             StorageClass storage_class = STC.none) { ... }
```

**AFTER (TS)**
```ts
static create(loc: Loc, type: Type, ident: Identifier, init: Initializer | null,
              storageClass: StorageClass = STC.none): VarDeclaration { ... }
```

**Invariants:**
- A default value that is itself a struct literal/`X.init` must respect value semantics
  (`03-value-semantics.md`): emit a fresh copy per call, not a shared object. For `null`,
  scalars, and enum constants this is automatic.
- TS requires that no required param follows an optional one. D allows defaults only on
  *trailing* params too, so this matches — if you ever see a non-trailing default (you won't
  in the frontend; D forbids it), STOP and escalate.

---

## 3. Variadics — three distinct kinds, three distinct translations

D has **three** variadic forms. They look similar but translate differently. Identify the kind
by syntax before translating.

| D form | How to recognise | Frontend example |
|---|---|---|
| **C-style** `..., T format, ...` | bare `...` after a typed param; body uses `va_list`/`va_start` | dmd/errors.d:170 |
| **Typesafe** `T[] xs...` | a typed *slice* param immediately followed by `...` | dmd/statement.d:503 |
| **Template** `(T...)(... T args)` | `...` inside the *template* param list | dmd/lexer.d:3120 |

### 3.1 C-style variadic (`...` + `va_list`)

**BEFORE (D)** — dmd/errors.d:170 (printf-style diagnostic)
```d
extern (C++) void error(Loc loc, const(char)* format, ...)
{
    va_list ap; va_start(ap, format);
    vreportDiagnostic(loc, format, ap, ErrorKind.error);
    va_end(ap);
}
```

**AFTER (TS)** — rest parameter; `va_list` becomes the rest array
```ts
// C-variadic: format + printf args. Message formatting owned by 10-tests-diagnostics.md.
function error(loc: Loc, format: CStr, ...args: unknown[]): void {
  vreportDiagnostic(loc, format, args, ErrorKind.error);
}
```
**Invariant:** the `va_list ap; va_start; va_end` triple is the C ABI plumbing — it **erases**.
The rest array `args` *is* the materialised `va_list`. The downstream `vreportDiagnostic`
consumes it; the **printf format-string interpretation** (`%s`, `%.*s`, ordering, exact output
text) is owned by `10-tests-diagnostics.md` and MUST match DMD byte-for-byte — do not
reinvent it here. The `pragma(printf)` and `static if (__VERSION__ < 2092)` wrapper around
this declaration resolve at translation time (`07-compile-time.md`): keep one branch, drop the
other with an auditable comment.

### 3.2 Typesafe variadic (`T[] xs...`)

**Fact (verified by probe):** `int sumv(int[] xs...)` accepts BOTH loose args `sumv(1,2,3)`
*and* an actual array `sumv([4,5,6])`. The compiler packs loose args into a fresh array; an
existing array is passed through.

**BEFORE (D)** — dmd/statement.d:503
```d
final this(Loc loc, Statement[] sts...)
{
    super(loc, STMT.Compound);
    statements = new Statements();
    foreach (s; sts) statements.push(s);
}
```

**AFTER (TS)** — rest parameter; honour the dual call shape at the call sites
```ts
constructor(loc: Loc, ...sts: Statement[]) {
  super(loc, STMT.Compound);
  this.statements = new Statements();
  for (const s of sts) this.statements.push(s);
}
```
**Invariant — dual call shape:** D allows `new CompoundStatement(loc, s1, s2)` *and*
`new CompoundStatement(loc, arrayOfStatements)`. A TS rest param handles the loose form
natively; for the array form the caller MUST spread: `new CompoundStatement(loc, ...arr)`.
When you translate a *call site* that passes an array to a typesafe variadic, **emit the
spread `...`** — forgetting it passes the array as a single element and is a silent bug.
- The delegate variant (`int delegate(Dsymbol) dg` as the variadic-adjacent param) at
  dmd/dsymbol.d:73 is not itself variadic — see §4.

### 3.3 Template variadic (`T...` sequence/tuple parameter)

**BEFORE (D)** — dmd/lexer.d:3120 (a *template* whose `T...` is a type sequence)
```d
void error(T...)(const(char)* format, T args) { eSink.error(token.loc, format, args); }
```

**AFTER (TS)** — the type sequence `T...` becomes a rest parameter; forward with spread
```ts
error(format: CStr, ...args: unknown[]): void { this.eSink.error(this.token.loc, format, ...args); }
```
**Invariant:** a template variadic that merely *forwards* its pack (the frontend's universal
pattern for diagnostics — dmd/lexer.d:3120-3152) collapses to a rest param + spread forward.
The template is monomorphic per call site in D, but since every body just forwards the pack
unchanged, a single rest-param TS function reproduces all instantiations. **Do not** attempt
to model `T...` as a generic tuple type unless a body *inspects* the pack per-element by static
type (it does not, in the frontend's diagnostic helpers). If you meet a template variadic that
branches on `T[i]`'s static type or `T.length` (compile-time pack reflection) — STOP and
escalate; that is CT reflection (`07-compile-time.md`), not a simple rest param.

---

## 4. Delegates, closures, function pointers

D has two callable-value types; both map to JS functions/closures, but the **`this`-capture**
distinction is the trap.

| D type | Captures context? | Frontend example | TS form |
|---|---|---|---|
| `R delegate(P)` | **YES** — captures `this` / enclosing locals | dmd/dsymbol.d:73 | closure / arrow |
| `R function(P)` | **NO** — bare code pointer, no context | dmd/expressionsem.d:2259 | plain function value |

### 4.1 Delegate parameters → closures

**BEFORE (D)** — dmd/dsymbol.d:73 / dmd/mtype.d:3988
```d
int foreachDsymbol(Dsymbols* symbols, scope int delegate(Dsymbol) dg) { ... dg(s) ... }
void modifiersApply(const TypeFunction tf, void delegate(string) dg) { ... }
```

**AFTER (TS)** — a function-typed param; `scope` erases (§6)
```ts
function foreachDsymbol(symbols: Dsymbols | null, dg: (s: Dsymbol) => number): number { ... }
function modifiersApply(tf: TypeFunction, dg: (s: string) => void): void { ... }
```

### 4.2 Delegate literals / lambdas → arrows

**BEFORE (D)** — dmd/dsymbolsem.d:3245
```d
tm.members.foreachDsymbol(s => s.addMember(argscope, tm));
```

**AFTER (TS)**
```ts
foreachDsymbol(tm.members, (s) => s.addMember(argscope, tm));
```
(The `tm.members.foreach…` → `foreach…(tm.members, …)` rewrite is UFCS — see §6.)

### 4.3 THE `this`-capture pitfall — DECISIVE

**Fact (verified by probe):** `&c.getN` produces a **bound** delegate: mutating `c.n` to 99
after binding, then calling the delegate, returns 99. The delegate carries the receiver.

> **In D, a delegate taken from a method (`&obj.method`) is permanently bound to `obj`.
> In JS, a method referenced as a value (`obj.method`) loses `this` — calling it later throws or
> reads `undefined`.** This is the single most dangerous mistranslation in this doc.

**Canonical rule:** whenever D forms a delegate from a method — `&obj.method`, or passing a
method where a `delegate` is expected, or capturing `this` inside a nested function — the TS
translation MUST bind the receiver, using an **arrow that closes over the receiver**:

**BEFORE (D)**
```d
int delegate() dg = &c.getN;   // bound to c
```

**AFTER (TS)** — arrow preserves `this`/receiver; NEVER `const dg = c.getN`
```ts
const dg: () => number = () => c.getN();   // arrow re-binds c at call time
```
- `() => c.getN()` (arrow wrapper) is canonical. `c.getN.bind(c)` also works but the arrow is
  preferred — it reads at the call site and survives TS's `noImplicitThis`.
- **That preference is scoped to delegate capture (`&obj.method`), and it inverts when the
  ANNOTATION is what selects an overload.** Inside `(cb) => x.m(cb)` the call re-resolves
  against `m`'s overload set and takes the FIRST match, so an annotated arrow fails to compile
  where the annotated `x.m.bind(x)` — checked directly against the target type — succeeds
  (verified with tsc on `Array.each`, `08 §2.6`). A `.bind` in that position is correct, not a
  §4.3 violation; it is a recurring false-positive review finding.
- A bare `const dg = c.getN;` is **forbidden** — it is the silent `this`-loss bug.
- Inside a method, a nested arrow that uses `this` is correct *because arrows inherit `this`*.
  A nested `function(){}` would NOT — so **nested closures are always arrows** (see §5).

### 4.4 Function pointers (`R function(P)`) → plain function values

**BEFORE (D)** — dmd/expressionsem.d:2259
```d
void checkOverriddenDtor(FuncDeclaration f, Scope* sc, Loc loc,
            scope bool function(DtorDeclaration) check, const string checkName) { ... check(dd) ... }
```

**AFTER (TS)** — same function type; there is no context to preserve
```ts
function checkOverriddenDtor(f: FuncDeclaration, sc: Scope, loc: Loc,
            check: (d: DtorDeclaration) => boolean, checkName: string): void { ... check(dd) ... }
```
**Invariant:** a `function` pointer has no `this`. A plain stateless arrow/function value is the
faithful map; do NOT bind a receiver to it. If a call site passes `&freeFunction` to a
`function`-typed param, the TS value is just the function reference (no wrapper needed). The
distinction matters only against §4.3: `function` = no capture, `delegate` = capture.

---

## 5. Nested functions → inner closures (arrows)

D nested functions capture enclosing locals by reference and are common in the frontend (helper
subroutines inside a long semantic pass).

**BEFORE (D)** — dmd/dcast.d:2095 (nested `ok`, `tryAliasThisCast`, `fail` capture `e`, `t`,
`sc`, `att`, `hasAliasThis`)
```d
Expression castTo(Expression e, Scope* sc, Type t, ...)
{
    Expression ok() { auto r = new CastExp(e.loc, e, t); r.type = t; return r; }   // captures e, t
    Expression fail() { ... error(e.loc, "cannot cast ...", e.toChars(), ...); return ErrorExp.get(); }
    ...
}
```

**AFTER (TS)** — inner `const` arrows; they inherit `this` and close over locals
```ts
function castTo(e: Expression, sc: Scope, t: Type, /* ... */): Expression {
  const ok = (): Expression => { const r = new CastExp(e.loc, e, t); r.type = t; return r; };
  const fail = (): Expression => { error(e.loc, "cannot cast ...", e.toChars(), /* ... */); return ErrorExp.get(); };
  // ...
}
```
**Invariants:**
- **Always arrows, never `function(){}`** for nested functions — arrows inherit the enclosing
  method's `this`, matching D's nested-function context capture (§4.3).
- D nested functions can be mutually recursive and forward-referenced; TS `const` arrows are
  NOT hoisted. If a nested function is *called before its textual definition* (forward
  reference within the body), declare it with a `function` declaration (which IS hoisted) at the
  top of the body — but if it references `this`, you must instead arrow it AND reorder so
  definition precedes use. If reordering is impossible (true mutual recursion across the
  capture boundary), STOP and escalate.
- A nested function captures **by reference** in D: a later mutation of an enclosing local is
  visible inside the closure (and vice versa). JS closures capture the variable binding (also
  by reference for `let`/`var`) — this matches. But beware `03-value-semantics.md`: if the
  captured local is a *struct*, D captures the variable (the struct storage), so mutations
  through the closure hit the same storage — do NOT `.copy()` on capture.
- **Ported-but-not-yet-called nested closures** (stub-first fills where only one dispatch arm
  is live, e.g. `resolve`'s `returnExp`/`returnSymbol`/`returnError` setters while only the
  Tident arm runs): `tsconfig` has `noUnusedLocals`, so the faithful-but-uncalled closure is a
  compile error. **Canonical suppression: a `void fn;` statement** right after the definition,
  with a one-line comment naming what will call it. Do NOT underscore-rename (breaks
  1:1 name fidelity) and do NOT delete the closure (the next wave would re-derive it).
- **The same idiom applies at MODULE level** for a faithfully-ported D function with zero call
  sites (a D-dead `private` free function, e.g. `access.d:64`): `void fn;` after the
  definition with the comment `// no D call sites; kept for 1:1 fidelity` (there is no future
  caller to name). Export-widening and deletion are both forbidden; this is the only tool.
  The same holds for a D-dead module-private manifest constant (`inlinecost.d:44`
  `STATEMENT_COST_MAX` → `void STATEMENT_COST_MAX;`).
- **Third case: a WRITE-ONLY LOCAL whose only reader was a resolved-OFF branch.** When a
  `static if` / `version` block is the sole reader of a local and `07-compile-time.md` resolves
  that block away, the faithful port keeps the declaration and its writes (D declares and
  assigns them too) and suppresses the unused-local error the same way: `void _arguments;`
  (`semantic3.ts:1222`, whose reader is the `static if (!IN_LLVM)` at `semantic3.d:1157`),
  `void old_loc;` (`errors.ts:621`), `void LOGDOTEXP;` (`mtype.ts:140`). The comment names the
  resolved-away branch that read it. Both review lenses have flagged this shape as invented
  code, so the comment is what stops the re-litigation: the local is D's, the `void` is ours.

---

## 6. UFCS (Uniform Function Call Syntax)

**Fact (verified):** `s.toDString()` calls the **free function** `toDString(inout(char)* s)`
declared at dmd/root/string.d:17 — `s` is the *first argument*, not a method receiver. Same for
`tm.members.foreachDsymbol(dg)` (dmd/dsymbolsem.d:3245) → the free function
`foreachDsymbol(symbols, dg)` (dmd/dsymbol.d:73), and `udas.each!(...)` (dmd/attribsem.d:72) →
`each(udas, ...)`.

**How to detect UFCS:** `x.foo(y)` is UFCS (not a method call) **iff `foo` is NOT a member of
`x`'s type** but IS a free function whose first parameter accepts `x`'s type. When translating a
call `x.foo(args)`, first check: does `typeof(x)` declare a method `foo`? If yes → method call,
translate as `x.foo(args)`. If no → it is UFCS, and `foo` is a free function.

**PAREN-LESS UFCS is the trap: `x.name` with no arguments and no parens looks exactly like a
field read.** D lets a zero-argument UFCS call drop its parens, so `expressionsem.d:6706`'s
`if (!sc.hasThis)` is a call to the free `hasThis(Scope*)` — `Scope` has no such member, in D or
in `dscope.ts`. The naive `this.sc.hasThis` **compiles clean**, is always truthy as a method
reference or `undefined` as a missing field, and **inverts the branch**: every nested-class
`new` would take the "no implicit this" error path. **Rule: for any `x.name` with NO parens
whose receiver type declares no such member, resolve it as UFCS before assuming a field.** The
receiver's TS class is the authority, not the shape of the expression.

**Canonical rule — DECISIVE:** rewrite every UFCS call to the explicit free-function call with
the receiver as the first argument.

**BEFORE (D)** — dmd/dsymbolsem.d:3245, dmd/expressionsem.d:16162
```d
tm.members.foreachDsymbol(s => s.addMember(argscope, tm));
new StringExp(loc, s.toDString());
```

**AFTER (TS)** — `x.foo(y)` becomes `foo(x, y)`
```ts
foreachDsymbol(tm.members, (s) => s.addMember(argscope, tm));
new StringExp(loc, toDString(s));
```
**Invariant:** the receiver becomes the **first** positional argument, in front of all explicit
args. Preserve evaluation order: `x` is evaluated before `y` in both forms, so no reordering of
side effects. If you cannot statically determine whether `foo` is a method or a free function
(ambiguity, e.g. both exist) — STOP and escalate; emitting the wrong form silently calls the
wrong code.

> **ANTI-PATTERN (absolute): a UFCS free function is NEVER promoted to a method on the receiver
> class.** Not when the receiver class is being ported in the same batch, not when the method
> form is more convenient, not when the free function's module is not yet translated. A D free
> function is emitted as a free function **in the TS module mirroring its D module**, full stop
> (`01-conventions.md` Rule 1.1). Re-homing (the old port moved ~20 `typesem.d` free functions
> onto `Type` in `mtype.ts`) breaks the file-level 1:1 diff, breaks every not-yet-ported D
> caller that imports the free function, and entangles two modules' translation states. If a
> cross-module value import would create a load cycle, that is `01-conventions.md` Rule 4.3/4.4
> (deferred import) — never a relocation.
>
> **CONSUMING an already-re-homed symbol** (the rung-era tree carries some — notably D
> `toBool` → `Expression.toBool`, D `toBasetype` → `Type.toBasetype`): when your file's D
> source selectively imports such a free function and the faithful export does not exist,
> **call the method form the tree has**, mark the site
> `// re-homed: D free fn <module>.<name> — sweeps at <owner file> retranslation`, and file a
> `dependency signature` escalation (`11-escalate.md §1`). Never re-home more symbols to
> match, never define a local wrapper (that is a forbidden stand-in, 11 §2.5). The re-homed
> families are unwound when their owner files are retranslated clean.
>
> **WAVE-BOUNDARY CARRY-OVER (the integrator-sanctioned exception to the anti-pattern).**
> When D homes an operation in a file of a LATER wave (`merge`/`toBasetype`/`size`/… are free
> functions in typesem.d/dcast.d — W3) but the current tree's consumers and pinned tests need
> it through THIS wave, the earlier file (mtype.ts) may CARRY the member, under all of:
> 1. carried members sit in segregated `CARRY-OVER` regions: carried FREE functions in one
>    region at the END of the file; carried CLASS members (TS cannot place methods outside
>    the class body) in an end-of-CLASS sub-region per class — plus ONE file-end
>    `CARRY-OVER INDEX` comment listing every carried member and its region;
> 2. each carries the marker
>    `// carry-over: D free fn <module>.d:<line> <name> — mis-homed until <owner> retranslation; body: rung-era, behavior-pinned by <test>`;
> 3. the BODY is the tested legacy body transplanted AS-IS — never freshly re-derived (that
>    would smuggle a later wave's translation in without its review), never new logic;
> 4. only members with live consumers or pinned tests are carried — no dead freight;
> 5. the translation report lists the carried set — it is the later wave's pick-up list.
> A marked carry-over is sanctioned and reviewers accept it as-is (content drift between the
> carried body and its D free function is the LATER wave's job, not a finding now); an
> UNMARKED mis-homed member remains a §6 finding.
>
> **The decision test at a CONSUMER site, decidable in one read:** does the owner file carry a
> `// carry-over:` marker for the symbol? **YES** → consume it silently — no marker, no
> escalation; it is already recorded where it belongs. **NO** → mark your site `// re-homed:`
> and file the `dependency signature` record.
>
> **The faithful export wins wherever it exists.** *If the owner's TS module exports the
> faithful free function, the consumer MUST call it.* A carried method on the receiver class is
> for consumers that have no other option, and it is never the default — one file made 27 calls
> in the carried method form against exports that existed, with no markers at all. Because the
> `// re-homed:` marker asserts a negative, it must carry the check:
> `// re-homed: <name> — no faithful export in <owner>.ts (checked: grep "export function <name>(" src/dmd/<owner>.ts)`.
> Three sites in one file carried the marker while the faithful export existed and was imported
> sixty lines above, and it read past two reviewers.
>
> **Consumer-side marking is TIERED.** Per-site `// re-homed:` up to about 5 sites of one
> family; above that, ONE consolidated block at the top of the consuming file, listing the
> families and their site counts. The OWNER file's `// carry-over:` marker is the primary
> record; the consumer marker exists so a grep finds the consuming FILE, not so every
> expression carries a comment (one file consumes 11 families at ~276 call sites — 276
> identical lines would bury the signal).
>
> **A carried member MUST be EXPORTED.** A carried body declared `function` rather than
> `export function` is invisible to the consumers it exists for, and drives them into walls
> over a symbol the tree already contains.
>
> **RETIREMENT — the carry-over's other end.** When the owner file starts exporting the
> faithful symbol, the carrier (a) DROPS the carried body; (b) imports the name from the owner
> and re-exports it while other files still address it, marked at that line; (c) files ONE
> `dependency signature` escalation naming every importer the integrator must repoint. Until
> (a) happens, **a consumer MUST import from the D-faithful home**: a symbol exported both from
> its home and from a carrier hands a fresh translator two equally-plausible imports and no
> rule to choose between them.
>
> **The UN-PICK is done by the compiler, never by grep.** Delete the marked members FIRST, then
> let `tsc --noEmit` enumerate the consumers: TS2339/TS2551 name the RECEIVER TYPE at every
> site, which settles the §6.1 same-name hazard for free. Done by grep, one wave would have
> mis-flipped five families sharing a name (`size` Type vs Dsymbol, `merge` Type vs Scope,
> `alignment`, `search`/`insert` Dsymbol vs Scope, `inferType` Initializer vs Expression). Watch
> for the one thing tsc cannot tell you: removing a carried member can silently drop a D
> DECLARATION-SITE INITIALIZER the carried code stood in for (`TypeTuple.empty`, mtype.d:1927,
> was exactly that).
>
> **§6 or a §2.5 wall?** §6 covers a symbol whose D HOME is a later wave's file AND whose tested
> body already exists; `11 §2.5` covers a callee never ported at all. Where a rung-era helper's
> D home is a module nobody has ported (`arrayop.d`), the site stays WALLED — the port of that
> module closes it in the burn-down. A carry-over marker is not a licence to resurrect a
> rung-era body.
>
> **Rule 3 protects the BODY, not the markers.** Normalizing a transplanted body's wall
> messages and D cites to the current convention (`(dmd/<f>.d:<n>)`) is not re-deriving it, and
> is expected: a carried region passes the same audit greps as the rest of the file (`14 §3`).

> Chained UFCS (`a.f().g()` where both are free) unwinds inside-out: `g(f(a))`. The
> `s.toPrettyChars().toDString()` chain at dmd/expressionsem.d:16174 → `toDString(toPrettyChars(s))`
> *only if* `toPrettyChars` is also free; if it is a method, it stays `toPrettyChars(s)` as a
> method on the result. Resolve each link independently by the detection rule above.

### 6.1 Same-named free functions in DIFFERENT modules — resolve per call site, never by grep

**Hazard (hit twice in Rung 4b).** The frontend has UFCS families that share a name across
modules, distinguished only by the first-parameter type *and* by which module each call site
imports — sometimes via a **function-local selective import**:

- `size(Type t, Loc loc)` lives in **typesem.d:1602**, while `size(Dsymbol _this, Loc loc)`
  lives in **dsymbolsem.d:383**. Inside one function, dmd switches family mid-body:
  `dsym.type.size()` resolves to the typesem one (module-level `import dmd.typesem;`), while
  three lines later `sym.size(loc)` resolves to the dsymbolsem one via a **local**
  `import dmd.dsymbolsem : size;` (e.g. dmd/typesem.d:1744, dmd/dsymbolsem.d:8438).
- A nested/static helper can shadow the real target for a grep: `mtype.d:541` contains a
  nested `static Type merge(Type t)` inside `Type`'s init code — it is NOT what `t.merge()`
  resolves to (that is the free `merge` at typesem.d:3514).

**Canonical rule:** locate a UFCS target by reading the call-site module's **imports**
(module-level *and* function-local) and matching the **first-parameter type** — never by a
repo-wide grep for the name. When D splits one name across modules by first-arg type, the TS
port gives each its own name following the existing **overload-pair convention** — the
receiver-type suffix, as in `checkDeprecated(Dsymbol)` / `checkDeprecatedType` and
`hasPointers(Type)` (typesem.ts) / `hasPointersDsymbol` (dsymbolsem.ts) — and each interface
comment cites which D `size`/`merge`/… it models, so the families never re-conflate.

**REGISTERED FAMILIES** (verified; extend by docFeedback). Where both forms keep the bare
name, the consumer aliases at the import as `<module><Name>` (`import { trySemantic as
typesemTrySemantic }`, `01 §3.3`) — it does NOT rename the export, which belongs to the owner file:

| D family         | D homes (the FIRST parameter decides)                                                    | TS spelling                                                                                                          |
|------------------|------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| `trySemantic`    | expressionsem.d:15580 (`Expression`, `Scope`) / typesem.d:4779 (`Type`, `Loc`, `Scope`)  | both BARE, in their own modules — every consumer aliases                                                             |
| `equals`         | expressionsem.d:919 (`Expression`) / dsymbolsem.d:1049 (`Dsymbol`)                       | both BARE, in their own modules — every consumer aliases. Neither is a method: 1.43's `rootobject.d` has no `equals` |
| `implicitConvTo` | a D overload PAIR in dcast.d (`Expression` / `Type`)                                     | `implicitConvTo` (Expression) / `implicitConvToType` (Type), both in `dcast.ts`                                      |
| `inferType`      | dcast.d:3213 (`Expression`, `Type`) / initsem.d:1221 (`Initializer`, `Scope`)            | `inferType` (dcast.ts) / `inferTypeInitializer` (initsem.ts)                                                         |
| `checkLabel`     | statementsem.d:5100 (`SwitchStatement`, private) / statementsem.d:5144 (`GotoStatement`) | `checkLabelSwitchStatement` / `checkLabel` — the Goto form keeps the bare name, being the cross-module contract      |

**`hdrgen.d`'s printer overload sets** — `toChars`, `toErrMsg` and `toCBuffer` — are each one D
name over several first-parameter types. They take PREFIX names, receiver type first, the
spelling the tree already exports (`typeToChars`, `typeToCBuffer`, `expToCBuffer`,
`templateParameterToCBuffer`, `rootObjectToErrMsg`, `dsymbolToErrMsg`); this is the exception
§1 Form B rule 2 points at. The one bare name is `toErrMsg` itself, which the tree gives to the
`Expression` member of the `toErrMsg` set:

| D overload                                | D line          | TS name                      |
|-------------------------------------------|-----------------|------------------------------|
| `toChars(const Statement)`                | `hdrgen.d:195`  | `statementToChars`           |
| `toChars(const Expression)`               | `hdrgen.d:204`  | `expressionToChars`          |
| `toChars(const Initializer)`              | `hdrgen.d:212`  | `initializerToChars`         |
| `toChars(const Type)`                     | `hdrgen.d:220`  | `typeToChars`                |
| `toChars(const Dsymbol)`                  | `hdrgen.d:231`  | `dsymbolToChars`             |
| `toString(const Initializer)`             | `hdrgen.d:267`  | `initializerToString`        |
| `toErrMsg(const RootObject)`              | `hdrgen.d:112`  | `rootObjectToErrMsg`         |
| `toErrMsg(const Expression)`              | `hdrgen.d:126`  | `toErrMsg`                   |
| `toErrMsg(const Dsymbol)`                 | `hdrgen.d:138`  | `dsymbolToErrMsg`            |
| `toCBuffer(Dsymbol)`                      | `hdrgen.d:980`  | `dsymbolToCBuffer`           |
| `toCBuffer(const TemplateParameter)`      | `hdrgen.d:3218` | `templateParameterToCBuffer` |
| `toCBuffer(const Statement)`              | `hdrgen.d:3344` | `statementToCBuffer`         |
| `toCBuffer(const Type, …, Identifier, …)` | `hdrgen.d:3349` | `typeToCBuffer`              |
| `toCBuffer(const Initializer)`            | `hdrgen.d:3364` | `initializerToCBuffer`       |
| `toCBuffer(const Expression)`             | `hdrgen.d:3578` | `expToCBuffer`               |

The two families are different functions: `toErrMsg(const Expression)` sets `hgs.errorMsg` and
truncates at 60 characters, `toChars(const Expression)` does neither. A consumer that wants D's
`e.toChars()` must not call `toErrMsg`. Where the owner has not emitted a name yet, consumers
wall those call sites (`11 §2.5`) under the name in this table — they do not invent another
spelling.

Same shape, and just as easy to get backwards: `isExpression` / `isType` / `isDsymbol` are FREE
functions (`dtemplate.d:78/86/94` → `dtemplate.ts:98/105/112`) reached by UFCS, **not**
`RootObject` methods — `rootobject.d` declares none of them. Writing the method form does not
compile, whatever a manifest row may say.

**The dangerous variant of that mistake is the one that DOES compile.** Where a base class
carries a same-named method that returns a constant (a `Type.isIntegral()` returning `false`
for every type, over the real `isIntegral(Type)` free function in `typesem.ts`), the method
form type-checks, runs, and answers wrongly everywhere — the free-function-vs-method axis of
the silent miscompile `13 §7.5` rule 1 exists to prevent. Resolve `x.name()` against the D
source's home for `name`, not against whatever the receiver class happens to expose.

---

## 7. Contracts: `in` / `out` / `do` / `invariant`

**Facts (verified):**
- `in { assert(...); }` precondition + `do { ... }` body — dmd/identifier.d:56.
- `out(result) { assert(...); }` postcondition + `do { ... }` body — dmd/target.d:1464.
- 157 contract sites total (ground-truth §4). No `invariant {}` aggregate-level blocks appear
  to be used as runtime checks the port must keep (the `invariant` token hits are diagnostics
  text and `clone.d` invariant-*generation* logic, which is normal ported code).

### Canonical rule — DECISIVE

> **`in`/`out` contracts → inline `assert` calls at the top (in) and just before each `return`
> (out) of the function body. The `do { }` wrapper → just the function body (drop the `do`
> keyword). `invariant {}` blocks on a struct/class → drop (state below).**

The contained `assert`/`enforce` expressions port to the runtime `assert` helper per
`10-tests-diagnostics.md` — this doc only specifies the *placement transform*.

**BEFORE (D)** — dmd/identifier.d:56 (`in` + `do`)
```d
this(const(char)* name, size_t length, int value)
in { assert(name[length] == '\0'); }
do { this(name[0 .. length], value); }
```

**AFTER (TS)** — `in` body becomes leading asserts; `do` body becomes the function body
```ts
constructor(name: CStr, length: number, value: number) {
  assert(name[length] === 0);            // from `in` contract
  // ... `do` body ...
}
```

**BEFORE (D)** — dmd/target.d:1464 (`out(result)` + `do`)
```d
@property bool isPOSIX() scope const nothrow @nogc @safe
out(result) { assert(result || os == Target.OS.Windows); }
do { return (os & Target.OS.Posix) != 0; }
```

**AFTER (TS)** — capture the return value, assert, then return; attributes + `@property` erase
```ts
get isPOSIX(): boolean {            // @property -> getter (see §9); all attrs erase (§8)
  const result = (this.os & Target.OS.Posix) !== 0;
  assert(result || this.os === Target.OS.Windows);   // from `out(result)` contract
  return result;
}
```
**Invariants:**
- An `out(result)` contract names the return value; introduce a `const result = <expr>;`,
  assert, then `return result;`. For an `out { }` with no named result, the postcondition has no
  return access — place the asserts before the (single) `return`.
- Multiple `return` paths in the body: the `out` asserts must run on **every** return. Either
  factor the body so there is one exit (`const result = …; <out-asserts>; return result;`) or
  duplicate the assert block before each `return`. Prefer the single-exit factoring; it is
  faithful (the contract runs once on the actual returned value).
- **Do not silently drop `in`/`out` asserts** — they are real runtime checks in a non-`-release`
  build, and the corpus may depend on the resulting error. Per `crash-only-recovery.md` /
  boundary-validation discipline, an assert that fires is a loud halt, which is correct.
- `out` **parameters** (`out bool asterisk`, dmd/chkformat.d:550; `out Expression eresult`,
  dmd/inline.d:2033) are a SEPARATE construct — NOT contracts. They are by-reference output
  params. Translate per the ref/out-parameter rule in `03-value-semantics.md` (a holder/box or
  return-tuple), not as contract asserts. Distinguish by position: `out` *inside the parameter
  list* = out-param; `out` *after the parameter list* = contract.
- `invariant {}` (aggregate-level): if you encounter one as a runtime self-check, **drop it**
  with `// dropped: invariant block (no -invariant build; checks are CTFE-irrelevant)`. The port
  targets the lex→sema→CTFE pipeline, not a `-invariant` runtime. If an `invariant` is
  load-bearing for a corpus test outcome — STOP and escalate.

---

## 8. Attribute erasure

**Fact / counts (grep):** `@safe` 827, `nothrow` 727, `pure` 706, `@nogc` 354, `@trusted` 114,
`@system` 74, `scope const` 65, `return scope` 37, `@live` 6.

**Canonical rule — DECISIVE: nearly every D function attribute ERASES in the TS port.** They are
compile-time guarantees about purity, memory, exceptions, and lifetimes that have **no
JS-visible runtime effect** and no effect on the lex→sema→CTFE *result* we compute. Strip them.

| D attribute | JS-visible effect? | Action |
|---|---|---|
| `pure` | none | **ERASE** |
| `nothrow` | none (JS has no checked exceptions) | **ERASE** |
| `@nogc` | none (JS is GC'd; allocation is implicit) | **ERASE** |
| `@safe` / `@trusted` / `@system` | none | **ERASE** |
| `const` / `immutable` / `inout` on method (trailing `const`) | none at runtime | **ERASE** (optionally `readonly` on fields per `02-types.md`) |
| trailing `inout` on a method (`T get() inout`) | none — const-transfer qualifier | **ERASE** (like trailing `const`/`immutable`) |
| `inout(T)` wrapper on a param/return type (`inout(T) get()`) | none — const-transfer qualifier | **ERASE the wrapper, KEEP `T`** (`inout(T) get() inout` → `get(): T`) |
| `scope` (storage class on param) | none — escape analysis only | **ERASE** |
| `return` / `return scope` | none — lifetime annotation | **ERASE** |
| `@live` (ownership/borrow checking) | none — CT analysis | **ERASE** |
| `ref` / `out` (parameter storage) | **YES** — pass-by-reference semantics | **KEEP** — see `03-value-semantics.md` |
| `static` (on method) | **YES** — no `this` | **KEEP** as `static` |
| `override` / `abstract` | **YES** — virtuality | **KEEP** per `02-types.md` (class doc) |
| `final` (on a method or class) | none expressible — **TS has no `final`** | **ERASE** (keep any adjacent `override`); `override final f()` → `override f()` |
| `extern(C++)` / `extern(D)` | none in JS (ABI/mangling) | **ERASE** the linkage; mangling logic lives in `mangle/` and is ported as code, not as a linkage attribute |

**BEFORE (D)** — dmd/mtype.d:415, dmd/target.d:1464, dmd/root/optional.d:79
```d
const(char)* kind() const nothrow pure @nogc @safe { ... }
@property bool isPOSIX() scope const nothrow @nogc @safe out(result){...} do { ... }
inout(T) get() inout { assert(present); return value; }   // both inout forms in one decl
```

**AFTER (TS)** — attribute soup gone; only structure remains
```ts
kind(): CStr { ... }
get isPOSIX(): boolean { ... }   // @property -> getter (§9); out(result) -> assert (§7)
get(): T { assert(this.present); return this.value; }   // inout(T) wrapper + trailing inout both erase, T kept
```
**Invariants:**
- Erasing `pure`/`nothrow`/`@nogc`/`@safe` is **always correct** for this port — these never
  alter the value the frontend computes; they only constrained the D source. There is no case
  where keeping them affects output.
- `scope`/`return`/`@live` are escape/lifetime analysis consumed by D's *own* compilation, not
  by the algorithm we run. Erase. (Do not confuse `scope` the **storage class** here with
  `scope(exit/success/failure)` the **statement** — that is owned by `06-control-flow.md`.)
- `ref` and `out` are the exceptions: they change *parameter passing* (by reference), which IS
  observable. Keep them — translation is owned by `03-value-semantics.md`.
- Record nothing in comments for routine attribute erasure (it is uniform and expected); the
  diff stays clean. Only comment when an attribute drove a `static if`/`version` choice
  (`07-compile-time.md`).

---

## 9. `@property` functions

**Fact (verified):** all 32 `@property` uses in the frontend are **getters** (read-only). No
`@property void foo(T)` setter form exists in the source. Examples: `Target.isPOSIX`
(dmd/target.d:1464), `compiler.front`/`empty`/`totalLength` (range-style getters,
dmd/compiler.d:188-191), `console.fp` (dmd/console.d:121).

**Canonical rule — DECISIVE: a zero-arg `@property` getter → a TS `get` accessor. A one-arg
`@property` setter (none in current frontend) → a TS `set` accessor.**

**BEFORE (D)** — dmd/compiler.d:188
```d
@property auto totalLength() const { return packages.length + 1 + (isPackageFile ? 1 : 0); }
@property auto empty() { return index >= totalLength(); }
```

**AFTER (TS)** — `get` accessors; call sites that read `x.totalLength` (no parens) stay unchanged
```ts
get totalLength(): number { return this.packages.length + 1 + (this.isPackageFile ? 1 : 0); }
get empty(): boolean { return this.index >= this.totalLength; }
```
**Invariants:**
- D `@property` lets the call site omit parens (`x.empty` not `x.empty()`). A TS `get` accessor
  matches this exactly — call sites read `x.empty`. **Preserve the no-parens call form** when
  translating call sites of a `@property`.
- D *also* permits calling a `@property` getter *with* parens (`x.empty()`); if a call site in
  the source writes `x.totalLength()`, drop the parens in TS (a `get` accessor is not callable).
  Detect by: the symbol is declared `@property` → it is a getter, never `()` at the call site.
- A *free function* marked `@property` and invoked UFCS-style (`x.prop`) is rare; if you meet
  one, it cannot be a class `get` accessor — translate it as a free function `prop(x)` (the
  UFCS rule §6 governs), and rewrite the call site to `prop(x)`. If genuinely ambiguous —
  STOP and escalate.
- If you ever encounter a `@property` **setter** (`@property void name(T v)`) added in future
  upstream, translate it to a `set name(v: T)` accessor and keep `x.name = v` call sites. None
  exist today; flag if found.

**`@property` is NOT required for property-call syntax.** D applies the no-parens (getter) and
assignment (setter) call forms to **any** member function of the right arity, regardless of the
`@property` attribute: a 0-arg member `T name()` may be called `x.name`, and a 1-arg member
`void name(T v)` may be called `x.name = v`. The 32-getters fact above counts only *attributed*
`@property` uses — it does **not** mean these are the only property-style call sites. So a method
**without** `@property` can still be invoked with property syntax at its call sites, and the
canonical port is the same: emit `get`/`set` accessors and rewrite the call sites accordingly.

**BEFORE (D)** — dmd/root/bitarray.d:26-44 — a getter/setter *pair* named `length`, no `@property`
```d
size_t length() const @nogc nothrow pure @safe { return len; }
void length(size_t nlen) nothrow pure { ... len = nlen; }       // setter form, dmd/root/bitarray.d:31-44
// call sites (unittest, dmd/root/bitarray.d:160,166):
array.length = 20;          // setter call: assignment syntax, no parens
assert(array.length == 20); // getter call: no parens
```

**AFTER (TS)** — `get`/`set` accessor pair; assignment and read call sites stay unchanged
```ts
get length(): number { return this.len; }
set length(nlen: number) { /* ... */ this.len = nlen; }
// call sites:
array.length = 20;          // unchanged: set accessor
assert(array.length === 20);// unchanged: get accessor
```

**Detection rule:** do not key on `@property` alone. A 0-arg member function read at a call site
*without* parens (`x.name`) → `get name()`. A 1-arg `void` member assigned at a call site
(`x.name = v`) → `set name(v: T)`. A getter/setter pair sharing one name (as `length` above) →
one `get`/`set` accessor pair on the same property. Drive the decision from the **call sites**,
not only the declaration's attribute.

**A DEPENDENCY may already spell the pair as two METHODS — read the receiver's TS, not D's
declaration.** Where a getter/setter pair could not become accessors (the §1B tie-break gives
the setter its own name), the tree spells them `name()` and `name_set(v)`. `Dsymbol` does
exactly this: `userAttribDecl()` (`dsymbol.ts:661`) and `userAttribDecl_set(uad)` (`:674`),
plus `depdecl_set` (`:666`), `cppnamespace_set` (`:670`), `ddocUnittest_set` (`:1024`). Against
such a receiver the READ is a CALL (`m.userAttribDecl()`) and the WRITE is `_set(…)` — D's
field form gains parens on read instead of losing them.

Emitting D's field form against that receiver gets you a tsc error on every WRITE and **silence
on every READ**: `m.userAttribDecl` is a method object, so `if (m.userAttribDecl !== null)` is
always true and the *function itself* flows onward as a value. One file fed a method into
`dsymbolSemantic` that way and took 32 tests down with `dsym.accept is not a function`; only
vitest found it. **Audit item:** a bare `x.someProp` in a truth test or comparison where
`someProp` is a method on the receiver's type. `grep -h '_set(' src/dmd/*.ts` enumerates every
pair the tree spells this way (today `cppnamespace`, `ddocUnittest`, `depdecl`,
`userAttribDecl`, all on `Dsymbol`).

---

## 10. Quick decision cheats (for fast lookup)

| You see… | Do this |
|---|---|
| 2–3 overloads, shorter = prefix of longer | one fn, optional trailing params (§1 Form A) |
| same-arity overloads, different param types | rename `<name>From<Type>`, rewrite call sites (§1 Form B) |
| two C-variadics, one extra leading `Loc` | with-`Loc` keeps name; no-`Loc` → `<name>NoLoc` (§1.1a) |
| ≥2 same-arity overloads, diff 2nd-param type/return | primary keeps name; others get type suffix (§1.1b) |
| two same-arity ctors, diff param type | one stays `constructor`; other → `static from<Type>` (§1.1c) |
| param `= value` | TS default param, same value (§2) |
| `..., format, ...` + `va_list` | `...args: unknown[]`; format owned by 10-tests (§3.1) |
| `T[] xs...` | `...xs: T[]`; spread arrays at call sites (§3.2) |
| `(T...)(... T args)` forwarding | `...args` + spread forward (§3.3) |
| `delegate(P)` param | closure `(p) => …` (§4.1) |
| `&obj.method` | arrow `() => obj.method()` — NEVER `obj.method` (§4.3) |
| `function(P)` param | plain function value, no binding (§4.4) |
| nested function in a body | inner `const` arrow (§5) |
| `x.foo(y)`, `foo` not a member of `x` | `foo(x, y)` (UFCS, §6) |
| `in {…}` / `out(r){…}` / `do {…}` | leading/trailing asserts; drop `do` (§7) |
| `out T param` *in param list* | ref/out param → `03-value-semantics.md` (§7) |
| `pure nothrow @nogc @safe scope return @live const` | ERASE all (§8) |
| `ref` / `out` param storage | KEEP → `03-value-semantics.md` (§8) |
| `@property T foo()` | `get foo(): T` (§9) |
