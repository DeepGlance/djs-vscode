# 13 — The Visitor Pattern (`Visitor`, `accept`, the `(AST)` template, the visit-mixins)

> **STOP rule (read first):** if you meet a visitor construct this doc does not cover — a node
> whose base class you cannot place in the hierarchy, an `accept` that calls something other than
> `v.visit(this)`, a mixin you cannot resolve at translation time, or any ambiguity about which
> named method an overload becomes — **STOP and escalate** (`11-escalate.md`). Never guess. The
> visitor is the spine of every `*sem` pass; a wrong dispatch silently mis-routes whole node
> classes and the bug surfaces hundreds of files away.

Read `_ground-truth.md` first. This doc owns the **one canonical translation of the DMD frontend's
Visitor pattern** — the single `extern(C++) class Visitor` overload set, each node's `accept`, the
`(AST)` template parameter, the default-forwarding overloads, and the mixin-generated visit
methods. It supersedes the earlier blocker notes recorded inside the STOP-stubbed
`src/dmd/visitor/*.ts` (parsetime/strict/permissive/transitive) — **GAP A and GAP B in those files
are RESOLVED here.** Re-translate those files per this rule once the node headers exist (§8).

This is the resolution for the three pilot/foundation visitor blockers:
**(1)** the `void visit(NodeType)` overload set, **(2)** the `(AST)` namespace-template parameter,
**(3)** the per-overload static-forwarding bodies that a single TS `visit` cannot carry.

---

## 0. THE CRITICAL RULE (it governs everything below)

D's `Visitor` is **one method name, `visit`, overloaded ~290 times** — one `void visit(X)` per AST
node type `X` (`dmd/visitor/package.d:26-91`, `dmd/visitor/parsetime.d:19-304`). TypeScript has
**no runtime method overloading**: a class may declare overload *signatures*, but it gets exactly
**one implementation body**, and dispatch is by the value's runtime shape, not its static type.
A D visitor needs N *distinct bodies* (one per node), statically selected by the node's concrete
type. The single-body TS form cannot express that.

**The resolution: rename each overload to a distinct named method.** Method name = the literal
string `"visit"` + the node class's name:

| D overload | Canonical TS method |
|---|---|
| `void visit(IntegerExp e)` | `visitIntegerExp(e: IntegerExp): void` |
| `void visit(Expression e)` | `visitExpression(e: Expression): void` |
| `void visit(Type t)` | `visitType(t: Type): void` |
| `void visit(Dsymbol s)` | `visitDsymbol(s: Dsymbol): void` |
| `void visit(VarDeclaration s)` | `visitVarDeclaration(s: VarDeclaration): void` |

The dispatch that D's overload resolution did *statically* is recovered by each node's `accept`
calling **its own** named method (§2). This is THE faithful, idiomatic TS visitor — it is not a
fallback, not a Form-B rename of last resort. There is exactly one canonical name per node, so all
parallel translation agents stay consistent.

> **Why not a runtime type-switch in one `visit` body?** A `switch (node.constructor)` / chain of
> `instanceof` inside a single `visit` would re-implement overload resolution at runtime, be O(N)
> per dispatch, drift from the class hierarchy, and — fatally — break the `accept` double-dispatch
> every `*sem` pass depends on. Do not do it. The named-method + `accept` form below is mandatory.

> **Why not keep TS overload signatures on one `visit`?** TS overload *signatures* share **one
> body**; you would still have nowhere to put the N distinct forwarding/visiting bodies. The
> signatures-only form is what the current stubs tried and is precisely the blocker (GAP B) this
> doc removes. Rename to N methods.

---

## 1. The named-method renaming table (the mechanical rule)

For **every** `void visit(NodeType node)` overload — in the base `Visitor`, in `ParseTimeVisitor`,
and in every subclass — emit a TS method named `visit` + `NodeType`, same parameter, `void` return.

```d
// BEFORE — dmd/visitor/package.d:26-65 (excerpt of the single overloaded `visit`)
extern (C++) class Visitor : ParseTimeVisitor!ASTCodegen
{
    void visit(ASTCodegen.ErrorStatement s) { visit(cast(ASTCodegen.Statement)s); }   // :30
    void visit(ASTCodegen.ErrorExp e)       { visit(cast(ASTCodegen.Expression)e); }  // :64
    void visit(ASTCodegen.ComplexExp e)     { visit(cast(ASTCodegen.Expression)e); }  // :65
    // … ~60 more, each forwarding to a base ……………………………………………………………
}
```

```ts
// AFTER — one named method per node; the cast-forward becomes a call to the base's named method
export class Visitor extends ParseTimeVisitor {           // (AST) monomorphized away — §3
  visitErrorStatement(s: ErrorStatement): void { this.visitStatement(s); }   // :30
  visitErrorExp(e: ErrorExp): void             { this.visitExpression(e); }  // :64
  visitComplexExp(e: ComplexExp): void         { this.visitExpression(e); }  // :65
  // … ~60 more, each forwarding to the base's named method — §4 ……………………
}
```

Naming is purely mechanical and **case-preserving**: the node class name is appended verbatim
(`IntegerExp` → `visitIntegerExp`, `TypeInfoStructDeclaration` → `visitTypeInfoStructDeclaration`).
No abbreviation, no `From`, no numeric suffix — the node name already makes every method unique.

> **`alias visit = …visit;` lines vanish.** Every visitor subclass carries an
> `alias visit = typeof(super).visit;` (or `ParseTimeVisitor!ASTCodegen.visit`, e.g.
> `dmd/visitor/package.d:28,99,116`). Those exist solely to un-hide the base's `visit` overloads
> that the subclass's own `visit` overloads would otherwise shadow (`02-types.md §5.3`). With each
> overload now a **distinctly named** method, there is no name-hiding to undo — **drop the alias**,
> with the auditable comment `// dropped: alias visit = super.visit — no overload hiding in TS`.

---

## 2. `accept` — the double-dispatch (the load-bearing half)

Every AST node overrides `accept(Visitor v)`, and the body is **always** `v.visit(this)`
(`dmd/expression.d:740-743` for `IntegerExp`; `dmd/dsymbol.d:899`; `dmd/statement.d:253`; the root
contract is the abstract `void accept(Visitor v)` at `dmd/ast_node.d:25`). In D, `v.visit(this)`
resolves *at compile time* against `this`'s **static type** to the matching overload — that static
selection is the entire mechanism.

In TS the node knows its own concrete type, so it calls **its own specifically-named** method on
the visitor. That is the static double-dispatch, preserved exactly:

```d
// BEFORE — dmd/ast_node.d:25 (root contract) + dmd/expression.d:740-743 (IntegerExp override)
extern (C++) abstract class ASTNode : RootObject { abstract void accept(Visitor v); }   // root
// …
override void accept(Visitor v) { v.visit(this); }     // in IntegerExp — picks visit(IntegerExp)
```

```ts
// AFTER — root is an abstract method (02-types.md §2); each node calls ITS OWN named method
export abstract class ASTNode extends RootObject { abstract accept(v: Visitor): void; }   // root
// …
override accept(v: Visitor): void { v.visitIntegerExp(this); }   // IntegerExp -> visitIntegerExp
```

**The rule for every node's `accept`:** `v.visit(this)` → `v.visit<ConcreteNodeClassName>(this)`,
where `<ConcreteNodeClassName>` is the class the `accept` override lives in. `IntegerExp.accept` →
`v.visitIntegerExp(this)`; `VarDeclaration.accept` → `v.visitVarDeclaration(this)`. **Never** call
the base's method from a node's `accept` — the node dispatches to its *own* type; the base-forward
happens *inside the visitor's* method (§4), not in `accept`. Getting this wrong collapses the whole
node class onto its base and silently mis-routes it.

> **This is the half agents drop.** §1 (rename) without §2 (per-node `accept`) gives a visitor with
> the right methods that nobody calls correctly. Both halves are mandatory, exactly as
> `05-operators.md` requires both the method *and* every call-site rewrite.

---

## 3. The `(AST)` template parameter — MONOMORPHIZE to our one concrete AST

`ParseTimeVisitor(AST)`, `PermissiveVisitor(AST)`, `StrictVisitor(AST)`,
`ParseTimeTransitiveVisitor(AST)` are templated over a parameter **`AST`** that is a
*namespace-of-types*: a `struct` whose members are every AST node class. The frontend instantiates
them with **`ASTCodegen`** (`dmd/astcodegen.d:10` — `struct ASTCodegen` is exactly that bag of
`public import`s + `alias`es), e.g. `class Visitor : ParseTimeVisitor!ASTCodegen`
(`dmd/visitor/package.d:26`). A lighter parse-only AST exists in principle, but **the frontend's
live visitor stack is instantiated at exactly one `AST` = `ASTCodegen`.**

**We port one AST.** Therefore: **drop the `(AST)` parameter entirely** and reference the concrete
node classes directly. `AST.Expression` → `Expression`, `AST.Dsymbol` → `Dsymbol`, etc. — the real
ported classes from `expression.d` / `dsymbol.d` / `mtype.d` / `statement.d` (Bucket 7).

```d
// BEFORE — dmd/visitor/parsetime.d:16-26 (templated over the namespace `AST`)
extern (C++) class ParseTimeVisitor(AST)
{
    void visit(AST.Dsymbol)    { assert(0); }
    void visit(AST.Expression) { assert(0); }
    void visit(AST.Declaration s) { visit(cast(AST.Dsymbol)s); }   // :30
    // …
}
```

```ts
// AFTER — no generic; AST.X -> the concrete ported class X (Bucket 7)
export class ParseTimeVisitor {
  visitDsymbol(_s: Dsymbol): void    { assertUnreachable(); }   // assert(0) -> assertUnreachable
  visitExpression(_e: Expression): void { assertUnreachable(); }
  visitDeclaration(s: Declaration): void { this.visitDsymbol(s); }   // :30 — forwards to base (§4)
  // …
}
```

> **This RETRACTS GAP A.** The current `parsetime.ts` models `AST` as a structural interface
> `ParseTimeAST` with `object` slots and makes the class `generic over AST extends ParseTimeAST`.
> That was a holding pattern because the node classes did not exist yet. The canonical form is
> **non-generic, monomorphized to the concrete classes** — delete the `ParseTimeAST` interface and
> the `<AST>` parameter when re-translating (§8). The node subtyping that GAP A/B said was
> "undefined until ASTCodegen" is simply the ported class hierarchy (`VarDeclaration extends
> Declaration extends Dsymbol`, `IntegerExp extends Expression`, …) — once those headers exist, the
> `cast(AST.Base)` forwards (§4) are ordinary upcasts that need no cast at all in TS.

> **STOP** only if you encounter a visitor instantiated with an `AST` that is **not** `ASTCodegen`
> and whose node set differs (a genuinely distinct parse-only AST used live). The frontend's
> in-scope stack does not; if you think you found one, escalate rather than introduce a second
> monomorphization.

---

## 4. The default-forwarding overload (`visit(Derived) { visit(cast(Base)d); }`)

The dominant body shape across `ParseTimeVisitor` and `Visitor` is a **default-forward**: an
unhandled derived node delegates to its base's visit, so a visitor that only overrides
`visit(Expression)` still receives every `Expression` subclass there. This is the chain
`IntegerExp → Expression`, `VarDeclaration → Declaration → Dsymbol`, etc.

```d
// BEFORE — dmd/visitor/parsetime.d:30 / :51 (forward derived to base)
void visit(AST.Declaration s)    { visit(cast(AST.Dsymbol)s); }
void visit(AST.VarDeclaration s) { visit(cast(AST.Declaration)s); }
```

```ts
// AFTER — call the BASE's named method; the cast disappears (TS upcast is implicit)
visitDeclaration(s: Declaration): void { this.visitDsymbol(s); }
visitVarDeclaration(s: VarDeclaration): void { this.visitDeclaration(s); }
```

**The rule:** `void visit(Derived d) { visit(cast(Base)d); }` → `visitDerived(d: Derived): void
{ this.visitBase(d); }`. The `cast(Base)` is a no-op in TS (a `Derived` already *is* a `Base`), so
it vanishes; what matters is the **method name** you forward to — the *base's* named method. This
preserves the exact fall-through routing D's overload resolution gave for free.

**Which `visit` a call binds is decided by the ARGUMENT'S STATIC TYPE, whether or not this class
overrides it.** Inside `InstMemberWalker`, `templatesem.d:1106-1108`'s `if (sd.xeq) visit(sd.xeq);`
binds the INHERITED `visit(FuncDeclaration)` — because `sd.xeq` is declared `FuncDeclaration` —
so the faithful TS is `this.visitFuncDeclaration(sd.xeq)`, **not** `this.visitDsymbol(…)`. The
two look equivalent as long as nothing overrides the intermediate method, and diverge silently
the moment anything does. Resolve every intra-visitor `visit(x)` call by reading `x`'s declared
type, never by what the class happens to implement.

**SELF-cast forward** (`visit(cast(SameType)x)` — one live site: `parsetime.d:304`,
`visit(AST.CInitializer i) { visit(cast(AST.CInitializer)i); }`): in D this resolves to the SAME
overload, i.e. it recurses forever if ever called. Reproduce it verbatim
(`visitCInitializer(i) { this.visitCInitializer(i); }`) with a comment stating it is upstream's
self-forward, infinite if called, and why it is unreachable here (CInitializer is ImportC-only —
excluded). Do not "correct" it to a base forward; if you find a self-cast on a REACHABLE path,
STOP and escalate.

> The 8 **root** overloads do not forward — they `assert(0)` (`dmd/visitor/parsetime.d:19-26`:
> `Dsymbol`, `Parameter`, `Statement`, `Type`, `Expression`, `TemplateParameter`, `Condition`,
> `Initializer`). Those become `visitDsymbol`/… with body `assertUnreachable()` (the
> `assert(0)` → `assertUnreachable` mapping, cheatsheet / `09-numerics.md` house helper). A
> subclass that means "do nothing at the root" (PermissiveVisitor, `package.d:101-108`) overrides
> them with an **empty body** `{}` instead of the assert.

### 4.1 Flattened walkers inherit the forwarding contract (or must document the gap)

A TS module that replaces a `walkPostorder` + `StoppableVisitor` pair with a hand-rolled
recursive descent (e.g. `canthrow.ts`) **silently loses the default-forwarding chain**: in D,
a `BlitExp` with no own override routes through `visit(BlitExp e) { visit(cast(AssignExp)e); }`
(dmd/visitor/package.d:85), so a visitor's `visit(AssignExp)` logic fires for blits and
constructs too. A flattened walker that switches on `e.op` gets NO such routing — `EXP.blit`
falls to whatever generic arm exists, and the superclass logic (e.g. canthrow.d:181-202's
`visit(AssignExp)` postblit checks) is dropped **with no wall and no marker**.

**Rule:** when flattening a visitor into a switch/descent, for every node kind the original
visitor handles *via a base-class visit*, either (a) route the subclass ops to the shared arm
explicitly (`case EXP.blit: case EXP.construct: case EXP.assign:` stacked labels), or (b) leave
an auditable gap note naming the dropped D logic and its file:line, so the map phase of a later
rung finds it. An undocumented drop is invisible to both grep and the wall-order probe.

### 4.2 Base-overload calls sandwiched in stateful logic

`visit(cast(Base)x)` is not always a one-line forward. `SearchVisitor.visit(Module)`
(dmd/dsymbolsem.d:7179-7219) **mutates state around the base call**: it sets `m.insearch`,
calls `visit(cast(ScopeDsymbol)m)` (the explicit BASE overload on the SAME visitor instance),
reads `result` back, clears `insearch`, and updates the search cache keyed on the visitor's
`flags` field — shared state between the two frames. Port these as `this.visitScopeDsymbol(m)`
embedded in the same statement sequence; do NOT inline the base body and do NOT reset visitor
fields across the call. The forwarding rule of §4 gives the *name*; the surrounding mutation
order comes from the D body, statement by statement.

---

## 5. Mixin-generated visit methods — RESOLVE the mixin, EMIT the concrete methods

`ParseTimeTransitiveVisitor(AST)` (`dmd/visitor/transitive.d:17-23`) and
`SemanticTimeTransitiveVisitor` (`dmd/visitor/package.d:114-119`) do not write their 121 traversal
`visit` overrides by hand — they `mixin ParseVisitMethods!AST` (the template-mixin at
`transitive.d:30+`), which textually generates one `override void visit(AST.X)` per node, each body
walking the node's children (`s.exp.accept(this)`, `foreach (sx; *s.statements) sx.accept(this)`,
…). This is a **compile-time code-generation** construct (`07-compile-time.md`).

**Resolve the mixin at translation time and emit the concrete `visitX` methods it expands to** —
do not invent a TS "mixin." Walk `ParseVisitMethods` once, and for each `override void visit(AST.X)`
it generates, emit the corresponding named method with the traversal body translated 1:1:

```d
// BEFORE — dmd/visitor/transitive.d:35-45 (a method the mixin generates)
override void visit(AST.ExpStatement s)
{
    if (s.exp)
    {
        if (auto de = s.exp.isDeclarationExp()) de.declaration.accept(this);
        else s.exp.accept(this);
    }
}
```

```ts
// AFTER — emitted as a concrete named override; accept() calls dispatch per §2
override visitExpStatement(s: ExpStatement): void {
  if (s.exp) {
    const de = s.exp.isDeclarationExp();
    if (de) de.declaration.accept(this);
    else s.exp.accept(this);
  }
}
```

The `mixin … __methods; alias visit = __methods.visit;` pair (`transitive.d:21-22`,
`package.d:118-119`) collapses to: emit the generated methods inline, **drop the alias** (§1). The
mixin's expansion is **121 traversal overrides + 14 helper methods** (verified:
`grep -c 'override void visit(AST\.' transitive.d` = 121) — a one-sitting mechanical expansion,
not a deferred body phase.

**HELPER-NAME COLLISION (adjudicated — the rule is decisive).** The mixin's helpers are ordinary
methods translated under their D names — EXCEPT where a helper's name collides with a §1
generated virtual-slot name in the same hierarchy. `visitType` is the proven case: the helper
`void visitType(AST.Type t)` (`transitive.d:334`) is a DISPATCHER whose else-arm ends in
`t.accept(this)`, while the §1 slot `visitType` (the rename of `visit(AST.Type)`) is the
TERMINATING SINK — merging them (or letting the helper shadow the inherited sink) is unbounded
recursion, proven by ldc2 probe and TS reproducer. Resolution: **the §1 virtual-slot fabric is
inviolable — the slot keeps the bare name; the colliding HELPER takes the `Helper` suffix**
(`visitTypeHelper`, `visitTypeQualifiedHelper`), each with the audit comment
`// renamed: D helper visitType (transitive.d:334) — collides with the §1 virtual slot`.
Every internal call the mixin bodies make to the helper is rewritten to the suffixed name
(in D those calls name the helper, not `visit` — the rename preserves exactly that routing).
`visitAttribDeclaration` also collides but is BENIGN (helper and slot are the same routing
target there); it keeps the bare name with a comment saying so. Any NEW collision: apply the
same rule, name it in the file header. Second proven case: InlineScanVisitor's helper
`visitCallExp(CallExp, Expression, bool, bool)` (inline.d:1593) vs the slot `visitCallExp`
(inline.d:1574) → `visitCallExpHelper`.

**If the expansion is BLOCKED** (a collision or dependency you cannot resolve): emit the
generated method set as `DJS-ESCALATE` stubs per `11-escalate.md §2` (one stub per generated
method, one batched escalation record) — NEVER an empty class body, which compiles past
silently. The class CONSTRUCTOR stays clean: inherited (verified) behavior must not be
falsified by a ctor throw.

> **STOP** if the mixin's expansion depends on a `static if`/`__traits` you cannot resolve against
> the fixed config, or generates a `visit` for a node not in the ported hierarchy. Otherwise the
> expansion is mechanical: one named override per node, body translated by the normal rules
> (`06-control-flow.md` for the `foreach`/`if`, `02-types.md` for the `isXxx()` downcasts).

---

## 6. Base methods empty vs abstract; subclasses override specific named methods

- The **root** `Visitor`/`ParseTimeVisitor` visit methods are either `assert(0)` (parse-time roots,
  `parsetime.d:19-26` → `assertUnreachable()`) or empty `{}` (permissive roots,
  `package.d:101-108` → `{}`). The abstract contract lives on the **node** side
  (`ASTNode.accept` is `abstract`, `ast_node.d:25` → TS `abstract accept`), not on the visitor's
  visit methods — so the base visit methods are concrete (assert or empty), never `abstract`.
- **Concrete visitor subclasses override specific named methods.** `Visitor` (`package.d:26`) adds
  the semantic-time nodes; `SemanticTimePermissiveVisitor` (`package.d:97`) empties the roots;
  `SemanticTimeTransitiveVisitor` (`package.d:114`) fills traversal via the mixin (§5);
  `StrictVisitor` (`strict.d:13`) overrides the node methods strict.d lists (223/230) with `assert(0)` so a missed
  visit fails *at the precise node*, not at its base (ldc2-verified load-bearing difference, noted
  in the current `strict.ts` header — preserved by per-node `visitX` overrides each
  `assertUnreachable()`). `StoppableVisitor` (`package.d:256`) adds a `stop: boolean` field.

Each subclass overrides only the named methods it customizes; the rest inherit the base behavior —
identical routing to D, now via TS method inheritance instead of overload inheritance.

---

## 7. The `*sem` passes come in TWO visitor idioms — check which one BEFORE emitting anything

The semantic passes are visitors, but they use **two distinct idioms**, and emitting the wrong
shape is a structural miscompile. **Precondition (mandatory): before emitting a visitor class for
a `*sem` module, grep the D module for `class .*Visitor`. If there is none, the pass uses the
nested-function idiom of §7.5 — do NOT invent a class.** Verified census on the 1.43-beta1 tree
(`grep -c 'class .*Visitor' dmd/<file>.d`):

| Has visitor CLASSES (this section) | Uses the NESTED-FUNCTION idiom (§7.5 — zero classes) |
|---|---|
| `dsymbolsem.d` (13), `expressionsem.d` (5), `statementsem.d` (1), `semantic2.d` (2), `semantic3.d` (1), `templatesem.d` (4), `templateparamsem.d` (1 — `TemplateParameterSemanticVisitor`, `:47`) | `typesem.d`, `dcast.d`, `funcsem.d`, `initsem.d`, `enumsem.d` |

**An EXISTING ported file that violates the census** (a class invented where D has none — the
old `TypeSemanticVisitor` case): you never convert it in place (§7.5 rule 5) and never edit a
file you do not own (14 §2). File it as a `dependency signature` escalation (11 §1, category
extended to cover wrong-idiom ports) — it sweeps when the owner file is retranslated clean.

**Idiom A — visitor classes.** A pass defines a `extern(C++) … Visitor`-derived class (e.g.
`ExpressionSemanticVisitor`) whose `visit(SomeExp)` overloads carry the semantic analysis, driven
through `e.accept(v)`. These translate by **exactly** this doc's rule:

- Each `visit(NodeType)` analysis overload → `visitNodeType(n: NodeType): void` (§1).
- The pass's `accept`-driven entry (`exp.accept(scopesem)`, etc.) already works because every node's
  `accept` calls its own `visitX` (§2) — no change at the call sites beyond the node rename.
- The pervasive `alias visit = typeof(super).visit;` at the top of each `*sem` visitor (e.g.
  `expressionsem.d:1381`, `statement` passes) → **dropped** (§1).
- Forwarding/empty/assert bodies → §4/§6 as written.

These pass bodies are **Bucket-7 core SCC** work: their `visitX` methods reference the concrete node
classes, so they are filled in once those node headers are stubbed (`translation-order.md`). The
visitor *shape* (named methods + `accept` dispatch) is fixed now by this doc; the *bodies* arrive
with the nodes.

---

## 7.5 Idiom B — nested-function visitor + trailing dispatch `switch` (typesem, dcast, funcsem, initsem, enumsem)

The second idiom: a **free function** whose body declares nested functions — a base `visit(Expression e)`
plus `visitXxx(XxxExp e)` specializations — and ends with a **dispatch `switch` on the node tag**
(`switch (e.op)` / `switch (t.ty)`). There is no class, no `accept`, no overload set: the trailing
switch IS the dispatch, hand-written. Verified canonical instance — `implicitCastTo`
(`dmd/dcast.d:112`; nested base `visit` at `:114`, specializations `visitString`/`visitError`/
`visitFunc`/`visitArrayLiteral`/`visitSlice` at `:231-:270`, dispatch at `:287`):

```d
// dmd/dcast.d:287-295 — the trailing dispatch switch IS the visitor dispatch
switch (e.op)
{
    default              : return visit            (e);
    case EXP.string_     : return visitString      (e.isStringExp());
    case EXP.error       : return visitError       (e.isErrorExp());
    case EXP.function_   : return visitFunc        (e.isFuncExp());
    case EXP.arrayLiteral: return visitArrayLiteral(e.isArrayLiteralExp());
    case EXP.slice       : return visitSlice       (e.isSliceExp());
}
```

**Translation rules (all mandatory):**

1. **The dispatch switch is load-bearing and is emitted IN FULL, always** — every `case` arm and
   the `default`, even in a partial translation. Dropping an arm silently collapses that node kind
   onto the base `visit`, which compiles, runs, and miscompiles (this exact bug shipped in the old
   `dcast.ts`: 2 of its 4 functions kept the dispatch, 2 dropped it). **Where a D function of
   this idiom has NO dispatch switch at all** (`enumsem.d` is nested-functions-only, zero
   switches), the rule has nothing to apply to — it never licenses synthesizing one.
2. **An unfilled arm is an explicit inline wall**, at its `case` position, whose message names the
   D nested function and its line: `case EXP.slice: throw new Error("TODO-BODY: visitSlice (dmd/dcast.d:270)");`
   Never route an unfilled arm to `default`/base — that is a masked regression, not a deferral.
   **When the arm is PARTIALLY translatable, the wall moves INSIDE the nested visitor** — keep
   the `case` routing to its named visitor and put the wall at the deferred D statement within
   it. D's nested `visitXxx` functions are real declarations and most are partly portable
   (`visitString`'s early-outs are live; only its payload defers), so a case-position throw
   discards structure the port needs. The rule's guarantee is preserved either way (no arm
   silently collapses onto `default`), positional correspondence improves, and partial arms stay
   possible. Reserve the case-position throw for a visitor that is wholly unportable. The
   forbidden pin of `10 §1.8` rule 5 and the bug this rule prevents are the same defect from the
   test side: a rung test pins a base-`visit` wall for `implicitConvTo(long→int)` while
   `dcast.d:1503` routes `EXP.int64` to `visitInteger`, whose Tint32 arm returns
   `MATCH.convert` — the pin passed only because that file had dropped its dispatch switch.
3. The nested functions translate per `04-functions.md §5` (inner `const` arrows, declaration
   before the dispatch switch). The base `visit` keeps its name; specializations keep their D
   names verbatim (`visitString`, not `visitStringExp` — Idiom B names are the D source's own,
   NOT the §1 renaming scheme, which applies only to Idiom A overload sets).
4. The `default: return visit(e);` arm reproduces D's fall-to-base — keep it exactly; do not
   enumerate "missing" node kinds yourself.
5. Do **not** convert Idiom B into an Idiom A class (or vice versa). The idiom is part of the 1:1
   structure; converting breaks diff-ability and the wall-placement audit.

> **BAD (the shipped divergence):** translating the nested `visitXxx` functions but ending the
> function with `return visit(e);` and no switch — every specialized node silently takes the base
> path. **GOOD:** the full switch above, with walls on unfilled arms.

---

## 7.6 Idiom C — the `mixin VisitStatement!Result` / `visitStmtCase` CTFE-mixin dispatch

A third, distinct dispatch shape: a function declares nested `visitXxx` handlers and then
drives them through the **CTFE-generated switch** of `statement.d`'s `VisitStatement` mixin
(`mixin(visitStmtCase("Exp"))` … one generated `case STMT.X:` per statement kind). Live
consumers: `blockexit.d:498`, `dinterpret.d:1677`, `hdrgen.d:971`, `statementsem.d:3823`.
It is §5's compile-time code generation meeting §7.5's nested functions. Canonical rules:

1. **Resolve the mixin at translation time and emit the generated switch INLINE at the
   `visit.VisitStatement(s)` call site** (one trailing `switch (s.stmt)` in the enclosing
   function), with a resolved-comment naming the mixin
   (`// resolved: mixin VisitStatement!B + visitStmtCase -> inlined dispatch switch`). Do not
   emit a named wrapper function — §7.5's inline-trailing-switch shape is the house form.
2. **The generated arm set is emitted IN FULL**, exactly as the CTFE expansion produces it.
3. **LOAD-BEARING routing rule: an arm whose `visitXxx` nested handler does NOT exist in this
   function routes to `visitDefaultCase` — NEVER to a "related" handler.** The generator's
   `__traits(compiles, …)` probe does exactly that; hand-routing `CompoundDeclarationStatement`
   to `visitCompound` (the rung-era blockexit.ts bug) is the silent-miscompile class rule 1 of
   §7.5 exists to prevent. **`visitDefaultCase` is NOT always the `assert(0)` arm — read the D
   body, do not assume.** It is `assert(0)` in some consumers and a plain pass-through in
   others: in `statementSemanticVisit` (`statementsem.d:189`) it is `result = s;`. Emitting
   `assertUnreachable()` there would turn five faithfully-inert arms (StaticForeach, SwitchError,
   CompoundDeclaration, InlineAsm, GccAsm) into hard crashes.
4. Nested handlers keep their D names verbatim, exactly as in §7.5 rule 3.

---

## 8. The variant visitors are currently STOP-stubbed — fill them with THIS rule

`src/dmd/visitor/parsetime.ts`, `strict.ts`, `permissive.ts`, `transitive.ts` are presently
STOP-stubbed (their headers record GAP A "namespace-template `AST`" and GAP B "N forwarding bodies
under one `visit`"). **Both gaps are resolved here.** When the Bucket-7 node headers exist,
re-translate each as follows:

| D source | Re-translate to |
|---|---|
| `parsetime.d` (`ParseTimeVisitor(AST)`) | non-generic `class ParseTimeVisitor`; 8 root `visitX` = `assertUnreachable()`; every forwarding overload = `visitDerived(d){ this.visitBase(d); }` (§3, §4). Delete the `ParseTimeAST` interface and `<AST>` param. |
| `permissive.d` (`PermissiveVisitor(AST)`) | `class PermissiveVisitor extends ParseTimeVisitor`; 8 root `visitX` overridden with empty `{}` (§6). Drop the alias. |
| `strict.d` (`StrictVisitor(AST)`) | `class StrictVisitor extends ParseTimeVisitor`; the node `visitX` set strict.d itself lists overridden with `assertUnreachable()` (223 of parsetime's 230 — translate the SOURCE'S set, do not complete it; the 7 absentees inherit the parse-time assert roots anyway). |
| `transitive.d` (`ParseTimeTransitiveVisitor` + `ParseVisitMethods` mixin) | resolve the mixin, EMIT the concrete traversal `visitX` overrides (§5; 121 + 14 helpers; the visitType/visitTypeQualified helpers take the `Helper` suffix per the §5 collision rule). If BLOCKED: DJS-ESCALATE stubs per method (§5), never an empty class body. |
| `package.d` (`Visitor`, `SemanticTime*`, `Stoppable`) | `Visitor extends ParseTimeVisitor` with the semantic-node `visitX`; the SemanticTime variants per §6; `StoppableVisitor` adds `stop`. |

Each re-translation drops every `alias visit = …` and replaces every `visit(cast(Base)x)` with the
base's named method. The result compiles (no overload-body collision) and routes identically to D.

---

## 9. Quick checklist (run for every visitor or AST node you touch)

1. Node with `override void accept(Visitor v) { v.visit(this); }`? → `override accept(v: Visitor):
   void { v.visit<ThisNodeClass>(this); }` (§2). Calls its **own** named method, never the base's.
2. Visitor with `void visit(X)` overloads? → one `visit<X>(n: X): void` per overload, name =
   `"visit"` + class name (§1). One method, never a shared `visit` body.
3. Forwarding body `visit(cast(Base)x)`? → `this.visit<Base>(x)`; cast vanishes (§4).
4. Root `assert(0)` body? → `assertUnreachable()`. Permissive empty? → `{}` (§6).
5. `(AST)` template parameter? → **drop it**, reference concrete node classes (§3).
6. `mixin ParseVisitMethods!AST`? → resolve at translation time, emit concrete `visitX` overrides
   (§5, `07-compile-time.md`).
7. `alias visit = typeof(super).visit;`? → **drop**, with the auditable comment (§1).
8. A `*sem` pass? → grep it for `class .*Visitor` FIRST (§7 census). Classes → Idiom A, this
   doc's rename rule. No classes → Idiom B (§7.5): nested functions + the trailing dispatch
   switch, emitted IN FULL, walls inline per unfilled arm. Never invent a class for Idiom B.
9. Translating an Idiom-B function partially? → every `case` arm present; unfilled arms are
   inline walls naming the D `visitXxx` file:line; `default` routes to base `visit` (§7.5).

---

## Cross-references

- **`abstract class` / `class` mapping, the bodyless-`accept`→`abstract` rule, `isXxx()` downcasts
  used inside traversal bodies:** `02-types.md` (§2, §3).
- **`alias visit = typeof(super).visit;` — why it drops (no TS overload hiding):** `02-types.md §5.3`.
- **`mixin ParseVisitMethods!AST` and any `static if`/`__traits` inside the expansion:**
  `07-compile-time.md`.
- **`assert(0)` → `assertUnreachable()`; numeric domains inside visit bodies:** `09-numerics.md` /
  cheatsheet.
- **`foreach (sx; *s.statements) sx.accept(this)` and the `if`/control flow in traversal bodies:**
  `06-control-flow.md`.
- **Method-name collisions from same-name/different-param overloads elsewhere (Form B):**
  `04-functions.md §1B` — but the visitor's per-node names are already unique, so Form B does not
  apply here; this doc's `"visit" + NodeName` scheme is the canonical visitor naming.
- **Bucket order, the 76-module core SCC the `*sem` visitors live in, stub-first headers:**
  `translation-order.md`.
- **Any uncovered visitor construct, a non-`ASTCodegen` AST instantiation, an `accept` that is not
  `v.visit(this)`, or an unresolvable visit-mixin:** `11-escalate.md` — STOP, never guess.
