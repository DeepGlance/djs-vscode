# CHEATSHEET — D→TS Quick Reference (one row per idiom)

> Read `_ground-truth.md` first. STOP & escalate (`11`) on ANY uncovered/ambiguous construct — never guess.
> One canonical TS form per idiom. `Doc` column points to the owner; open it for invariants & call-site rules.

## Types (→ `02`)

| D | TS | Note | Doc |
|---|---|---|---|
| `void` / `bool` | `void` / `boolean` | direct | 02§1 |
| `byte ubyte short ushort int uint char wchar dchar` | `number` | ≤32-bit; truncate-on-store (`09`) | 02§1 |
| `long ulong` | `bigint` | 64-bit; `asIntN/asUintN(64,…)` | 02§1, 09§1 |
| `float double real` | `number` | `real`==double on target; no `Math.fround` | 02§1, 09§6 |
| `size_t ptrdiff_t` | `number` | index/length domain (bigint if folds, `09§8`) | 02§1, 09§1.1 |
| `cent ucent` | — | obsolete, not a live type → STOP | 02§1.2 |
| `struct S` | `class S` | **VALUE** — copy on move (`03`) | 02§2 |
| `class C` / `: Base` / `abstract` | `class C` / `extends Base` / `abstract class` | reference; shares | 02§2 |
| `interface I` (sig-only / w/ body) | `interface I` / `abstract class I` | follow D keyword (`Visitor` etc.) | 02§3 |
| `enum X = v;` (manifest) | `const X = v;` | `=` w/o `{}` = const, never TS enum | 02§4.1 |
| `enum E {…}` (≤32-bit base) | TS `enum E` | base→`int`; `int→enum` unchecked `v as E` | 02§4.2 |
| `enum E : long/ulong {…}` | `const E={…} as const` + branded `bigint` | TS enum can't hold bigint | 02§4.2 |
| `enum X : ulong {…}` flag-enum (bits OR'd) | plain `const X={none:0n,a:1n<<0n,…}` + `type X=bigint` (NO brand) | members OR clean; `(x&MASK)!==0n`; existing branded OK | 02§4.2 |
| `alias N = Type;` | `type N = …;` | type alias | 02§5.1 |
| `alias N = …delegate(…);` | `type N = (…) => ret;` | function-type alias | 02§5.2 |
| `alias visit = typeof(super).visit;` | (drop, comment) | TS has no overload hiding | 02§5.3 |
| `alias x = symbol;` | `const x = …` / `export {… as x}` | rebind local / re-export cross-module | 02§5.3 |
| `T[N]` static array | `T[]` (fixed len) | **VALUE** — clone on move (`03`) | 02§7 |
| `T[]` dynamic array/slice | `T[]` | **REFERENCE** — shares; NO copy | 02§8 |
| `V[K]` assoc array | `Map<K,V>` | absent-key = `V.init` not `undefined` (`08`); struct key→`08` | 02§9, 08§5/6 |
| `Class*` | `Class \| null` | drop `*` (already a ref) | 02§10 |
| `Struct*` | the class ref, NO copy | intentional alias to a value | 02§10, 03§7 |
| `char*`/`void*`/`prim*` | byte cursor (`08`) / `unknown` / boxed out (`04`) | by role; ptr-arith→STOP | 02§10,11 |
| `Optional!T` | `class Optional<T>` (faithful) | `.get()` asserts; don't collapse to `T\|null` | 02§11 |
| `UnionExp` / `emplaceExp!(T)(&ue,…)` | wrapper holding one `Expression` | `ue.emplace(new T(…))`; read via `ue.exp()` / `ue.copy()` | 02 "UnionExp / emplaceExp (CTFE expression construction)" |
| `Token` payload `union{int<->uint}` (TARGETED carve-out) | one raw `intUnsValue:bigint`; `intvalue`=`toInt64(raw)`, `unsvalue`=`toUint64(raw)`; `floatvalue:number` + string struct SEPARATE; one meaningful per TOK | NOT blanket escalate — only int/uint share bits | 11 carve-out, ref 02 |

## Value semantics (→ `03`) — the silent-bug doc; emit `.copy()` at every D copy point

| D copy point | TS | Doc |
|---|---|---|
| `S b = a;` (structs) | `const b = a.copy();` | 03§1#1 |
| `S s = S(1,2);` (construction) | `new S(1,2)` — no copy | 03§1 |
| `f(s)` by-value param | `f(s.copy())` — copy at **call site** | 03§1#2/3.1 |
| `f(ref S s)` | `f(s)` — alias, NO copy | 03§3.2 |
| `f(in S s)` / `const ref` / `const scope` | `f(s)` — read-only alias, NO copy | 03§3.4 |
| `f(out S o)` | box `{value}`, reset on entry then fill | 03§3.3 |
| `return s;` | `return s.copy();` (elide per §9 w/ comment) | 03§1#3 |
| `S v = arr[i];` / `obj.field` (struct) | `const v = arr[i].copy();` | 03§1#4/6 |
| `arr[i].x = v;` (index lvalue write) | `arr[i].x = v;` — in place, NO copy | 03§4 |
| `obj.field = s;` (field is struct) | `obj.field = s.copy();` | 03§1#5 |
| `foreach(x;arr)` mutating x / `foreach(ref x;arr)` | per-elem `x.copy()` / iterate in place | 03§4 |
| `a = b;` & S has `opAssign` | `a.opAssign(b)` (not `b.copy()`) | 03§6.3, 05§6 |
| `@disable this(this)` struct | NO `.copy()`; if copy needed → STOP | 03§6.2 |
| `S* p = &s;` / `int* p = &n;` | `const p = s;` (obj ref) / `Ref<number>` box | 03§7.2 |
| `*p` / `p.field` / `p == &s` | `p.value` / `p.field` / `p === s` | 03§7.2 |
| `mem.xmalloc`/`Region`/`scope`/lifetime kw | erase (JS GC) | 03§8, 08§13 |
| `.copy()` body | per-field: prim=value, nested struct=recurse `.copy()`, class ref=share, slice=share | 03§2 |
| fn-ptr field in a value struct, on `.copy()` | SHARE the function reference (no clone) | 03§2 |
| `memcpy` OVERWRITING an existing inline value struct (preserve object identity held by external refs) | copy fields INTO the existing object (field-by-field / `Object.assign`), NOT reassign the ref; distinct from `.copy()` | 03 in-place value-overwrite |

## Functions & callables (→ `04`) — D resolved at compile time; bake in the choice

| D | TS | Doc |
|---|---|---|
| overloads = prefixes (arity-distinct) | one fn, optional trailing params | 04§1A |
| overloads same arity, diff types | rename `<name>From<Type>`, rewrite call sites | 04§1B |
| ctor Form-B (same arity, diff types) | named static factory `X.fromY(…)` | 04§1B |
| param `= value` | TS default param, same value/order | 04§2 |
| C-variadic `…, format, …` + `va_list` | `…args: unknown[]`; format owned by `10` | 04§3.1 |
| typesafe variadic `T[] xs...` | `...xs: T[]`; **spread arrays at call sites** | 04§3.2 |
| template variadic `(T...)` forwarding | `...args` + spread forward | 04§3.3 |
| `R delegate(P)` param | closure `(p) => …` (captures `this`) | 04§4.1 |
| `&obj.method` | `() => obj.method()` — **NEVER** `obj.method` | 04§4.3 |
| `R function(P)` param | plain function value, no binding | 04§4.4 |
| nested function in a body | inner `const` arrow (inherits `this`) | 04§5 |
| `x.foo(y)`, `foo` not a member of x | `foo(x, y)` (UFCS; receiver first) | 04§6 |
| `in{…}` / `out(r){…}` / `do{…}` | leading/trailing `assert`s; drop `do` | 04§7 |
| `out T param` in param list | ref/out param → box (`03`), NOT a contract | 04§7, 03§3.3 |
| `pure nothrow @nogc @safe scope return @live const immutable extern(C++)` | **ERASE** all | 04§8 |
| `ref` / `out` / `static` / `override abstract` | **KEEP** | 04§8 |
| `final` (method or class) | **ERASE** — TS has no `final`; keep the `override` | 04§8 |
| bare class-typed param `Module mod` | non-null `T` if body dereferences (callers `!` where D faults); `T \| null` if body null-tests | 02§10.1 |
| param reassigned walking a chain (`s = s.parent`) | widened local cursor named `cur` | 02§10.1 |
| D field shadowing breaks a TS upcast/compare | audited cascade `x as unknown as Base` + comment naming the shadowed field pair | 02§11.5 |
| `@property T foo()` | `get foo(): T` (call sites lose parens) | 04§9 |
| trailing `inout` on a method (`T get() inout`) | **ERASE** (const-transfer qualifier, like trailing `const`) | 04 attributes |
| `inout(T)` wrapper on param/return (`inout(T) get() inout`) | **ERASE the wrapper, KEEP `T`** → `get(): T` | 04 attributes |

## Operators (→ `05`) — TS has NO operator overloading; (a) emit method + (b) rewrite EVERY call site

| D op | method | call-site rewrite | Doc |
|---|---|---|---|
| `== !=` | `opEquals(o)` | `a.opEquals(b)` / `!a.opEquals(b)` (struct); class identity stays `===` | 05§2 |
| `< <= > >=` | `opCmp(o):number` | `a.opCmp(b) <0 / <=0 / >0 / >=0` | 05§3 |
| `==` no opEquals (only opCmp) | `opCmp` | `a.opCmp(b) === 0` | 05§3 |
| `+ - * / % ~ & \| ^ << >> >>> ^^` | `opAdd opSub opMul opDiv opMod opCat opAnd opOr opXor opShl opShr opUShr opPow` | `a.opAdd(b)` … | 05§4 |
| reversed binary (`opBinaryRight`) | `opAdd_r` … (`_r` suffix) | `right.opAdd_r(left)` | 05§4 |
| prefix `- + ~ ++ --` | `opNeg opPlus opCom opInc opDec` | `a.opNeg()` … (`++`/`--` mutate+return) | 05§5 |
| `+= … ~=` | `opAddAssign … opCatAssign` | `a.opAddAssign(b)` | 05§6 |
| `a[i]` / `a[i]=v` | `opIndex(i)` / `opIndexAssign(v,i)` | `a.opIndex(i)` / `a.opIndexAssign(v,i)` (val,idx) | 05§7 |
| `a[lo..hi]` / `a[]` on OutBuffer | `opSlice(lo,hi)` / `opSliceAll()` | never collapse the two | 05§7 |
| `a[lo..hi]` / `a[]` on `Array!T` | `opSlice(lo,hi)` / `opSlice()` | both COPY; `Array` has no `opSliceAll` | 08§2.1 |
| `Array!T` slice MUTATED through | `tdata()` | D's slice is live; `opSlice()` is a copy — a write through it is lost | 08§2.1 |
| `$` in `a[…]` | `opDollar()` | substitute `a.opDollar()` for `$` | 05§7 |
| `a(args)` / `cast(bool)a`,`if(a)` | `opCall(args)` / `opCastBool()` | rewrite incl. every truthiness use | 05§7/10 |
| `foreach(…;a)` a has opApply | `opApply(dg):number` | callback + control-code protocol (NOT for-of) | 05§11,06 |
| AA-key hash / value→str | `toHash():number` / `toString()` (sink:`toStringSink`) | hashmap (`08`); no rewrite | 05§13 |
| `cast(int/long/ubyte)x` on prim | — | numeric truncation, NOT opCast | 05§10, 09§2 |
| `cast(ClassDecl)sym` | — | downcast/`isXxx()`/instanceof | 05§10, 02 |
| `==`,`<` on a generic type param `T` | — | primitive-`T`: `===`,`<` ; struct `T`: `.opEquals`/`.opCmp` ; else **escalate** | 05 "Operators on a generic type parameter" |
| multiple same-op overloads by param type | self-type keeps `opMul`; others `opMul_<paramType>` | rewrite call sites by arg type | 05 "Multiple overloads of the same operator" |
| operator inside an operator-overload body (e.g. `a*b` in `opMul`) | rewrite recursively | `a.opMul(b)` | 05 intro |
| `arr[i]=v` where `opIndex` returns `ref T` (no `opIndexAssign`) | synthesize `opIndexAssign(v,i)` | `arr.opIndexAssign(v,i)` | 05 "Synthesized opIndexAssign for a ref-returning opIndex" |

## Control flow (→ `06`)

| D | TS | Doc |
|---|---|---|
| `foreach(x; arr)` | `for (const x of arr) {}` | 06§1.1 |
| `foreach(i,x; arr)` | `for (const [i,x] of arr.entries()) {}` | 06§1.2 |
| `foreach(i; lo..hi)` | `for (let i=lo; i<hi; i++)` (bound captured once) | 06§1.3 |
| `foreach(char c;s)` / `foreach(dchar c;s)` | `for(const c of byteBuf)` / `for(const dc of utf8Decode(s))` | 06§1.4 |
| `foreach(e; range)` | `for(let r=range; !r.empty; r.popFront()){const e=r.front;}` (`for(;;)` not while) | 06§1.7 |
| `foreach(…; opApplyObj)` | `obj.opApply((…)=>{…; return 0/1;})` 0=cont,≠0=break | 06§1.8 |
| `foreach(e; containerValue)` (container w/ `[Symbol.iterator]`) | `for (const e of arrayValue) {}` (delegates to backing array) | 06 "foreach over a container value" |
| `foreach_reverse(i,x; a)` | descending counter `for`; `i`=orig position | 06§2 |
| `if (T x = f()) {…}` (decl in condition) | `const x = f(); if (x !== null) {…}` (hoist decl, test value) | 06 "Declaration in a condition" |
| `if (ref) {…}` / `if (!ref)` (nullable ref truthiness) | `if (ref !== null)` / `if (ref === null)` | 06 "Truthiness of a nullable reference" |
| plain `switch` | `switch` w/ `default` (always present in source) | 06§3.1 |
| `final switch` | `switch` + `default:{const _e:never=…; throw new SwitchError(_e);}` | 06§3.2 |
| `with(Enum) switch` | re-qualify case labels `Enum.x` | 06§3.3 |
| `switch("str")` | JS string switch (if accessor yields a string) | 06§3.4 |
| `case a: .. case b:` | stacked cases (≤16, inclusive) or range `if` (large) | 06§3.5 |
| implicit fallthrough | impossible in D (compile error) | 06§3.6 |
| `goto case;` (next) / `goto default;` | omit `break` (comment) / extract default to closure, call+`break` | 06§3.6 |
| `goto case <v>;` non-adjacent / `goto Label;` (non-trivial) | **STOP/escalate** | 06§3.6/§4 |
| `goto Label;` — classify the SHAPE, one fixed spelling each | RETRY→labeled `for(;;)`+`continue`; BAIL→zero-param nested arrow tail (`return LerrTail();`); SKIP-FLAG→`gotoLxxx` gate; SHARED-ARM→signal closure; else STOP. Tails capture locals — NEVER positional params | 06§4 vocabulary |
| `with(value)` | `const _w = value;` + explicit `_w.member` | 06§5 |
| `ref const(char)* p` cursor | shared cursor obj `{buf:DString,p:number}` by ref; mutate `cursor.p`; `scope(exit) sequence=p` is a no-op (shared obj IS writeback); `utf_decodeChar`: `const r=utf_decodeChar(s,idx); idx=r.nextIdx; u=r.dchar` | 06, 09 |
| `break Label;` / `continue Label;` | same in TS (never `forEach`/`.map`) | 06§6 |
| `scope(exit) C;` (single) | `try{…} finally{C}` | 06§7.1 |
| `scope(success/failure)` (single) | `_ok` flag + finally / `catch{C; throw e}` | 06§7.1 |
| ≥2 `scope(...)` | one LIFO `_guards` stack drained in `finally` | 06§7.2 |
| `try`/`catch(T e)`/`finally` | `catch(e){ if(!(e instanceof T)) throw e; …}` + `else throw e` | 06§8 |
| `throw new Exception(…)` / D `Error` | `throw new DException(…)` / `DError` (NOT JS `Error`) | 06§8.3 |

## Compile-time (→ `07`) — RESOLVE at translation time; emit only the result + audit comment

| D | action | emit | Doc |
|---|---|---|---|
| `version(X){A}else{B}` | eval `X` vs fixed world (`_config`) | `A` or `B`, never `version` | 07§1 |
| ON: `IN_LLVM LDC Posix D_Exceptions all`; OFF: `MARS GNU Windows BSD X86 CRuntime_* DMDLIB none` | per table | live branch | 07§1.2 |
| `version=X;` / `debug …` | fold into matching `version(X)` / always OFF | nothing / drop, keep else | 07§1/2 |
| `static if(c){A}else{B}` | eval `c` | taken branch + `// resolved:` | 07§3 |
| `static if(__VERSION__ < N)` | `__VERSION__==2113` (verified, 1.43-beta1) | selected branch | 07§3.2 |
| `static if(__traits(compiles,e))` | CT bool | selected branch | 07§3.3 |
| `static foreach(x; xs)` | UNROLL (default) / runtime `for` (no CT-keyed body) | concrete copies | 07§4 |
| `mixin("str")` | eval CTFE string | inlined translated code | 07§5 |
| `mixin Name!(args)` | expand template body w/ args | inlined members | 07§6 |
| `__traits(allMembers/getMember/identifier/isSame, …)` | enumerate/resolve | literal / branch | 07§7 |
| `__traits(classInstanceSize, C)` | elide (no manual memory) | field-wise copy / drop table | 07§7.1 |
| `is(…)` / `typeof` (CT) | resolve to type/bool | concrete type / `true`/`false` | 07§8 |
| `enum x = <CTFE expr>;` | evaluate | `const x = <literal>;` | 07§9 |
| `__FILE__/__LINE__` self-config / feature | placeholder/drop / **PORT the logic** | const / ported code | 07§10 |
| emitting any `version`/`static if`/`mixin`/`__traits` token into TS | — | **always a bug → STOP** | 07§11 |
| `static if`/`is(typeof)` on a generic `T` (type stays generic) | can't fold; monomorphize that method or escalate | per-`T` method / escalate | 07 "Compile-time dispatch on a generic type parameter" |

## Numerics (→ `09`) — `number`/`bigint` never mix; CTFE carrier is `bigint`

| Topic | Rule | Form | Doc |
|---|---|---|---|
| Domain split | ≤32-bit→`number`; 64-bit `long`/`ulong`→`bigint`; CTFE/fold carrier→`bigint` | — | 09§0/1 |
| Cast/store truncation | mask to width, sign-extend if signed (no throw) | `toIntN/toUintN`, `normalizeInteger` | 09§2 |
| 32-bit wrap (number doesn't wrap) | re-truncate after op | `\|0` (i32), `>>>0` (u32), `Math.imul` (mul) | 09§3 |
| 64-bit wrap (bigint unbounded) | re-truncate after op | `BigInt.asIntN/asUintN(64, …)` | 09§3 |
| `& \| ^ ~` 32-bit / 64-bit | JS ops direct / BigInt ops then re-truncate | `~0u → (~0)>>>0` | 09§4.1/4.2 |
| `<<` `>>` `>>>` | result type = left operand; `>>`=arith, `>>>`=logical | bigint no `>>>`: `toUint64(x)>>n` | 09§4 |
| shift count ≥ width | const→compile error (absent in source); runtime→`<width` by source | port 1:1 | 09§4.3 |
| mixed number/bigint | TS error; widen narrow operand at boundary | `BigInt(x)+bigVal`; never `Number(ulong)` | 09§5 |
| `int.min / -1` | HARD compile error, not wrap | reproduce diagnostic verbatim | 09§3 |
| signed vs unsigned div/cmp | read carrier per operand signedness | `toUint64` vs `toInt64` before `/` | 09§3.1 |
| signed carrier `==` unsigned-suffixed literal (`x == 0xFFFF_FFFFu`) | read literal into the **signed** domain before compare | `toInt64(lit)` then `===` | 09§3.1 |
| `T.sizeof` / `T.alignof` as CT constant | fold to fixed target-width literal (no runtime query) | int `4`; long/`size_t`/ptr `8` | 09 |
| `float/double/real` | all `number`; CTFE keeps double precision; **never** `Math.fround` | plain JS ops | 09§6 |
| NaN / Inf | `NaN` / `Infinity`; keep explicit NaN guard in `realCmp` | `Number.isNaN` | 09§6.2 |
| float suffix `f`/`L` | sets AST `type`; value stays `number` (no round) | — | 09§6.3 |
| `char/wchar/dchar` arith | promotes to `int` (`number`); store-back truncates | `cast(char)`→`toUint8` | 09§7 |
| exactness decides compile | `bigint` MANDATORY: folding, CTFE, enum `long`, sizes, hashes, mangling, `Cent` | litmus: off-by-1-bit? | 09§8 |
| numeric truthiness `if(x)` / `x\|\|y` | MANDATORY expand for floats (NaN is D-truthy, JS-falsy!), enums, `&&`/`\|\|`→bool, unclear types; optional for plain integrals | `x !== 0` / `(a!==0)\|\|(b!==0)` | 09§9, 06§2.5 |
| `T x;` default init / `out` reset | use the VERIFIED `.init` table — char=`0xFF`, wchar/dchar=`0xFFFF`, floats=`NaN`, enum=FIRST member; never guess 0 | per-type | 09§1.0, 03§6.4 |
| slice truthiness `if (arr)` | tests the POINTER: null slice falsy, empty-non-null TRUTHY | `arr !== null` (never `.length`) | 06§2.8 |
| `cast(void) e;` (value discard) | drop the cast, keep the expression statement | `e;` | 09 "cast(void): value discard" |
| `size_t.max` as not-found sentinel | `SIZE_MAX = -1`; `i != size_t.max`→`i !== SIZE_MAX`; arithmetic use→drop/escalate | `i !== SIZE_MAX` | 09 "size_t.max and the SIZE_MAX sentinel" |

## Conventions, runtime lib, tests (→ `01` / `08` / `10`)

| D | TS | Doc |
|---|---|---|
| `module dmd.x.y;` / `package.d` | `src/dmd/x/y.ts` (KEEP `dmd` prefix) / `src/dmd/x/index.ts` | 01§1.1 |
| `dmd/root/*` runtime modules (`array`, `outbuffer`, `rmem`, …) | **HAND-WRITTEN** replacement, same contract (NOT 1:1; port-every-unittest relaxed) | 00 / 08 / 10 |
| identifier (D keyword-escaped `scope_`/`_init`) | carry verbatim | 01§2.1 |
| JS-reserved id (`var arguments yield let eval await`) | append one `_` (`var_`) | 01§2.3 |
| `import dmd.x;` / `import dmd.x : a,b;` | `import { used… } from "./x.js"` / `{a,b}` | 01§3.1/3.2 |
| `import x : alias = name;` / `public import` | `import {name as alias}` / `export … from` | 01§3.3/3.4 |
| `static import dmd.x;` / `core.*`,`std.*` | `import * as x` / runtime shim — NOT a module (`08`/`09`) | 01§3.5/7 |
| excluded-module import (`dtoh`) | drop import + STOP-stub call site | 01§3.6, 11§3.1 |
| cyclic import, type-only use | `import type {…}` (erased, breaks cycle) | 01§4.2 |
| top-level `new`/value-read across cycle | forbidden → init function (`let X; initMod(){X=…}`) | 01§4.5 |
| `static this()` / `shared static this()` | `export function initMod()`, shim calls in import-graph order | 01§5 |
| `static ~this()` | drop (unless external side effect) | 01§5.3 |
| `Array!T` methods | `Array<T>`: `.length push pop insert remove copy(shallow) opSlice find(→SIZE_MAX)` | 08§2 |
| generic container `Array!T` (any/many `T`) | single TS-native `Array<T>`; per-`T` default/capability → escalate/special-case | 08 "Container representation: TS-native Array<T>" |
| `string` / `const(char)*` | `DString` byte buffer (NOT JS string); `toChars()`→display | 08§8/11, 02§1.3 |
| C-string/NUL view: `toChars()`/`extractChars()`/`peekChars()` return NUL-terminated `DString` (trailing `0x00`); logical string = bytes before first NUL; `cstrlen(p)`/`cstr(p)` in `dstring.ts`; `if(*p)`→`p.length>0&&p[0]!==0`, `*p==0`→`p[0]===0`, `%.*s` stops at first NUL | 02§11 |
| AA with struct key | custom hashmap via `toHash`+`opEquals` (NOT `Map`) | 08§5/6, 05§13 |
| `mem.xmalloc`/`Region`/`xfree` | delete (GC) | 08§13 |
| `assert(c)` in code / `assert(0)` | `assert(c)` helper (throws `AssertError`) / `assertUnreachable()` | 10§2 |
| `unittest{}` / `@("name") unittest` | `src/dmd/x.test.ts`: `test("unittest#N")` / `test("name")` | 10§1 |
| `assert(c)` / `assert(a==b,"m")` in unittest | `expect(c).toBe(true)` / `expect(a,"m").toBe(b)` | 10§1.4 |
| `error(loc,"fmt %s",…)` | reproduce DMD string byte-for-byte; specifiers `%s %.*s %d %u %lld %llu %x %llx %c %%` | 10§3 |
| `hashOf(x)` / `toHash` body (e.g. `Loc.toHash`) | `hashOf(x:number\|bigint\|Uint8Array,seed=0):number` + `mixHash(a,b):number` in `root/hash.ts` (MurmurHash2); returns 32-bit `number` | 08§9 |
| `dmdformat`/`printf`/`vprintf` specifiers | `dmdformat(fmt,args):Uint8Array` in `root/dmdformat.ts`: `%s`(NUL-aware) `%d %i %u` `%lld %llu`(bigint) `%x %X` `%o %llo` `%c %zu %%`, width/prec/flags (`%03o %-10s %5d`), `%.*s`(stops at first NUL in window); `%f/%g/%e`→CTFloat STOP-stub (deferred); `OutBuffer.printf/vprintf` delegate here | 10§3.5 |
| `fputs/fprintf(stderr,…)/vfprintf` | assemble full msg via `dmdformat`, then ONE `process.stderr.write(dsToJs(msg))` | 10§4 |
| D `private` member (MODULE-scoped) | emit WITHOUT `private` + `// D module-private` if touched by sibling fn or module unittest; TS `private` only when truly class-local | 01-conventions, 10 |

## Visitors (→ `13`) — TWO idioms; grep `class .*Visitor` in the D module FIRST

| D | TS | Doc |
|---|---|---|
| `void visit(IntegerExp e)` overload (Idiom A class) | `visitIntegerExp(e: IntegerExp): void` — one named method per overload | 13§1 |
| node's `accept` | `v.visit<ThisNodeClass>(this)` — its OWN name, never the base's | 13§2 |
| `visit(Derived d){visit(cast(Base)d);}` | `visitDerived(d){ this.visitBase(d); }` (cast vanishes) | 13§4 |
| `ParseTimeVisitor(AST)` template param | drop `(AST)`, reference concrete node classes | 13§3 |
| `alias visit = typeof(super).visit;` | drop (+ comment) | 13§1 |
| typesem/dcast/funcsem/initsem/enumsem (NO visitor classes) | Idiom B: nested `visit`/`visitXxx` fns + trailing dispatch `switch (e.op)` emitted IN FULL; unfilled arms = inline walls; never invent a class | 13§7.5 |
| `buf[]` / `peekSlice` vs `extract*` on OutBuffer | `buf[]`→`opSliceAll()` is a VIEW; `extract*` CONSUMES (empties) — never swap; grep `extract` at self-gate | 08§13a.2, 05§7 |

## Marker table (→ `11`) — categorization checkable by grep

| Situation | Marker |
|---|---|
| §2 blocker (decision needed, no future porting resolves it) | `DJS-ESCALATE` comment (D file:line ON the marker line) + throw |
| §2.5 wall (deferred callee, NOT exported anywhere — sweeps when its owner is ported) | `TODO-BODY: … (dmd/<f>.d:<n>)` throw, inline at the D site; the cite names where the callee is DEFINED |
| callee ported but UNREACHABLE (not exported / re-protocoled) | §2 `dependency signature` — **never** `TODO-BODY`: no porting event repairs it. No throw, no marker; the audited comment + the record ARE the artifact |
| deferred callee with no semantic effect (timing/tracing/profiling) | `// dropped: …` naming the D file:line — begin/end pair dropped TOGETHER, never walled |
| faithful D `assert(0)` | `assertUnreachable()` — NEITHER token, not a wall |
| blocked class-body mixin | one stub per generated method, ONE batched record; ctor stays clean |

## STOP triggers (→ `11`) — refuse, stub, escalate

Uncovered/ambiguous construct · `cast(T*)` reinterpret / `p+n` / `p[i]` / `p2-p1` ptr arithmetic · `T**` ·
SIMD `__vector` value/CTFE logic · `asm{}` semantic processing · layout-significant `union` · alignment/bitfields ·
non-resolvable `mixin`/`__traits` · `version(linux/OSX)` real divergence · big `main.d`/`mars.d` driver blocks ·
non-bool `opCast` · real frontend `opDispatch` · postfix `++` overload · can't decide `number` vs `bigint` from type.
