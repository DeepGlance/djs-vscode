// Queries on the last compile's analysed AST, for an editor host: the hover text and the declaration of the symbol
// under a position, the semantic tokens, the inlay hints, the inactive ranges and the expansion peeks of a file, the
// AST view of a module, the template instances of files, the modules loaded with their imports, the names after a `.`
// and those in scope, the outline of a file, the references of a symbol and its rename, a call's signatures, and the
// declarations the program's entry cannot reach (10 §4.7, "Queries").
//
// Hand-written djs module, NOT a port of a dmd/ file: the 1.43.0 frontend has no query API (D language servers such as
// serve-d run their own analysis). The host contract is 10 §4.7; the entries are `queryHover`, `queryDefinition`,
// `querySemanticTokens` (with its legend, `SEMANTIC_TOKEN_TYPES` and `SEMANTIC_TOKEN_MODIFIERS`), `queryInlayHints`,
// `queryInactiveRanges`, `queryExpansionSites`, `queryExpansion`, `queryAst`, `queryInstances`, `queryImports`,
// `queryCompletion`, `queryDocumentSymbols`, `queryReferences`, `queryPrepareRename`, `queryRename`,
// `querySignatureHelp`, `queryUnused` and `dropQueryIndex`, exported through src/djs.ts.
//
// THE CONTRACT. A query reads the frontend's module table (`Module.amodules`) as the last compile left it, whatever
// that compile was (`djsMain` or `djsMainKept`, fresh or kept), and runs between compiles only. It is read-only: no
// semantic call, no generated identifier, no write to frontend state. The kept-module engine (src/keep.ts) replays the
// next compile from this state, and its guarantee, output byte-identical to a fresh compile, holds only if nothing
// between two compiles changes it. What a query does call is the printer, as diagnostics do: types and signatures
// print through hdrgen.ts, which bumps and restores recursion guards. Its `optimize` calls (a variable template
// argument, a `size_t` expression) can run an initializer's semantic, so a query prints with the identity in their
// place (`printing`), the AST view and the instances' names with a fold that runs none (`foldVariable`, AST VIEW); an
// instance's peek and the AST view print through hdrgen's print hook (`dumping`), and after a kept compile that
// numbered generated identifiers otherwise, every query's print wraps `Identifier.toChars` and `toString`
// (`spellFresh`, in `printing`). Every swap is undone when the call ends.
//
// THE INDEX. Per file and per compile, built at the first query on that file and dropped when the next compile
// starts (`dropQueryIndex`, called by src/djs.ts). A walk of the module's analysed AST (`IndexWalker`, a
// SemanticTimeTransitiveVisitor whose overrides record what names a symbol) and of the members of the template
// instances and mixins whose template is declared in that file maps the byte offset of an identifier token to the
// symbols found there (`Hit`). The nodes and what each gives: VarExp, SymOffExp, DotVarExp, ThisExp/SuperExp's
// variable, DsymbolExp, ScopeExp, TemplateExp, DotTemplateExp, DotTemplateInstanceExp, DotTypeExp, DelegateExp, TypeExp
// and StructLiteralExp (a struct, class or enum), NewExp (the constructor, else the type); every declaration at its own
// name, function parameters included; the types written in a declaration (`originalType`: a TypeIdentifier or
// TypeInstance gives the symbol of the analysed type at the same place in the type's shape, else a read-only lookup of
// the name in the symbol tables around the declaration); the base classes of a class; an import's module and package
// names and its selective names; the module declaration. Code the analysis did not reach is not walked: the branch a
// condition did not choose, a function body whose semantic3 did not run (a template member never called, a function of
// a non-root module). The same walk notes, for the inlay hints and the inactive ranges, the calls written with their
// arguments in parentheses whose function the analysis resolved (`Call`), and the conditionals it decided (`Decided`).
// A node's Loc is not always its identifier, and the key is found from it on the file's bytes (`keyAt`): a member
// access is at its `.` (dmd/parse.d parsePostExp) or, once analysed, at its chain's leftmost operand (its key is then
// its own `.name` along the chain, `memberHit`: `a.x.x` gives each `x` its own symbol; of a parenthesised operand,
// inside or at the `(`, the chain after its `)`, `groupChain`), a call at its `(`, an aggregate or a template at its
// keyword, a parameter at its type. Several hits at one key: the hit whose symbol's name is the token's text wins over
// a lowered one (`__r12`, a `__ctor` call at a struct's name, the implicit `this`), and a compiler-made name never
// answers; among the winners, the first, and when they come from several template instances, the hover names the
// instance and the count. The walk also notes, raw, what the expansions and the Resolved sections read (`Notes`: string
// mixins, template mixins, manifest constants and enum members, the lowered nodes, the key of each variable and member
// access), which those build at their first need.
// THE FALLBACK. Where the analysis left no node, folded or rewritten away (an enum member or a manifest constant
// replaced by its value, `S` in `S.staticMethod()`, a selective import's name), an identifier outside comments and
// literals is looked up as written, read-only (`fallback`): after a `.`, in the scope of the symbol before it; else
// from the innermost analysed function holding it, through the symbol tables (`lookupLexical`). The hover and the
// definition refuse an inactive branch before any lookup (INACTIVE_REASON), as the tokens and the references skip it.
// It does not answer in other code the analysis skipped, where the tables around it hold other names: in the body of a
// function not analysed (a template's own members, semantic3 not run, a unittest's body without `-unittest`, which the
// parser skips), and with a runtime variable or parameter, which no analysis folds away, except in the body of a
// function whose analysis reported errors (`erroneousBody`): an expression with an error leaves an `ErrorExp`, a
// statement with one an `ErrorStatement` that its block becomes, so the walk meets none of their names. There a name is
// looked up by position as completion finds a first link (`brokenBodyLookup`: the function's locals declared before it,
// then the scopes outward), outside the inactive branches; a name found outside the function's locals is refused when
// the body's text declares it, names it as a lambda's untyped parameter, or holds a `with` statement, scopes the tables
// do not show.
// The lookup follows the imports declared in the function bodies holding the name, before it (`localImported`: a
// renamed import's name, a selective import's, a plain import's module), then the tables outward, at the module what
// its imports give as dmd's `search` finds it (`importedName`, `searchModule`: an imported module's own member, else
// its non-private imports', the symbols not visible from the module left out); after a `.`, a module's or a package's
// member through its imports and its package.d (`memberNamed`). Where two imports give different symbols (`search`
// reports an ambiguity, or merges overloads across modules) it answers nothing. A plain import's name answers as its
// first package (`std` of `std.file.exists`), as the analysis resolves it; a renamed import's name as the import. A
// runtime variable answers where the analysis left a node of it under another name at the token or along the chain
// before it (`resolvedNear`: `stdout` for its alias's target `__stdoutp`, a Tuple's `st.terminated`). It never answers
// for the words that are no symbol (`fallbackAllowed`: `exit` in `scope(exit)` is not core.stdc.stdlib's `exit`). A
// runtime variable before `.sizeof`, `.alignof`, `.mangleof` or `.stringof`, or inside `typeof(...)`, answers: those
// keep no node of their operand (`foldedOperand`), and a member after it (through a pointer) answers.
// A template's parameter with no node (in the parameter list, a constraint, a `static if` condition, a template's
// argument) answers with the argument it stands for, as a use with a node does: of the instance whose analysed function
// holds it, else the first, the hover counting them (`templateArgument`).
// BUILT-IN PROPERTIES and TYPE PARAMETERS. Two names no symbol stands for, answered by the hover alone. An identifier
// after a `.` that nothing above answers and that is one of the spec's properties of the operand's type (`builtinAt`,
// the list of completion's group 2, `builtins`): kind `property`, its type as that list gives it and the operand's
// type; the operand (`operandBefore`) is a basic type's keyword, a string literal, or the identifier ending it, past
// calls, indexes and template arguments, by its hit (in a template's code, the first instance's) or the fallback's
// symbol, or a parenthesised name dereferenced (`(*p).length`, `groupedOperand`). The definition says `a built-in property has no declaration`. A parameter named in a function or delegate
// type written in a declaration (`void delegate(int code) cb;`, `Notes.parameters`): kind `parameter`, as hdrgen prints
// the analysed parameter; its definition is its own name.
//
// A REQUEST carries the document's current text. When it differs from the text the compile read (`Module.src`, less a
// UTF-8 byte order mark), the answer is empty with `stale` set: every position would be wrong. A completion is the
// exception: it moves its position into the compiled text (COMPLETION). Otherwise (line from 0, UTF-16 character from
// 0) becomes a byte offset through the file's line table, then the identifier containing it.
//
// SEMANTIC TOKENS (`querySemanticTokens`). One pass over the file's code bytes (comments and literals skipped, as
// `nonCode` finds them) gives every identifier that is not a keyword the symbol the hover would show (`choose`), with
// two differences. An unnamed hit answers only when it is a function, a template or an instance (a call through an
// alias of another name: `msecs` for `dur!"msecs"`; a static `opCall` gives its aggregate): another unnamed hit is a
// value the analysis folded at the token (`15.seconds` holds a `Duration` literal at `seconds`). The fallback does not
// answer in a branch of a `version`, `debug` or `static if` the analysis did not choose (INACTIVE RANGES), nor for the
// words that are never symbols (`fallbackAllowed`: `scope(exit)`, `extern(C)`, `@safe`, a label).
// A template parameter used in an instance's code is the parameter (`templateParameter`, the instance's argument
// table), where the hover and the definition answer with the argument it stands for (the parameter's own alias has no
// source location).
// Not tokenised: an identifier with no symbol (a builtin property, a name in an unanalysed body, a version
// identifier), keywords and basic types (the grammar's), compiler-made names, the branch not chosen, a string's
// prefix or postfix, and object.d's `string`, `wstring`, `dstring`, `size_t`, `ptrdiff_t`, `noreturn`, which the
// TextMate grammar colours as basic types.
// The kinds (`SEMANTIC_TOKEN_TYPES`, standard LSP names; `tokenKind`):
//   module, package, `extern(C++)` namespace, scoped import   namespace
//   class / interface / struct, union                          class / interface / struct
//   enum / enum member                                         enum / enumMember (readonly)
//   template type, alias and tuple parameter                   typeParameter
//   template value parameter                                   parameter (readonly)
//   function parameter                                         parameter
//   field, static member variable, @property function          property
//   member function (static ones, member templates too)        method
//   free or nested function, overload set                      function
//   constructor (at `new S`, `S(...)`)                         its aggregate's kind
//   global or local variable, a tuple of variables             variable
//   alias of a symbol / of an aggregate or enum type           the target's kind (`defaultLibrary` the alias's own,
//                                                              but a selective import's the target's)
//   alias of any other type (a delegate, an array, ...)        type
//   template                                                   its eponymous member's kind (one, or the first of
//                                                              several overloads); `type` for an alias template, a
//                                                              mixin template, or a template without one
//   template instance                                          its template's kind
// Modifiers (`SEMANTIC_TOKEN_MODIFIERS`, bits): `declaration` when the token is the key of the symbol's own location
// (a module only in its module declaration); `readonly` for enum members, manifest constants, template value
// parameters, and variables `const` or `immutable` by storage class or by their type's head; `static` for static
// member functions and variables and for static or `__gshared` locals, never module-level ones; `deprecated`
// (`isDeprecated`, of the alias or its target); `defaultLibrary` when the symbol's outermost package is one of
// druntime's and Phobos's (`core`, `std`, `etc`, `ldc`) or it is in `object`: a root-package rule rather than the
// import paths a compile resolved, so the answer does not depend on the command line, and no user package of those
// names exists in the repositories djs serves.
// The answer: `Uint32Array` 5-tuples `[line, character, length, type, modifiers]`, absolute line from 0, UTF-16
// character and length, sorted by position, no two overlapping; the host does the relative encoding.
//
// INACTIVE RANGES (`queryInactiveRanges`). The branches of the `version`, `debug` and `static if` declarations and
// statements that the analysis did not choose, as it chose them for the compile's target and flags. A declaration's
// condition stays in the analysed AST (`ConditionalDeclaration.condition.inc`); a statement's does not (semantic
// replaces it by its chosen branch), and the frontend notes each statement it decides on its function
// (`FuncDeclaration.djsConditionals`, dmd/statementsem.ts). The walk collects both (`Decided`), from every analysed
// copy of the code: a branch is inactive when some copy decided the condition and none chose that branch (a template's
// instances may choose differently, and then nothing is inactive; speculative instances do not count); a conditional
// no analysis decided (a template without instances, a function whose semantic3 did not run) has no inactive branch,
// nor one whose copies are not all known (`undecided`: in a mixin template, mixed in by modules this walk does not
// enter; in a function of which some instance's copy was not analysed). Its extent is found on the text
// from the conditional's keyword (`conditionalBranches`): from after the condition to the end of the branch's block or
// statement (`statementEnd`: a brace-less `if ... else`, a loop, `static foreach`, `try ... catch` are one statement,
// D binding an `else` to the innermost `if` or condition; a function's `in`/`out` contracts belong to it; attributes
// with a `:` reach the end of the block), or from after the `:` to the end of the enclosing block for `version
// (X):`; the `else` branch, when the analysed node has one, from after the `else`. Comments and literals, delimited
// and token strings included (`nonCode`), are skipped. Ranges are merged: an inactive
// branch nested in another is inside it. The semantic tokens give no token there.
//
// EXPANSIONS (`queryExpansionSites`, `queryExpansion`). Three constructs, each with its analysed copies (one, or one
// per template instance or `static foreach` iteration holding it; a peek shows the first and counts them):
//   mixin       a string mixin declaration: its declarations as parsed and analysed (`MixinDeclaration.decl`), printed
//               by hdrgen. A mixin statement: semantic replaced it by its statements (dmd/statementsem.d `flatten`),
//               whose locations are in the file `<file>-mixin-<line>` the parse made (dsymbolsem.d `adjustLocForMixin`,
//               one name object per mixin): a run of them in a block is matched to the `mixin (` keywords of that line
//               that start a statement (`matchMixins`): by the string a keyword's lone literal argument mixes in, else
//               by parse order, a copy's runs taking the line's keywords in turn. A mixin in an expression or a type is
//               not one.
//   instance    a template instance written with `!` (`Foo!(args)`, `Foo!arg`, not an IFTI call): the instance a hit at
//               its name is or belongs to (of nested eponymous ones the outermost, `outermost`), else one made at that
//               location (`Twice!3`, folded to its value); a template mixin at its template's name. Printed as -vcg-ast
//               prints it (`HdrGenState` `fullDump` and `vcg_ast`, dmd/hdrgen.d `dumpTemplateInstance`): the
//               instantiated members, arguments substituted; an instance met again inside its own dump by name only
//               (`instanceText`).
//   value       a folded value where it differs from the source (`folded`: whitespace, a leading `cast(T)`, a number's
//               suffix and digit separators ignored; a source that is one literal is never a site): a manifest
//               constant's or an enum member's initializer as the analysis left it; a `static if` condition, `true` or
//               `false` per copy (`Decided`); a value argument of an instance written with `!` whose analysed argument
//               is a literal (`Box!(int, K + 1)` holds 4), nested in the instance's site. A value printed empty (an
//               error) is none.
// The sites are the outermost of nested ones, one code lens each; a peek answers the innermost site containing its
// range: a cursor's point, a lens's own site, a selection.
//
// RESOLVED (the hover's last section). What the analysis made of the code at a token, printed by hdrgen from the
// analysed nodes (`Lowered`), never rebuilt from the text, for one analysed copy:
//   Lowered:                 an operator overload's call at its operator (`a + b` as `a.opBinary!"+"(b)`, a comparison
//                            or negation around `opCmp`/`opEquals`, `[` for `opIndex`, `in` for `opBinaryRight`; the
//                            overloads the analysis locates at their object, LOCATED_AT_OBJECT, at the token found
//                            from it: `-a`, `++a`, `cast(int) a`, `a[i] += x`); a `foreach` lowered to a `for` over a
//                            range (the range's copy, the head, the loop variables) or to an `opApply` call (its
//                            delegate by its signature), at the keyword
//   Property call:           a function called without parentheses, as the call (`a.twice()`, a setter `a.twice(4)`)
//   UFCS:                    a free function called as a member, as the call (`ufcs(a, 5)`)
//   Through `alias this`:    a member reached through `alias this`, to a field or a function (`o.inner.deep`,
//                            `bf.get().deep`), or the access itself
//   Overload picked among N candidates:  the signature of the function the call resolved to, when its overload set
//                            (`overloadCount`, read-only) declares more than one function or template
//   Implicit conversion:     a cast the analysis inserted around the expression starting at the token, between types
//                            that differ past their modifiers (not to `void`, not of a literal, not one written)
// A call is printed through its instance (`opBinary!"+"`, the outermost of nested eponymous ones), a prefixed object
// in parentheses (`(*p).opUnary!"-"()`); its arguments, as the other nodes, by hdrgen. A part whose text names a
// compiler's temporary (`__r12`) is not shown, but for a lowered `foreach`. A hover at a token where one sits and no
// identifier (an operator, `a+b` included) or no symbol (`foreach`, `new`, `cast`) answers with the section alone,
// kind `operator`, `statement` for `foreach`, `expression` for another word. A `Lowered:` part that calls a function
// (an operator's overload, `opApply`) is followed by that function's doc summary (`Resolution.called`): at an operator
// the hover has no other text to show it.
//
// INLAY HINTS (`queryInlayHints`), three kinds, for the declarations and calls of a range:
//   type        a variable declared without a type (`auto x`, `const x = 1`, `enum x = 1`, `foreach (i, ref x; r)`,
//               `auto a = 1, b = 2`; found on the text, `declaredWithoutType`: the analysed variable has a type
//               either way): `: T` after its name; an `auto` function (`inferRetType`): `-> T` after its last
//               parameter list. T as dmd prints the analysed type, cut at HINT_TYPE_WIDTH characters; in a template's
//               code, the instances' distinct types joined by ` | `.
//   parameter   each argument of a call whose function the analysis resolved, the overload it picked: `name:` before
//               it, as written in that function's type. A UFCS receiver is the first parameter; none for an argument
//               that is the parameter's own name (VS Code's TypeScript convention), a parameter without a name of
//               its own (a tuple's expansion, `_param_0`), the arguments of a variadic function past its last
//               parameter, nor from the first named argument on, nor from the first written argument that is not
//               exactly one analysed argument (`Call.args`: a tuple written as one expands to several). Calls without
//               parentheses (a property, an operator) have none. `new C(...)` is a call of its constructor.
//   instances   a template declared in the file, the number of instances the compile created of it (`instancesOf`:
//               every module's, not speculative ones), after its name; the first HINT_INSTANCES in the tooltip.
//               None when zero; a mixin template's mixins are not counted.
// A tooltip is the hover's code block of the symbol the hint is about (the variable, the function, the called
// function), or the instances.
//
// AST VIEW (`queryAst`). A compiled module (a root, or one `-i` compiles: `-vcg-ast` writes nothing for a module only
// imported) as `-vcg-ast` writes it in `<file>.cg` (dmd/main.d: `moduleToBuffer`, `fullDump` and `vcg_ast`, tab
// indents), printed from the AST the last compile left, kept or fresh, with every declaration printed through hdrgen's
// symbol printer: its range in the text, its kind and name, the identifier of its declaration (what `queryDefinition`
// finds; an instance's is where it was instantiated; none for a symbol the compiler made), and a function's extent in
// that file (to its `endloc`). The ranges are the print's own (`astOf`, through hdrgen's print hook); the variables of
// `int a, b;` in a function, which hdrgen prints without its symbol dispatch, have none. Two departures from the
// identity of `printing`, both read-only:
//   - hdrgen's `optimize` folds a variable that is a template argument or an array dimension (`Foo!(1114112LU)` for
//     `Foo!(maxIndex)`); the view folds a variable whose initializer is a constant (`foldVariable`), and prints the
//     name where `optimize` would analyse an initializer that is not one yet, which -vcg-ast's own print analyses:
//     the one place the text can differ from the `.cg` file;
//   - a kept compile's AST holds the generated identifiers (`__r12`, `__o3`) its replayed units made when they ran, in
//     an earlier compile, numbered from that compile's counter, where a fresh compile numbers them from this one's. The
//     engine records each unit's generated identifiers and where its replay consumed their numbers (src/keep.ts
//     `keepGenerated`, `keepGeneratedNames`), and the view spells each one as a fresh compile numbers it
//     (`spellFresh`): after a kept compile the view is the one a fresh compile of the same files gives.
// An instance met again inside its own dump prints by name only (`dumping`), where -vcg-ast recurses until the stack
// ends.
//
// INSTANCES (`queryInstances`). The `instances` hints' table whole (`instancesOf`): per template declared in the
// queried files and instantiated, every instance the compile created, not the speculative ones, with its title and
// where it was instantiated. The names print as the AST view prints them: with `foldVariable`, and spelled by
// `spellFresh` after a renumbering kept compile.
//
// IMPORTS (`queryImports`). The modules the last compile loaded (`Module.amodules`), each with its role (on the
// command line, compiled through `-i`, imported), its size and its imports: the modules its own `import` declarations
// name outside functions and templates (`moduleImports`), in the branch a condition chose, in mixins and aggregates;
// not the frontend's `aimports`, which also takes the imports of the instances a module requests, and which a kept
// module keeps from compile to compile. The cycles are the strongly connected components of those imports.
//
// COMPLETION (`queryCompletion`). The names after `expr.` at a position, from the last compile, whatever it was: in
// editor mode a compile of a half-typed buffer analyses the declarations the parser kept (a body cut by the parse error
// runs to the text's end, `offsetOf`), and the answer is that compile's; no older module is kept for it. The request's
// text may differ from the compiled one (the dot typed after the compile): `expr` is read from the request's text,
// backwards from the dot (`chainBefore`), whitespace, newlines and comments skipped, up to the statement's start (a
// `;`, `{` or `}`): an identifier chain `a.b.c`, `this` or `super` first, a leading `.` for the module scope (a `.`
// with no identifier, `)`, `]` or literal before it), a link ending in `()` with no arguments or `[...]`; anything else
// is a miss. Its scope is found in the compiled text at the dot moved through the common prefix and suffix of the two
// texts (`editOf`, `movedOffset`, djs-vscode's move for the hints; inside the changed span, the span's start): the
// innermost analysed function holding it (`scopesAt`; in a function template's body, each analysed instance's copy, and
// the chain must resolve to one type in all of them), else the module (the frontend keeps no extent of an aggregate).
// The first link: `this`, `super` (qualified as the member function's `this`); the symbol the index has at the
// identifier when it is in the text the compile read, before the edit or in the unchanged end (`indexedSymbol`: the
// declaration the analysis found there, of two locals of one name, or of a local and a later one shadowing a global);
// an import declared in an enclosing body before the dot (`localImport`, which no function table holds); else
// `lookupFrom`: `lookupLexical` with an aggregate's base classes and template mixins, a function's parameters and
// locals by position (one declared after the dot is not in scope; a name several locals of the function declare is a
// miss: its table holds only the first; in a body with errors, which the walk sees as an `ErrorStatement`, a local the
// walk did not meet takes its own location's position, and a name the body's text declares more than once is a miss,
// `declarations`, which never counts an expression statement). Each next link is a member of what the previous names
// (`memberOf`, `memberNamed`; through one `alias this` for a value; a module's public imports', a package's
// package.d's). A variable gives a value of its type (a field of a `const` or `immutable` value takes the qualifier), a
// function the value it returns (`()` written or not, D's optional parentheses: every overload callable with no
// arguments, one return type, not `void`, no template), an aggregate, an enum or a type alias a type, an import, a
// module or a package a scope; `[...]` an array's or a pointer's element, an associative array's value (`symbolTarget`,
// `returnType`, `applyOps`). The items, one per name (`completionItems`):
//   0  members: of a value of aggregate type (through a pointer; an enum value as its base type), every member of its
//      table, its template mixins' and its base classes' (object.Object's for a class), then those its `alias this`
//      reaches; of the functions only those callable on the receiver, mutable or not (static, or a `this` qualifier
//      it converts to: `callableOn`, `modConverts`; an `immutable` method is not offered on a mutable value); of a
//      type, its static members
//      (`isStaticMember`), an enum's members; of a module, its members and its public imports'; of a package, its
//      modules and subpackages the compile loaded and its package.d's members. Not the compiler's names (constructors,
//      destructors, postblits, invariants, unittests, `__`-prefixed) nor imports' package names. Visibility
//      (`accessible`), an approximation: `private` from its module only, `package` from a module of its package,
//      `protected` from its module or a derived class;
//   1  UFCS candidates for a value (`ufcsCandidates`): the module-level functions of the place's module, of the
//      modules it imports (their public imports followed), of its selective imports and of the function-local imports
//      before the dot, whose first parameter takes the receiver as D passes it (`receives`): the same type with its
//      qualifiers converted as D converts them, through a slice's or a pointer's target (`converts`); a derived class
//      by value; the qualifier dropped by a copy of a type without mutable indirections (`mutableIndirections`, from
//      the analysed fields); a `ref` parameter the same type, its head qualifier converted. A function template by
//      an instance the compile made with such a parameter. No other conversion, no template constraint;
//   2  built-in properties, the spec's fixed lists (`builtins`; an enum value's `min` and `max` are the enum's).
// An item: kind (`completionKind`), detail (the hover's signature on one line, `(+N overloads)` after a member
// function's), documentation (the doc comment's summary as `DocComment.parse` splits it, on one line: the overload
// the item shows first, a UFCS candidate's receiving overload, then the name's). Sorted by group, then label
// (`completionOrder`: names starting with `_` last, case ignored first).
// Without a `.` before the identifier being typed (or with nothing typed), the names visible there (`scopeCompletion`,
// `scopeItems`), from the same compile and the same scope, found at the position moved as the dot is (of a template's
// instances, the first copy), one item per name, the innermost declaration winning:
//   0  the locals and parameters of the functions holding the position (a nested function's, then its enclosing
//      ones'): those the walk met and those of the function's table it did not (a body with errors; nested functions
//      and aggregates), at their own locations, declared before the position in a block still open there or, declared
//      in a statement's parentheses (`foreach`, `if (auto x = ...)`, `catch`), within that statement (`openAt`); the
//      parameters of a template instance holding it; the function-local renamed imports before it (`import io = ...`);
//   1  the members of the aggregate whose member function holds it: `this`'s as after `this.` (its qualifier's
//      methods, its `alias this`'s), a static member function's static members;
//   2  the module's own members and the names its imports declare (`std` of `import std.stdio;`, a renamed import);
//   3  the public members of the modules it imports, their public imports followed, and of the function-local imports
//      before the position (a selective import's names).
// Not the keywords (the grammar's), nor the compiler's names. Each item as after a dot, its overloads counted; a
// module's entries are listed once per compile and their items printed at the first need (`moduleItems`, `itemOf`).
//
// DOCUMENT SYMBOLS (`queryDocumentSymbols`). The file's declarations as a tree, from the module's members as the last
// compile left them (`Outline`): the module declaration; one `imports` node per scope holding its imports; aggregates,
// enums, templates and template mixins with their members (a template with an eponymous member, `struct Pair(T)`, is
// one node of the member's kind, the template's parameters before the member's detail; another template a
// `namespace`); functions with the functions, aggregates, enums and templates declared in their bodies, which come
// from the index (the declarations the walk met at their names, of every analysed copy; none in a body no analysis
// ran); variables, aliases, enum members, unittests, constructors and the other special functions by their D
// spelling (`this`, `~this`, `this(this)`, `static this`, `invariant`, `unittest`). Attributes are transparent; of a
// `version`, `debug` or `static if`, the branch the analysis chose (both when it decided none, as in a template's
// members): a declaration in a branch not chosen is absent, as it has no semantic tokens; a `static foreach`, its
// expanded members (one node per name and place). A string mixin's declarations are its children's level's, at the
// mixin's range, their detail starting `(mixin) `; a template mixin's members are its children at its range. The
// compiler's names (`__xopEquals`, an anonymous member's) and the functions it generates (an `opAssign` of a struct
// with a field that has one) are not shown. Kinds are LSP's names (`SymbolKindName`); a
// template's members, not analysed, are fields and methods by their place in an aggregate. A node's selection is its
// name's key (`keyAt`); its range runs from the first token of the declaration's line (back to a `;` or a brace) to
// its end (`statementEnd`: the block, or the `;`); an enum member's is its name. The detail, cut at HINT_TYPE_WIDTH: a
// function's type, a variable's, an enum's base type, an enum member's initializer as written, an aggregate's bases,
// an alias's target, a template's parameters.
//
// REFERENCES (`queryReferences`). The tokens of every module the last compile analysed (its roots and the modules `-i`
// compiled, `analysedModules`; not those only imported, whose bodies no analysis ran) that name the symbol at a
// position. The target is the token's symbol as the semantic tokens find it (`tokenSymbol`: the index's hit, else the
// fallback, so a folded enum member or manifest constant is found), a template instance standing for its template, a
// constructor named by its aggregate's name (`S(1)`, `new S`) for the aggregate; or a parameter of a template declared
// in the file whose extent holds the token, not after a `.` (`parameterAt`). A symbol is identified by its
// declaration's identifier (`referenceKey`: a template member and its copies in every instance, a function template and
// its instances' functions are one), or by itself when it has none (no location, declared in a string mixin; such a
// declaration is listed at its name inside the mixin's literal when `mixinSite` finds it there). Each
// occurrence of the name in code (`occurrences`, comments and literals skipped) is a reference when one of the hits
// there (`choose`) or the token's symbol has the target's key, or is a constructor of the aggregate the target is: a
// call through UFCS, a property call, a member of an instance, a selective import's name, an alias's target as written
// all are. A template parameter's references are its name's occurrences in the template's extent, outside a nested
// template declaring the same name. Not found: the uses in a module only imported, in a branch not chosen, in a
// function body no analysis ran (a template without instances), the names a string mixin's text spells, and an implicit
// use with no token of the name (an operator's `opBinary`, a `foreach` range's `front`). Each reference says whether it
// is the declaration's own name (`isDeclarationAt`).
//
// RENAME (`queryPrepareRename`, `queryRename`). The references' target, renamed at every reference, the declaration's
// name included, unless one of them could be missed (`renameTarget` refuses, with the reason): a module or a package
// (renamed with its file); a constructor or another special function (`this`); a name D calls with no token of its own
// (`opBinary` and the other `op` names, a range's `front`, `empty`, ..., `length`, `toString`, `toHash`:
// `IMPLICIT_NAMES`); a symbol declared in a string mixin or with no declaration; one declared in a module the last
// compile only imports (the bundled import tree's included), whose other users no analysis saw; a name a string mixin's
// text spells as a word in a searched module, in a token string or in a literal of a `mixin (...)`'s arguments
// (`mixinSpelling`; a string built elsewhere and mixed in is not seen). The new name must be a D identifier, not a
// keyword, not starting with `__`, and not declared already in the symbol's scope (a template parameter: not spelled in
// the template); a clash in a function's locals is not checked (the next compile reports it).
//
// SIGNATURE HELP (`querySignatureHelp`). The call whose parentheses hold the position: the innermost `(` open there,
// found backwards over the code up to the statement's start (`openParen`), the callee the identifier before it (past
// `!arg` or `!(...)`). The candidates (`callCandidates`): the function the compile resolved the call to (`Call`, an
// instance's function when it instantiated a template), then the rest of the name's overload set (`overloadSet`; a
// template not instantiated for this call as its eponymous function, its parameters as written); with no resolved call
// (a call being typed, compiled with the parse error), the overload set of the symbol at the callee (the hit, else the
// fallback); an aggregate's name gives its constructors. A candidate's label is `ret name(params)` (a constructor's
// `S(params)`, a template's parameters after the name), each parameter as hdrgen prints it, with its span; the doc
// summary is the hover's. The active parameter counts the commas at the call's depth before the position, plus one for
// a UFCS receiver (the resolved call's, or a free function after a `.`).
//
// UNUSED (`queryUnused`). The declarations of the program the entry cannot reach, for the compile's target and flags:
// the modules it analysed (its roots and those `-i` compiled), never druntime's and Phobos's, are the program. The
// graph's nodes are the analysed symbols, each template instance's copy its own (its code differs); a declaration is
// live when one of its copies is (`referenceKey`: a template's member, a function template). Edges, unioned:
//   1. the analysed code of each node (`ReachWalker`): every symbol an expression names (variables, calls, members,
//      `new`, delegates, function literals, templates) and every aggregate or enum in an expression's or a declared
//      type, lowered nodes included (a `foreach` over `opApply` or a range, an operator's overload, `opDispatch`, a
//      copy constructor) and the code string mixins produced, which is ordinary AST once analysed. The template
//      instances live code reaches are walked wherever their template is (`writeln!S` calls `S.toString`); the
//      non-template code of druntime and Phobos is not analysed and names nothing.
//   2. the token net, for what the analysis folded away (a CTFE call in `enum x = f();`, `typeof`, `is`,
//      `__traits(compiles)`, a constraint, a `static if` or `static assert` condition): each identifier of a user's
//      module resolved as the tokens resolve it (`tokenSymbol`), from the innermost analysed function holding it, else
//      the aggregate, enum or template whose extent holds it (`Reach.holders`), else the module, which is a root.
//   3. the names written where no analysis ran but code is: in a branch of a `version`, `debug` or `static if` the
//      compile did not choose, in a unittest without `-unittest`, a name keeps every user's declaration of that name
//      live with its holder (a function only another target or the tests call is not reported); in a live function
//      whose body no analysis ran, likewise; in a string literal, when the module's code spells `mixin(` or
//      `__traits(` (a function a string mixin's code calls in CTFE leaves no other trace: the mixin's text is not
//      kept).
// Roots: the entry (`main`, C `main`, `WinMain`, `DllMain`), the module constructors and destructors,
// `pragma(crt_constructor)` and `crt_destructor`, the unittests under `-unittest`, the definitions with a linkage other
// than D's, `export` or `pragma(mangle)`, the aggregates of another class kind (C++, Objective-C), what module-level
// code names; every class once `Object.factory` or `TypeInfo_Class.find` is reached. A live node keeps the declaration
// it sits in (a template instance its template); a live aggregate its destructor, postblit, copy constructor,
// `opAssign`, `opEquals`, `opCmp`, `toHash`, `toString`, invariant, `alias this` target, base classes and fields'
// types (TypeInfo and the runtime call them with no node). Virtual functions form families by `foverrides` (interfaces
// included): a member is live when its class is and one member of its family is named, or when the family reaches a
// function outside the user's modules (`Object.toString`, which druntime calls).
// Reported: functions (free, member, nested; a function template by its template), templates, aggregates, enums and
// mutable module or static variables (not `extern`), declared at their identifier in a user's D file (not a C module's
// headers, not a .di), the outermost unused one only (an unused struct's methods are not listed again). Not reported,
// since an analysis folds or hides their uses: fields, locals, parameters, enum members, manifest constants and `const`
// or `immutable` variables, aliases, the declarations a string mixin made, unittests, imports. Why (`UnusedWhy`):
// nothing names it; only itself or code nested in it does; only unused code does (or a template no instance analysed
// names it). A declaration only a module the compile does not import uses (another program's, one imported in a branch
// not compiled) is reported: unused in this program.
// Misses: no entry (a library compile: what is unused depends on its users); a compile with errors.
//
// Cost: the first query on a file decodes its text and walks its AST and its templates' instances (a large application
// module: ~50 ms); the next ones compare the request's text with the compiled one, look the key up and print. The
// tokens of a file are one pass over its bytes and one hit lookup per identifier, the fallback where none answers (a
// large application module under -i: 8998 tokens, ~25 ms with the index built, ~95 ms when it builds it; the fallback
// is ~4 ms of that and 954 of the tokens, the folded enum members among them). The unused code walks the user's modules
// and the instances the program reaches, and resolves every token of those modules (that application, 165 D modules
// under -i: ~0.8 s with the indexes to build, ~0.45 s with them built). The inactive ranges scan the text once per
// conditional decided; the inlay hints of a range look at each of its declarations and calls and print their types and
// signatures. A completion scans the request's text (its comments and literals, the move, when it is not the compiled
// one, ~2 ms on that module) and prints its items (that module under -i, at a load of 4: a struct's 35 items ~3 ms, a
// module's 44 ~2 ms, an enum's 10 ~0.1 ms, a string's 71, 64 of them UFCS, ~5 ms; ~50 ms when the request builds the
// index).

import { resolve } from "node:path";
import { SemanticTimeTransitiveVisitor } from "./dmd/visitor/index.js";
import { Module } from "./dmd/dmodule.js";
import { Include } from "./dmd/cond.js";
import { Dsymbol, PASS, Visibility } from "./dmd/dsymbol.js";
import { FileType, LINK, MODFlags, STC, Sizeok, TY, VarArg } from "./dmd/astenums.js";
import { global } from "./dmd/globals.js";
import { isVirtualMethod } from "./dmd/funcsem.js";
import { DocComment } from "./dmd/doc.js";
import {
    EXPtoString, HdrGenState, dsymbolToCBuffer, dsymbolToChars, expToCBuffer, expressionToChars,
    faithfulEnumMemberInteger, functionToBufferFull, initializerToChars, registerDsymbolPrintHook,
    parameterToChars, registerEnumMemberInteger, registerOptimize, statementToCBuffer,
} from "./dmd/hdrgen.js";
import { optimize } from "./dmd/optimize.js";
import { EXP } from "./dmd/tokens.js";
import { isScalar } from "./dmd/typesem.js";
import { WANTexpand } from "./dmd/expression.js";
import { OutBuffer } from "./dmd/common/outbuffer.js";
import { Id } from "./dmd/id.js";
import { Identifier } from "./dmd/identifier.js";
import { DYNCAST } from "./dmd/rootobject.js";
import { cstr } from "./dstring.js";
import type { DString } from "./dstring.js";
import { ClassKind } from "./dmd/aggregate.js";
import type { AggregateDeclaration } from "./dmd/aggregate.js";
import { ConditionalDeclaration, StaticForeachDeclaration } from "./dmd/attrib.js";
import type { MixinDeclaration } from "./dmd/attrib.js";
import type { ClassDeclaration } from "./dmd/dclass.js";
import type { AliasDeclaration, Declaration, VarDeclaration } from "./dmd/declaration.js";
import type { EnumDeclaration, EnumMember } from "./dmd/denum.js";
import type { Import } from "./dmd/dimport.js";
import type { ScopeDsymbol } from "./dmd/dsymbol.js";
import { TemplateInstance } from "./dmd/dtemplate.js";
import type { TemplateDeclaration, TemplateMixin } from "./dmd/dtemplate.js";
import type {
    AssignExp, BinExp, CallExp, CastExp, CmpExp, DeclarationExp, DelegateExp, DotTemplateExp, DotTemplateInstanceExp,
    DotTypeExp, DotVarExp, DsymbolExp, Expression, FuncExp, NewExp, NotExp, ScopeExp, StructLiteralExp, SuperExp,
    SymOffExp, TemplateExp, ThisExp, TypeExp, UnaExp, VarExp,
} from "./dmd/expression.js";
import type { FuncDeclaration } from "./dmd/func.js";
import type { Loc, SourceLoc } from "./dmd/location.js";
import { Type } from "./dmd/mtype.js";
import type { Parameter, TypeFunction } from "./dmd/mtype.js";
import type { Catch, CompoundStatement, ExpStatement, Statement } from "./dmd/statement.js";
import { compiledImports } from "./dmd/compiler.js";
import { keepAllGeneratedNames, keepGeneratedNames, keepRenumbered } from "./keep.js";
import type { FreshNumber } from "./keep.js";

/** A position in a file, in an editor's terms: line from 0, character in UTF-16 code units from 0. */
export interface QueryPosition {
    line: number;
    character: number;
}

/** A range in a file, start inclusive, end exclusive, in `QueryPosition`s. */
export interface QueryRange {
    start: QueryPosition;
    end: QueryPosition;
}

/** No answer: `reason` says why; `stale` when the text differs from the compiled one (an editor shows that one). */
export interface QueryMiss {
    result: null;
    stale: boolean;
    reason: string;
}

/** The hover of the symbol under a position. */
export interface HoverResult {
    /** dmd's kind of the symbol (`function`, `struct`, ...); `parameter`, `field` or `local variable` for those. */
    kind: string;
    /** The symbol's qualified name (`toPrettyChars`). */
    name: string;
    /** Markdown: kind and name, the signature or type in a ```d block, deprecation, the rendered doc comment. */
    markdown: string;
    /** The identifier the hover is for, in the queried file. */
    range: QueryRange;
}

/** The declaration of the symbol under a position. */
export interface DefinitionResult {
    /** The symbol's qualified name. */
    name: string;
    /** The declaring file as the compiler names it (absolute when the command line and import paths are). */
    file: string;
    /** The declaration's identifier in that file; a module's is the start of its file. */
    range: QueryRange;
}

export type HoverAnswer = { result: HoverResult } | QueryMiss;
export type DefinitionAnswer = { result: DefinitionResult } | QueryMiss;

// ── the index ───────────────────────────────────────────────────────────────────────────────────────────────

/** A symbol named at a key, and the template instance (or mixin) whose members held the node. */
interface Hit {
    sym: Dsymbol;
    named: boolean;
    inst: TemplateInstance | null;
}

/**
 * A function's byte range, from its name to its closing brace (a unittest the parser skipped: from its keyword);
 * `fd` null when the analysis did not run its body.
 */
interface Body {
    start: number;
    end: number;
    fd: FuncDeclaration | null;
}

/** A resolved call written with its arguments in parentheses: its `(`, the function, whether a UFCS receiver leads. */
interface Call {
    paren: number;
    fd: FuncDeclaration;
    ufcs: boolean;
    /** The byte offset in this file of each analysed argument (`-1` when elsewhere), defaults included. */
    args: number[];
}

/**
 * A `version`, `debug` or `static if`, declaration or statement, as one analysis decided it: the byte offset of its
 * keyword, the decision (`Include.yes` or `Include.no`), and whether it has an `else` branch.
 */
interface Decided {
    at: number;
    inc: Include;
    hasElse: boolean;
}

/**
 * The statements one string mixin put in a block (semantic replaced the mixin statement by them): the line its file
 * name gives (`<file>-mixin-<line>`), that name (one object per mixin parsed), the index of its first location (the
 * mixins of one line are parsed in order), the statements, the instance whose copy holds them.
 */
interface MixinRun {
    line: number;
    name: DString;
    index: number;
    statements: Statement[];
    inst: TemplateInstance | null;
}

/**
 * A node a hover's Resolved section may print (RESOLVED in the header), at the byte offset of its location: a resolved
 * call, or a comparison or negation around an operator's call; a member access through `alias this`, or one that is
 * the `alias this` access; a cast; the statements of a `foreach` lowered to a `for` over a range.
 */
interface Lowered {
    kind: "call" | "aliasThis" | "cast" | "foreach";
    node: Expression | Statement[];
    at: number;
    /**
     * A call's first argument's byte offset (a UFCS receiver is before the callee), a cast's operand's first byte;
     * else -1.
     */
    first: number;
    /** An operator call's object's first byte (`a` of `-a`, which some lowerings are located at), else -1. */
    object: number;
    inst: TemplateInstance | null;
}

/** What the walk notes for the expansions and the Resolved sections, raw (EXPANSIONS and RESOLVED in the header). */
interface Notes {
    /** A string mixin declaration at its keyword, with its parsed and analysed declarations. */
    mixins: { at: number; decl: Dsymbol[]; inst: TemplateInstance | null }[];
    runs: MixinRun[];
    /** A template mixin at its template's name. */
    templateMixins: { at: number; tm: TemplateMixin; inst: TemplateInstance | null }[];
    /** A manifest constant, or an enum member with a value, at its name. */
    manifests: { at: number; sym: VarDeclaration; inst: TemplateInstance | null }[];
    lowered: Lowered[];
    /** The key (`keyAt`) of each variable and member access the walk recorded a hit for. */
    keys: Map<Expression, number>;
    /**
     * A parameter named in a function or delegate type written in a declaration (`void delegate(int code) cb;`), at
     * its name, with the analysed type it belongs to: no symbol stands for it (TYPE PARAMETERS in the header).
     */
    parameters: Map<number, { param: Parameter; tf: TypeFunction }>;
}

interface FileIndex {
    /** The compiled text the offsets index (`Module.src` less a byte order mark), and decoded. */
    bytes: Uint8Array;
    text: string;
    /** Built at the first request on the file whose text is the compiled one (`hitsOf`). */
    hits: Map<number, Hit[]> | null;
    /** The function bodies' byte ranges (`Body`), and the comments' and literals' (`nonCode`). */
    functions: Body[];
    nonCode: [number, number][];
    /** The calls (`Call`) and the decided conditionals (`Decided`) the walk met, in walk order. */
    calls: Call[];
    decided: Decided[];
    undecided: [number, number][];
    /** The branches no analysis chose (INACTIVE RANGES in the header), built at the first need (`inactiveOf`). */
    inactive: [number, number][] | null;
    notes: Notes | null;
    /** The expansions (EXPANSIONS) and the Resolved sections by key (RESOLVED), built at the first need. */
    expansions: Expansion[] | null;
    resolved: Map<number, Resolution[]> | null;
    /** The AST view (AST VIEW), printed at the first request. */
    ast: AstResult | null;
    /** The imports the walk met that resolved a module, at their keyword's byte offset (COMPLETION's local ones). */
    imports: { at: number; imp: Import }[];
    /** The parameters and variables of functions, at their name's byte offset (COMPLETION's locals by position). */
    locals: { at: number; v: VarDeclaration }[];
    /** `locals` by function, built at the first need (`localsOf`). */
    localsByFunction: Map<FuncDeclaration, { at: number; v: VarDeclaration }[]> | null;
}

const indexes = new Map<Module, FileIndex>();
/** The module of each requested file name, or null when none (`moduleOf`). */
const modulesByFile = new Map<string, Module | null>();
/** The instances of each template, from the module members (`appendToModuleMember`), built once per compile. */
let instancesByTemplate: Map<Dsymbol, TemplateInstance[]> | null = null;
/** The generated identifiers of each owner's units, and of the compile's (`spellFresh`), built at the first need. */
const generatedBy = new Map<Dsymbol, Map<Identifier, FreshNumber>>();
let allGenerated: Map<Identifier, FreshNumber[]> | null = null;
/** The generated identifiers a print left unspelled since the last compile (`queryAmbiguousNames`). */
const ambiguous = new Set<Identifier>();
/** The items of each module's table for a completion without a dot (`moduleItems`), printed at the first need. */
const moduleItemCache = new Map<ScopeDsymbol, ModuleEntry[]>();

/**
 * Drops every index: called by src/djs.ts when a compile starts, since the indexes point into the AST that compile
 * replaces. Cost: none beyond the garbage.
 */
export function dropQueryIndex(): void {
    indexes.clear();
    modulesByFile.clear();
    instancesByTemplate = null;
    generatedBy.clear();
    allGenerated = null;
    ambiguous.clear();
    moduleItemCache.clear();
    searches.clear();
}

const utf8 = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The text of a frontend string (`cstr`: an `extractChars` result carries its terminator). Through the module's one
 * decoder: `dsToJs` constructs a TextDecoder per call, which dominated a completion's thousands of names.
 */
function str(s: DString | null): string {
    return s === null ? "" : utf8.decode(cstr(s));
}

function identText(id: Identifier | null): string {
    return id === null ? "" : str(id.toString());
}

/**
 * An enum member's initializer, or null. Not the `value` getter: it reads `_init` as an `ExpInitializer`
 * unconditionally (denum.d:132), and a member whose initializer failed its analysis holds an `ErrorInitializer`
 * (`getConstInitializer`, expressionsem.d:19014, at a use of `E.illegal` declared `illegal = noreturn`,
 * fail_compilation/noreturn_expr2.d), where D faults as well. dmd never walks the AST after such an error; the queries
 * do.
 */
function memberValue(em: EnumMember): Expression | null {
    return em._init?.isExpInitializer()?.exp ?? null;
}

// ── scanning D source bytes ───────────────────────────────────────────────────────────────────────────────────

/** D keywords: a Loc at one is a declaration's or an expression's keyword, not the identifier the key wants. */
const KEYWORDS: ReadonlySet<string> = new Set(("abstract alias align asm assert auto bool break byte case cast catch "
    + "cdouble cent cfloat char class const continue creal dchar debug default delegate delete deprecated do double "
    + "else enum export extern false final finally float for foreach foreach_reverse function goto idouble if ifloat "
    + "immutable import in inout int interface invariant ireal is lazy long macro mixin module new nothrow null out "
    + "override package pragma private protected public pure real ref return scope shared short static struct super "
    + "switch synchronized template this throw true try typeid typeof ubyte ucent uint ulong union unittest ushort "
    + "version void wchar while with __gshared __traits __vector __parameters").split(" "));

function isIdentStart(b: number | undefined): boolean {
    return b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b >= 0x80);
}

function isIdentByte(b: number | undefined): boolean {
    return b !== undefined && (isIdentStart(b) || (b >= 0x30 && b <= 0x39));
}

/** The end of the identifier starting at `p` (`p` when none starts there). */
function identEnd(t: Uint8Array, p: number): number {
    if (!isIdentStart(t[p]))
        return p;
    while (isIdentByte(t[p]))
        p++;
    return p;
}

/** Skips whitespace and comments (`//`, `/* *\/`, nested `/+ +/`) from `p`. */
function skipTrivia(t: Uint8Array, p: number): number {
    for (;;) {
        const c = t[p];
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b) {
            p++;
        } else if (c === 0x2f && t[p + 1] === 0x2f) {
            while (p < t.length && t[p] !== 0x0a)
                p++;
        } else if (c === 0x2f && t[p + 1] === 0x2a) {
            p += 2;
            while (p < t.length && !(t[p] === 0x2a && t[p + 1] === 0x2f))
                p++;
            p += 2;
        } else if (c === 0x2f && t[p + 1] === 0x2b) {
            let depth = 0;
            do {
                if (t[p] === 0x2f && t[p + 1] === 0x2b) {
                    depth++;
                    p += 2;
                } else if (t[p] === 0x2b && t[p + 1] === 0x2f) {
                    depth--;
                    p += 2;
                } else {
                    p++;
                }
            } while (depth > 0 && p < t.length);
        } else {
            return p;
        }
    }
}

/** How far after a keyword the declared name is searched (`struct Foo`, `template Foo(T)`, `new Foo`). */
const NAME_WINDOW = 256;

/**
 * The first identifier among `names` after `p`, within NAME_WINDOW bytes and before a `;`, `{` or `}`; -1 if none.
 * Strings and character literals are skipped as one token.
 */
function findName(t: Uint8Array, p: number, names: readonly string[]): number {
    const limit = Math.min(t.length, p + NAME_WINDOW);
    while (p < limit) {
        p = skipTrivia(t, p);
        const c = t[p];
        if (c === undefined || c === 0x3b || c === 0x7b || c === 0x7d)
            return -1;
        const e = identEnd(t, p);
        if (e > p) {
            if (names.includes(utf8.decode(t.subarray(p, e))))
                return p;
            p = e;
        } else if (c === 0x22 || c === 0x60 || c === 0x27) {
            p++;
            while (p < limit && t[p] !== c)
                p += t[p] === 0x5c && c !== 0x60 ? 2 : 1;
            p++;
        } else {
            p++;
        }
    }
    return -1;
}

/** Skips a balanced `(...)` or `[...]` starting at `p` (strings not recognized: a call's arguments rarely hold one). */
function skipBalanced(t: Uint8Array, p: number, limit: number): number {
    const open = t[p];
    const close = open === 0x28 ? 0x29 : 0x5d;
    let depth = 0;
    for (; p < limit; p++) {
        if (t[p] === open)
            depth++;
        else if (t[p] === close && --depth === 0)
            return p + 1;
    }
    return limit;
}

/**
 * The first of `names` along the postfix chain that follows the identifier ending at `p`, after `skip` earlier ones:
 * `.name`, past calls, indexes and template arguments (`a.b().c[1].d!int.name`); -1 if the chain ends first. The
 * analysis gives a member access the location of its leftmost operand: `p.len()`'s DotVarExp is at `p`.
 */
function chainName(t: Uint8Array, p: number, names: readonly string[], skip = 0): number {
    const limit = Math.min(t.length, p + NAME_WINDOW);
    while (p < limit) {
        p = skipTrivia(t, p);
        const c = t[p];
        if (c === 0x28 || c === 0x5b) {
            p = skipBalanced(t, p, limit);
        } else if (c === 0x21 && t[p + 1] !== 0x3d) {   // `!` but not `!=`
            p = skipTrivia(t, p + 1);
            p = t[p] === 0x28 ? skipBalanced(t, p, limit) : Math.max(identEnd(t, p), p + 1);
        } else if (c === 0x2e && t[p + 1] !== 0x2e) {   // `.` but not `..`
            p = skipTrivia(t, p + 1);
            const e = identEnd(t, p);
            if (e === p)
                return -1;
            if (names.includes(utf8.decode(t.subarray(p, e))) && skip-- === 0)
                return p;
            p = e;
        } else {
            return -1;
        }
    }
    return -1;
}

/** The words a parenthesised expression may follow (`return (x).y;`): its `(` is no call's, cast's or condition's. */
const BEFORE_GROUP: ReadonlySet<string> = new Set(["", "return", "case", "throw"]);

/**
 * Whether the `(` at `open` starts a parenthesised expression: no identifier before it (a call's `f(`, a `typeof(`),
 * but a word of BEFORE_GROUP; a `)` before it may close a cast (`cast(uint) (*p).length`). Whitespace is skipped
 * backwards, not comments.
 */
function groupingParen(t: Uint8Array, open: number): boolean {
    let q = open;
    while (q > 0 && isSpace(t[q - 1]!))
        q--;
    let b = q;
    while (b > 0 && isIdentByte(t[b - 1]))
        b--;
    return t[q - 1] !== 0x21 && BEFORE_GROUP.has(utf8.decode(t.subarray(b, q)));
}

/**
 * The first of `names` along the postfix chain after the parenthesised expression holding byte `p`
 * (`(cast(C) o).f`, at `o`: the access's location is inside the parentheses), after `skip` earlier ones; -1 when `p`
 * is in none, or no `.` follows its `)`. Searched back within NAME_WINDOW bytes, up to a `;` or a brace.
 */
function groupChain(t: Uint8Array, p: number, names: readonly string[], skip: number): number {
    let depth = 0;
    for (let q = p - 1; q >= 0 && q > p - NAME_WINDOW; q--) {
        const c = t[q];
        if (c === 0x3b || c === 0x7b || c === 0x7d)
            return -1;
        if (c === 0x29)
            depth++;
        else if (c === 0x28 && depth-- === 0) {
            if (!groupingParen(t, q))
                return -1;
            const close = skipBalanced(t, q, Math.min(t.length, q + NAME_WINDOW));
            return t[close - 1] === 0x29 ? chainName(t, close, names, skip) : -1;
        }
    }
    return -1;
}

/** The start of the identifier that ends just before byte `p` (trivia skipped backwards over spaces only), or -1. */
function identBefore(t: Uint8Array, p: number): number {
    while (p > 0 && (t[p - 1] === 0x20 || t[p - 1] === 0x09))
        p--;
    let s = p;
    while (s > 0 && isIdentByte(t[s - 1]))
        s--;
    return s < p && isIdentStart(t[s]) ? s : -1;
}

/**
 * The identifier a node at byte `offset` names, given the names its symbol can be referred by. At an identifier: that
 * one when it is one of `names`; else the first of `names` along the postfix chain from there (`chainName`: the
 * analysis gives a member access its leftmost operand's location); else that identifier, unnamed, unless it is a
 * keyword, after which the first of `names` in the declaration (`struct Foo`). At a `.`: the next identifier. At a
 * `(` (a call's location): the callee just before it when it is one of `names`, else the first of `names` along the
 * postfix chain from the `(`. Elsewhere (a parameter's location at its type, `int[] arr`): the first of `names` that
 * follows. `named`: the token's text is one of `names`. Null when no identifier is found.
 * A member access at its leftmost operand (`memberHit`) passes `skip`, the accesses of the same name the chain makes
 * before it (`a.x.x`'s outer one skips one), and `operand` when the identifier at `offset` is that operand (a
 * variable, not the member an implicit `this` reaches), so that it is not taken even when its name matches; at a `.`,
 * `operand` says the `.` starts the chain (the implicit dereference of a pointer `p` in `p.x` sits there), not the
 * access's own `.`.
 */
function keyAt(t: Uint8Array, offset: number, names: readonly string[], skip = 0, operand = false):
    { start: number; named: boolean } | null {
    let p = offset;
    if (t[p] === 0x2e) {
        if (operand) {
            const member = chainName(t, p, names, skip);   // `p.x` through a pointer: the deref is at the `.`
            return member >= 0 ? { start: member, named: true } : null;
        }
        p = skipTrivia(t, p + 1);
        const e = identEnd(t, p);
        return e > p ? { start: p, named: names.includes(utf8.decode(t.subarray(p, e))) } : null;
    }
    const e = identEnd(t, p);
    if (e === p) {
        if (t[p] === 0x28) {
            const callee = identBefore(t, p);
            if (skip === 0 && !operand && callee >= 0
                && names.includes(utf8.decode(t.subarray(callee, identEnd(t, callee)))))
                return { start: callee, named: true };
            const member = chainName(t, p, names, skip);   // `S(1).method()`: the call's `(` is the access's location
            if (member >= 0)
                return { start: member, named: true };
            // a parenthesised operand is located at its `(`: `(c).f`'s variable `c`
            const inner = skipTrivia(t, p + 1);
            return skip === 0 && groupingParen(t, p) && names.includes(wordAt(t, inner))
                ? { start: inner, named: true } : null;
        }
        const found = findName(t, p, names);
        return found < 0 ? null : { start: found, named: true };
    }
    const word = utf8.decode(t.subarray(p, e));
    if (!operand && names.includes(word)) {
        if (skip === 0)
            return { start: p, named: true };
        skip--;
    }
    if (operand || !KEYWORDS.has(word)) {
        const member = chainName(t, e, names, skip);
        const outer = member < 0 ? groupChain(t, p, names, skip) : -1;   // `(cast(C) o).f`: the access is at `o`
        return member >= 0 || outer >= 0 ? { start: member >= 0 ? member : outer, named: true }
            : { start: p, named: false };
    }
    const found = findName(t, e, names);
    return found < 0 ? null : { start: found, named: true };
}

/** The byte offsets where the lines of `t` start, cached per buffer (a compiled text, a declaring file's content). */
const lineTables = new WeakMap<Uint8Array, number[]>();

function lineStarts(t: Uint8Array): number[] {
    let starts = lineTables.get(t);
    if (starts === undefined) {
        starts = [0];
        for (let i = t.indexOf(0x0a); i >= 0; i = t.indexOf(0x0a, i + 1))
            starts.push(i + 1);
        lineTables.set(t, starts);
    }
    return starts;
}

/** The (line, UTF-16 character) of byte `offset` in `t`. */
function positionOf(t: Uint8Array, offset: number): QueryPosition {
    const starts = lineStarts(t);
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= offset)
            lo = mid;
        else
            hi = mid - 1;
    }
    return { line: lo, character: utf8.decode(t.subarray(starts[lo]!, offset)).length };
}

/** The range of the identifier starting at byte `start` of `t`. */
function identRange(t: Uint8Array, start: number): QueryRange {
    const s = positionOf(t, start);
    const width = utf8.decode(t.subarray(start, identEnd(t, start))).length;
    return { start: s, end: { line: s.line, character: s.character + width } };
}

/**
 * The byte offset of (line, UTF-16 character) in `bytes`; null past the end of the line or of the text. The line's
 * start comes from the line table, its first `character` code units are encoded again.
 */
function byteOffset(bytes: Uint8Array, line: number, character: number): number | null {
    const starts = lineStarts(bytes);
    if (line >= starts.length)
        return null;
    const start = starts[line]!;
    const end = line + 1 < starts.length ? starts[line + 1]! - 1 : bytes.length;
    const lineText = utf8.decode(bytes.subarray(start, end));
    if (character > lineText.length)
        return null;
    return start + encoder.encode(lineText.slice(0, character)).length;
}

// ── symbols: names, kinds, scopes ─────────────────────────────────────────────────────────────────────────────────

/**
 * The names `sym` is written with: its identifier; a constructor also `this` and its aggregate's name; a destructor
 * and a postblit `this`.
 */
function namesOf(sym: Dsymbol): string[] {
    const n = [identText(sym.ident)];
    if (sym.ident === Id.dtor || sym.ident === Id.postblit)
        n.push("this");     // `~this`, `this(this)`
    if (sym.ident === Id.ctor) {
        n.push("this");
        const ad = sym.toParent()?.isAggregateDeclaration() ?? null;
        if (ad !== null)
            n.push(identText(ad.ident));
    }
    return n;
}

/**
 * A name the compiler makes (`__r12`, `__ctor`, `_d_arrayappendT`, the implicit `this` of a member access): a hit
 * with it never answers unless named.
 */
function isCompilerName(sym: Dsymbol): boolean {
    const n = identText(sym.ident);
    return n === "" || n === "this" || n.startsWith("__") || n.startsWith("_d_");
}

/** A module as a Dsymbol: upcast cascade, Module.errors (uint) shadows Dsymbol.errors (bool). */
function asDsymbol(m: Module): Dsymbol {
    return m as unknown as Dsymbol;
}

/** The element or target type of a pointer, array or reference type (`TypeNext.next`), else null. */
function elementType(t: Type): Type | null {
    return (t.isTypePointer() ?? t.isTypeDArray() ?? t.isTypeSArray() ?? t.isTypeAArray() ?? t.isTypeReference())
        ?.next ?? null;
}

/** The aggregate or enum an analysed type names (through its modifiers), else null. */
function typeSymbol(t: Type | null): Dsymbol | null {
    if (t === null)
        return null;
    return t.isTypeStruct()?.sym ?? t.isTypeClass()?.sym ?? t.isTypeEnum()?.sym ?? null;
}

/** The object operand of a postfix chain link: a member access's, a call's callee, an index's or slice's array. */
function operandOf(e: Expression): Expression | null {
    return (e.isDotVarExp() ?? e.isDotTemplateInstanceExp() ?? e.isDotTemplateExp() ?? e.isCallExp() ?? e.isPtrExp()
        ?? e.isSliceExp() ?? e.isArrayExp() ?? e.isIndexExp())?.e1 ?? null;
}

/**
 * Whether `e` is an access the analysis made through `alias this`: `o.inner` for `alias inner this`, the call
 * `o.get()` for `alias get this` to a function.
 */
function isAliasThisAccess(e: Expression): boolean {
    const dv = e.isDotVarExp() ?? e.isCallExp()?.e1?.isDotVarExp() ?? null;
    if (dv === null || dv.var_ === null || dv.e1 === null || dv.e1.type === null)
        return false;
    if (e.isDotVarExp() !== null && dv.var_.isFuncDeclaration() !== null)
        return false;   // the function's access, not yet the call
    return (typeSymbol(dv.e1.type)?.isAggregateDeclaration()?.aliasthis?.sym ?? null) === dv.var_;
}

/** An operator overload's name (`opBinary`, `opEquals`, `opIndexAssign`, ...; object.d's `opEquals` too). */
const OPERATOR_FUNCTION = /^op[A-Z]/;

/** Whether `e` is a call of an operator overload at `loc` (an operator's location: `a.opCmp(b)` at `<`). */
function isOperatorCall(e: Expression | null, loc: Loc): boolean {
    const ce = e?.isCallExp() ?? null;
    return ce !== null && ce.f !== null && OPERATOR_FUNCTION.test(identText(ce.f.ident))
        && ce.loc.index_ === loc.index_;
}

/** The member name a member access writes (`.name`), else null. */
function memberIdent(e: Expression): Identifier | null {
    return e.isDotVarExp()?.var_?.ident ?? e.isDotTemplateInstanceExp()?.ti?.name ?? e.isDotTemplateExp()?.td?.ident
        ?? null;
}

/**
 * The symbol `id` names from `scope`, by a read-only walk of the symbol tables (`DsymbolTable.lookup`): each
 * enclosing function's local table, each enclosing scope's table, then at the module what its imports give
 * (`importedName`: dmd/dsymbolsem.d `search` follows a public import chain, `import std.datetime;` reaches
 * std.datetime.systime's `Clock`). No `search` itself: it may run semantic and caches what it finds (`OverloadSet`s, a
 * module's search cache). Null when no table holds the name, or when two imports give different symbols.
 * A template parameter is not found (a use of `T` in an instance answers with the argument it stands for; the
 * tokens look parameters up apart, `templateParameter`).
 * Cost: at the module, every module the imports reach publicly is read once per name and compile (a large
 * application module under -i: a few hundred), then the answer is cached (`searches`).
 */
function lookupLexical(scope: Dsymbol | null, id: Identifier): Dsymbol | null {
    for (let s = scope; s !== null; s = s.parent) {
        const fd = s.isFuncDeclaration();
        const local = fd?.localsymtab?.lookup(id) ?? null;
        if (local !== null)
            return local;
        const sds = s.isScopeDsymbol();
        const found = sds?.symtab?.lookup(id) ?? null;
        if (found !== null)
            return found;
        if (s.isModule() !== null)
            return importedName(sds!, id);
    }
    return null;
}

/** What `id` gives in a module's imports, or a module's own members, per compile (`importedName`, `moduleMember`). */
const searches = new Map<ScopeDsymbol, Map<Identifier, Dsymbol[]>>();

/**
 * The symbol `id` names in the scopes module `m` imports, read-only, as dmd/dsymbolsem.d `search` finds it there:
 * through each import, private ones included (a module sees its own), what `searchModule` gives, and a template
 * mixin's table; the symbols not visible from `m` left out. Two that are one symbol count once (`sameSymbol`). Where
 * several are left, `search` reports an ambiguity, or merges functions or templates into an overload set across
 * modules, and the query names neither: null. C symbols excepted: of those `search` takes the first (C has one global
 * name space), and so does this.
 */
function importedName(m: ScopeDsymbol, id: Identifier): Dsymbol | null {
    const found: Dsymbol[] = [];
    for (const ss of m.importedScopes?.opSlice() ?? []) {
        if (ss === null)
            continue;
        const own = ss.isModule() === null ? ss.isScopeDsymbol()?.symtab?.lookup(id) ?? null : null;
        for (const c of own !== null ? [own] : ss.isModule() !== null ? searchModule(ss.isScopeDsymbol()!, id) : [])
            if (visibleFrom(m, c))
                addDistinct(found, c);
    }
    return single(found);
}

/** The one symbol of `found`, else the first when all are C symbols, else null (none, or an ambiguity). */
function single(found: readonly Dsymbol[]): Dsymbol | null {
    return found.length === 1 || (found.length > 1 && found.every((c) => c.isCsymbol())) ? found[0]! : null;
}

/**
 * The symbols `id` names in module `mod` as an importer reaches it (dmd/dsymbolsem.d `search` with
 * `ignorePrivateImports`): its own table's entry, private or not (the importer's visibility check drops it, and then
 * nothing else answers); else, recursively, what each import of `mod` that is not private gives, visible from `mod`,
 * one per symbol (`addDistinct`). A module met again while its search runs gives nothing (a cycle of public imports,
 * dmd's `insearch`). Cached per compile (`searches`).
 */
function searchModule(mod: ScopeDsymbol, id: Identifier): readonly Dsymbol[] {
    let byName = searches.get(mod);
    if (byName === undefined)
        searches.set(mod, byName = new Map());
    const known = byName.get(id);
    if (known !== undefined)
        return known;
    byName.set(id, []);
    const own = mod.symtab?.lookup(id) ?? null;
    const found: Dsymbol[] = own !== null ? [own] : [];
    const scopes = own === null ? mod.importedScopes?.opSlice() ?? [] : [];
    for (let k = 0; k < scopes.length; k++) {
        const ss = scopes[k] ?? null;
        if (ss === null || mod.visibilities?.[k] === Visibility.Kind.private_)
            continue;
        const inner = ss.isModule() === null ? ss.isScopeDsymbol()?.symtab?.lookup(id) ?? null : null;
        for (const c of inner !== null ? [inner] : ss.isModule() !== null ? searchModule(ss.isScopeDsymbol()!, id) : [])
            if (visibleFrom(mod, c))
                addDistinct(found, c);
    }
    byName.set(id, found);
    return found;
}

/**
 * Whether `s` is visible from module `m` as a lookup sees it (dmd/access.d `symbolIsVisible`, read-only and
 * approximated: `private` only from its own module; `package` and `protected` as visible).
 */
function visibleFrom(m: ScopeDsymbol, s: Dsymbol): boolean {
    const kind = s.visible().kind;
    return kind !== Visibility.Kind.none && (kind !== Visibility.Kind.private_ || s.getAccessModule() === m.isModule());
}

/** Appends `c` to `found` unless it is one of them (`sameSymbol`). */
function addDistinct(found: Dsymbol[], c: Dsymbol): void {
    if (!found.some((x) => sameSymbol(x, c)))
        found.push(c);
}

/**
 * Whether two symbols a lookup found are one, as dmd/dsymbolsem.d `search` decides it, read-only: the same symbol
 * after following aliases (`aliasTarget`: a selective import's alias and its target), two aliases of one type, two
 * imports of one module or of one first package name.
 */
function sameSymbol(a: Dsymbol, b: Dsymbol): boolean {
    if (a === b)
        return true;
    const i1 = a.isImport();
    const i2 = b.isImport();
    if (i1 !== null && i2 !== null)
        return i1.mod === i2.mod || (i1.parent?.isImport() === null && i2.parent?.isImport() === null
            && i1.ident === i2.ident);
    const ta = resolvedAlias(a);
    const tb = resolvedAlias(b);
    if (ta.sym !== null && ta.sym === tb.sym)
        return true;
    return ta.type !== null && tb.type !== null && ta.type.equals(tb.type);
}

/** What an alias stands for, read-only: its symbol (`aliasTarget`), else its type; any other symbol, itself. */
function resolvedAlias(s: Dsymbol): { sym: Dsymbol | null; type: Type | null } {
    const al = s.isAliasDeclaration();
    if (al === null)
        return { sym: s, type: null };
    const sym = aliasTarget(al);
    return { sym, type: sym === null ? al.type : null };
}

/**
 * The instances of the templates of every module, keyed by template, the primary instance of each argument list; not
 * the speculative ones (`minst` null: made inside `__traits(compiles)`, `is(typeof(...))`, a constraint), whose code
 * is not part of the program.
 */
function instancesOf(td: Dsymbol): readonly TemplateInstance[] {
    return instanceTable().get(td) ?? [];
}

/** The table `instancesOf` reads, built at the first need after a compile from every module's members. */
function instanceTable(): Map<Dsymbol, TemplateInstance[]> {
    if (instancesByTemplate === null) {
        instancesByTemplate = new Map();
        for (const m of Module.amodules) {
            for (const s of m?.members ?? []) {
                const ti = s?.isTemplateInstance() ?? null;
                if (ti === null || ti.isTemplateMixin() !== null || ti.tempdecl === null || ti.inst !== ti
                    || ti.minst === null)
                    continue;
                const list = instancesByTemplate.get(ti.tempdecl) ?? [];
                list.push(ti);
                instancesByTemplate.set(ti.tempdecl, list);
            }
        }
    }
    return instancesByTemplate;
}

// ── the walk ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Records the hits of one file (THE INDEX in the header). Read-only: it reads fields and calls `accept`; the base
 * class's one write (`visitStructLiteralExp`'s recursion flag, restored on exit) is replaced by a set of its own.
 */
class IndexWalker extends SemanticTimeTransitiveVisitor {
    readonly hits = new Map<number, Hit[]>();
    /** The byte ranges of the function bodies, analysed or not, for the fallback's scope (`scopeAt`). */
    readonly functions: Body[] = [];
    readonly calls: Call[] = [];
    readonly decided: Decided[] = [];
    /**
     * Byte ranges where a conditional's decisions are not all known (`inactiveOf` dims nothing there): a mixin
     * template's declaration (the mixins of other modules are not walked) and the body of a template instance's
     * function the analysis did not run (an instance made by a module compiled without its semantic3).
     */
    readonly undecided: [number, number][] = [];
    private inst: TemplateInstance | null = null;
    private readonly literals = new Set<StructLiteralExp>();
    private readonly walkedInstances = new Set<TemplateInstance>();
    private readonly fileOf = new Map<DString, boolean>();
    /** What the expansions and the Resolved sections read (`Notes`), raw, in walk order. */
    readonly notes: Notes = { mixins: [], runs: [], templateMixins: [], manifests: [], lowered: [], keys: new Map(),
        parameters: new Map() };
    readonly imports: { at: number; imp: Import }[] = [];
    readonly locals: { at: number; v: VarDeclaration }[] = [];
    private readonly mixinLines = new Map<DString, number>();

    constructor(private readonly file: string, private readonly bytes: Uint8Array) {
        super();
    }

    /**
     * The byte offset of `loc` when it is in this file (not a mixin, not another file), else null. An `end` location
     * may be the text's end: parser recovery runs a body cut by a parse error to the end of the file.
     */
    private offsetOf(loc: Loc, end = false): number | null {
        const name = loc.filename();
        if (name === null)
            return null;
        let mine = this.fileOf.get(name);
        if (mine === undefined) {
            mine = str(name) === this.file;
            this.fileOf.set(name, mine);
        }
        if (!mine)
            return null;
        const off = loc.fileOffset();
        return off < this.bytes.length || (end && off === this.bytes.length) ? off : null;
    }

    /** Records `sym` for the node at `loc` (keyed by `keyAt`); the key, or -1 when none. */
    private hit(loc: Loc, sym: Dsymbol | null): number {
        if (sym === null)
            return -1;
        const off = this.offsetOf(loc);
        return off !== null ? this.hitAt(off, sym) : -1;
    }

    private hitAt(off: number, sym: Dsymbol, names: readonly string[] = namesOf(sym), skip = 0, operand = false):
        number {
        const k = keyAt(this.bytes, off, names, skip, operand);
        if (k === null)
            return -1;
        const list = this.hits.get(k.start) ?? [];
        if (!list.some((h) => h.sym === sym))
            list.push({ sym, named: k.named, inst: this.inst });
        this.hits.set(k.start, list);
        return k.start;
    }

    /**
     * The symbols of the type `orig` as written in a declaration of `scope`, against `res`, the analysed type: a
     * TypeIdentifier `a.b.C` gives at `C` the symbol of `res` (or, when its name is not `C`, an alias named `C`
     * found by `lookupLexical`), at `a` and `b` that symbol's parents; a TypeInstance its instance's symbol; arrays,
     * pointers, functions and delegates recurse into the parts both shapes have.
     */
    private typeRefs(orig: Type | null, res: Type | null, scope: Dsymbol | null): void {
        if (orig === null)
            return;
        const ti = orig.isTypeIdentifier();
        const tinst = orig.isTypeInstance();
        if (ti !== null || tinst !== null) {
            const q = (ti ?? tinst)!;
            const off = this.offsetOf(q.loc);
            if (off === null)
                return;
            const ids: Identifier[] = [];
            if (ti !== null && ti.ident !== null)
                ids.push(ti.ident);
            const name = tinst?.tempinst?.name ?? null;
            if (name !== null)
                ids.push(name);
            for (const o of q.idents) {
                if (o === null || o.dyncast() !== DYNCAST.identifier)
                    break;
                ids.push(o as Identifier);
            }
            this.qualified(off, ids, typeSymbol(res), scope);
            return;
        }
        const to = orig.isTypeFunction() ?? orig.isTypeDelegate()?.next?.isTypeFunction() ?? null;
        if (to !== null) {
            const tr = res?.isTypeFunction() ?? res?.isTypeDelegate()?.next?.isTypeFunction() ?? null;
            this.functionTypeRefs(to, tr, scope);
            return;
        }
        const same = res !== null && res.ty === orig.ty ? res : null;
        const aa = orig.isTypeAArray();
        if (aa !== null)
            this.typeRefs(aa.index, same?.isTypeAArray()?.index ?? null, scope);
        const next = elementType(orig);
        if (next !== null)
            this.typeRefs(next, same !== null ? elementType(same) : null, scope);
    }

    /**
     * The return and parameter types of a function type as written, against the analysed one; the names of its
     * parameters (`Notes.parameters`), the analysed parameter when the two lists match.
     */
    private functionTypeRefs(orig: TypeFunction, res: TypeFunction | null, scope: Dsymbol | null): void {
        this.typeRefs(orig.next, res?.next ?? null, scope);
        const ps = orig.parameterList.parameters;
        const rs = res?.parameterList.parameters ?? null;
        if (ps === null)
            return;
        for (let i = 0; i < ps.length; i++) {
            const analysed = rs !== null && rs.length === ps.length ? rs.opIndex(i) ?? null : null;
            this.typeRefs(ps.opIndex(i)?.type ?? null, analysed?.type ?? null, scope);
            const p = ps.opIndex(i) ?? null;
            const off = p !== null && p.ident !== null ? this.offsetOf(p.loc) : null;
            const k = off !== null ? keyAt(this.bytes, off, [identText(p!.ident)]) : null;
            if (k !== null && k.named && !this.notes.parameters.has(k.start))
                this.notes.parameters.set(k.start, analysed !== null && res !== null ? { param: analysed, tf: res }
                    : { param: p!, tf: orig });
        }
    }

    /**
     * The identifiers `ids[0] . ids[1] ...` written from byte `off` (the first one there): the last names `target`
     * (the analysed symbol) or, when that one's name differs, what `lookupLexical` finds; the others the target's
     * parents of the same names.
     */
    private qualified(off: number, ids: readonly Identifier[], target: Dsymbol | null, scope: Dsymbol | null): void {
        if (ids.length === 0)
            return;
        const starts: number[] = [];
        let p = off;
        for (let i = 0; i < ids.length; i++) {
            p = skipTrivia(this.bytes, p);
            const e = identEnd(this.bytes, p);
            if (e === p || utf8.decode(this.bytes.subarray(p, e)) !== identText(ids[i]!))
                break;
            starts.push(p);
            p = skipTrivia(this.bytes, e);
            if (this.bytes[p] !== 0x2e)   // not a `.`: the end, or a `!` and an instance's arguments
                break;
            p++;
        }
        let sym: Dsymbol | null = target;
        for (let i = ids.length - 1; i >= 0; i--) {
            const id = ids[i]!;
            let s = sym !== null && sym.ident === id ? sym : null;
            if (s === null && i === 0)
                s = lookupLexical(scope, id);
            if (s === null && i === ids.length - 1 && sym !== null)
                s = sym;    // an alias resolved to another name: the target, as an unnamed hit
            if (s !== null && i < starts.length)
                this.hitAt(starts[i]!, s);
            sym = s?.parent ?? null;
        }
    }

    /**
     * Records `sym` for the member access `e` of the object `e1`. Once analysed, an access sits where its chain starts
     * (`a.x.x`: both at `a`; `p.x` through a pointer: at the `.`, the implicit dereference's location; `a.f().g`: at
     * the `(` of `f()`), so the key is the access's own `.name` along the chain from there, after the accesses of the
     * same name between it and that start (`skip`). The deepest node of `e1` at the access's location is where the text
     * of the chain begins: what lies below it precedes the location. The token there is skipped when it is that node's
     * (a variable `x` in `x.x`), not when it is the member an implicit `this` reaches (`x.y` in a method, a ThisExp at
     * the `x`).
     */
    private memberHit(e: Expression, e1: Expression | null, sym: Dsymbol | null): number {
        const off = this.offsetOf(e.loc);
        if (sym === null || off === null)
            return -1;
        const names = namesOf(sym);
        const spine: Expression[] = [];
        for (let x = e1; x !== null; x = operandOf(x))
            spine.push(x);
        let start = -1;
        for (let i = 0; i < spine.length; i++) {
            if (this.offsetOf(spine[i]!.loc) === off)
                start = i;
        }
        let skip = 0;
        for (const x of start < 0 ? spine : spine.slice(0, start + 1)) {
            const n = memberIdent(x);
            if (n !== null && names.includes(identText(n)))
                skip++;
        }
        let operand = false;
        if (start >= 0) {
            const at = spine[start]!;
            const word = utf8.decode(this.bytes.subarray(off, identEnd(this.bytes, off)));
            operand = !((at.isThisExp() !== null || at.isSuperExp() !== null) && word !== "this" && word !== "super");
        }
        return this.hitAt(off, sym, names, skip, operand);
    }

    /** Notes `node`, of `kind`, at `loc` when it is in this file (`Lowered`). */
    private lowered(kind: Lowered["kind"], node: Lowered["node"], loc: Loc, first = -1, object = -1): void {
        const at = this.offsetOf(loc);
        if (at !== null)
            this.notes.lowered.push({ kind, node, at, first, object, inst: this.inst });
    }

    /** The first byte of `e`'s text in this file: the least offset along its left operands, or -1. */
    private startOf(e: Expression | null): number {
        let first = -1;
        for (let x = e; x !== null; x = x.isBinExp()?.e1 ?? operandOf(x)) {
            const off = this.offsetOf(x.loc);
            if (off !== null && (first < 0 || off < first))
                first = off;
        }
        return first;
    }

    // ── expressions ──

    override visitVarExp(e: VarExp): void {
        const k = this.hit(e.loc, e.var_);
        if (k >= 0)
            this.notes.keys.set(e, k);
    }

    override visitSymOffExp(e: SymOffExp): void {
        this.hit(e.loc, e.var_);
    }

    /** Also notes an `alias this` access, or a member reached through one (RESOLVED). */
    override visitDotVarExp(e: DotVarExp): void {
        const k = this.memberHit(e, e.e1, e.var_);
        if (k >= 0)
            this.notes.keys.set(e, k);
        if (isAliasThisAccess(e) || (e.e1 !== null && isAliasThisAccess(e.e1)))
            this.lowered("aliasThis", e, e.loc);
        super.visitDotVarExp(e);
    }

    /** A cast, noted with its operand's first byte (`first`: a cast written before it is the user's, RESOLVED). */
    override visitCastExp(e: CastExp): void {
        this.lowered("cast", e, e.loc, this.startOf(e.e1));
        super.visitCastExp(e);
    }

    /** `a < b` lowered to `a.opCmp(b) < 0`: the comparison, around the call at its operator (RESOLVED). */
    override visitCmpExp(e: CmpExp): void {
        if (isOperatorCall(e.e1, e.loc))
            this.lowered("call", e, e.loc);
        super.visitCmpExp(e);
    }

    /** `a != b` lowered to `!a.opEquals(b)` (RESOLVED). */
    override visitNotExp(e: NotExp): void {
        if (isOperatorCall(e.e1, e.loc))
            this.lowered("call", e, e.loc);
        super.visitNotExp(e);
    }

    override visitThisExp(e: ThisExp): void {
        this.hit(e.loc, e.var_);
    }

    override visitSuperExp(e: SuperExp): void {
        this.hit(e.loc, e.var_);
    }

    override visitDsymbolExp(e: DsymbolExp): void {
        this.hit(e.loc, e.s);
    }

    override visitScopeExp(e: ScopeExp): void {
        this.hit(e.loc, e.sds);
        super.visitScopeExp(e);
    }

    override visitTemplateExp(e: TemplateExp): void {
        this.hit(e.loc, e.fd ?? e.td);
    }

    override visitDotTemplateExp(e: DotTemplateExp): void {
        this.memberHit(e, e.e1, e.td);
        super.visitDotTemplateExp(e);
    }

    override visitDotTemplateInstanceExp(e: DotTemplateInstanceExp): void {
        this.memberHit(e, e.e1, e.ti);
        super.visitDotTemplateInstanceExp(e);
    }

    override visitDotTypeExp(e: DotTypeExp): void {
        this.hit(e.loc, e.sym);
        super.visitDotTypeExp(e);
    }

    override visitDelegateExp(e: DelegateExp): void {
        this.hit(e.loc, e.func);
        super.visitDelegateExp(e);
    }

    override visitTypeExp(e: TypeExp): void {
        this.hit(e.loc, typeSymbol(e.type));
        super.visitTypeExp(e);
    }

    override visitNewExp(e: NewExp): void {
        const ad = typeSymbol(e.newtype);
        const off = this.offsetOf(e.loc);
        if (ad !== null && off !== null)
            this.hitAt(off, e.member ?? ad, [identText(ad.ident)]);
        const paren = off !== null && e.member !== null ? newArguments(this.bytes, off) : -1;
        if (paren >= 0)
            this.calls.push({ paren, fd: e.member!, ufcs: false, args: this.argumentOffsets(e.arguments_) });
        super.visitNewExp(e);
    }

    /**
     * A call whose location is its `(` (dmd/parse.d parsePostExp; an operator's lowering is elsewhere) and whose
     * function the analysis resolved. A UFCS call (`r.f(x)`, rewritten as `f(r, x)`) has its receiver, the first
     * argument, before the `(`. Every resolved call is also noted for the Resolved sections (an operator's lowering,
     * a property call, UFCS, the overload picked).
     */
    override visitCallExp(e: CallExp): void {
        const off = this.offsetOf(e.loc);
        if (off !== null && e.f !== null && this.bytes[off] === 0x28) {
            const args = this.argumentOffsets(e.arguments_);
            this.calls.push({ paren: off, fd: e.f, ufcs: args.length !== 0 && args[0]! >= 0 && args[0]! < off, args });
        }
        if (e.f !== null) {
            const a0 = e.arguments_ !== null && e.arguments_.length !== 0 ? e.arguments_.opIndex(0) : null;
            const operator = OPERATOR_FUNCTION.test(identText(e.f.ident));
            const object = operator ? this.startOf(e.e1?.isDotVarExp()?.e1 ?? null) : -1;
            this.lowered("call", e, e.loc, a0 !== null ? this.offsetOf(a0.loc) ?? -1 : -1, object);
        }
        if (isAliasThisAccess(e))   // `alias get this` to a function: the call the analysis made
            this.lowered("aliasThis", e, e.loc);
        super.visitCallExp(e);
    }

    private argumentOffsets(args: CallExp["arguments_"]): number[] {
        return (args?.opSlice() ?? []).map((a) => (a !== null ? this.offsetOf(a.loc) ?? -1 : -1));
    }

    override visitStructLiteralExp(e: StructLiteralExp): void {
        // the base class guards the recursion with a flag on the node (`stageflags`); a query writes nothing
        if (this.literals.has(e))
            return;
        this.hit(e.loc, e.sd);
        this.literals.add(e);
        for (const el of e.elements ?? [])
            el?.accept(this);
        this.literals.delete(e);
    }

    // ── declarations ──

    override visitVarDecl(v: VarDeclaration): void {
        const k = this.hit(v.loc, v);
        if (k >= 0 && (v.storage_class & STC.manifest) !== 0n && v._init !== null)
            this.notes.manifests.push({ at: k, sym: v, inst: this.inst });
        if (k >= 0 && (v.toParent2()?.isFuncDeclaration() ?? null) !== null)
            this.locals.push({ at: k, v });
        this.typeRefs(v.originalType, v.type, v.parent);
        super.visitVarDecl(v);
    }

    override visitFuncBody(f: FuncDeclaration): void {
        this.hit(f.loc, f);
        if (f.originalType !== null)
            this.typeRefs(f.originalType, f.type, f);
        for (const p of f.parameters ?? []) {
            const k = p !== null ? this.hit(p.loc, p) : -1;
            if (k >= 0)
                this.locals.push({ at: k, v: p! });
        }
        const analysed = f.semanticRun >= PASS.semantic3done;
        this.body(f, analysed);
        if (!analysed && this.inst !== null) {
            const start = this.offsetOf(f.loc);
            const end = this.offsetOf(f.endloc, true);
            if (start !== null && end !== null && end > start)
                this.undecided.push([start, end]);
        }
        if (analysed) {
            for (const cs of f.djsConditionals ?? [])
                this.decide(cs.loc, cs.condition!.inc, cs.elsebody !== null);
            super.visitFuncBody(f);
        }
    }

    /** Records a conditional at `loc` that an analysis decided (`Decided`); one not decided records nothing. */
    private decide(loc: Loc, inc: Include, hasElse: boolean): void {
        const at = this.offsetOf(loc);
        if (at !== null && inc !== Include.notComputed)
            this.decided.push({ at, inc, hasElse });
    }

    /**
     * Records the byte range of `f`'s body, `analysed` or not (`Body`); one without a body records nothing, but for a
     * unittest whose body the parser skipped (no `-unittest`: dmd/parse.d keeps an empty `UnitTestDeclaration` whose
     * `endloc` is the token after the `}`), recorded as not analysed up to that token, so that the fallback does not
     * answer from the module's tables inside it.
     */
    private body(f: FuncDeclaration, analysed: boolean): void {
        const start = this.offsetOf(f.loc);
        const end = this.offsetOf(f.endloc, true);
        if (start === null || end === null || end <= start)
            return;
        if (f.fbody !== null)
            this.functions.push({ start, end, fd: analysed ? f : null });
        else if (f.isUnitTestDeclaration() !== null)
            this.functions.push({ start, end: end - 1, fd: null });
    }

    /**
     * The functions among declarations the walk does not enter (a template's own members, the branch a condition did
     * not choose), as not analysed: the fallback does not answer in their bodies, where the names are not the ones
     * the symbol tables around them hold.
     */
    private notAnalysed(members: Iterable<Dsymbol | null> | null): void {
        for (const s of members ?? []) {
            if (s === null)
                continue;
            const fd = s.isFuncDeclaration();
            const cond = s instanceof ConditionalDeclaration ? s : null;
            if (fd !== null) {
                this.body(fd, false);
            } else if (cond !== null) {
                this.notAnalysed(cond.decl);
                this.notAnalysed(cond.elsedecl);
            } else {
                this.notAnalysed(s.isAttribDeclaration()?.decl ?? s.isScopeDsymbol()?.members ?? null);
            }
        }
    }

    override visitFuncDeclaration(f: FuncDeclaration): void {
        // the base class walks the analysed type (no locations) and the body; `visitFuncBody` does both parts
        this.visitFuncBody(f);
    }

    override visitAliasDeclaration(d: AliasDeclaration): void {
        this.hit(d.loc, d);
        if (d.aliassym === null)
            this.typeRefs(d.originalType ?? d.type, d.type, d.parent);
    }

    override visitStructDeclaration(d: AggregateDeclaration): void {
        this.aggregate(d);
    }

    override visitUnionDeclaration(d: AggregateDeclaration): void {
        this.aggregate(d);
    }

    override visitClassDeclaration(d: ClassDeclaration): void {
        this.aggregate(d);
    }

    override visitInterfaceDeclaration(d: ClassDeclaration): void {
        this.aggregate(d);
    }

    /** An aggregate at its name, a class's base classes at theirs (between the name and the body), its members. */
    private aggregate(d: AggregateDeclaration): void {
        this.hit(d.loc, d);
        const cd = d.isClassDeclaration();
        const off = this.offsetOf(d.loc);
        if (cd !== null && off !== null) {
            for (const b of cd.baseclasses) {
                const sym = b?.sym ?? null;
                if (sym === null)
                    continue;
                const at = findName(this.bytes, off, [identText(sym.ident)]);
                if (at >= 0)
                    this.hitAt(at, sym);
            }
        }
        for (const s of d.members ?? [])
            s?.accept(this);
    }

    override visitEnumDeclaration(d: EnumDeclaration): void {
        this.hit(d.loc, d);
        for (const em of d.members ?? [])
            em?.accept(this);
    }

    override visitEnumMember(em: EnumMember): void {
        const k = this.hit(em.loc, em);
        const value = memberValue(em);
        if (k >= 0 && value !== null)
            this.notes.manifests.push({ at: k, sym: em, inst: this.inst });
        // transitive.d's visit(EnumMember), through `memberValue`
        this.visitTypeHelper(em.type);
        value?.accept(this);
    }

    /**
     * A template at its name; then, when it is declared in this file, the members of its instances (the analysed
     * copies of its members, at the template's locations). Its own members are not walked: they are not analysed.
     */
    override visitTemplateDeclaration(d: TemplateDeclaration): void {
        this.hit(d.loc, d);
        const off = this.offsetOf(d.loc);
        if (off === null)
            return;
        if (d.ismixin)
            this.undecided.push([off, statementEnd(this.bytes, nonCode(this.bytes), off)]);
        this.notAnalysed(d.members);
        for (const ti of instancesOf(d))
            this.instanceMembers(ti);
    }

    override visitTemplateMixin(tm: TemplateMixin): void {
        const td = tm.tempdecl?.isTemplateDeclaration() ?? null;
        const off = this.offsetOf(tm.loc);
        if (td !== null && off !== null) {
            const at = findName(this.bytes, off, [identText(td.ident)]);
            if (at >= 0) {
                this.hitAt(at, td);
                this.notes.templateMixins.push({ at, tm, inst: this.inst });
            }
        }
        if (td !== null && this.offsetOf(td.loc) !== null)
            this.instanceMembers(tm);
    }

    /** A string mixin's declarations (`decl`, parsed and analysed) for its expansion; its arguments are walked. */
    override visitMixinDeclaration(d: MixinDeclaration): void {
        const at = this.offsetOf(d.loc);
        if (at !== null && d.decl !== null)
            this.notes.mixins.push({ at, decl: d.decl.opSlice().filter((s) => s !== null), inst: this.inst });
        super.visitMixinDeclaration(d);
    }

    /**
     * Notes the statements a string mixin of this file put in the block (EXPANSIONS: semantic replaced the mixin by
     * them, their locations in its `<file>-mixin-<line>` file) and the `foreach` statements lowered to a `for` over a
     * range (RESOLVED: the range's variable declared before the `for`, all at the `foreach` keyword); then walks.
     */
    override visitCompoundStatement(s: CompoundStatement): void {
        const list = s.statements?.opSlice() ?? [];
        let run: MixinRun | null = null;
        for (let i = 0; i < list.length; i++) {
            const sx = list[i] ?? null;
            if (sx === null)
                continue;
            const name = sx.loc.filename();
            const line = name !== null ? this.mixinLine(name) : -1;
            if (line < 0) {
                run = null;
            } else if (run !== null && run.name === name) {
                run.statements.push(sx);
            } else {
                run = { line, name: name!, index: sx.loc.index_, statements: [sx], inst: this.inst };
                this.notes.runs.push(run);
            }
            const fs = sx.isForStatement();
            const at = fs !== null ? this.offsetOf(fs.loc) : null;
            const word = at !== null ? wordAt(this.bytes, at) : "";
            if ((word === "foreach" || word === "foreach_reverse") && (fs!.condition?.isNotExp() ?? null) !== null) {
                let j = i;
                while (j > 0 && (list[j - 1] ?? null) !== null && this.offsetOf(list[j - 1]!.loc) === at)
                    j--;
                const node = list.slice(j, i + 1) as Statement[];
                this.notes.lowered.push({ kind: "foreach", node, at: at!, first: -1, object: -1, inst: this.inst });
            }
        }
        super.visitCompoundStatement(s);
    }

    /** The line of the mixin a statement's file name `<this file>-mixin-<line>` gives, else -1 (cached by name). */
    private mixinLine(name: DString): number {
        let line = this.mixinLines.get(name);
        if (line === undefined) {
            const n = str(name);
            const rest = n.startsWith(`${this.file}-mixin-`) ? n.slice(this.file.length + 7) : "";
            line = /^\d+$/.test(rest) ? Number(rest) : -1;
            this.mixinLines.set(name, line);
        }
        return line;
    }

    private instanceMembers(ti: TemplateInstance): void {
        if (this.walkedInstances.has(ti))
            return;
        this.walkedInstances.add(ti);
        const outer = this.inst;
        this.inst = ti;
        for (const s of ti.members ?? [])
            s?.accept(this);
        this.inst = outer;
    }

    /** Only the branch the condition chose: the other one is not analysed. */
    override visitConditionalDeclaration(d: ConditionalDeclaration): void {
        const inc = d.condition?.inc ?? Include.notComputed;
        this.decide(d.loc, inc, d.elsedecl !== null);
        const chosen = inc === Include.yes ? d.decl : inc === Include.no ? d.elsedecl : null;
        if (inc !== Include.yes)
            this.notAnalysed(d.decl);
        if (inc !== Include.no)
            this.notAnalysed(d.elsedecl);
        for (const s of chosen ?? [])
            s?.accept(this);
    }

    /** The expanded members (`cache`), not the body. */
    override visitStaticForeachDeclaration(d: StaticForeachDeclaration): void {
        for (const s of d.cache ?? [])
            s?.accept(this);
    }

    override visitCatch(c: Catch): void {
        if (c.var_ !== null)
            this.hit(c.var_.loc, c.var_);
        super.visitCatch(c);
    }

    /** `import a.b.c : x, y = z;`: each package, the module, each selective name and alias. */
    override visitImport(imp: Import): void {
        const m = imp.mod;
        const off = this.offsetOf(imp.loc);
        if (m === null || off === null)
            return;
        this.imports.push({ at: off, imp });
        const ids = [...(imp.packages ?? []), imp.id!];
        this.qualified(off, ids, asDsymbol(m), null);
        // a renamed import's name, before its `=` (the import's location is the module name's)
        let eq = off;
        while (eq > 0 && isSpace(this.bytes[eq - 1]!))
            eq--;
        const name = this.bytes[eq - 1] === 0x3d && imp.aliasId !== null ? identBefore(this.bytes, eq - 1) : -1;
        if (name >= 0)
            this.hitAt(name, imp, [identText(imp.aliasId)]);
        for (let i = 0; i < imp.names.length; i++) {
            const name = imp.names.opIndex(i);
            if (name === null)
                continue;
            // the selective name's alias (dimport.d `aliasdecls`), resolved by the import's semantic
            const ad = i < imp.aliasdecls.length ? imp.aliasdecls.opIndex(i) : null;
            const target = (ad !== null ? aliasTarget(ad) : null) ?? m.symtab?.lookup(name) ?? null;
            const at = findName(this.bytes, off, [identText(name)]);
            if (target !== null && at >= 0)
                this.hitAt(at, target, [identText(name)]);
        }
    }

    override visitModule(m: Module): void {
        const md = m.md;
        const off = md !== null ? this.offsetOf(md.loc) : null;
        if (md !== null && off !== null) {
            const start = findName(this.bytes, off, [identText(md.packages[0] ?? md.id)]);
            if (start >= 0)
                this.qualified(start, [...md.packages, md.id!], asDsymbol(m), null);
        }
        super.visitModule(m);
    }
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────────────────

/** The module of the last compile whose source file is `file` (both resolved against the working directory). */
function moduleOf(file: string): Module | null {
    let found = modulesByFile.get(file);
    if (found === undefined) {
        const want = resolve(file);
        found = null;
        for (const m of Module.amodules) {
            if (m !== null && m.src !== null && resolve(str(m.srcfile.toChars())) === want) {
                found = m;
                break;
            }
        }
        modulesByFile.set(file, found);
    }
    return found;
}

/** The text the compile's offsets index: `Module.src` less a UTF-8 byte order mark (dmodule.ts `processSource`). */
function compiledBytes(m: Module): Uint8Array {
    const src = m.src!;
    return src.length >= 3 && src[0] === 0xef && src[1] === 0xbb && src[2] === 0xbf ? src.subarray(3) : src;
}

function indexOf(m: Module): FileIndex {
    let ix = indexes.get(m);
    if (ix === undefined) {
        const bytes = compiledBytes(m);
        ix = { bytes, text: utf8.decode(bytes), hits: null, functions: [], nonCode: [], calls: [], decided: [],
            undecided: [], inactive: null, notes: null, expansions: null, resolved: null, ast: null, imports: [],
            locals: [], localsByFunction: null };
        indexes.set(m, ix);
    }
    return ix;
}

/** The index's hits, walking the module at the first call (THE INDEX in the header). */
function hitsOf(m: Module, ix: FileIndex): Map<number, Hit[]> {
    if (ix.hits === null) {
        const w = new IndexWalker(str(m.srcfile.toChars()), ix.bytes);
        m.accept(w);
        ix.hits = w.hits;
        ix.functions = w.functions;
        ix.calls = w.calls;
        ix.decided = w.decided;
        ix.undecided = w.undecided;
        ix.notes = w.notes;
        ix.imports = w.imports;
        ix.locals = w.locals;
        ix.nonCode = nonCode(ix.bytes);
    }
    return ix.hits;
}

function miss(reason: string, stale = false): QueryMiss {
    return { result: null, stale, reason };
}

/** The reason of a request whose text is not the compiled one. */
export const STALE_REASON = "the file changed since the last compile";

/**
 * The reason of a hover, a definition, a signature help, a references or a rename query in a branch the compile did
 * not choose (INACTIVE RANGES in the header).
 */
export const INACTIVE_REASON = "in a branch not compiled for this target and flags";

/**
 * The hits at the identifier under (line, character) of `file`, whose editor text is `text`, and the chosen one:
 * the first hit whose symbol's name is the token, else the first whose name the compiler did not make; with how many
 * template instances hold a chosen hit. An identifier in an inactive branch misses (INACTIVE_REASON) as the semantic
 * tokens, the hints and the references do: no analysis ran there, and the fallback's tables are the chosen branch's
 * scope, not the one that branch would see.
 */
function lookup(file: string, line: number, character: number, text: string):
    { hit: Hit; instances: number; bytes: Uint8Array; start: number } | QueryMiss {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    const ix = indexOf(m);
    if (text !== ix.text)
        return miss(STALE_REASON, true);
    const bytes = ix.bytes;
    let off = byteOffset(bytes, line, character);
    if (off === null)
        return miss("the position is outside the text");
    if (!isIdentByte(bytes[off]) && off > 0 && isIdentByte(bytes[off - 1]))
        off--;    // the cursor right after an identifier
    if (!isIdentByte(bytes[off]))
        return miss("no identifier at the position");
    while (off > 0 && isIdentByte(bytes[off - 1]))
        off--;
    if (!isIdentStart(bytes[off]))
        return miss("no identifier at the position");
    if (rangeHolding(inactiveOf(m, ix), off) >= 0)
        return miss(INACTIVE_REASON);
    const pool = choose(m, ix, off);
    if (pool.length === 0) {
        const allowed = inCode(ix, off) && fallbackAllowed(bytes, off);
        const sym = allowed ? fallback(m, ix, off, 0, foldedOperand(ix, off)) : null;
        const args = sym === null && allowed ? templateArgument(m, ix, off) : [];
        if (sym === null && args.length === 0)
            return miss("no symbol at the position");
        pool.push(...(sym !== null ? [{ sym, named: true, inst: null }] : args));
    }
    const hit = pool[0]!;
    const instances = hit.inst === null ? 0 : new Set(pool.filter((h) => h.inst !== null).map((h) => h.inst)).size;
    return { hit, instances, bytes, start: off };
}

/**
 * What a template's parameter at `start` stands for, where the analysis left no node of it (its declaration in the
 * parameter list, a `static if` condition, a template's argument, a field's type): the template declared in the file
 * whose extent holds the token and whose parameters declare its name (`parameterAt`, the references' rule), in the
 * instance whose analysed function holds the token, else its first instance; the argument of that instance's table
 * (templatesem.d `argsym`), as a use with a node answers (`T value` answers the struct `T` stands for): an alias's
 * target or its type's aggregate or enum, else the alias (a basic type's), a value parameter's constant; then the
 * other instances' (the hover counts them). Empty when the template has no instance.
 */
function templateArgument(m: Module, ix: FileIndex, start: number): Hit[] {
    const t = ix.bytes;
    const word = utf8.decode(t.subarray(start, identEnd(t, start)));
    const p = parameterAt(m, ix, start, word);
    const id = Identifier.lookup(t.subarray(start, identEnd(t, start)));
    if (p === null || id === null)
        return [];
    let here: TemplateInstance | null = null;
    for (let s = scopeAt(m, ix, start); s !== null && here === null; s = s.parent) {
        const ti = s.isTemplateInstance();
        if (ti !== null && ti.tempdecl === p.td)
            here = ti;
    }
    const all = instancesOf(p.td);
    const hits: Hit[] = [];
    for (const inst of here !== null ? [here, ...all.filter((x) => x !== here)] : all) {
        const arg = inst.argsym?.symtab?.lookup(id) ?? null;
        const al = arg?.isAliasDeclaration() ?? null;
        if (arg !== null)
            hits.push({ sym: (al !== null ? aliasTarget(al) ?? typeSymbol(al.type) : null) ?? arg, named: true, inst });
    }
    return hits;
}

/** The hits at `start` that may answer: the named ones, else those whose name the compiler did not make. */
function choose(m: Module, ix: FileIndex, start: number): Hit[] {
    const hits = hitsOf(m, ix).get(start) ?? [];
    const named = hits.filter((h) => h.named);
    return named.length !== 0 ? named : hits.filter((h) => !isCompilerName(h.sym));
}

/**
 * The comments and the string and character literals of `t`, as sorted byte ranges: the fallback does not answer
 * inside them, and the inactive ranges' scans skip them. Delimited and heredoc strings (`q"(...)"`, `q"EOS ... EOS"`)
 * and token strings (`q{...}`, a string whose tokens need not balance) are literals too.
 */
function nonCode(t: Uint8Array): [number, number][] {
    const ranges: [number, number][] = [];
    for (let p = 0; p < t.length;) {
        const c = t[p];
        if (c === 0x2f && (t[p + 1] === 0x2f || t[p + 1] === 0x2a || t[p + 1] === 0x2b)) {
            const e = skipTrivia(t, p);
            ranges.push([p, e]);
            p = Math.max(e, p + 2);
        } else if (c === 0x22 || c === 0x60 || (c === 0x27 && !isIdentByte(t[p - 1]))) {
            // a WYSIWYG string (`...`, r"...") and a hex string (x"...") have no escapes
            const prefixed = (t[p - 1] === 0x72 || t[p - 1] === 0x78) && !isIdentByte(t[p - 2]);
            const raw = c === 0x60 || (c === 0x22 && prefixed);
            let q = p + 1;
            while (q < t.length && t[q] !== c)
                q += t[q] === 0x5c && !raw ? 2 : 1;
            ranges.push([p, q + 1]);
            p = q + 1;
        } else if (c === 0x71 && (t[p + 1] === 0x22 || t[p + 1] === 0x7b) && !isIdentByte(t[p - 1])) {
            const e = t[p + 1] === 0x22 ? delimitedEnd(t, p + 2) : tokenStringEnd(t, p + 1);
            ranges.push([p, e]);
            p = e;
        } else if (isIdentStart(c)) {
            p = identEnd(t, p);
        } else {
            p++;
        }
    }
    return ranges;
}

/**
 * The end of a delimited string whose delimiter starts at `p` (after `q"`): a nesting `(`, `[`, `{`, `<` to its match,
 * a heredoc identifier to the line holding it alone, another character to its next occurrence; then the `"`.
 */
function delimitedEnd(t: Uint8Array, p: number): number {
    const open = t[p];
    const close = open === 0x28 ? 0x29 : open === 0x5b ? 0x5d : open === 0x7b ? 0x7d : open === 0x3c ? 0x3e : -1;
    if (close >= 0) {
        let depth = 0;
        for (let q = p; q < t.length; q++) {
            if (t[q] === open)
                depth++;
            else if (t[q] === close && --depth === 0 && t[q + 1] === 0x22)
                return q + 2;
        }
        return t.length;
    }
    if (isIdentStart(open)) {
        const id = t.subarray(p, identEnd(t, p));
        for (let q = t.indexOf(0x0a, p); q >= 0; q = t.indexOf(0x0a, q + 1)) {
            const e = q + 1 + id.length;
            if (e < t.length && t[e] === 0x22 && id.every((b, i) => t[q + 1 + i] === b))
                return e + 1;
        }
        return t.length;
    }
    for (let q = p + 1; q < t.length; q++)
        if (t[q] === open && t[q + 1] === 0x22)
            return q + 2;
    return t.length;
}

/** The end of a token string whose `{` is at `p`: its matching `}`, the strings and comments inside skipped. */
function tokenStringEnd(t: Uint8Array, p: number): number {
    let depth = 0;
    for (let q = p; q < t.length;) {
        const c = t[q];
        if (c === 0x2f && (t[q + 1] === 0x2f || t[q + 1] === 0x2a || t[q + 1] === 0x2b)) {
            q = Math.max(skipTrivia(t, q), q + 2);
        } else if (c === 0x22 || c === 0x60) {
            q++;
            while (q < t.length && t[q] !== c)
                q += t[q] === 0x5c && c === 0x22 ? 2 : 1;
            q++;
        } else {
            if (c === 0x7b)
                depth++;
            else if (c === 0x7d && --depth === 0)
                return q + 1;
            q++;
        }
    }
    return t.length;
}

/** True when byte `off` is outside every comment and literal of the index. */
function inCode(ix: FileIndex, off: number): boolean {
    let lo = 0;
    let hi = ix.nonCode.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const [a, b] = ix.nonCode[mid]!;
        if (off < a)
            hi = mid - 1;
        else if (off >= b)
            lo = mid + 1;
        else
            return false;
    }
    return true;
}

/**
 * The fallback's lookup scope at byte `off`: the innermost function whose body holds it, else the module; null when
 * that function's body was not analysed (`Body`). Of two bodies with one range (a template's function and its
 * instance's copy), the first analysed one (`scopesAt`).
 */
function scopeAt(m: Module, ix: FileIndex, off: number): Dsymbol | null {
    return scopesAt(m, ix, off)?.[0] ?? null;
}

/**
 * Whether the fallback may answer with `sym`: not a variable the analysis would have left a node for. A runtime
 * variable or parameter is never folded away, so an identifier with no hit that looks up to one sits in code the
 * analysis skipped (the branch a `static if` or `version` statement did not choose) where the name may be another
 * declaration's; an enum member and a manifest, `const` or `immutable` variable are folded to their values.
 */
function foldable(sym: Dsymbol): boolean {
    const v = sym.isVarDeclaration();
    if (v === null || sym.isEnumMember() !== null)
        return true;
    return !v.isParameter() && (v.storage_class & (STC.manifest | STC.const_ | STC.immutable_)) !== 0n;
}

/** How deep the fallback follows a `.` chain to the left (`a.b.c.d`). */
const CHAIN_DEPTH = 8;

/**
 * The symbol an identifier with no hit names, by a read-only lookup in the symbol tables: where the analysis left no
 * node (an enum member or a manifest constant, folded to its value; `S` in `S.staticMethod()`; a selective import's
 * name inside a body), the identifier is looked up as written. After a `.`, in the symbol of the identifier before
 * it (its hits, else this fallback again): a scope's table (an enum's members, an aggregate's, a module's), a
 * variable's type's, an alias's target's. Otherwise `lookupLexical` from the innermost analysed function holding it.
 * An alias found is followed to its target (a selective import's alias to the imported symbol). Null when not found,
 * and when it is a runtime variable (`foldable`) unless `anyVariable` (a built-in property's operand, `s.sizeof`; a
 * name inside `typeof(...)`) or the analysis left a node of it there under another name (`resolvedNear`).
 * In a body with errors (`erroneousBody`), where the walk met no node at all, a variable answers too: the lookup is
 * then by position (`brokenBodyLookup`), outside the inactive branches and the words that are never symbols.
 */
function fallback(m: Module, ix: FileIndex, start: number, depth: number, anyVariable = false): Dsymbol | null {
    const t = ix.bytes;
    const id = Identifier.lookup(t.subarray(start, identEnd(t, start)));
    if (id === null || depth > CHAIN_DEPTH)
        return null;
    let p = start;
    while (p > 0 && (t[p - 1] === 0x20 || t[p - 1] === 0x09 || t[p - 1] === 0x0a || t[p - 1] === 0x0d))
        p--;
    const scope = scopeAt(m, ix, start);
    const broken = erroneousBody(scope) && rangeHolding(inactiveOf(m, ix), start) < 0 && fallbackAllowed(t, start);
    let found: Dsymbol | null;
    if (p > 0 && t[p - 1] === 0x2e && t[p - 2] !== 0x2e) {
        const prev = identBefore(t, p - 1);
        if (prev < 0)
            return null;
        const left = choose(m, ix, prev)[0]?.sym ?? fallback(m, ix, prev, depth + 1, anyVariable);
        const container = left === null ? null : containerOf(left);
        // a module's or a package's member: through its public imports, its package.d (`std.datetime.Clock`)
        found = container === null ? null : container.isPackage() !== null
            ? memberNamed({ kind: "scope", sds: container }, id) : container.symtab?.lookup(id) ?? null;
    } else if (broken) {
        found = brokenBodyLookup(m, ix, scope!.isFuncDeclaration()!, start, id);
    } else {
        found = scope !== null ? localImported(m, ix, start, id) ?? lookupLexical(scope, id) : null;
    }
    const alias = found?.isAliasDeclaration() ?? null;
    const sym = (alias !== null ? aliasTarget(alias) : null) ?? found;
    // a plain import's name stands for its first package, as expressionsem.d `resolveIsPackage` makes it (`std` of
    // `std.file.exists`); a renamed import's name is the import
    const imp = sym?.isImport() ?? null;
    if (imp !== null && imp.aliasId === null)
        return imp.pkg;
    return sym !== null && (broken || anyVariable || foldable(sym) || resolvedNear(m, ix, start, sym)) ? sym : null;
}

/**
 * Whether the analysis left a node of `sym` at the identifier at `start`, or at one of the identifiers of the `.` chain
 * before it, under another name (`choose` drops a hit whose name the compiler made and is not the token's): an alias's
 * target, `__stdoutp` at `stdout`; a field reached through an alias, a Tuple's `__expand_field_0` for `st.terminated`,
 * located at the chain's start. The compile resolved the name to `sym` there, a runtime variable included.
 */
function resolvedNear(m: Module, ix: FileIndex, start: number, sym: Dsymbol): boolean {
    const t = ix.bytes;
    for (let p = start, depth = 0; p >= 0 && depth <= CHAIN_DEPTH; depth++) {
        if ((hitsOf(m, ix).get(p) ?? []).some((h) => h.sym === sym))
            return true;
        const dot = codeBefore(t, ix.nonCode, p) - 1;
        if (t[dot] !== 0x2e || t[dot - 1] === 0x2e)
            return false;
        p = identBefore(t, codeBefore(t, ix.nonCode, dot));
    }
    return false;
}

/**
 * Whether `scope` is a function whose analysis reported errors (`hasSemantic3Errors`, semantic3.d: the error count
 * grew, or the body became an `ErrorStatement`). Only there does the analysis leave no node for an identifier it
 * resolved or could resolve: an expression with an error becomes an `ErrorExp` (a `return` holding one keeps its
 * statement), and a statement with an error an `ErrorStatement`, which its block then becomes (statementsem.d
 * CompoundStatement), so one such error leaves the walk no node of the whole body. The editor's usual case: the
 * function being typed. Gagged errors (a speculative instance, `__traits(compiles)`) do not count.
 */
function erroneousBody(scope: Dsymbol | null): boolean {
    return scope?.isFuncDeclaration()?.hasSemantic3Errors ?? false;
}

/**
 * `id` at byte `start` of a body with errors (`erroneousBody`), as completion finds a chain's first link there
 * (`lookupFrom`: the function's locals by position, the name of several locals not resolved; a function-local import
 * declared before). A name found outside the function's own locals and parameters is refused where the body's text
 * could declare or open a scope the tables do not show, since the walk knows nothing of what the error dropped: the
 * body declares the name (`declarations`: a nested function's parameter, a local of a block, a local declared after
 * `start`), names it as a lambda's parameter (`lambdaParameter`), or holds a `with` statement. Null when not resolved.
 */
function brokenBodyLookup(m: Module, ix: FileIndex, fd: FuncDeclaration, start: number, id: Identifier):
    Dsymbol | null {
    const place: Place = { m, ix, off: start, scope: fd, edit: null, imports: localImports(ix, start),
        firstHits: null };
    const found = localImport(place, id) ?? lookupFrom(place, id);
    if (found === null || typeof found === "string")
        return null;
    if (found.toParent2() === fd)
        return found;
    const body = ix.functions.find((f) => f.fd === fd);
    if (body === undefined || declarations(place, fd, id) !== 0)
        return null;
    const name = identText(id);
    const inBody = (p: number): boolean => p >= body.start && p < body.end;   // `occurrences` are in code
    const hidden = occurrences(ix, name).some((p) => inBody(p) && lambdaParameter(ix, p, name.length, body.end))
        || occurrences(ix, "with").some((p) => inBody(p) && ix.bytes[skipTrivia(ix.bytes, p + 4)] === 0x28);
    return hidden ? null : found;
}

/**
 * Whether the name of `length` bytes at `p` is a function literal's parameter written without a type: `x => ...`, or
 * in the parenthesised list before a `=>` (`(a, x) => ...`). Searched up to `end`, the body's end.
 */
function lambdaParameter(ix: FileIndex, p: number, length: number, end: number): boolean {
    const t = ix.bytes;
    let q = skipTrivia(t, p + length);
    if (t[q] === 0x3d && t[q + 1] === 0x3e)
        return true;
    if (t[q] !== 0x2c && t[q] !== 0x29)
        return false;
    for (let depth = 0; q < end; q++) {
        const c = t[q];
        if (c === 0x28)
            depth++;
        else if (c === 0x3b || c === 0x7b || c === 0x7d)
            return false;
        else if (c === 0x29 && depth-- === 0) {
            const r = skipTrivia(t, q + 1);
            return t[r] === 0x3d && t[r + 1] === 0x3e;
        }
    }
    return false;
}

/**
 * What an alias names, read-only: its `aliassym` when the analysis set it; for a selective import's alias still
 * unresolved (`_import`, dmd/dsymbolsem.d resolves it at its first use), the imported name looked up in the imported
 * module and the modules it imports (`lookupLexical`). Null when neither gives one.
 */
function aliasTarget(al: AliasDeclaration): Dsymbol | null {
    if (al.aliassym !== null)
        return al.aliassym;
    const imp = al._import?.isImport() ?? null;
    if (imp === null || imp.mod === null)
        return null;
    const i = imp.aliasdecls.opSlice().indexOf(al);
    const name = i >= 0 ? imp.names.opIndex(i) : null;
    return name !== null ? lookupLexical(asDsymbol(imp.mod), name) : null;
}

/** A module as the scope of a member lookup (`memberNamed`). */
function moduleScope(mod: Module): Target {
    return { kind: "scope", sds: asDsymbol(mod).isScopeDsymbol()! };
}

/**
 * The symbol `id` names through the imports declared in the function bodies holding byte `off`, before it, the latest
 * first (`localImports`; no symbol table of the function holds them): a renamed import's name (`import io =
 * std.stdio;`) or a plain import's first package (`std` of `import std.file;`) is the import itself, as a module's
 * table holds it (`fallback` answers a plain one as its package); a selective import's name its target; else a member
 * of a plain import's module or of the modules it imports publicly (`searchModule`), visible from `m`. Null when none,
 * or when two of those imports give different symbols (`single`).
 */
function localImported(m: Module, ix: FileIndex, off: number, id: Identifier): Dsymbol | null {
    const imports = localImports(ix, off).reverse();
    for (const imp of imports) {
        if (imp.aliasId !== null ? imp.aliasId === id : imp.names.length === 0 && imp.ident === id)
            return imp;
        for (let i = 0; i < imp.names.length; i++) {
            const name = imp.names.opIndex(i);
            const alias = i < imp.aliases.length ? imp.aliases.opIndex(i) : null;
            if ((alias ?? name) !== id)
                continue;
            const ad = i < imp.aliasdecls.length ? imp.aliasdecls.opIndex(i) : null;
            return (ad !== null ? aliasTarget(ad) : null)
                ?? (imp.mod !== null && name !== null ? memberNamed(moduleScope(imp.mod), name) : null);
        }
    }
    const found: Dsymbol[] = [];
    for (const imp of imports) {
        if (imp.names.length === 0 && imp.aliasId === null && imp.mod !== null)
            for (const c of searchModule(asDsymbol(imp.mod).isScopeDsymbol()!, id))
                if (visibleFrom(asDsymbol(m).isScopeDsymbol()!, c))
                    addDistinct(found, c);
    }
    return single(found);
}

/**
 * The scope whose table holds the members `sym.x` names: `sym` itself, a variable's type's, an alias's target's, an
 * import's module (renamed: `io.writeln`) or first package (`std.file.exists`).
 */
function containerOf(sym: Dsymbol): ScopeDsymbol | null {
    const sds = sym.isScopeDsymbol();
    if (sds !== null)
        return sds;
    const imp = sym.isImport();
    if (imp !== null)
        return imp.aliasId !== null ? imp.mod !== null ? asDsymbol(imp.mod).isScopeDsymbol() : null : imp.pkg;
    const v = sym.isVarDeclaration();
    if (v !== null)   // a pointer's target: `p.x` dereferences it
        return typeSymbol(v.type?.ty === TY.Tpointer ? elementType(v.type) : v.type)?.isScopeDsymbol() ?? null;
    const al = sym.isAliasDeclaration();
    if (al !== null)
        return al.aliassym?.isScopeDsymbol() ?? typeSymbol(al.type)?.isScopeDsymbol() ?? null;
    return null;
}

/** The basic types a keyword names before a built-in property (`float.nan`, `uint.max`). */
const BASIC_TYPES: ReadonlyMap<string, TY> = new Map([["byte", TY.Tint8], ["ubyte", TY.Tuns8], ["short", TY.Tint16],
    ["ushort", TY.Tuns16], ["int", TY.Tint32], ["uint", TY.Tuns32], ["long", TY.Tint64], ["ulong", TY.Tuns64],
    ["cent", TY.Tint128], ["ucent", TY.Tuns128], ["float", TY.Tfloat32], ["double", TY.Tfloat64], ["real", TY.Tfloat80],
    ["ifloat", TY.Timaginary32], ["idouble", TY.Timaginary64], ["ireal", TY.Timaginary80], ["cfloat", TY.Tcomplex32],
    ["cdouble", TY.Tcomplex64], ["creal", TY.Tcomplex80], ["bool", TY.Tbool], ["char", TY.Tchar],
    ["wchar", TY.Twchar], ["dchar", TY.Tdchar]]);

/**
 * The `(` or `[` matching the `)` or `]` at `close`, comments and literals skipped; -1 when a `;`, `{` or `}` comes
 * first (the statement's start) or the text's start.
 */
function openingOf(t: Uint8Array, nc: [number, number][], close: number): number {
    const shut = t[close];
    const open = shut === 0x29 ? 0x28 : 0x5b;
    let depth = 0;
    for (let p = close; p >= 0; p--) {
        const k = rangeHolding(nc, p);
        if (k >= 0) {
            p = nc[k]![0];
            continue;
        }
        const c = t[p];
        if (c === shut)
            depth++;
        else if (c === open && --depth === 0)
            return p;
        else if (c === 0x3b || c === 0x7b || c === 0x7d)
            return -1;
    }
    return -1;
}

/**
 * What the operand of the `.` at `dot` gives, for a built-in property after it (BUILT-IN PROPERTIES in the header),
 * read-only: a basic type's keyword its type, a string literal `string`; else the identifier that ends the operand
 * (past the calls and indexes written after it, `f(x).length`, `row[0].length`, and a template's arguments,
 * `to!string(x).length`): the symbol the index has there (in a template's code, the first instance's), else, outside
 * the branches not chosen, the fallback's, a runtime variable included (`s.sizeof` leaves no node of `s`); then its
 * value or type (`symbolTarget`), a function's return type (the overload resolved there; a property's too). Null when
 * none.
 */
function operandBefore(m: Module, ix: FileIndex, dot: number): Target | null {
    const t = ix.bytes;
    const nc = ix.nonCode;
    let q = codeBefore(t, nc, dot);
    const ops: ("call" | "index")[] = [];
    while (t[q - 1] === 0x29 || t[q - 1] === 0x5d) {
        const open = openingOf(t, nc, q - 1);
        if (open < 0)
            return null;
        const b = codeBefore(t, nc, open);
        if (t[q - 1] === 0x29 && t[b - 1] === 0x21) {   // `name!(args)`: the template's arguments
            q = codeBefore(t, nc, b - 1);
            continue;
        }
        if (t[q - 1] === 0x29 && ops.length === 0 && groupingParen(t, open))
            return groupedOperand(m, ix, open, q - 1);
        ops.unshift(t[q - 1] === 0x29 ? "call" : "index");
        q = b;
    }
    const literal = q > 0 ? rangeHolding(nc, q - 1) : -1;
    if (literal >= 0)     // a string literal without a postfix (`"--port=".length`)
        return ops.length === 0 && t[q - 1] === 0x22 && [0x22, 0x60, 0x72].includes(t[nc[literal]![0]]!)
            ? { kind: "value", type: Type.tstring, mod: Type.tstring.mod } : null;
    let s = identBefore(t, q);
    if (s < 0)
        return null;
    let word = utf8.decode(t.subarray(s, q));
    const bang = codeBefore(t, nc, s);
    const name = t[bang - 1] === 0x21 ? identBefore(t, codeBefore(t, nc, bang - 1)) : -1;
    if (name >= 0 && !KEYWORDS.has(utf8.decode(t.subarray(name, identEnd(t, name))))) {
        s = name;    // `name!arg`: the template's name, its one argument skipped
        word = utf8.decode(t.subarray(s, identEnd(t, s)));
    }
    const basic = ops.length === 0 ? BASIC_TYPES.get(word) : undefined;
    if (basic !== undefined)
        return Type.basic[basic] !== null ? { kind: "type", type: Type.basic[basic]! } : null;
    if (KEYWORDS.has(word))
        return null;
    const inactive = inactiveOf(m, ix).some(([a, b]) => a <= s && s < b);
    const sym = choose(m, ix, s)[0]?.sym ?? (inactive ? null : fallback(m, ix, s, 0, true));
    if (sym === null)
        return null;
    const link: Link = { name: word, start: s, end: s + word.length, ops };
    // a function: the overload the analysis resolved there returns it, called with or without parentheses
    const fd = sym.isFuncDeclaration();
    const next = fd !== null ? fd.type?.isTypeFunction()?.next ?? null : null;
    const target = next !== null ? next.ty === TY.Tident ? "not inferred" : applyOps({ kind: "value", type: next,
        mod: next.mod }, { ...link, ops: ops[0] === "call" ? ops.slice(1) : ops }) : symbolTarget(sym, link, 0);
    return typeof target === "string" ? null : target;
}

/** A parenthesised operand that dereferences a name or a chain, `(*p)`, `(**a.b)`, `(x)`; its `*`s. */
const DEREF_OPERAND = /^\s*(\**)\s*[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*\s*$/;

/**
 * What a parenthesised operand between `open` and `close` gives (`(*stList).length`), for `operandBefore`: a name or
 * a chain, dereferenced by the `*`s before it (DEREF_OPERAND), each the target of a pointer value; null for another
 * expression, or a `*` of something not a pointer.
 */
function groupedOperand(m: Module, ix: FileIndex, open: number, close: number): Target | null {
    const form = DEREF_OPERAND.exec(utf8.decode(ix.bytes.subarray(open + 1, close)));
    let target = form !== null ? operandBefore(m, ix, close) : null;
    for (let n = form?.[1]!.length ?? 0; n > 0 && target !== null; n--) {
        const next = target.kind === "value" && target.type.ty === TY.Tpointer ? elementType(target.type) : null;
        target = next !== null ? { kind: "value", type: next, mod: next.mod } : null;
    }
    return target;
}

/**
 * The built-in property named by the identifier at `start` (BUILT-IN PROPERTIES in the header): an identifier after
 * a `.` that no symbol answers, one of the spec's properties of the operand's type (`builtins`, the completion's
 * list); with the operand's value or type. Null when it is not one.
 */
function builtinAt(m: Module, ix: FileIndex, start: number): { target: Target & { type: Type }; item: CompletionItem }
    | null {
    const t = ix.bytes;
    if (!inCode(ix, start))
        return null;
    const dot = codeBefore(t, ix.nonCode, start) - 1;
    if (t[dot] !== 0x2e || t[dot - 1] === 0x2e)
        return null;
    const target = operandBefore(m, ix, dot);
    if (target === null || target.kind === "scope")
        return null;
    const te = target.kind === "type" ? target.type.isTypeEnum() : null;
    const ad = te === null ? aggregateOf(target.type) : null;
    const valueEnum = target.kind === "value" ? target.type.isTypeEnum() : null;
    const type = target.kind === "value" ? baseOf(target.type) : target.type;
    const name = utf8.decode(t.subarray(start, identEnd(t, start)));
    const item = builtins(type, ad, valueEnum !== null ? target.type : null).find((b) => b.label === name);
    return item !== undefined ? { target, item } : null;
}

/**
 * The hover of a name no symbol stands for, at `start`: a built-in property (`builtinAt`), kind `property`, its type
 * and the operand's; a parameter named in a function or delegate type (`Notes.parameters`), kind `parameter`, as
 * hdrgen prints it.
 */
function builtinHover(m: Module, ix: FileIndex, start: number): HoverAnswer | null {
    const range = identRange(ix.bytes, start);
    const p = typeParameterAt(m, ix, start);
    if (p !== null) {
        const name = identText(p.param.ident);
        const markdown = `*parameter* \`${name}\`\n\n\`\`\`d\n${str(parameterToChars(p.param, p.tf, false))}\n\`\`\``;
        return { result: { kind: "parameter", name, markdown, range } };
    }
    const b = builtinAt(m, ix, start);
    if (b === null)
        return null;
    const { label, detail } = b.item;
    const code = detail === "" ? label : detail.includes("(") ? detail : `${detail} ${label}`;
    const markdown = `*property* \`${label}\` of \`${str(b.target.type.toChars())}\`\n\n\`\`\`d\n${code}\n\`\`\``;
    return { result: { kind: "property", name: label, markdown, range } };
}

/** The parameter named at `start` in a function or delegate type written in a declaration, else null. */
function typeParameterAt(m: Module, ix: FileIndex, start: number): { param: Parameter; tf: TypeFunction } | null {
    hitsOf(m, ix);
    return ix.notes?.parameters.get(start) ?? null;
}

/** The properties that fold their operand away whatever it is: a runtime variable before them leaves no node. */
const FOLDING_PROPERTIES: ReadonlySet<string> = new Set(["sizeof", "alignof", "mangleof", "stringof"]);

/**
 * Whether the identifier at `start` is the operand of a property that folds it away (`addr.sizeof`), or inside the
 * parentheses of a `typeof` (`is(typeof(cl.flag) : bool)`: the analysis keeps only the type): the fallback may then
 * answer with a runtime variable, and a member after it.
 */
function foldedOperand(ix: FileIndex, start: number): boolean {
    const t = ix.bytes;
    const dot = skipTrivia(t, identEnd(t, start));
    const p = t[dot] === 0x2e && t[dot + 1] !== 0x2e ? skipTrivia(t, dot + 1) : -1;
    return (p >= 0 && FOLDING_PROPERTIES.has(utf8.decode(t.subarray(p, identEnd(t, p))))) || inTypeof(ix, start);
}

/** How far back from a name its enclosing `typeof(` is searched. */
const TYPEOF_WINDOW = 1024;

/** Whether byte `start` is inside a `typeof`'s parentheses, within its statement (comments and literals skipped). */
function inTypeof(ix: FileIndex, start: number): boolean {
    const t = ix.bytes;
    let depth = 0;
    for (let p = start - 1; p >= 0 && p > start - TYPEOF_WINDOW; p--) {
        const k = rangeHolding(ix.nonCode, p);
        if (k >= 0) {
            p = ix.nonCode[k]![0];
            continue;
        }
        const c = t[p];
        if (c === 0x3b || c === 0x7b || c === 0x7d)
            return false;
        if (c === 0x29)
            depth++;
        else if (c === 0x28 && depth-- === 0) {
            depth = 0;
            const w = identBefore(t, codeBefore(t, ix.nonCode, p));
            if (w >= 0 && wordAt(t, w) === "typeof")
                return true;
        }
    }
    return false;
}

/** The start of the identifier holding byte `off`, or ending just before it (a cursor after it). */
function identStartAt(t: Uint8Array, off: number): number {
    if (!isIdentByte(t[off]) && off > 0 && isIdentByte(t[off - 1]))
        off--;
    while (off > 0 && isIdentByte(t[off - 1]))
        off--;
    return off;
}

/**
 * The hover of the symbol at (line from 0, UTF-16 character from 0) of `file`, whose editor text is `text`, from the
 * last compile (THE CONTRACT in the header: read-only, between compiles). `file` is matched against the source files
 * of the last compile's modules, both resolved against the working directory. Misses: the file is not in the last
 * compile; `stale` (STALE_REASON) when `text` is not the text that compile read; no identifier, or no symbol, at the
 * position; the position in an inactive branch (INACTIVE_REASON). Cost: see the header.
 */
export function queryHover(file: string, line: number, character: number, text: string): HoverAnswer {
    return printing(() => hover(file, line, character, text));
}

function hover(file: string, line: number, character: number, text: string): HoverAnswer {
    // an operator right after an identifier (`a+b`, `a[1]`) is the operator's, not the identifier's the lookup steps to
    const m0 = moduleOf(file);
    const ix0 = m0 !== null ? indexOf(m0) : null;
    const off = ix0 !== null && text === ix0.text ? byteOffset(ix0.bytes, line, character) : null;
    if (off !== null && !isIdentByte(ix0!.bytes[off])) {
        const lowered = resolvedHover(m0!, ix0!, off);
        if (lowered !== null)
            return lowered;
    }
    const r = lookup(file, line, character, text);
    if ("reason" in r) {
        const builtin = r.reason === "no symbol at the position" && off !== null
            ? builtinHover(m0!, ix0!, identStartAt(ix0!.bytes, off)) : null;
        if (builtin !== null)
            return builtin;
        const lowering = r.reason === "no identifier at the position" || r.reason === "no symbol at the position";
        return (lowering && off !== null ? resolvedHover(m0!, ix0!, off) : null) ?? r;
    }
    const { hit, instances, bytes, start } = r;
    const sym = hit.sym;
    printStack.push(...contextOf(sym));   // the context of `spellFresh` (`printing` empties it)
    const kind = kindOf(sym);
    const name = str(sym.toPrettyChars());
    const parts = [`*${kind}* \`${name}\``, "```d\n" + signatureOf(sym) + "\n```"];
    const inst = hit.inst ?? enclosingInstance(sym);
    if (inst !== null) {
        const of = instances > 1 ? ` (1 of ${instances} instances)` : "";
        parts.push(`In instance \`${str(inst.toChars())}\`${of}.`);
    }
    if (sym.isDeprecated()) {
        const msg = sym.depdecl()?.msgstr ?? null;
        parts.push(msg !== null ? `**Deprecated**: ${str(msg)}` : "**Deprecated**");
    }
    const doc = docOf(sym);
    if (doc !== null) {
        const rendered = renderDoc(sym, doc);
        if (rendered !== "")
            parts.push("---", rendered);
    }
    const m = moduleOf(file)!;
    const resolved = firstCopy(resolvedOf(m, indexOf(m)).get(start) ?? []);
    if (resolved.length !== 0)
        parts.push("---", resolvedSection(m, indexOf(m), start, resolved));
    return { result: { kind, name, markdown: parts.join("\n\n"), range: identRange(bytes, start) } };
}

/**
 * The declaration of the symbol at (line, character) of `file` (see `queryHover` for the arguments and the misses):
 * the declaring file as the compiler names it and the range of the declaration's identifier; a module's file at its
 * start; a symbol declared in a string mixin, its name inside the mixin's literal, else the `mixin` keyword
 * (`mixinSite`). More misses: a symbol without a source location (a builtin, `Loc.initial`), one declared in a string
 * mixin that `mixinSite` cannot place (a string built elsewhere, on a line of several mixins).
 */
export function queryDefinition(file: string, line: number, character: number, text: string): DefinitionAnswer {
    return printing(() => definition(file, line, character, text));
}

function definition(file: string, line: number, character: number, text: string): DefinitionAnswer {
    const r = lookup(file, line, character, text);
    if ("reason" in r) {
        const m = r.reason === "no symbol at the position" ? moduleOf(file) : null;
        const ix = m !== null ? indexOf(m) : null;
        const off = ix !== null ? byteOffset(ix.bytes, line, character) : null;
        if (off === null)
            return r;
        const start = identStartAt(ix!.bytes, off);
        const p = typeParameterAt(m!, ix!, start);
        if (p !== null)     // the parameter's own name: its declaration
            return { result: { name: identText(p.param.ident), file: str(m!.srcfile.toChars()),
                range: identRange(ix!.bytes, start) } };
        return builtinAt(m!, ix!, start) !== null ? miss("a built-in property has no declaration") : r;
    }
    const name = str(r.hit.sym.toPrettyChars());
    const d = declarationOf(r.hit.sym);
    if (typeof d !== "string")
        return { result: { name, ...d } };
    const site = mixinSite(r.hit.sym);
    return site === null ? miss(d) : { result: { name, file: site.file, range: site.range } };
}

/**
 * Where a symbol declared in a string mixin is written in the source, for `queryDefinition` and `queryReferences`:
 * its location's file `<file>-mixin-<line>` (dsymbolsem.d `adjustLocForMixin`) names the line of the `mixin (`; of
 * the keywords starting a statement there, the one whose lone literal argument holds the very bytes the mixin parsed
 * (no escape sequence decoded) gives the declaration's identifier inside the literal (`named`); else, when the line
 * has one such keyword, the keyword (the outline's selection). Null when neither: a mixed-in string built elsewhere
 * (`mixin(code)`) on a line of several mixins, or a location that is no mixin's.
 */
function mixinSite(sym: Dsymbol): (DeclarationSite & { named: boolean }) | null {
    if (!sym.loc.isValid() || sym.loc.filename() === null)
        return null;
    const sl = sym.loc.toSourceLoc();
    const parts = /^(.*)-mixin-(\d+)$/s.exec(str(sl.filename));
    const m = parts !== null ? moduleOf(parts[1]!) : null;
    if (m === null)
        return null;
    const file = parts![1]!;
    const ix = indexOf(m);
    const t = ix.bytes;
    const nc = ix.hits !== null ? ix.nonCode : nonCode(t);
    const keywords = mixinKeywords(t, nc, Number(parts![2]) - 1);
    const parsed = sl.fileContent;
    const k = sl.fileOffset < parsed.length ? keyAt(parsed, sl.fileOffset, namesOf(sym)) : null;
    for (const at of k !== null ? keywords : []) {
        const a = mixinArgument(t, nc, at);
        const n = a !== null ? a.end - a.start : -1;
        // an escape sequence makes the parsed text shorter than the literal: equal bytes mean none
        if (a === null || n > parsed.length || (n < parsed.length && parsed[n] !== 0)
            || !t.subarray(a.start, a.end).every((b, i) => b === parsed[i]))
            continue;
        return { file, range: identRange(t, a.start + k!.start), named: true };
    }
    return keywords.length === 1 ? { file, range: identRange(t, keywords[0]!), named: false } : null;
}

/**
 * Where `sym` is declared, as `queryDefinition` answers: the file as the compiler names it and the identifier's range
 * there (a module's file at its start, a package's through its package.d; the point of the location where no
 * identifier of the symbol's name is found from it, unless `atIdentifier`); else why there is none.
 */
function declarationOf(sym: Dsymbol, atIdentifier = false): DeclarationSite | string {
    const pkg = sym.isPackage();
    if (pkg !== null && sym.isModule() === null) {
        const pm = pkg.isPackageMod();
        if (pm === null)
            return "a package has no declaration";
        sym = asDsymbol(pm);
    }
    const m = sym.isModule();
    if (m !== null) {
        const zero = { line: 0, character: 0 };
        return { file: str(m.srcfile.toChars()), range: { start: zero, end: zero } };
    }
    const at = sourceLoc(sym.loc);
    if (typeof at === "string")
        return at;
    const { sl, file } = at;
    const content = sl.fileContent;
    const k = content !== null && sl.fileOffset < content.length ? keyAt(content, sl.fileOffset, namesOf(sym)) : null;
    if (k === null) {
        if (atIdentifier)
            return "the location is not at the declaration's identifier";
        const p = { line: Math.max(sl.line - 1, 0), character: Math.max(sl.column - 1, 0) };
        return { file, range: { start: p, end: p } };
    }
    const r0 = identRange(content!, k.start);
    const delta = lineDelta(sl);
    return { file, range: { start: { line: r0.start.line + delta, character: r0.start.character },
        end: { line: r0.end.line + delta, character: r0.end.character } } };
}

/** `loc` resolved, with its file as the compiler names it; else why it is not in a source file. */
function sourceLoc(loc: Loc): { sl: SourceLoc; file: string } | string {
    if (!loc.isValid() || loc.filename() === null)
        return "the symbol has no source location";
    const sl = loc.toSourceLoc();
    const file = str(sl.filename);
    if (/-mixin-\d+$/.test(file))
        return "the symbol is declared in a string mixin";
    return { sl, file };
}

/**
 * The lines a `#line` directive adds at `sl`: its line comes from the SourceLoc, which counts the substitution, and
 * the character from the line's bytes.
 */
function lineDelta(sl: SourceLoc): number {
    return sl.line - 1 - positionOf(sl.fileContent, sl.fileOffset).line;
}

// ── semantic tokens ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The token types of `querySemanticTokens`, standard LSP/VS Code names; an answer's type is an index into this list.
 * The table of which symbol gets which type is SEMANTIC TOKENS in the header.
 */
export const SEMANTIC_TOKEN_TYPES: readonly string[] = ["namespace", "type", "class", "struct", "interface", "enum",
    "enumMember", "typeParameter", "function", "method", "variable", "parameter", "property"];

/** The token modifiers of `querySemanticTokens`, standard names; an answer's modifiers are bits: 1 << index. */
export const SEMANTIC_TOKEN_MODIFIERS: readonly string[] = ["declaration", "readonly", "static", "deprecated",
    "defaultLibrary"];

/** The semantic tokens of one file: flat 5-tuples, sorted by position, never overlapping (SEMANTIC TOKENS). */
export interface SemanticTokensResult {
    /** `[line, character, length, type, modifiers]` per token: absolute line from 0, UTF-16 character and length. */
    data: Uint32Array;
}

/** The answer of `querySemanticTokens`: the file's tokens, or a miss (the file is not in the last compile; `stale`). */
export type SemanticTokensAnswer = { result: SemanticTokensResult } | QueryMiss;

const TT = Object.fromEntries(SEMANTIC_TOKEN_TYPES.map((t, i) => [t, i])) as Record<string, number>;
const TM_DECLARATION = 1;
const TM_READONLY = 2;
const TM_STATIC = 4;
const TM_DEPRECATED = 8;
const TM_DEFAULT_LIBRARY = 16;

/** The root packages of druntime and Phobos as LDC ships them (`object` is a module): `defaultLibrary`. */
const DEFAULT_LIBRARY: ReadonlySet<string> = new Set(["core", "std", "etc", "ldc", "object"]);

/** object.d's aliases the TextMate grammar colours as basic types (`storage.type.basic-type.d`): not tokenised. */
const GRAMMAR_BASIC_TYPES: ReadonlySet<string> = new Set(["string", "wstring", "dstring", "size_t", "ptrdiff_t",
    "noreturn"]);

/** How deep an alias, an overload alias or a template is followed to what it names. */
const ALIAS_DEPTH = 8;

/** A token's type and its modifiers other than `declaration`, which depends on the token's place, not its symbol. */
interface TokenKind {
    type: number;
    mods: number;
}

/** The name of the outermost package (or module) `sym` belongs to: `std` for std.stdio.File, `object`. */
function rootPackageOf(sym: Dsymbol): string {
    let s: Dsymbol = sym.getModule() !== null ? asDsymbol(sym.getModule()!) : sym;
    while (s.parent !== null)
        s = s.parent;
    return identText(s.ident);
}

/** The modifiers every kind takes from its symbol: `deprecated`, `defaultLibrary`. */
function commonMods(sym: Dsymbol): number {
    const library = DEFAULT_LIBRARY.has(rootPackageOf(sym));
    return (sym.isDeprecated() ? TM_DEPRECATED : 0) | (library ? TM_DEFAULT_LIBRARY : 0);
}

/**
 * A function's kind: a constructor is its type's; a member `method` (`property` when @property), else `function`.
 * Membership is `isMember2`, past template instances: a member template's instance (`s.tm!long`, a templated
 * constructor or `opCall`) has its instance as parent, where `isMember` stops.
 */
function functionKind(fd: FuncDeclaration, owner: Dsymbol, depth: number): TokenKind | null {
    const fa = fd.isFuncAliasDeclaration();
    if (fa !== null)
        return fa.funcalias !== null && depth < ALIAS_DEPTH ? tokenKind(fa.funcalias, depth + 1) : null;
    const ad = owner.isMember2();
    if (fd.ident === Id.ctor)
        return ad !== null ? tokenKind(ad, depth + 1) : null;
    const mods = commonMods(fd);
    if (ad === null)
        return { type: TT["function"]!, mods };
    const property = fd.type?.isTypeFunction()?.isProperty ?? false;
    return { type: property ? TT["property"]! : TT["method"]!, mods: mods | (fd.isStatic() ? TM_STATIC : 0) };
}

/** A variable's kind (SEMANTIC TOKENS in the header). */
function variableKind(v: VarDeclaration): TokenKind {
    let mods = commonMods(v);
    if (v.isEnumMember() !== null)
        return { type: TT["enumMember"]!, mods: mods | TM_READONLY };
    if ((v.storage_class & (STC.manifest | STC.const_ | STC.immutable_)) !== 0n
        || (v.type !== null && (v.type.isConst() || v.type.isImmutable())))
        mods |= TM_READONLY;
    if ((v.storage_class & STC.templateparameter) !== 0n)
        return { type: TT["parameter"]!, mods: mods | TM_READONLY };
    if (v.isParameter())
        return { type: TT["parameter"]!, mods };
    const isStatic = (v.storage_class & (STC.static_ | STC.gshared)) !== 0n;
    if (v.isMember() !== null)
        return { type: TT["property"]!, mods: mods | (isStatic ? TM_STATIC : 0) };
    const local = v.toParent2()?.isFuncDeclaration() ?? null;
    return { type: TT["variable"]!, mods: mods | (local !== null && isStatic ? TM_STATIC : 0) };
}

/**
 * The kind of a template: the kind of its eponymous member (`onemember`: a function, method, aggregate, enum or
 * variable template), `type` for an alias template, a mixin template and a template without one.
 */
function templateKind(td: TemplateDeclaration, depth: number): TokenKind {
    const one = td.onemember ?? eponymousOverload(td);
    const fd = one?.isFuncDeclaration() ?? null;
    if (fd !== null)
        return functionKind(fd, td, depth) ?? { type: TT["function"]!, mods: commonMods(td) };
    if (one !== null && one.isAliasDeclaration() === null && !td.ismixin) {
        const k = tokenKind(one, depth + 1);
        if (k !== null)
            return { type: k.type, mods: k.mods | commonMods(td) };
    }
    return { type: TT["type"]!, mods: commonMods(td) };
}

/**
 * A member of `td` with its name when it has no `onemember` because it declares several (`template canFind(alias
 * pred) { bool canFind(R)(R r) ...; bool canFind(R, E)(R r, E e) ...; }`), through attribute blocks; else null.
 */
function eponymousOverload(td: TemplateDeclaration): Dsymbol | null {
    const find = (list: Iterable<Dsymbol | null> | null): Dsymbol | null => {
        for (const s of list ?? []) {
            if (s === null)
                continue;
            if (s.ident === td.ident)
                return s;
            const attrib = s.isAttribDeclaration();
            const found = attrib !== null ? find(attrib.decl) : null;
            if (found !== null)
                return found;
        }
        return null;
    };
    return find(td.members);
}

/** The token kind of `sym` (SEMANTIC TOKENS in the header); null for a symbol the legend has no type for. */
function tokenKind(sym: Dsymbol, depth = 0): TokenKind | null {
    if (depth > ALIAS_DEPTH)
        return null;
    if (sym.isModule() !== null || sym.isPackage() !== null || sym.isNspace() !== null)
        return { type: TT["namespace"]!, mods: commonMods(sym) };
    const imp = sym.isImport();
    if (imp !== null)   // a scoped import's symbol, named by its first package (`std` of `import std.stdio;`)
        return { type: TT["namespace"]!, mods: commonMods(imp.mod !== null ? asDsymbol(imp.mod) : imp) };
    const al = sym.isAliasDeclaration();
    if (al !== null) {
        if ((al.storage_class & STC.templateparameter) !== 0n)
            return { type: TT["typeParameter"]!, mods: commonMods(al) };
        const target = aliasTarget(al) ?? typeSymbol(al.type);
        const k = target !== null ? tokenKind(target, depth + 1) : null;
        if (k === null)
            return { type: TT["type"]!, mods: commonMods(al) };
        // a selective import's alias is the library's name; a user's own alias of a library symbol is user code
        const library = al._import !== null ? k.mods & TM_DEFAULT_LIBRARY : commonMods(al) & TM_DEFAULT_LIBRARY;
        const mods = (k.mods & ~TM_DEFAULT_LIBRARY) | library | (al.isDeprecated() ? TM_DEPRECATED : 0);
        return { type: k.type, mods };
    }
    const tup = sym.isTupleDeclaration();
    if (tup !== null)
        return { type: (tup.storage_class & STC.templateparameter) !== 0n ? TT["typeParameter"]! : TT["variable"]!,
            mods: commonMods(tup) };
    const v = sym.isVarDeclaration();
    if (v !== null)
        return variableKind(v);
    const fd = sym.isFuncDeclaration();
    if (fd !== null)
        return functionKind(fd, fd, depth);
    if (sym.isOverloadSet() !== null)
        return { type: TT["function"]!, mods: commonMods(sym) };
    const td = sym.isTemplateDeclaration();
    if (td !== null)
        return templateKind(td, depth);
    const ti = sym.isTemplateInstance();
    if (ti !== null)
        return ti.tempdecl !== null ? tokenKind(ti.tempdecl, depth + 1) : null;
    const ad = sym.isAggregateDeclaration();
    if (ad !== null) {
        const type = ad.isInterfaceDeclaration() !== null ? "interface" : ad.isClassDeclaration() !== null ? "class"
            : "struct";
        return { type: TT[type]!, mods: commonMods(ad) };
    }
    if (sym.isEnumDeclaration() !== null)
        return { type: TT["enum"]!, mods: commonMods(sym) };
    return null;
}

/**
 * Whether the token at `start` is `sym`'s own declaration name: `sym` is declared in this file (`file`, the name the
 * compile gives it) and its location's key (`keyAt`, as the index keys a declaration) is the token. A module is
 * declared only by its own module declaration; a package never.
 */
function isDeclarationAt(m: Module, ix: FileIndex, file: string, sym: Dsymbol, start: number): boolean {
    if (sym.isModule() !== null)
        return sym === asDsymbol(m) && start === moduleNameAt(m, ix);
    if (sym.isPackage() !== null || !sym.loc.isValid())
        return false;
    const name = sym.loc.filename();
    if (name === null || str(name) !== file)
        return false;
    const off = sym.loc.fileOffset();
    return off < ix.bytes.length && keyAt(ix.bytes, off, namesOf(sym))?.start === start;
}

/**
 * The start of the last identifier of `m`'s module declaration in its text (`f` of `module pk.f;`), as
 * IndexWalker.visitModule finds the declaration's names; -1 when `m` has none.
 */
function moduleNameAt(m: Module, ix: FileIndex): number {
    const md = m.md;
    if (md === null || !md.loc.isValid())
        return -1;
    const t = ix.bytes;
    let p = findName(t, md.loc.fileOffset(), [identText(md.packages[0] ?? md.id)]);
    for (let i = 0; i < md.packages.length && p >= 0; i++) {
        p = skipTrivia(t, identEnd(t, p));
        if (t[p] !== 0x2e)
            return -1;
        p = skipTrivia(t, p + 1);
    }
    return p;
}

/** The keywords whose parenthesised first identifier is never a symbol: `scope(exit)`, `extern(C)`, `pragma(msg`. */
const NOT_SYMBOL_AFTER: ReadonlySet<string> = new Set(["scope", "extern", "pragma", "version", "debug", "__traits",
    "align", "goto", "break", "continue"]);

/**
 * Whether the fallback may answer for the identifier at `start`: not a label after `goto`/`break`/`continue`, not an
 * attribute after `@`, not the first word inside `scope(...)`, `extern(...)`, `pragma(...)`, `version(...)`,
 * `debug(...)`, `__traits(...)`, `align(...)`, not a `version =`/`debug =` identifier. Those words are no symbol,
 * and a lookup could find one of the same name (`exit` in `scope(exit)` and core.stdc.stdlib's `exit`).
 */
function fallbackAllowed(t: Uint8Array, start: number): boolean {
    let p = start;
    while (p > 0 && (t[p - 1] === 0x20 || t[p - 1] === 0x09 || t[p - 1] === 0x0a || t[p - 1] === 0x0d))
        p--;
    const c = t[p - 1];
    if (c === 0x40)   // `@`
        return false;
    const before = c === 0x28 || c === 0x3d ? identBefore(t, p - 1) : identBefore(t, p);
    if (before < 0)
        return true;
    const word = utf8.decode(t.subarray(before, identEnd(t, before)));
    if (c === 0x28)   // `(`
        return !NOT_SYMBOL_AFTER.has(word);
    if (c === 0x3d)   // `=`
        return word !== "version" && word !== "debug";
    return word !== "goto" && word !== "break" && word !== "continue";
}

/**
 * Walks the code bytes of `t` from `p` (comments and literals, `nonCode`, skipped whole) and returns the first offset
 * where `stop` answers true for a code byte, or `t.length`.
 */
function scanCode(t: Uint8Array, nonCodeRanges: [number, number][], p: number,
    stop: (c: number, at: number) => boolean): number {
    let k = firstRangeFrom(nonCodeRanges, p);
    while (p < t.length) {
        if (k < nonCodeRanges.length && p >= nonCodeRanges[k]![0]) {
            p = Math.max(p, nonCodeRanges[k]![1]);
            k++;
            continue;
        }
        if (stop(t[p]!, p))
            return p;
        p++;
    }
    return t.length;
}

/** The index of the first range of `ranges` (sorted, disjoint) that ends after `p`. */
function firstRangeFrom(ranges: [number, number][], p: number): number {
    let lo = 0;
    let hi = ranges.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ranges[mid]![1] <= p)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}

// ── inactive ranges ──────────────────────────────────────────────────────────────────────────────────────────

/** The identifier or keyword starting at byte `p` of `t`, "" when none starts there. */
function wordAt(t: Uint8Array, p: number): string {
    const e = identEnd(t, p);
    return e > p ? utf8.decode(t.subarray(p, e)) : "";
}

/** After the `(` at `p`: the offset past its matching `)` (comments and literals skipped), or `t.length`. */
function pastParens(t: Uint8Array, nc: [number, number][], p: number): number {
    let depth = 0;
    const e = scanCode(t, nc, p, (c) => (c === 0x28 ? (depth++, false) : c === 0x29 ? --depth === 0 : false));
    return Math.min(e + 1, t.length);
}

/** At a `version`, `debug` or `static if` keyword at `p`: the offset after its condition, or -1 when it is none. */
function afterCondition(t: Uint8Array, nc: [number, number][], p: number): number {
    const w = wordAt(t, p);
    let q = skipTrivia(t, identEnd(t, p));
    if (w === "static") {
        if (wordAt(t, q) !== "if")
            return -1;
        q = skipTrivia(t, q + 2);
        return t[q] === 0x28 ? pastParens(t, nc, q) : -1;
    }
    if (w !== "version" && w !== "debug")
        return -1;
    if (t[q] === 0x28)
        return pastParens(t, nc, q);
    return w === "debug" && t[q] !== 0x3d ? q : -1;   // `debug stmt;`, not `debug = x;`; `version` needs `(`
}

/** The statements made of a parenthesised head and one statement (`scope` only when a `(` follows it). */
const HEADED: ReadonlySet<string> = new Set(["if", "while", "for", "foreach", "foreach_reverse", "with", "switch",
    "synchronized", "scope"]);

/** The words that continue a declaration after its `{ ... }` block: a function's contracts and body. */
const CONTRACT: ReadonlySet<string> = new Set(["in", "out", "do", "body"]);

/**
 * The end of the declaration or statement starting at `p` (trivia skipped first), on the text: a `{ ... }` block; a
 * `version`, `debug`, `static if` or `if` with its branch and an `else` that follows it (D binds an `else` to the
 * innermost one); a loop, `with`, `switch`, `synchronized`, `scope(...)` with its body; `do ... while (...);`; `try`
 * with its `catch` and `finally` parts; else up to its `;` at its own nesting level, or to the `}` of a block opened at
 * that level (an aggregate, a function, `static foreach`), past a function's contracts and past a `(`, `.`, `[` or `;`
 * that continues an expression after it (`() { ... }();`), or to the `}` that closes the enclosing block.
 */
function statementEnd(t: Uint8Array, nc: [number, number][], p: number): number {
    p = skipTrivia(t, p);
    if (t[p] === 0x7b) {
        let depth = 0;
        const e = scanCode(t, nc, p, (c) => (c === 0x7b ? (depth++, false) : c === 0x7d ? --depth === 0 : false));
        return Math.min(e + 1, t.length);
    }
    let w = wordAt(t, p);
    const q = afterCondition(t, nc, p);
    if (q >= 0)
        return withElse(t, nc, statementEnd(t, nc, q));
    let head = skipTrivia(t, p + w.length);
    const second = wordAt(t, head);
    if ((w === "final" && second === "switch")
        || (w === "static" && (second === "foreach" || second === "foreach_reverse"))) {
        w = second;
        head = skipTrivia(t, head + second.length);
    }
    if (HEADED.has(w) && (t[head] === 0x28 || w === "synchronized")) {
        const end = statementEnd(t, nc, t[head] === 0x28 ? pastParens(t, nc, head) : head);
        return w === "if" ? withElse(t, nc, end) : end;
    }
    if (w === "do") {
        const end = statementEnd(t, nc, head);
        let r = skipTrivia(t, end);
        if (wordAt(t, r) !== "while")
            return end;
        r = skipTrivia(t, r + 5);
        r = t[r] === 0x28 ? skipTrivia(t, pastParens(t, nc, r)) : r;
        return t[r] === 0x3b ? r + 1 : r;
    }
    if (w === "try") {
        let end = statementEnd(t, nc, head);
        for (;;) {
            const r = skipTrivia(t, end);
            const part = wordAt(t, r);
            if (part === "catch") {
                const h = skipTrivia(t, r + 5);
                end = statementEnd(t, nc, t[h] === 0x28 ? pastParens(t, nc, h) : h);
            } else if (part === "finally") {
                end = statementEnd(t, nc, r + 7);
            } else {
                return end;
            }
        }
    }
    if (attributeColon(t, nc, p)) {   // `private:` and the like: to the end of the enclosing block
        let depth = 0;
        return scanCode(t, nc, p, (c) => (c === 0x7b ? (depth++, false) : c === 0x7d ? --depth < 0 : false));
    }
    let depth = 0;
    let braced = false;
    let contract = false;
    for (;;) {
        const e = scanCode(t, nc, p, (c, at) => {
            if (c === 0x28 || c === 0x5b || c === 0x7b) {
                if (c === 0x7b && depth === 0) {
                    braced = true;
                    contract = opensContract(t, nc, at);
                }
                depth++;
                return false;
            }
            if (c === 0x29 || c === 0x5d || c === 0x7d)
                return --depth < 0 || (depth === 0 && c === 0x7d && braced);
            return c === 0x3b && depth === 0;
        });
        if (depth < 0 || e >= t.length)
            return e;
        if (t[e] === 0x3b)
            return e + 1;
        // a `}` closing a block opened at this level: what follows it says whether the statement goes on
        const n = skipTrivia(t, e + 1);
        if (t[n] === 0x3b)
            return n + 1;
        if (t[n] !== 0x28 && t[n] !== 0x2e && t[n] !== 0x5b && !(contract && CONTRACT.has(wordAt(t, n))))
            return e + 1;
        braced = false;
        p = n;
    }
}

/** Whether the `{` at `brace` opens a function's `in` or `out` contract (`in {`, `out (r) {`). */
function opensContract(t: Uint8Array, nc: [number, number][], brace: number): boolean {
    let q = prevCode(t, nc, brace);
    if (q >= 0 && t[q] === 0x29) {
        let depth = 0;
        for (; q >= 0; q = prevCode(t, nc, q)) {
            if (t[q] === 0x29)
                depth++;
            else if (t[q] === 0x28 && --depth === 0)
                break;
        }
        q = q >= 0 ? prevCode(t, nc, q) : -1;
    }
    const w = q >= 0 ? wordEndingAt(t, q) : "";
    return w === "in" || w === "out";
}

/** The attributes a `:` may follow to apply to the rest of a block (`private:`, `extern(C):`, `@safe:`). */
const COLON_ATTRIBUTES: ReadonlySet<string> = new Set(["private", "package", "protected", "public", "export", "extern",
    "final", "abstract", "override", "synchronized", "deprecated", "nothrow", "pure", "static", "const", "immutable",
    "shared", "inout", "scope", "__gshared", "align"]);

/** Whether the declaration at `p` is attributes (one at least, with their arguments) followed by a `:`. */
function attributeColon(t: Uint8Array, nc: [number, number][], p: number): boolean {
    let any = false;
    for (;;) {
        p = skipTrivia(t, p);
        if (t[p] === 0x40) {   // `@attr`, `@attr(...)`
            p = skipTrivia(t, identEnd(t, skipTrivia(t, p + 1)));
        } else {
            const w = wordAt(t, p);
            if (!COLON_ATTRIBUTES.has(w))
                return any && t[p] === 0x3a;
            p = skipTrivia(t, p + w.length);
        }
        if (t[p] === 0x28)
            p = pastParens(t, nc, p);
        any = true;
    }
}

/** After a statement ending at `end`: the end of the `else` branch that follows it, else `end`. */
function withElse(t: Uint8Array, nc: [number, number][], end: number): number {
    const r = skipTrivia(t, end);
    return wordAt(t, r) === "else" ? statementEnd(t, nc, r + 4) : end;
}

/**
 * The byte ranges of the branches of the conditional whose keyword is at `at`, on the text: the first one from after
 * its condition (for the `:` form, from after the `:` to the end of the enclosing block); the `else` one, when
 * `hasElse` (the analysed node's), from after the `else`. Null when no conditional starts at `at`.
 */
function conditionalBranches(t: Uint8Array, nc: [number, number][], at: number, hasElse: boolean):
    { then: [number, number]; else: [number, number] | null } | null {
    const q = afterCondition(t, nc, at);
    if (q < 0)
        return null;
    const s = skipTrivia(t, q);
    if (t[s] === 0x3a) {   // `version (X):`
        let depth = 0;
        const e = scanCode(t, nc, s + 1, (c) => (c === 0x7b ? (depth++, false) : c === 0x7d ? --depth < 0 : false));
        return { then: [s + 1, e], else: null };
    }
    const end = statementEnd(t, nc, q);
    const r = skipTrivia(t, end);
    if (!hasElse || wordAt(t, r) !== "else")
        return { then: [q, end], else: null };
    return { then: [q, end], else: [r + 4, statementEnd(t, nc, r + 4)] };
}

/**
 * The branches of the file's conditionals that no analysis chose (INACTIVE RANGES in the header), sorted and merged
 * into disjoint byte ranges, built once per index. A conditional's decisions are those of every analysed copy of it
 * (each template instance, each `static foreach` iteration): a branch is inactive when some copy decided and none
 * chose it. A conditional no analysis decided (in a template without instances, a function not analysed) has none.
 */
function inactiveOf(m: Module, ix: FileIndex): [number, number][] {
    if (ix.inactive !== null)
        return ix.inactive;
    hitsOf(m, ix);
    const byAt = new Map<number, { yes: boolean; no: boolean; hasElse: boolean }>();
    for (const d of ix.decided) {
        const k = byAt.get(d.at) ?? { yes: false, no: false, hasElse: d.hasElse };
        k.yes ||= d.inc === Include.yes;
        k.no ||= d.inc === Include.no;
        byAt.set(d.at, k);
    }
    const ranges: [number, number][] = [];
    for (const [at, k] of byAt) {
        if ((k.yes && k.no) || ix.undecided.some(([s, e]) => s <= at && at < e))
            continue;
        const b = conditionalBranches(ix.bytes, ix.nonCode, at, k.hasElse);
        if (b === null)
            continue;
        if (!k.yes)
            ranges.push(b.then);
        if (!k.no && b.else !== null)
            ranges.push(b.else);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of ranges.filter(([s, e]) => s < e)) {
        const last = merged[merged.length - 1];
        if (last !== undefined && r[0] <= last[1])
            last[1] = Math.max(last[1], r[1]);
        else
            merged.push([r[0], r[1]]);
    }
    ix.inactive = merged;
    return merged;
}

/** The ranges of the branches no analysis chose in one file: sorted, disjoint, outermost only. */
export interface InactiveRangesResult {
    ranges: QueryRange[];
}

/** The answer of `queryInactiveRanges`: the ranges, or a miss (the file is not in the last compile; `stale`). */
export type InactiveRangesAnswer = { result: InactiveRangesResult } | QueryMiss;

/**
 * The branches of the `version`, `debug` and `static if` declarations and statements of `file`, whose editor text is
 * `text`, that the last compile did not choose (INACTIVE RANGES in the header), from after the condition (or the
 * `else`) to the branch's end; read-only, between compiles (THE CONTRACT). Misses: the file is not in the last
 * compile; `stale` (STALE_REASON) when `text` is not the text that compile read. Cost: the file's index when no query
 * built it since the compile, then one scan of the text per conditional decided.
 */
export function queryInactiveRanges(file: string, text: string): InactiveRangesAnswer {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    const ix = indexOf(m);
    if (text !== ix.text)
        return miss(STALE_REASON, true);
    const t = ix.bytes;
    const ranges = inactiveOf(m, ix).map(([s, e]) => ({ start: positionOf(t, s), end: positionOf(t, e) }));
    return { result: { ranges } };
}

/**
 * The semantic tokens of `file`, whose editor text is `text`, from the last compile (THE CONTRACT in the header:
 * read-only, between compiles): every identifier outside comments and literals that names a symbol, with its type
 * and modifiers (SEMANTIC TOKENS in the header), in one pass over the file's index (built here when no query built it
 * since the compile). Misses: the file is not in the last compile; `stale` (STALE_REASON) when `text` is not the text
 * that compile read. Cost: see the header.
 */
export function querySemanticTokens(file: string, text: string): SemanticTokensAnswer {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    const ix = indexOf(m);
    if (text !== ix.text)
        return miss(STALE_REASON, true);
    const t = ix.bytes;
    const fileName = str(m.srcfile.toChars());
    const inactive = inactiveOf(m, ix);
    const out: number[] = [];
    let line = 0;
    let character = 0;   // UTF-16 units from the line's start to `p`
    let k = 0;           // the next comment or literal
    let ia = 0;          // the next inactive range
    for (let p = 0; p < t.length;) {
        const c = t[p]!;
        const inNonCode = k < ix.nonCode.length && p >= ix.nonCode[k]![0];
        if (inNonCode && p >= ix.nonCode[k]![1]) {
            k++;
            continue;
        }
        if (inNonCode || !isIdentStart(c) || isIdentByte(t[p - 1])) {
            if (c === 0x0a) {
                line++;
                character = 0;
            } else if ((c & 0xc0) !== 0x80) {
                character += c >= 0xf0 ? 2 : 1;
            }
            p++;
            continue;
        }
        const e = identEnd(t, p);
        let width = 0;
        for (let q = p; q < e; q++)
            if ((t[q]! & 0xc0) !== 0x80)
                width += t[q]! >= 0xf0 ? 2 : 1;
        const next = t[e];
        const prev = t[p - 1];
        // a string's prefix or postfix (`r"..."`, `"..."c`) is part of the literal
        const literalAffix = next === 0x22 || next === 0x60 || prev === 0x22 || prev === 0x60 || prev === 0x27;
        while (ia < inactive.length && inactive[ia]![1] <= p)
            ia++;
        if (!literalAffix && !KEYWORDS.has(utf8.decode(t.subarray(p, e)))) {
            const kind = tokenAt(m, ix, fileName, p, inactive[ia] ?? null);
            if (kind !== null)
                out.push(line, character, width, kind.type, kind.mods);
        }
        character += width;
        p = e;
    }
    return { result: { data: Uint32Array.from(out) } };
}

/**
 * The symbol a token names: the hit `choose` gives (the hover's) when named; when unnamed, the template parameter of
 * the hit's instance the token names (`T` stands for its argument), else the hit when a function, a template or an
 * instance (a call through an alias of another name, `msecs` for `dur!"msecs"`; a static `opCall` names its
 * aggregate, `UTC()`); else, outside the inactive branch (`inactive`, the first inactive range that ends after
 * `start`, null when none) and where `fallbackAllowed`, the fallback's, then a template parameter of the instance the
 * innermost function sits in. An unnamed hit of another kind is the value an analysis folded at the token, not what
 * the token names (`15.seconds` holds a `Duration` literal at `seconds`), and goes to the fallback.
 */
function tokenSymbol(m: Module, ix: FileIndex, start: number, inactive: [number, number] | null): Dsymbol | null {
    const t = ix.bytes;
    const hit = choose(m, ix, start)[0];
    if (hit !== undefined) {
        const s = hit.sym;
        if (hit.named)
            return s;
        const param = hit.inst !== null ? templateParameter(hit.inst, t, start) : null;
        if (param !== null)
            return param;
        const fd = s.isFuncDeclaration();
        const owner = fd !== null && fd.ident === Id.opCall ? fd.isMember2() : null;
        if (owner !== null)
            return owner;
        if (fd !== null || s.isTemplateDeclaration() !== null || s.isTemplateInstance() !== null
            || s.isOverloadSet() !== null)
            return s;
    }
    const inInactive = inactive !== null && inactive[0] <= start;
    if (inInactive || !fallbackAllowed(t, start))
        return null;
    return fallback(m, ix, start, 0) ?? templateParameter(scopeAt(m, ix, start), t, start);
}

/**
 * The template parameter the identifier at `start` names from `scope`: the argument table (templatesem.d `argsym`)
 * of the instance `scope` is or sits in, or of an enclosing one; else null. For the tokens only (SEMANTIC TOKENS in
 * the header): `lookupLexical` does not look there.
 */
function templateParameter(scope: Dsymbol | null, t: Uint8Array, start: number): Dsymbol | null {
    const id = Identifier.lookup(t.subarray(start, identEnd(t, start)));
    if (id === null)
        return null;
    for (let s = scope; s !== null; s = s.parent) {
        const found = s.isTemplateInstance()?.argsym?.symtab?.lookup(id) ?? null;
        if (found !== null)
            return found;
    }
    return null;
}

/**
 * The token at the identifier starting at `start` (`tokenSymbol`), with its kind and, when the token is its
 * declaration's name, `declaration`. Null when there is none, the legend has no type for it, or it is an alias of
 * object.d the grammar colours as a basic type.
 */
function tokenAt(m: Module, ix: FileIndex, fileName: string, start: number, inactive: [number, number] | null)
    : TokenKind | null {
    const sym = tokenSymbol(m, ix, start, inactive);
    if (sym === null)
        return null;
    const kind = tokenKind(sym);
    if (kind === null)
        return null;
    if ((kind.mods & TM_DEFAULT_LIBRARY) !== 0 && rootPackageOf(sym) === "object"
        && GRAMMAR_BASIC_TYPES.has(utf8.decode(ix.bytes.subarray(start, identEnd(ix.bytes, start)))))
        return null;
    return isDeclarationAt(m, ix, fileName, sym, start) ? { type: kind.type, mods: kind.mods | TM_DECLARATION } : kind;
}

// ── inlay hints ──────────────────────────────────────────────────────────────────────────────────────────────

/** One inlay hint: text an editor shows before the character at `position`, which it does not change. */
export interface InlayHint {
    position: QueryPosition;
    /**
     * `type`: an inferred declaration's type, `: T` after a variable's name, `-> T` after an `auto` function's
     * parameters; `parameter`: `name:` before a call's argument; `instances`: a template's instance count after its
     * name (INLAY HINTS in the header).
     */
    kind: "type" | "parameter" | "instances";
    label: string;
    /** Markdown: the hover's code block of the symbol the hint is about, or the template's first instances. */
    tooltip: string;
}

/** The inlay hints of a range of one file, sorted by position. */
export interface InlayHintsResult {
    hints: InlayHint[];
}

/** The answer of `queryInlayHints`: the hints, or a miss (the file is not in the last compile; `stale`). */
export type InlayHintsAnswer = { result: InlayHintsResult } | QueryMiss;

/** The widest type a hint's label shows (the tooltip has it whole), and how many types and instances it lists. */
const HINT_TYPE_WIDTH = 60;
const HINT_TYPES = 3;
const HINT_INSTANCES = 5;

/**
 * The storage classes a variable declared without a type starts with (`auto x`, `const x = 1`, `foreach (ref x; r)`);
 * any other word before a declared name is its type.
 */
const INFERRING: ReadonlySet<string> = new Set(["auto", "const", "immutable", "shared", "inout", "scope", "static",
    "enum", "ref", "__gshared"]);

/** The attributes a declaration may start with besides INFERRING's (`private auto x = 1, y = 2;`). */
const ATTRIBUTES: ReadonlySet<string> = new Set(["private", "package", "protected", "public", "export", "extern",
    "final", "abstract", "override", "synchronized", "deprecated", "nothrow", "pure", "align"]);

/** The index of the range of `ranges` (sorted, disjoint) holding byte `q`, or -1. */
function rangeHolding(ranges: [number, number][], q: number): number {
    const k = firstRangeFrom(ranges, q);
    return k < ranges.length && ranges[k]![0] <= q ? k : -1;
}

/** The offset of the last code byte before `p` (whitespace, comments and literals skipped), or -1. */
function prevCode(t: Uint8Array, nc: [number, number][], p: number): number {
    let q = p - 1;
    for (;;) {
        while (q >= 0 && (t[q] === 0x20 || t[q] === 0x09 || t[q] === 0x0a || t[q] === 0x0d))
            q--;
        if (q < 0)
            return -1;
        const k = rangeHolding(nc, q);
        if (k < 0)
            return q;
        q = nc[k]![0] - 1;
    }
}

/** The identifier or keyword whose last byte is at `e`, "" when none ends there. */
function wordEndingAt(t: Uint8Array, e: number): string {
    let s = e + 1;
    while (s > 0 && isIdentByte(t[s - 1]))
        s--;
    return s <= e && isIdentStart(t[s]) ? utf8.decode(t.subarray(s, e + 1)) : "";
}

/**
 * Whether the name at `start` is in the head of a `foreach` or `foreach_reverse` before its `;` (`foreach (i, x; r)`):
 * the first unbalanced `(` before it follows one of those words, with no `;`, `{` or `}` in between.
 */
function inForeachHead(t: Uint8Array, nc: [number, number][], start: number): boolean {
    let depth = 0;
    for (let q = prevCode(t, nc, start); q >= 0; q = prevCode(t, nc, q)) {
        const c = t[q];
        if (c === 0x29 || c === 0x5d) {
            depth++;
        } else if (c === 0x28 || c === 0x5b) {
            if (--depth < 0) {
                const w = c === 0x28 ? prevCode(t, nc, q) : -1;
                const word = w >= 0 ? wordEndingAt(t, w) : "";
                return word === "foreach" || word === "foreach_reverse";
            }
        } else if (c === 0x3b || c === 0x7b || c === 0x7d) {
            return false;
        }
    }
    return false;
}

/**
 * Whether the declaration that a `,` at `comma` continues declares its first name without a type (`auto a = 1, b =
 * 2;`): back to the declaration's start (a `;`, `{`, `}` or unbalanced `(` before it), then past its storage classes
 * and attributes (one of INFERRING's at least), a name followed by `=`.
 */
function declaresWithoutType(t: Uint8Array, nc: [number, number][], comma: number): boolean {
    let depth = 0;
    let p = 0;
    for (let q = prevCode(t, nc, comma); q >= 0; q = prevCode(t, nc, q)) {
        const c = t[q];
        if (c === 0x29 || c === 0x5d || (c === 0x7d && depth > 0)) {
            depth++;
        } else if (c === 0x28 || c === 0x5b || (c === 0x7b && depth > 0)) {
            depth--;
        }
        if (depth < 0 || (depth === 0 && (c === 0x3b || c === 0x7b || c === 0x7d))) {
            p = q + 1;
            break;
        }
    }
    let storage = false;
    for (;;) {
        p = skipTrivia(t, p);
        if (t[p] === 0x40) {   // `@attr`, `@attr(...)`
            p = skipTrivia(t, identEnd(t, skipTrivia(t, p + 1)));
            if (t[p] === 0x28)
                p = pastParens(t, nc, p);
            continue;
        }
        const w = wordAt(t, p);
        if (w === "")
            return false;
        const after = skipTrivia(t, p + w.length);
        if (!INFERRING.has(w) && !ATTRIBUTES.has(w))
            return storage && t[after] === 0x3d && t[after + 1] !== 0x3d;
        if (t[after] === 0x28) {   // `const(int)` is a type; `extern(C)` an attribute
            if (w !== "extern" && w !== "deprecated" && w !== "align")
                return false;
            p = pastParens(t, nc, after);
            continue;
        }
        storage ||= INFERRING.has(w);
        p = after;
    }
}

/**
 * Whether the variable named at `start` was declared without a type, on the text: the word before the name is one of
 * INFERRING's; or the name follows the `(` or a `,` of a `foreach` head; or a `,` of a declaration whose first name has
 * no type. A function parameter is one only in a `foreach` head (an `opApply` body's parameter), never a lambda's.
 */
function declaredWithoutType(t: Uint8Array, nc: [number, number][], start: number, parameter: boolean): boolean {
    const foreachHead = inForeachHead(t, nc, start);
    if (parameter && !foreachHead)
        return false;
    const q = prevCode(t, nc, start);
    if (q < 0)
        return false;
    const c = t[q];
    if (isIdentByte(c))
        return INFERRING.has(wordEndingAt(t, q));
    if (c === 0x28)
        return foreachHead;
    if (c === 0x2c)
        return foreachHead || declaresWithoutType(t, nc, q);
    return false;
}

/** After the name of a function at `start`: the offset past its last parameter list (a template's two), or -1. */
function afterParameters(t: Uint8Array, nc: [number, number][], start: number): number {
    let p = skipTrivia(t, identEnd(t, start));
    if (t[p] !== 0x28)
        return -1;
    p = pastParens(t, nc, p);
    const q = skipTrivia(t, p);
    return t[q] === 0x28 ? pastParens(t, nc, q) : p;
}

/**
 * At a `new` at `p`: the `(` of its arguments after a type written as identifiers (`new a.B!int(1)`), else -1 (an
 * array, a placement, an anonymous class).
 */
function newArguments(t: Uint8Array, p: number): number {
    if (wordAt(t, p) !== "new")
        return -1;
    p = skipTrivia(t, p + 3);
    while (isIdentStart(t[p])) {
        p = skipTrivia(t, identEnd(t, p));
        if (t[p] === 0x21 && t[p + 1] !== 0x3d) {   // `!`, not `!=`
            p = skipTrivia(t, p + 1);
            p = skipTrivia(t, t[p] === 0x28 ? skipBalanced(t, p, t.length) : identEnd(t, p));
        }
        if (t[p] !== 0x2e)
            break;
        p = skipTrivia(t, p + 1);
    }
    return t[p] === 0x28 ? p : -1;
}

/**
 * The start of each argument written between the `(` at `paren` and its `)`, comments and literals skipped, and the
 * offset of the `)`.
 */
function argumentsAt(t: Uint8Array, nc: [number, number][], paren: number): { starts: number[]; close: number } {
    const starts: number[] = [];
    let depth = 0;
    let from = paren + 1;
    const push = (to: number): void => {
        const s = skipTrivia(t, from);
        if (s < to)
            starts.push(s);
    };
    const close = scanCode(t, nc, paren, (c, at) => {
        if (c === 0x28 || c === 0x5b || c === 0x7b) {
            depth++;
        } else if (c === 0x29 || c === 0x5d || c === 0x7d) {
            if (--depth === 0)
                push(at);
            return depth <= 0;
        } else if (c === 0x2c && depth === 1) {
            push(at);
            from = at + 1;
        }
        return false;
    });
    return { starts, close };
}

/**
 * The parameter names of `tf` as its arguments map to them: a tuple parameter's expansion and a parameter without a
 * name of its own (`_param_0`, a compiler's `__` name) give null. The raw list, with no `toBasetype` (it may run
 * semantic on an enum type): an analysed call's function type has its tuples expanded already.
 */
function parameterNames(tf: TypeFunction): (string | null)[] {
    const names: (string | null)[] = [];
    for (const p of tf.parameterList.parameters ?? []) {
        if (p === null)
            continue;
        const tt = p.type?.isTypeTuple() ?? null;
        if (tt !== null) {
            for (let i = 0; i < (tt.arguments?.length ?? 0); i++)
                names.push(null);
            continue;
        }
        const n = identText(p.ident);
        names.push(n === "" || n.startsWith("__") || n.startsWith("_param_") ? null : n);
    }
    return names;
}

/**
 * The distinct printed `types`, less those an error made (`_error_`, alone or inside another type): a declaration
 * whose initializer has an error gets no hint, its diagnostic says it.
 */
function typesOf(types: readonly Type[]): string[] {
    return [...new Set(types.map((x) => str(x.toChars())))].filter((x) => !x.includes("_error_"));
}

/** A type for a hint's label, or an expansion's title: cut at HINT_TYPE_WIDTH characters. */
function clip(type: string): string {
    return type.length > HINT_TYPE_WIDTH ? `${type.slice(0, HINT_TYPE_WIDTH - 1)}…` : type;
}

/** `types` (distinct, at least one) as a label: HINT_TYPES of them, ` | ` between. */
function typesLabel(types: readonly string[]): string {
    const shown = types.slice(0, HINT_TYPES).map(clip).join(" | ");
    return types.length > HINT_TYPES ? `${shown} | …` : shown;
}

function codeBlock(lines: readonly string[]): string {
    return "```d\n" + lines.join("\n") + "\n```";
}

/** The byte offset of `pos` in `t`, a position past its line's end or past the text clamped to the end. */
function clampedOffset(t: Uint8Array, pos: QueryPosition): number {
    const starts = lineStarts(t);
    if (pos.line >= starts.length)
        return t.length;
    return byteOffset(t, pos.line, pos.character)
        ?? (pos.line + 1 < starts.length ? starts[pos.line + 1]! - 1 : t.length);
}

/**
 * The inlay hints of `range` of `file`, whose editor text is `text`, from the last compile (INLAY HINTS in the header):
 * read-only, between compiles (THE CONTRACT). Misses: the file is not in the last compile; `stale` (STALE_REASON) when
 * `text` is not the text that compile read. Cost: the file's index when no query built it since the compile, then one
 * look at each declaration and call of the range, the printing of its types and signatures.
 */
export function queryInlayHints(file: string, text: string, range: QueryRange): InlayHintsAnswer {
    return printing(() => inlayHints(file, text, range));
}

function inlayHints(file: string, text: string, range: QueryRange): InlayHintsAnswer {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    const ix = indexOf(m);
    if (text !== ix.text)
        return miss(STALE_REASON, true);
    const hits = hitsOf(m, ix);
    const t = ix.bytes;
    const nc = ix.nonCode;
    const fileName = str(m.srcfile.toChars());
    const lo = clampedOffset(t, range.start);
    const hi = clampedOffset(t, range.end);
    const out: { at: number; hint: Omit<InlayHint, "position"> }[] = [];

    for (const [start, list] of hits) {
        if (start < lo || start >= hi)
            continue;
        const vars: VarDeclaration[] = [];
        const funcs: FuncDeclaration[] = [];
        const templates: TemplateDeclaration[] = [];
        for (const h of list) {
            const s = h.sym;
            if (!h.named || isCompilerName(s))
                continue;
            const v = s.isVarDeclaration();
            const fd = s.isFuncDeclaration();
            const td = s.isTemplateDeclaration();
            if ((v === null && fd === null && td === null) || !isDeclarationAt(m, ix, fileName, s, start))
                continue;
            if (v !== null && v.isEnumMember() === null && v.type !== null)
                vars.push(v);
            else if (fd !== null && fd.inferRetType && (fd.type?.isTypeFunction()?.next ?? null) !== null)
                funcs.push(fd);
            else if (td !== null)
                templates.push(td);
        }
        const vtypes = typesOf(vars.map((v) => v.type!));
        if (vtypes.length !== 0 && declaredWithoutType(t, nc, start, vars[0]!.isParameter())) {
            out.push({ at: identEnd(t, start), hint: { kind: "type", label: `: ${typesLabel(vtypes)}`,
                tooltip: codeBlock([...new Set(vars.map(signatureOf))]) } });
        }
        const ftypes = typesOf(funcs.map((f) => f.type!.isTypeFunction()!.next!));
        const after = ftypes.length !== 0 ? afterParameters(t, nc, start) : -1;
        if (after >= 0) {
            out.push({ at: after, hint: { kind: "type", label: `-> ${typesLabel(ftypes)}`,
                tooltip: codeBlock([...new Set(funcs.map(signatureOf))]) } });
        }
        const instances = templates.flatMap((td) => instancesOf(td));
        if (instances.length !== 0) {
            const n = instances.length;
            const names = instances.slice(0, HINT_INSTANCES).map((ti) => `\`${str(ti.toChars())}\``).join(", ");
            out.push({ at: identEnd(t, start), hint: { kind: "instances",
                label: `${n} instance${n === 1 ? "" : "s"}`,
                tooltip: `Instances: ${names}${n > HINT_INSTANCES ? `, and ${n - HINT_INSTANCES} more` : ""}.` } });
        }
    }

    const seen = new Set<number>();
    for (const call of ix.calls) {
        // a call that starts before the range may have arguments in it
        if (call.paren >= hi || seen.has(call.paren))
            continue;
        seen.add(call.paren);
        const fd = call.fd;
        const tf = fd.type?.isTypeFunction() ?? null;
        if (tf === null || (isCompilerName(fd) && fd.ident !== Id.ctor))
            continue;
        const names = parameterNames(tf);
        const typesafe = tf.parameterList.varargs === VarArg.typesafe;
        const { starts, close } = argumentsAt(t, nc, call.paren);
        if (starts.length === 0 || close < lo)
            continue;
        /** The written argument whose text holds byte `off`, or -1. */
        const writtenAt = (off: number): number => {
            if (off < starts[0]! || off >= close)
                return -1;
            let i = starts.length - 1;
            while (off < starts[i]!)
                i--;
            return i;
        };
        let tooltip: string | null = null;
        for (let i = 0; i < starts.length; i++) {
            const a = starts[i]!;
            const word = wordAt(t, a);
            if (word !== "" && t[skipTrivia(t, a + word.length)] === 0x3a)
                break;   // a named argument: the ones after it need not follow the parameters' order
            const k = i + (call.ufcs ? 1 : 0);
            if (k >= names.length)
                break;   // a variadic function's arguments past its last parameter (a typesafe one's: its first)
            // the analysed argument k must come from this written one alone: a tuple written as one argument
            // (`t.expand`, `args`) expands to several, and the parameters no longer follow the text; the typesafe
            // variadic parameter's arguments are packed into one array
            if (!(typesafe && k === names.length - 1)
                && (writtenAt(call.args[k] ?? -1) !== i || writtenAt(call.args[k + 1] ?? -1) === i))
                break;
            const name = names[k];
            if (name === null || a < lo || a >= hi)
                continue;
            const next = t[skipTrivia(t, a + word.length)];
            if (word === name && (next === 0x2c || next === 0x29))
                continue;   // the argument is the parameter's name already
            tooltip ??= codeBlock([signatureOf(fd)]);
            out.push({ at: a, hint: { kind: "parameter", label: `${name}:`, tooltip } });
        }
    }

    out.sort((x, y) => x.at - y.at);
    return { result: { hints: out.map(({ at, hint }) => ({ position: positionOf(t, at), ...hint })) } };
}

// ── expansions ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a peek shows: a string mixin's parsed code, a template instance's instantiated declaration, a folded value. */
export type ExpansionKind = "mixin" | "instance" | "value";

/** A construct whose expansion a peek shows (EXPANSIONS in the header). */
export interface ExpansionSite {
    kind: ExpansionKind;
    /**
     * The construct in the text: `mixin(...)` from the keyword to its `)`, an instance's `Foo!(args)` / `Foo!arg`
     * (a template mixin's too), the folded expression (an enum initializer, a `static if` condition, a template value
     * argument).
     */
    range: QueryRange;
    /** One line for a code lens label: `mixin: 2 declarations`, `Foo!(int, 3)`, `mixin Foo!int`, `= 42`. */
    title: string;
}

/** A peek: the site at a position, and what it expands to. */
export interface ExpansionResult extends ExpansionSite {
    /**
     * D source as hdrgen prints it, ending with "\n": a mixin's parsed declarations or statements, an instance's
     * instantiated declaration as -vcg-ast prints it, a value.
     */
    text: string;
    /** How many analysed copies answer at the position (in a template's code); the first one is shown. 1 otherwise. */
    instances: number;
}

/** The answer of `queryExpansion`: the peek, or a miss (not in the last compile; `stale`; no site at the position). */
export type ExpansionAnswer = { result: ExpansionResult } | QueryMiss;

/** The expansion sites of one file: sorted by range start, no two overlapping (of nested ones, the outermost). */
export interface ExpansionSitesResult {
    sites: ExpansionSite[];
}

/** The answer of `queryExpansionSites`: the sites, or a miss (the file is not in the last compile; `stale`). */
export type ExpansionSitesAnswer = { result: ExpansionSitesResult } | QueryMiss;

/** One analysed copy of an expansion: its lens title and its text, printed when asked. */
interface ExpansionCopy {
    title: () => string;
    text: () => string;
}

/** An expansion of the file: its kind, its byte range, its analysed copies (one, or one per instance). */
interface Expansion {
    kind: ExpansionKind;
    start: number;
    end: number;
    copies: ExpansionCopy[];
}

/** `list` grouped by `key`, in first-seen order. */
function groupBy<T, K>(list: readonly T[], key: (x: T) => K): Map<K, T[]> {
    const groups = new Map<K, T[]>();
    for (const x of list) {
        const k = key(x);
        const g = groups.get(k);
        if (g === undefined)
            groups.set(k, [x]);
        else
            g.push(x);
    }
    return groups;
}

/** `d` printed by hdrgen with four-space indents, as a header prints it. */
function dsymbolText(d: Dsymbol): string {
    const buf = new OutBuffer();
    buf.doindent = true;
    buf.spaces = true;
    dsymbolToCBuffer(d, buf, new HdrGenState());
    return str(buf.extractSlice());
}

/** `ti` printed by hdrgen as `-vcg-ast` prints it (`dumping`), four-space indents. */
function instanceText(ti: TemplateInstance): string {
    const buf = new OutBuffer();
    buf.doindent = true;
    buf.spaces = true;
    dumping((hgs) => dsymbolToCBuffer(ti, buf, hgs), (s, _into, print) => withContext([s], print));
    return str(buf.extractSlice());
}

/**
 * Runs `print` with the HdrGenState of `-vcg-ast` (`fullDump` and `vcg_ast`: `dumpTemplateInstance` prints an
 * instance's members), with an instance met again inside its own dump printed by name only. hdrgen's dump has no such
 * guard: `alias Self = Traits!T;` in `template Traits(T)` (runnable/template9.d) recurses until the stack ends, so the
 * guard changes no text that ends. It runs in hdrgen's print hook (`registerDsymbolPrintHook`), around each symbol's
 * print, for this call only (removed in `finally`, as `printing` swaps the `optimize` slot): a dump of an instance
 * already open runs with `fullDump` off, so its name and arguments print and its members do not. `around`, when given,
 * runs around each symbol's print outside the guard (the AST view's ranges).
 */
function dumping(print: (hgs: HdrGenState) => void, around: DsymbolPrintHook | null = null): void {
    const hgs = new HdrGenState();
    hgs.fullDump = true;
    hgs.vcg_ast = true;
    const open = new Set<TemplateInstance>();
    let named = 0;   // the depth of the printing by name only
    const guarded = (s: Dsymbol, run: () => void): void => {
        const ti = s.isTemplateInstance();
        if (ti === null || ti.isTemplateMixin() !== null) {
            run();      // a template mixin's members print where it is mixed in, not in a dump of its own
            return;
        }
        if (named === 0 && !open.has(ti)) {
            open.add(ti);
            try {
                run();
            } finally {
                open.delete(ti);
            }
            return;
        }
        named++;
        hgs.fullDump = false;
        try {
            run();
        } finally {
            hgs.fullDump = --named === 0;
        }
    };
    registerDsymbolPrintHook(around === null ? (s, _buf, run) => guarded(s, run)
        : (s, buf, run) => around(s, buf, () => guarded(s, run)));
    try {
        print(hgs);
    } finally {
        registerDsymbolPrintHook(null);
    }
}

/** hdrgen's print hook (`registerDsymbolPrintHook`): runs `print`, which prints `s` into `buf`, once. */
type DsymbolPrintHook = (s: Dsymbol, buf: OutBuffer, print: () => void) => void;

/** `s` printed by hdrgen with four-space indents from `level`. */
function statementText(s: Statement, level = 0): string {
    const buf = new OutBuffer();
    buf.doindent = true;
    buf.spaces = true;
    buf.level = level;
    statementToCBuffer(s, buf, new HdrGenState());
    return str(buf.extractSlice());
}

function exprText(e: Expression): string {
    return str(expressionToChars(e));
}

/** `n` and a noun, plural when not one: `2 statements`. */
function counted(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The text without its whitespace, a leading `cast(T)`, a number's suffix and digit separators: a value is a site
 * only where it differs from the source so (`enum ubyte v = 1_000;` holds `cast(ubyte)1000u`, `2.5f` prints `2.5F`).
 */
function squeezed(s: string): string {
    return s.replace(/\s+/g, "").replace(/^(cast\([^()]*\))+/, "").replace(/([\d.])[uUlLfFi]+$/, "$1")
        .replace(/(\d)_+(?=\d)/g, "$1");
}

/** A number literal's text alone (`0xFF`, `2.5f`, `1_000`), or `true`, `false`, `null`. */
const SCALAR = new RegExp(String.raw`^(?:[-+]?(?:0[xX][\da-fA-F_.pP+-]*|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?`
    + String.raw`(?:[eE][-+]?[\d_]+)?)[uUlLfFi]*|true|false|null)$`);

/**
 * Whether the folded value written at bytes [start, end) of `t` is an expansion site: when some copy's value differs
 * from the source (`squeezed`) and the source is not a literal, whose value is itself (`0xFF` holds 255, `static if
 * (true)`, a string alone).
 */
function folded(t: Uint8Array, nc: [number, number][], start: number, end: number, values: readonly string[]): boolean {
    const source = utf8.decode(t.subarray(start, end));
    const k = rangeHolding(nc, start);
    const literal = SCALAR.test(source) || (k >= 0 && nc[k]![0] === start && identEnd(t, nc[k]![1]) >= end);
    return !literal && values.some((v) => squeezed(v) !== squeezed(source));
}

/** The end of the code before `e`: back over whitespace and comments, not over literals (`"a" ~ "b"` keeps `"b"`). */
function codeEnd(t: Uint8Array, nc: [number, number][], e: number): number {
    for (;;) {
        while (e > 0 && (t[e - 1] === 0x20 || t[e - 1] === 0x09 || t[e - 1] === 0x0a || t[e - 1] === 0x0d))
            e--;
        const k = rangeHolding(nc, e - 1);
        if (k < 0 || t[nc[k]![0]] !== 0x2f)   // not in a comment
            return e;
        e = nc[k]![0];
    }
}

/** The end of the number literal at `p`: digits, letters (hex, suffixes), `_`, a `.` before a digit, an exponent. */
function numberEnd(t: Uint8Array, p: number): number {
    let e = p;
    const hex = t[p] === 0x30 && (t[p + 1] === 0x78 || t[p + 1] === 0x58);
    for (;;) {
        const c = t[e];
        const prev = t[e - 1];
        const exponent = hex ? prev === 0x70 || prev === 0x50 : prev === 0x65 || prev === 0x45;
        if (isIdentByte(c) || (c === 0x2e && t[e + 1]! >= 0x30 && t[e + 1]! <= 0x39)
            || ((c === 0x2b || c === 0x2d) && exponent))
            e++;
        else
            return e;
    }
}

/** At the `mixin` keyword at `at`: the offset past the `)` of its arguments, or -1 when no `(` follows. */
function mixinEnd(t: Uint8Array, nc: [number, number][], at: number): number {
    const q = skipTrivia(t, at + 5);
    return t[q] === 0x28 ? pastParens(t, nc, q) : -1;
}

/**
 * The offsets of the `mixin (` keywords that start a statement on line `line` (from 0) of `t`, outside comments and
 * literals: after a `;`, `{`, `}`, `)` or `:` (`static foreach (...) mixin(...)`, a label), `else`, `do`, or nothing;
 * not an expression's (`int x = mixin("2");`).
 */
function mixinKeywords(t: Uint8Array, nc: [number, number][], line: number): number[] {
    const starts = lineStarts(t);
    if (line < 0 || line >= starts.length)
        return [];
    const end = line + 1 < starts.length ? starts[line + 1]! : t.length;
    const found: number[] = [];
    for (let p = starts[line]!; p < end; p++) {
        if (!isIdentStart(t[p]) || isIdentByte(t[p - 1]) || wordAt(t, p) !== "mixin" || rangeHolding(nc, p) >= 0
            || t[skipTrivia(t, p + 5)] !== 0x28)
            continue;
        const q = prevCode(t, nc, p);
        const c = t[q];
        if (q < 0 || c === 0x3b || c === 0x7b || c === 0x7d || c === 0x29 || c === 0x3a
            || wordEndingAt(t, q) === "else" || wordEndingAt(t, q) === "do")
            found.push(p);
    }
    return found;
}

/**
 * The bytes between the delimiters of the one literal a `mixin (` at `at` takes as its whole argument (`"..."`,
 * `r"..."`, `` `...` ``, `q{...}`), and whether it is a `"..."`, whose escape sequences the lexer decodes; else null
 * (another argument, or a delimited or hex string).
 */
function mixinArgument(t: Uint8Array, nc: [number, number][], at: number):
    { start: number; end: number; escapes: boolean } | null {
    const p = skipTrivia(t, skipTrivia(t, at + 5) + 1);
    const k = rangeHolding(nc, p);
    if (k < 0 || nc[k]![0] !== p || t[skipTrivia(t, nc[k]![1])] !== 0x29)
        return null;
    const end = nc[k]![1] - 1;
    if (t[p] === 0x60 || t[p] === 0x22)
        return { start: p + 1, end, escapes: t[p] === 0x22 };
    if ((t[p] === 0x72 && t[p + 1] === 0x22) || (t[p] === 0x71 && t[p + 1] === 0x7b))
        return { start: p + 2, end, escapes: false };
    return null;
}

/**
 * The string a `mixin (` at `at` mixes in when its argument is one literal alone (`mixin("s += 1;")`), as the parser
 * read it (simple escapes decoded); else null.
 */
function mixinLiteral(t: Uint8Array, nc: [number, number][], at: number): string | null {
    const a = mixinArgument(t, nc, at);
    if (a === null)
        return null;
    const raw = utf8.decode(t.subarray(a.start, a.end));
    if (!a.escapes)
        return raw;
    try {
        return JSON.parse(`"${raw}"`) as string;
    } catch {
        return null;
    }
}

/** After the `!` at `bang`: the end of the template arguments, `(...)` or one token (`Foo!int`, `Foo!"x"`). */
function argumentsEnd(t: Uint8Array, nc: [number, number][], bang: number): number {
    const p = skipTrivia(t, bang + 1);
    if (t[p] === 0x28)
        return pastParens(t, nc, p);
    const k = rangeHolding(nc, p);
    if (k >= 0 && nc[k]![0] === p)
        return nc[k]![1];
    return isIdentStart(t[p]) ? identEnd(t, p) : numberEnd(t, p);
}

/** The byte ranges of the template arguments written after the `!` at `bang`, trailing trivia left out. */
function writtenArguments(t: Uint8Array, nc: [number, number][], bang: number): [number, number][] {
    const p = skipTrivia(t, bang + 1);
    if (t[p] !== 0x28)
        return [[p, argumentsEnd(t, nc, bang)]];
    const { starts, close } = argumentsAt(t, nc, p);
    return starts.map((s, i) => {
        const next = i + 1 < starts.length ? prevCode(t, nc, starts[i + 1]!) : close;   // the `,` or the `)`
        return [s, codeEnd(t, nc, next)];
    });
}

/**
 * The byte range of the initializer written after the name at `start` (`enum x = <init>;`, `a = <init>,` in an enum):
 * from after the `=` to the `,`, `;` or closing bracket that ends it, trailing trivia left out; null without a `=`.
 */
function initializerRange(t: Uint8Array, nc: [number, number][], start: number): [number, number] | null {
    const eq = skipTrivia(t, identEnd(t, start));
    if (t[eq] !== 0x3d || t[eq + 1] === 0x3d)
        return null;
    const s = skipTrivia(t, eq + 1);
    let depth = 0;
    const e = scanCode(t, nc, s, (c) => {
        if (c === 0x28 || c === 0x5b || c === 0x7b)
            depth++;
        else if (c === 0x29 || c === 0x5d || c === 0x7d)
            return --depth < 0;
        return depth === 0 && (c === 0x2c || c === 0x3b);
    });
    const end = codeEnd(t, nc, e);
    return end > s ? [s, end] : null;
}

/** The literal kinds a folded value prints as: a template value argument is a site only when it is one. */
function isLiteral(e: Expression): boolean {
    return (e.isIntegerExp() ?? e.isRealExp() ?? e.isComplexExp() ?? e.isStringExp() ?? e.isNullExp()
        ?? e.isArrayLiteralExp() ?? e.isAssocArrayLiteralExp() ?? e.isStructLiteralExp()) !== null;
}

/** A folded value as the copy of an expansion. */
function valueCopy(value: string): ExpansionCopy {
    return { title: () => clip(`= ${value.replace(/\s+/g, " ")}`), text: () => `${value}\n` };
}

/** A template instance as the copy of an expansion: printed as -vcg-ast prints it; a template mixin's title says so. */
function instanceCopy(ti: TemplateInstance): ExpansionCopy {
    const mixin = ti.isTemplateMixin() !== null;
    return { title: () => clip(`${mixin ? "mixin " : ""}${str(ti.toChars())}`), text: () => instanceText(ti) };
}

/**
 * The value a manifest constant or an enum member holds after the analysis, or null when an error made it. A member's
 * value prints as its enum's declaration prints it (`hgs.inEnumDecl`: `cast(E)4`, not the member's own name), less
 * the cast to its own enum.
 */
function valueOf(v: VarDeclaration): string | null {
    const em = v.isEnumMember();
    let value: string | null = null;
    const member = em !== null ? memberValue(em) : null;
    if (em !== null && member !== null) {
        const hgs = new HdrGenState();
        hgs.inEnumDecl = em.ed;
        const buf = new OutBuffer();
        expToCBuffer(member, buf, hgs);
        const own = em.ed !== null ? `cast(${str(em.ed.toChars())})` : "";
        value = str(buf.extractSlice());
        value = own !== "" && value.startsWith(own) ? value.slice(own.length) : value;
    } else if (em === null && v._init !== null) {
        value = str(initializerToChars(v._init));
    }
    return value === null || value.trim() === "" || value.includes("__error") ? null : value;
}

/** The template instance `sym` is, or is a member of, whose name is `name`; else null (`outermost` of a nest). */
function instanceNamed(sym: Dsymbol, name: string): TemplateInstance | null {
    for (let s: Dsymbol | null = sym; s !== null && s.isModule() === null; s = s.parent) {
        const ti = s.isTemplateInstance();
        if (ti !== null && identText(ti.name) === name)
            return outermost(ti);
    }
    return null;
}

/**
 * Of nested eponymous instances, the outermost: `to!string` for the `to!uint` it holds (`T to(A...)(A args)` in
 * `template to(T)`), the one written. The inner template is declared in the outer instance (`tempdecl.parent`); the
 * inner instance's own parent is that instance, or, with a local alias argument (`apply!(x => x + k)`), the function
 * the argument lives in.
 */
function outermost(ti: TemplateInstance): TemplateInstance {
    const outerOf = (x: TemplateInstance): TemplateInstance | null =>
        x.tempdecl?.parent?.isTemplateInstance() ?? x.parent?.isTemplateInstance() ?? null;
    let outer = outerOf(ti);
    while (outer !== null && outer.name === ti.name) {
        ti = outer;
        outer = outerOf(ti);
    }
    return ti;
}

/**
 * The instances of every module (`instancesOf`'s, not speculative, not mixins) made at a location in `file`, by byte
 * offset: an instance's location is where it was first written (`Twice!3`, which the analysis folded to its value and
 * left no node for).
 */
function instancesWrittenIn(file: string, size: number): Map<number, TemplateInstance[]> {
    const at = new Map<number, TemplateInstance[]>();
    const mine = new Map<DString, boolean>();
    for (const list of instanceTable().values()) {
        for (const ti of list) {
            const name = ti.loc.filename();
            if (name === null)
                continue;
            let ok = mine.get(name);
            if (ok === undefined) {
                ok = str(name) === file;
                mine.set(name, ok);
            }
            const off = ti.loc.fileOffset();
            if (ok && off < size)
                at.set(off, [...(at.get(off) ?? []), ti]);
        }
    }
    return at;
}

/**
 * The expansions of the file (EXPANSIONS in the header), nested ones included, sorted by start and, at one start, the
 * outermost first; built once per index from the walk's notes.
 */
function expansionsOf(m: Module, ix: FileIndex): Expansion[] {
    if (ix.expansions !== null)
        return ix.expansions;
    const hits = hitsOf(m, ix);
    const notes = ix.notes!;
    const t = ix.bytes;
    const nc = ix.nonCode;
    const out: Expansion[] = [];

    // string mixins: the declarations, at their keyword; the statements, matched to the keywords of their line
    const mixinAt = new Set<number>();
    for (const [at, list] of groupBy(notes.mixins, (x) => x.at)) {
        const end = mixinEnd(t, nc, at);
        if (end < 0)
            continue;
        mixinAt.add(at);
        out.push({ kind: "mixin", start: at, end, copies: list.map((x) => ({
            title: () => `mixin: ${counted(x.decl.length, "declaration")}`,
            text: () => x.decl.map(dsymbolText).join("") })) });
    }
    for (const [line, runs] of groupBy(notes.runs, (r) => r.line)) {
        const byKeyword = matchMixins(t, nc, mixinKeywords(t, nc, line - 1).filter((k) => !mixinAt.has(k)), runs);
        for (const [at, list] of byKeyword) {
            out.push({ kind: "mixin", start: at, end: mixinEnd(t, nc, at), copies: list.map((r) => ({
                title: () => `mixin: ${counted(r.statements.length, "statement")}`,
                text: () => r.statements.map((s) => statementText(s)).join("") })) });
        }
    }

    // template mixins, at their template's name
    const instanceAt = new Set<number>();
    for (const [at, list] of groupBy(notes.templateMixins, (x) => x.at)) {
        const bang = skipTrivia(t, identEnd(t, at));
        if (t[bang] !== 0x21)
            continue;
        instanceAt.add(at);
        const tms = [...new Set(list.map((x) => x.tm))];
        out.push({ kind: "instance", start: at, end: argumentsEnd(t, nc, bang), copies: tms.map(instanceCopy) });
    }

    // instances written with `!`, found through the hits at the name (the instance or a member of it), else through
    // the instances made at that location; their value arguments that the analysis folded
    let written: Map<number, TemplateInstance[]> | null = null;
    let k = 0;
    for (let p = 0; p < t.length;) {
        if (k < nc.length && p >= nc[k]![0]) {
            p = Math.max(p, nc[k++]![1]);
            continue;
        }
        if (!isIdentStart(t[p]) || isIdentByte(t[p - 1])) {
            p++;
            continue;
        }
        const e = identEnd(t, p);
        const bang = skipTrivia(t, e);
        const after = wordAt(t, skipTrivia(t, bang + 1));
        const word = utf8.decode(t.subarray(p, e));
        if (t[bang] !== 0x21 || t[bang + 1] === 0x3d || after === "is" || after === "in" || instanceAt.has(p)
            || KEYWORDS.has(word)) {
            p = e;
            continue;
        }
        const tis = new Set<TemplateInstance>();
        for (const h of hits.get(p) ?? []) {
            const ti = instanceNamed(h.sym, word);
            if (ti !== null && ti.isTemplateMixin() === null)
                tis.add(ti.inst ?? ti);
        }
        if (tis.size === 0) {
            written ??= instancesWrittenIn(str(m.srcfile.toChars()), t.length);
            for (const ti of written.get(p) ?? [])
                tis.add(ti);
        }
        if (tis.size !== 0) {
            const list = [...tis];
            out.push({ kind: "instance", start: p, end: argumentsEnd(t, nc, bang), copies: list.map(instanceCopy) });
            const args = writtenArguments(t, nc, bang);
            args.forEach(([s, end], i) => {
                const values: string[] = [];
                for (const ti of list) {
                    const o = ti.tiargs !== null && ti.tiargs.length === args.length ? ti.tiargs.opIndex(i) : null;
                    const v = o !== null && o.dyncast() === DYNCAST.expression && isLiteral(o as Expression)
                        ? exprText(o as Expression) : "";
                    if (v.trim() !== "")
                        values.push(v);
                }
                if (folded(t, nc, s, end, values))
                    out.push({ kind: "value", start: s, end, copies: values.map(valueCopy) });
            });
        }
        p = e;
    }

    // folded values: manifest constants and enum members, `static if` conditions
    for (const [at, list] of groupBy(notes.manifests, (x) => x.at)) {
        const r = initializerRange(t, nc, at);
        if (r === null)
            continue;
        const values = list.map((x) => valueOf(x.sym)).filter((v) => v !== null);
        if (folded(t, nc, r[0], r[1], values))
            out.push({ kind: "value", start: r[0], end: r[1], copies: values.map(valueCopy) });
    }
    for (const [at, list] of groupBy(ix.decided.filter((d) => wordAt(t, d.at) === "static"), (d) => d.at)) {
        const open = skipTrivia(t, skipTrivia(t, at + 6) + 2);   // `static`, `if`, then `(`
        if (t[open] !== 0x28)
            continue;
        const start = skipTrivia(t, open + 1);
        const end = codeEnd(t, nc, pastParens(t, nc, open) - 1);
        const values = list.map((d) => (d.inc === Include.yes ? "true" : "false"));
        if (folded(t, nc, start, end, values))
            out.push({ kind: "value", start, end, copies: values.map(valueCopy) });
    }

    out.sort((a, b) => a.start - b.start || b.end - a.end);
    ix.expansions = out;
    return out;
}

/**
 * The mixin statements of one line matched to their `mixin (` keywords (`keywords`, in text order). A keyword whose
 * argument is one string literal takes the runs that parsed that string; the others take the remaining runs in
 * parse order (`MixinRun.index`), one each in turn per analysed copy (`static foreach` parses the line's mixins once
 * per iteration), when the counts divide; one keyword left takes them all.
 */
function matchMixins(t: Uint8Array, nc: [number, number][], keywords: readonly number[], runs: readonly MixinRun[]):
    Map<number, MixinRun[]> {
    const byKeyword = new Map<number, MixinRun[]>();
    const take = (at: number, r: MixinRun): void => {
        byKeyword.set(at, [...(byKeyword.get(at) ?? []), r]);
    };
    const source = (r: MixinRun): string => str(r.statements[0]!.loc.toSourceLoc().fileContent);
    const texts = keywords.map((k) => mixinLiteral(t, nc, k));
    // a literal two keywords share does not tell them apart: those go by parse order
    const literal = new Map(keywords.map((k, i) => [k, texts.indexOf(texts[i]!) === texts.lastIndexOf(texts[i]!)
        ? texts[i]! : null]));
    const literals = new Set([...literal.values()].filter((v) => v !== null));
    const rest = keywords.filter((k) => literal.get(k) === null);
    const left: MixinRun[] = [];
    for (const r of runs) {
        const text = literals.size !== 0 ? source(r) : null;
        const at = text !== null && literals.has(text) ? keywords.find((k) => literal.get(k) === text) : undefined;
        if (at !== undefined)
            take(at, r);
        else
            left.push(r);
    }
    if (rest.length === 1) {
        left.forEach((r) => take(rest[0]!, r));
    } else if (rest.length > 1) {
        for (const copy of groupBy(left, (r) => r.inst).values()) {
            if (copy.length % rest.length !== 0)
                continue;
            copy.sort((a, b) => a.index - b.index);
            copy.forEach((r, i) => take(rest[i % rest.length]!, r));
        }
    }
    return byKeyword;
}

/** An expansion as a site: its kind, its range in `t`, its first copy's title. */
function siteOf(t: Uint8Array, x: Expansion): ExpansionSite {
    const range = { start: positionOf(t, x.start), end: positionOf(t, x.end) };
    return { kind: x.kind, range, title: x.copies[0]!.title() };
}

/**
 * The expansion sites of `file`, whose editor text is `text`, from the last compile (EXPANSIONS in the header): the
 * string mixins, the template instances written with `!` and the folded values whose expansion `queryExpansion`
 * shows; of nested sites the outermost (an instance's value argument is inside the instance). Read-only, between
 * compiles (THE CONTRACT). Misses: the file is not in the last compile; `stale` (STALE_REASON) when `text` is not the
 * text that compile read. Cost: the file's index when no query built it since the compile, then one pass over the
 * text and the printing of each site's title.
 */
export function queryExpansionSites(file: string, text: string): ExpansionSitesAnswer {
    return printing(() => expansionSites(file, text));
}

function expansionSites(file: string, text: string): ExpansionSitesAnswer {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    const ix = indexOf(m);
    if (text !== ix.text)
        return miss(STALE_REASON, true);
    const sites: ExpansionSite[] = [];
    let end = -1;
    for (const x of expansionsOf(m, ix)) {
        if (x.start < end || x.copies.length === 0)
            continue;
        end = x.end;
        sites.push(siteOf(ix.bytes, x));
    }
    return { result: { sites } };
}

/**
 * The expansion of `range` (lines from 0, UTF-16 characters from 0, end exclusive) of `file`, whose editor text is
 * `text` (EXPANSIONS in the header): of the sites containing the range, the innermost; its first analysed copy's text,
 * and how many copies answer. A cursor is an empty range: the innermost site at the point (its end excluded); a lens
 * passes its site's range and gets that site; a selection, the innermost site around it. Of sites with one range, the
 * one `queryExpansionSites` lists. Read-only, between compiles (THE CONTRACT). Misses: the file is not in the last
 * compile; `stale` (STALE_REASON); the range outside the text; no site containing it. Cost: the sites (see
 * `queryExpansionSites`), then the printing of one copy: an instance's whole declaration.
 */
export function queryExpansion(file: string, range: QueryRange, text: string): ExpansionAnswer {
    return printing(() => expansion(file, range, text));
}

function expansion(file: string, range: QueryRange, text: string): ExpansionAnswer {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    const ix = indexOf(m);
    if (text !== ix.text)
        return miss(STALE_REASON, true);
    const from = byteOffset(ix.bytes, range.start.line, range.start.character);
    const to = byteOffset(ix.bytes, range.end.line, range.end.character);
    if (from === null || to === null || to < from)
        return miss("the range is outside the text");
    let best: Expansion | null = null;
    for (const x of expansionsOf(m, ix)) {   // sorted as the list: the first of equal ranges is the one it shows
        const holds = x.start <= from && to <= x.end && (from < to || from < x.end) && x.copies.length !== 0;
        if (holds && (best === null || x.end - x.start < best.end - best.start))
            best = x;
    }
    if (best === null)
        return miss("no expansion at the range");
    const peek = withContext([asDsymbol(m)], () => best.copies[0]!.text());
    return { result: { ...siteOf(ix.bytes, best), text: peek, instances: best.copies.length } };
}

// ── the AST view ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where a symbol is declared, as `queryDefinition` answers: the file as the compiler names it, the identifier. */
export interface DeclarationSite {
    file: string;
    range: QueryRange;
}

/** One declaration printed in the AST view, with where it came from (AST VIEW in the header). */
export interface AstEntry {
    /** The declaration's print in `AstResult.text`: from its first character to past its last (`;`, `}`). */
    ast: QueryRange;
    /** dmd's kind (`function`, `struct`, `template instance`, `import`, ...), refined as a hover's (`field`, ...). */
    kind: string;
    /** `toPrettyChars`; an import's is the imported module's. */
    name: string;
    /**
     * The identifier of its declaration in a source file, found from the location the compiler gave it, as
     * `queryDefinition` finds it (an instance's location is where it was instantiated: the template's name there).
     * Null where that location is not at an identifier of its name: none (a builtin), in a string mixin, or a symbol
     * the compiler made (the implicit `import object`, `RTInfo!(S)` at its struct, a `foreach`'s `__r3`, `__key4`).
     */
    source: DeclarationSite | null;
    /** A function's extent in that file: from its identifier past its closing brace (`endloc`); null for the others. */
    extent: QueryRange | null;
}

/** The module as the compiler made it after semantic analysis: what `-vcg-ast` writes in `<file>.cg`. */
export interface AstResult {
    /** D source printed by hdrgen with `fullDump` and `vcg_ast`, tab indents, ending with "\n". */
    text: string;
    /**
     * Every declaration printed through hdrgen's symbol printer (members, locals, instance members), sorted by
     * `ast.start`, a container before what it holds.
     */
    entries: AstEntry[];
}

/** The answer of `queryAst`: the AST view, or a miss (not in the last compile; only imported; `stale`). */
export type AstAnswer = { result: AstResult } | QueryMiss;

/**
 * The AST view of `file`, whose editor text is `text`, from the last compile, kept or fresh (AST VIEW in the header):
 * the module as `-vcg-ast` writes it in `<file>.cg`, and every declaration printed, with its place in the text and
 * where it is declared. Read-only, between compiles (THE CONTRACT). Misses: the file is not in the last compile; its
 * module was only imported (`-vcg-ast` prints no AST for it); `stale` (STALE_REASON) when `text` is not the text that
 * compile read (a C module's is the preprocessor's output). Cost: the print of the module with its instances and the
 * source of each declaration, at the first request after a compile (a large application module under -i: 5.8 MB, ~1.7 s);
 * the answer is kept until the next compile.
 */
export function queryAst(file: string, text: string): AstAnswer {
    return printing(() => astView(file, text), foldVariable);
}

function astView(file: string, text: string): AstAnswer {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    if (!m.isRoot())
        return miss("the module is imported, not compiled: -vcg-ast prints no AST for it");
    const ix = indexOf(m);
    if (text !== ix.text)
        return miss(STALE_REASON, true);
    try {
        ix.ast ??= astOf(m);
    } catch (e) {
        // hdrgen faults where ldc2 does, and so does -vcg-ast in editor mode (an enum member whose initializer failed:
        // `EnumMember.value` of an `ErrorInitializer`, which ldc2 dereferences as null); the swaps are undone
        return miss(`-vcg-ast's print fails on this module: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { result: ix.ast };
}

/**
 * `m` printed as dmd/main.d's `-vcg-ast` loop prints it (`moduleToBuffer` into a buffer with `doindent`), with the
 * byte range of each symbol's print: hdrgen's print hook (`dumping`) notes the buffer's growth across each symbol's
 * print into this buffer (one into another buffer, hdrgen's `toChars` of a declaration, is no entry), and keeps the
 * symbols being printed on `printStack`, the context of `spellFresh`. After a kept compile that renumbered generated
 * identifiers, they are spelled as a fresh compile numbers them, the entries' names too (`entryName`, while the symbol
 * prints).
 */
function astOf(m: Module): AstResult {
    const buf = new OutBuffer();
    buf.doindent = true;
    const printed: { sym: Dsymbol; start: number; end: number; name: string }[] = [];
    const chains = new Map<Dsymbol, string>();
    const around = (s: Dsymbol, into: OutBuffer, print: () => void): void => withContext([s], () => {
        // the module is the whole text; an attribute block is its members' grouping
        const listed = into === buf && s.isModule() === null && s.isAttribDeclaration() === null;
        const mark = listed ? { sym: s, start: buf.length(), end: 0, name: "" } : null;
        if (mark !== null)
            printed.push(mark);   // before the members: a container before what it holds
        print();
        if (mark !== null) {
            mark.end = buf.length();
            if (mark.end !== mark.start)
                mark.name = entryName(s, chains);
        }
    });
    dumping((hgs) => dsymbolToCBuffer(asDsymbol(m), buf, hgs), around);
    const bytes = buf.extractSlice();
    const entries: AstEntry[] = [];
    for (const { sym, start, end, name } of printed) {
        let s = start;
        let e = end;
        while (s < e && isSpace(bytes[s]!))
            s++;
        while (e > s && isSpace(bytes[e - 1]!))
            e--;
        if (s === e)
            continue;
        const d = declarationOf(sym, true);
        const source = typeof d === "string" ? null : d;
        entries.push({ ast: { start: positionOf(bytes, s), end: positionOf(bytes, e) }, kind: kindOf(sym), name,
            source, extent: extentOf(sym) });
    }
    return { text: utf8.decode(bytes), entries };
}

/**
 * An entry's name: `toPrettyChars`, its parent chain's part kept per symbol in `chains` (the chain is the base
 * `toPrettyChars`, each ancestor's `toChars` joined by `.`; a class that overrides it is asked); an import's, the
 * module it imports, as resolved, else as written.
 */
function entryName(s: Dsymbol, chains: Map<Dsymbol, string>): string {
    const imp = s.isImport();
    if (imp !== null)
        return imp.mod !== null ? str(asDsymbol(imp.mod).toPrettyChars())
            : [...imp.packages ?? [], imp.id].map(identText).join(".");
    if (s.toPrettyChars !== Dsymbol.prototype.toPrettyChars)
        return str(s.toPrettyChars());
    const chain = (p: Dsymbol): string => {
        let c = chains.get(p);
        if (c === undefined) {
            c = p.parent === null ? str(p.toChars()) : `${chain(p.parent)}.${str(p.toChars())}`;
            chains.set(p, c);
        }
        return c;
    };
    return chain(s);
}

/**
 * Makes `Identifier.toChars` and `toString` spell each generated identifier (`__r12`) as a fresh compile numbers it,
 * after a kept compile that numbered some otherwise (`keepRenumbered`), for every query's print (`printing`). An
 * identifier no unit of the compile made keeps its name at once; one whose units all give it one number takes it
 * (`keepAllGeneratedNames`). Identifiers are interned, so one may be the name of several units' identifiers, of
 * different compiles: then the innermost symbol of `stack` (the symbols being printed, `printStack`) whose units made
 * it decides (`keepGeneratedNames`); else it keeps its name and counts as ambiguous (`queryAmbiguousNames`). Returns
 * the undo, which the caller runs in `finally`. Cost: the compile's generated identifiers, and one map per symbol of
 * the stack where one is ambiguous, each built at its first need after a compile.
 */
function spellFresh(stack: readonly Dsymbol[]): () => void {
    const proto = Identifier.prototype;
    const { toChars, toString } = proto;
    allGenerated ??= keepAllGeneratedNames();
    const all = allGenerated;
    const numberOf = (id: Identifier): FreshNumber | null => {
        const list = all.get(id);
        if (list === undefined)
            return null;
        if (list.length === 1)
            return list[0]!;
        for (let k = stack.length - 1; k >= 0; k--) {
            const s = stack[k]!;
            let t = generatedBy.get(s);
            if (t === undefined)
                generatedBy.set(s, t = keepGeneratedNames(s));
            const x = t.get(id);
            if (x !== undefined)
                return x;
        }
        ambiguous.add(id);
        return null;
    };
    const fresh = (id: Identifier): DString | null => {
        const x = numberOf(id);
        if (x === null)
            return null;
        const digits = encoder.encode(String(x.n));
        const out = new Uint8Array(x.prefix + digits.length);
        out.set(toString.call(id).subarray(0, x.prefix));
        out.set(digits, x.prefix);
        return out;
    };
    proto.toChars = function (this: Identifier): DString {
        return fresh(this) ?? toChars.call(this);
    };
    proto.toString = function (this: Identifier): DString {
        return fresh(this) ?? toString.call(this);
    };
    return () => {
        proto.toChars = toChars;
        proto.toString = toString;
    };
}

/**
 * For the tests: how many generated identifiers the prints since the last compile left with their kept names because
 * the compile's units that made them number them otherwise and no symbol being printed made one (`spellFresh`).
 */
export function queryAmbiguousNames(): number {
    return ambiguous.size;
}

function isSpace(b: number): boolean {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

/**
 * A function's extent in its file: from its location (its identifier; a destructor's `~`, a literal's first token)
 * past its last character at `endloc`, a `}` or a `;`; where `endloc` is past the end already (an expression body's,
 * `q => q + 1`; an invariant's, at the next token), to the last character before it. Null for another symbol, or
 * where the two locations are not in one source file in that order.
 */
function extentOf(sym: Dsymbol): QueryRange | null {
    const fd = sym.isFuncDeclaration();
    if (fd === null)
        return null;
    const from = sourceLoc(fd.loc);
    const to = sourceLoc(fd.endloc);
    if (typeof from === "string" || typeof to === "string" || from.file !== to.file
        || to.sl.fileOffset >= to.sl.fileContent.length || from.sl.fileOffset >= to.sl.fileOffset)
        return null;
    const content = to.sl.fileContent;
    let end = to.sl.fileOffset;
    if (content[end] === 0x7d || content[end] === 0x3b)
        end++;
    else {
        while (end > from.sl.fileOffset && isSpace(content[end - 1]!))
            end--;      // an `endloc` at the token after the body (an invariant's)
    }
    const s = positionOf(content, from.sl.fileOffset);
    const e = positionOf(content, end);
    return { start: { line: s.line + lineDelta(from.sl), character: s.character },
        end: { line: e.line + lineDelta(to.sl), character: e.character } };
}

// ── the template instances and the imports ──────────────────────────────────────────────────────────────────

/** One instance of a template, where the compile created it. */
export interface InstanceSite {
    /**
     * `toChars`, hdrgen's name of the instance, with a variable argument folded (`foldVariable`) and the generated
     * names spelled fresh (`spellFresh`) as in the AST view: `Foo!(int, 3)`, `Box!int`.
     */
    title: string;
    /**
     * Where it was instantiated (its `loc`): the file as the compiler names it and the template's name there (the
     * point of the location when the name is not found there); both null when the location is not in a source file.
     */
    file: string | null;
    range: QueryRange | null;
}

/** A template declared in one of the queried files, with the instances the compile created (INSTANCES). */
export interface TemplateInstances {
    /** `toPrettyChars`: a member template of an instance names its instance (`lib.Box!int.Box.get`). */
    name: string;
    /**
     * dmd's kind of the template (`TemplateDeclaration.kind`): `template`, or its eponymous member's kind when that is
     * an aggregate (`struct` for `struct Box(T)`, `class`).
     */
    kind: string;
    /** The declaring file as the compiler names it, and the template's identifier there. */
    file: string;
    range: QueryRange;
    /** Sorted by file, then position, then title. */
    instances: InstanceSite[];
}

/** The templates of `queryInstances`, sorted by file, then position. */
export interface InstancesResult {
    templates: TemplateInstances[];
}

/** The answer of `queryInstances`: the templates, or a miss (no compile to read). */
export type InstancesAnswer = { result: InstancesResult } | QueryMiss;

/**
 * The templates declared in `files` (absolute, or resolved against the working directory) that the last compile
 * instantiated, each with its instances (INSTANCES in the header). A file not in the last compile is skipped, not a
 * miss: the host knows which documents changed since the compile, and no text is compared. Read-only, between
 * compiles (THE CONTRACT). Miss: no compile to read. Cost: the instance table (one pass over every module's members,
 * shared with the inlay hints) at the first need after a compile, then each listed instance's name printed.
 */
export function queryInstances(files: readonly string[]): InstancesAnswer {
    return printing(() => instances(files), foldVariable);
}

function instances(files: readonly string[]): InstancesAnswer {
    if (Module.amodules.length === 0)
        return miss("no compile to read");
    const wanted = new Set(files.map((f) => resolve(f)));
    const templates: TemplateInstances[] = [];
    // the names print as the AST view prints them: after a renumbering compile, the symbol named and its parents are
    // the context (`spellFresh`)
    const named = (s: Dsymbol, name: () => DString): string => withContext(contextOf(s), () => str(name()));
    for (const [td, list] of instanceTable()) {
        const d = declarationOf(td);
        if (typeof d === "string" || !wanted.has(resolve(d.file)))
            continue;
        const sites = list.map((ti): InstanceSite => {
            const at = declarationOf(ti);
            const title = named(ti, () => ti.toChars());
            return typeof at === "string" ? { title, file: null, range: null } : { title, ...at };
        });
        sites.sort((a, b) =>
            compareSites(a.file ?? "", a.range, b.file ?? "", b.range) || compareText(a.title, b.title));
        templates.push({ name: named(td, () => td.toPrettyChars()), kind: str(td.kind()), file: d.file,
            range: d.range, instances: sites });
    }
    templates.sort((a, b) => compareSites(a.file, a.range, b.file, b.range) || compareText(a.name, b.name));
    return { result: { templates } };
}

/** File names, then positions (a missing range first). */
function compareSites(fa: string, ra: QueryRange | null, fb: string, rb: QueryRange | null): number {
    if (fa !== fb)
        return compareText(fa, fb);
    if (ra === null || rb === null)
        return (ra === null ? 0 : 1) - (rb === null ? 0 : 1);
    return ra.start.line - rb.start.line || ra.start.character - rb.start.character;
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** One module the last compile loaded (IMPORTS in the header). */
export interface ImportModule {
    /** The module's name, `pkg.mod`. */
    name: string;
    /** Its source file as the compiler names it. */
    file: string;
    /** `root` on the command line, `included` compiled through `-i`, `imported` read for its declarations only. */
    kind: "root" | "included" | "imported";
    /** The size of its source in bytes (`Module.src`); 0 for a module whose file could not be read. */
    size: number;
    /**
     * The modules its own module-level `import` declarations name (IMPORTS in the header), indexes into
     * `ImportsResult.modules`, in source order, no duplicates, not itself (object.d's implicit `import object`).
     */
    imports: number[];
    /**
     * The number of its strongly connected component of the imports when that component holds more than one
     * module, else null: an import is in a cycle when both ends carry the same number. Numbered from 0 in the order
     * of the list.
     */
    cycle: number | null;
}

/**
 * The modules of `queryImports`: the command-line roots first, then breadth-first along the imports; then,
 * breadth-first again, each module no root reaches, by name.
 */
export interface ImportsResult {
    modules: ImportModule[];
}

/** The answer of `queryImports`: the modules, or a miss (no compile to read). */
export type ImportsAnswer = { result: ImportsResult } | QueryMiss;

/**
 * The modules the last compile loaded, with their imports and import cycles (IMPORTS in the header). Read-only,
 * between compiles (THE CONTRACT). Miss: no compile to read. Cost: one pass over each loaded module's members, function
 * bodies and templates not entered.
 */
export function queryImports(): ImportsAnswer {
    const loaded = Module.amodules.opSlice().filter((m): m is Module => m !== null);
    if (loaded.length === 0)
        return miss("no compile to read");
    const included = new Set(compiledImports.opSlice());
    const known = new Set(loaded);
    const importsOf = new Map(loaded.map((m) =>
        [m, [...new Set(moduleImports(m.members))].filter((x) => x !== m && known.has(x))]));
    const order: Module[] = [];
    const index = new Map<Module, number>();
    const reach = (from: Module): void => {
        if (index.has(from))
            return;
        index.set(from, order.length);
        for (let i = order.push(from) - 1; i < order.length; i++) {
            for (const x of importsOf.get(order[i]!)!) {
                if (!index.has(x)) {
                    index.set(x, order.length);
                    order.push(x);
                }
            }
        }
    };
    for (const m of loaded.filter((x) => x.isRoot() && !included.has(x)))
        reach(m);
    const name = (m: Module): string => str(asDsymbol(m).toPrettyChars());
    for (const m of loaded.filter((x) => !index.has(x)).sort((a, b) => compareText(name(a), name(b))))
        reach(m);
    const edges = order.map((m) => importsOf.get(m)!.map((x) => index.get(x)!));
    const cycles = cyclesOf(edges);
    return { result: { modules: order.map((m, i): ImportModule => ({
        name: name(m),
        file: str(m.srcfile.toChars()),
        kind: included.has(m) ? "included" : m.isRoot() ? "root" : "imported",
        size: m.src === null ? 0 : m.src.length,
        imports: edges[i]!,
        cycle: cycles[i]!,
    })) } };
}

/**
 * The modules the `import` declarations of `members` name, in order: in attribute blocks, the branch a condition
 * chose, `static foreach` expansions, string and template mixins, aggregates; not in functions or templates.
 */
function moduleImports(members: Iterable<Dsymbol | null> | null): Module[] {
    const out: Module[] = [];
    for (const s of members ?? []) {
        if (s === null)
            continue;
        const imp = s.isImport();
        if (imp !== null) {
            if (imp.mod !== null)
                out.push(imp.mod);
        } else if (s instanceof ConditionalDeclaration) {
            const inc = s.condition.inc;
            out.push(...moduleImports(inc === Include.yes ? s.decl : inc === Include.no ? s.elsedecl : null));
        } else if (s instanceof StaticForeachDeclaration) {
            out.push(...moduleImports(s.cache));
        } else if (s.isAttribDeclaration() !== null) {
            out.push(...moduleImports(s.isAttribDeclaration()!.decl));
        } else if (s.isTemplateMixin() !== null) {
            out.push(...moduleImports(s.isTemplateMixin()!.members));
        } else if (s.isAggregateDeclaration() !== null || s.isNspace() !== null) {
            out.push(...moduleImports(s.isScopeDsymbol()!.members));
        }
    }
    return out;
}

/**
 * The cycle number of each node of `edges` (adjacency by index, no edge to itself): its strongly connected
 * component's (Tarjan's, the recursion as an explicit stack) when that component has more than one node, else null;
 * components numbered in the order of their first node.
 */
function cyclesOf(edges: readonly number[][]): (number | null)[] {
    const n = edges.length;
    const low = new Array<number>(n).fill(-1);
    const num = new Array<number>(n).fill(-1);
    const onStack = new Array<boolean>(n).fill(false);
    const comp = new Array<number>(n).fill(-1);
    const stack: number[] = [];
    let counter = 0;
    let comps = 0;
    for (let root = 0; root < n; root++) {
        if (num[root] !== -1)
            continue;
        const work: [number, number][] = [[root, 0]];
        num[root] = low[root] = counter++;
        stack.push(root);
        onStack[root] = true;
        while (work.length !== 0) {
            const top = work[work.length - 1]!;
            const [v, k] = top;
            if (k < edges[v]!.length) {
                top[1]++;
                const w = edges[v]![k]!;
                if (num[w] === -1) {
                    num[w] = low[w] = counter++;
                    stack.push(w);
                    onStack[w] = true;
                    work.push([w, 0]);
                } else if (onStack[w])
                    low[v] = Math.min(low[v]!, num[w]!);
                continue;
            }
            work.pop();
            if (work.length !== 0) {
                const u = work[work.length - 1]![0];
                low[u] = Math.min(low[u]!, low[v]!);
            }
            if (low[v] === num[v]) {
                let w: number;
                do {
                    w = stack.pop()!;
                    onStack[w] = false;
                    comp[w] = comps;
                } while (w !== v);
                comps++;
            }
        }
    }
    const size = new Array<number>(comps).fill(0);
    for (const c of comp)
        size[c]++;
    const numbers = new Map<number, number>();
    return comp.map((c) => {
        if (size[c]! < 2)
            return null;
        if (!numbers.has(c))
            numbers.set(c, numbers.size);
        return numbers.get(c)!;
    });
}

// ── completion ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a completion item is, for the editor's icon: standard LSP names (`completionKind`). */
export type CompletionKind = "method" | "function" | "field" | "property" | "variable" | "constant" | "enumMember"
    | "enum" | "struct" | "class" | "interface" | "module" | "typeParameter";

/** One name after a `.`, or visible where no `.` precedes the position (COMPLETION in the header). */
export interface CompletionItem {
    /** The name as written. */
    label: string;
    kind: CompletionKind;
    /**
     * One line: the signature or type as the hover's code block prints it (a function's full signature, a field's
     * `type name`), with ` (+N overloads)` after a function's first overload; a built-in property's fixed type; ""
     * when none.
     */
    detail: string;
    /** The doc comment's summary on one line, "" when none. */
    documentation: string;
    /**
     * The group, for the editor's order. After a dot: members of the type (0), UFCS candidates (1), built-in
     * properties (2). Without one: locals and parameters (0), the enclosing aggregate's members (1), the module's (2),
     * the imported modules' (3).
     */
    group: CompletionGroup;
}

/** A completion item's group (`CompletionItem.group`). */
export type CompletionGroup = 0 | 1 | 2 | 3;

/** The names after a `.`, or in scope without one, sorted by group, then label (`completionOrder`). */
export interface CompletionResult {
    /**
     * The text the items replace, in the REQUEST's text: the identifier characters typed up to the position, after the
     * dot or not (empty when the position is right after the dot, or nothing is typed).
     */
    range: QueryRange;
    items: CompletionItem[];
    /** True when the request's text differed from the compiled one and the answer went through the text move. */
    moved: boolean;
}

export type CompletionAnswer = { result: CompletionResult } | QueryMiss;

/**
 * One link of the chain before the `.`: its name, its byte offset and end in the request's text, and the `()` and
 * `[...]` written after it, in order.
 */
interface Link {
    name: string;
    start: number;
    end: number;
    ops: ("call" | "index")[];
}

/**
 * What the chain before the `.` names (`chainTarget`): a value of a type, with the qualifiers it is reached with (a
 * field of a `const` value is `const`, `this` in a `const` method), a type, or a module or package.
 */
type Target = { kind: "value"; type: Type; mod: number } | { kind: "type"; type: Type }
    | { kind: "scope"; sds: ScopeDsymbol };

/** The request's text against the compiled one, taken as one edit: the common prefix's and suffix's lengths. */
interface Edit {
    prefix: number;
    suffix: number;
    delta: number;
}

/**
 * Where a request is: its module, the index, the `.`'s offset moved into the compiled text, the analysed scope there
 * (one of a template's instances), the edit between the two texts (null when they are equal), and what every scope of
 * the request shares, found once: the imports declared in the bodies holding the dot before it (`localImports`), the
 * index's hits at the first link when it is in the text the compile read, the first per instance (`indexedSymbol`;
 * null when it is not).
 */
interface Place {
    m: Module;
    ix: FileIndex;
    off: number;
    scope: Dsymbol;
    edit: Edit | null;
    imports: readonly Import[];
    firstHits: ReadonlyMap<TemplateInstance | null, Dsymbol> | null;
}

/** The integral basic types, which have `min` and `max` (COMPLETION's built-in properties). */
const INTEGRAL: ReadonlySet<TY> = new Set([TY.Tint8, TY.Tuns8, TY.Tint16, TY.Tuns16, TY.Tint32, TY.Tuns32, TY.Tint64,
    TY.Tuns64, TY.Tint128, TY.Tuns128, TY.Tbool, TY.Tchar, TY.Twchar, TY.Tdchar]);

/** The floating basic types, with the spec's floating-point properties. */
const FLOATING: ReadonlySet<TY> = new Set([TY.Tfloat32, TY.Tfloat64, TY.Tfloat80, TY.Timaginary32, TY.Timaginary64,
    TY.Timaginary80, TY.Tcomplex32, TY.Tcomplex64, TY.Tcomplex80]);

/** The qualifiers that restrict which methods a receiver may call (`callableOn`). */
const RECEIVER_MODS = MODFlags.const_ | MODFlags.immutable_ | MODFlags.wild | MODFlags.shared_;

/**
 * The names visible after `expr.` at `position` of `file`, whose editor text is `text`, or, with no `.` before the
 * identifier being typed there, the names in scope at it, from the last compile, read-only (THE CONTRACT; COMPLETION
 * in the header). Unlike the other queries a text that differs from the compiled one is not a miss: the expression
 * before the dot is read from `text`, and its scope is found at the dot's position moved into the compiled text (the
 * common prefix and suffix of the two texts; a position inside the changed span goes to the span's start), `moved`
 * then true. `expr` is an identifier chain (`a.b.c`, across lines and comments; `this`
 * or `super` first; a leading `.` for the module scope; a link may end in `()`, a function's return type, or `[...]`,
 * an element's). The items: the members of what it names (group 0), the UFCS candidates the index knows (1), the
 * built-in properties (2), one per name, sorted by group then label (`completionOrder`). Without a dot: the locals and
 * parameters declared before the position (0), the enclosing aggregate's members (1), the module's names (2), the
 * imported modules' public names (3).
 * Misses: the file is not in the last compile; the position is outside `text`; the dot, or without one the position,
 * in a comment or a literal; the dot after a number, the position in one; the function holding the moved position not
 * analysed; the expression not resolved (never a guess: the reason names the link), or a template's analysed
 * instances resolving it to different types.
 * Cost: the first request after a compile builds the file's index (as every query); then the request text's scan
 * (its comments and literals, the move), the chain's resolution, a few table lookups per link, once per analysed copy
 * of the scope (in a template's body, one per instance, stopping at the first disagreement; what the copies share,
 * the hits at the first link and the local imports, is found once), and the items, each printed through the hover's
 * printer. A large application module under -i: see the header; inside std.format's heavily instantiated `getNth` body
 * ~5 ms; every `.` of the compile's 349 files, 138767 requests: none over 71 ms (an index build). Without a dot, the
 * first request after a compile prints the items of the imported modules' names (that module under -i: ~1500 items,
 * ~80 ms at a load of 25 besides the index), the later ones filter the kept entries (~2-10 ms).
 */
export function queryCompletion(file: string, text: string, position: QueryPosition): CompletionAnswer {
    return printing(() => completion(file, text, position));
}

function completion(file: string, text: string, position: QueryPosition): CompletionAnswer {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    const ix = indexOf(m);
    hitsOf(m, ix);      // the walk: the function bodies, the comments and literals, the imports a completion reads
    const moved = text !== ix.text;
    const t = moved ? encoder.encode(text) : ix.bytes;
    const off = byteOffset(t, position.line, position.character);
    if (off === null)
        return miss("the position is outside the text");
    let typed = off;
    while (typed > 0 && isIdentByte(t[typed - 1]))
        typed--;
    const dot = typed - 1;
    const nc = moved ? nonCode(t) : ix.nonCode;
    if (dot < 0 || t[dot] !== 0x2e || t[dot - 1] === 0x2e)
        return scopeCompletion(m, ix, t, nc, typed, off, position);
    if (rangeHolding(nc, dot) >= 0)
        return miss("the `.` is in a comment or a literal");
    let word = dot;
    while (word > 0 && isIdentByte(t[word - 1]))
        word--;
    if (word < dot && t[word]! >= 0x30 && t[word]! <= 0x39)
        return miss("the `.` follows a number");
    const edit = moved ? editOf(t, ix.bytes) : null;
    const at = edit === null ? dot : movedOffset(edit, t.length, dot);
    const scopes = scopesAt(m, ix, at);
    if (scopes === null)
        return miss("the function at the position was not analysed");
    const chain = chainBefore(t, nc, dot);
    if (typeof chain === "string")
        return miss(`the expression before the \`.\` is not resolved: ${chain}`);
    // in a template's body every analysed instance resolves the chain: the answer is theirs only when they agree;
    // what does not depend on the instance is found once
    const first = chain.links[0]!;
    // the first link's offset in the compiled text when it is in the text the compile read: before the edit, or in
    // the unchanged end (a line inserted above it)
    const compiled = edit === null || first.end <= edit.prefix ? first.start
        : first.start >= t.length - edit.suffix ? first.start + edit.delta : -1;
    let firstHits: Map<TemplateInstance | null, Dsymbol> | null = null;
    if (compiled >= 0) {
        firstHits = new Map();
        for (const h of choose(m, ix, compiled)) {
            if (!firstHits.has(h.inst))
                firstHits.set(h.inst, h.sym);
        }
    }
    const imports = localImports(ix, at);
    let found: { place: Place; target: Target } | null = null;
    for (const scope of scopes) {
        const place: Place = { m, ix, off: at, scope, edit, imports, firstHits };
        const target = chainTarget(place, chain.links, chain.leadingDot);
        if (typeof target === "string")
            return miss(`the expression before the \`.\` is not resolved: ${target}`);
        if (found !== null && !sameTarget(found.target, target))
            return miss("the expression before the `.` has different types in the template's instances");
        found ??= { place, target };
    }
    const items = completionItems(found!.place, found!.target);
    items.sort(completionOrder);
    return { result: { range: { start: positionOf(t, typed), end: position }, items, moved } };
}

/**
 * The order of the completion items (COMPLETION in the header): by group; in a group the names that do not start with
 * `_` first (a leading underscore marks an internal by D convention: dmd's `Expression._init()` came before every
 * member of an `Expression`), then by label ignoring case, then by UTF-16 code unit (`Abc` before `abc`).
 */
function completionOrder(a: CompletionItem, b: CompletionItem): number {
    return a.group - b.group || Number(a.label.startsWith("_")) - Number(b.label.startsWith("_"))
        || compareText(a.label.toLowerCase(), b.label.toLowerCase()) || compareText(a.label, b.label);
}

/**
 * The names visible at the identifier being typed from `typed` to `off` (byte offsets in the request's text `t`, whose
 * comments and literals are `nc`; `off` is `position`): COMPLETION without a dot. The scope is found as after a dot
 * (the position moved into the compiled text; the innermost analysed function there, of a template's instances the
 * first, else the module), and the names are those of `scopeItems`. Misses: the position is in a comment or a literal,
 * or in a number; the function at the moved position was not analysed.
 */
function scopeCompletion(m: Module, ix: FileIndex, t: Uint8Array, nc: [number, number][], typed: number, off: number,
    position: QueryPosition): CompletionAnswer {
    if (inCommentOrLiteral(t, nc, typed))
        return miss("the position is in a comment or a literal");
    if (typed < off && t[typed]! >= 0x30 && t[typed]! <= 0x39)
        return miss("the position is in a number");
    const moved = t !== ix.bytes;
    const edit = moved ? editOf(t, ix.bytes) : null;
    const at = edit === null ? typed : movedOffset(edit, t.length, typed);
    const scopes = scopesAt(m, ix, at);
    if (scopes === null)
        return miss("the function at the position was not analysed");
    const place: Place = { m, ix, off: at, scope: scopes[0]!, edit, imports: localImports(ix, at), firstHits: null };
    const items = scopeItems(place);
    items.sort(completionOrder);
    return { result: { range: { start: positionOf(t, typed), end: position }, items, moved } };
}

/**
 * Whether byte `p` of `t` is inside a comment or a literal of `nc` (`nonCode`, whose comment ranges run on over the
 * whitespace after them): past a literal's opening and before its end; in a `//` comment before its line's end; in a
 * block comment before its closing token.
 */
function inCommentOrLiteral(t: Uint8Array, nc: [number, number][], p: number): boolean {
    const k = rangeHolding(nc, p > 0 ? p - 1 : p);
    if (k < 0)
        return false;
    const [a, b] = nc[k]!;
    if (t[a] !== 0x2f || (t[a + 1] !== 0x2f && t[a + 1] !== 0x2a && t[a + 1] !== 0x2b))
        return p > a && p < b;
    if (t[a + 1] === 0x2f)
        return !t.subarray(a, p).includes(0x0a);
    let e = b;
    while (e > a && isSpace(t[e - 1]!))
        e--;
    return p < e;
}

/**
 * The names visible at a place, for a completion without a dot (COMPLETION in the header), one item per name, the
 * innermost declaration winning: group 0, the locals and parameters of the functions holding the place (a nested
 * function's, then its enclosing ones'), declared before it in a block still open there (`openAt`), and the parameters
 * of a template instance holding it, the function-local renamed imports before it; group 1, the members of the
 * aggregate whose member function holds it (`this`'s, filtered by its qualifier as after `this.`, its `alias this`'s; a
 * static member function's static members); group 2, the module's own members and the names its imports declare (`std`
 * of `import std.stdio;`, a renamed import's); group 3, the public members of the modules it imports, their public
 * imports followed, and of the function-local imports before the place (a selective import's names). Not the keywords
 * (the grammar's), nor the compiler's names. Each item as after a dot (`completionItem`), its overloads counted; the
 * items of a module's table are printed once per compile (`moduleItems`).
 */
function scopeItems(place: Place): CompletionItem[] {
    const items = new Map<string, CompletionItem>();
    const add = (sym: Dsymbol, group: CompletionGroup): void => {
        const label = identText(sym.ident);
        if (!items.has(label))
            items.set(label, completionItem(sym, label, group, sym, true));
    };
    let ad: AggregateDeclaration | null = null;
    for (let s: Dsymbol | null = place.scope; s !== null && s.isModule() === null; s = s.parent) {
        const fd = s.isFuncDeclaration();
        if (fd !== null) {
            for (const v of localsBefore(place, fd))
                add(v, 0);
        }
        for (const [, p] of s.isTemplateInstance()?.argsym?.symtab?.tab.asRange() ?? [])
            add(p, 0);
        ad ??= s.isAggregateDeclaration();
    }
    for (const imp of place.imports) {
        if (imp.aliasId !== null)
            add(imp, 0);    // `import io = std.stdio;` in a body: `io` is a name of the function's scope
    }
    if (ad !== null) {
        const self = thisOf(place.scope);
        const instance = self !== null && self.isThis() === ad;
        const mod = instance ? (self!.type?.mod ?? 0) & RECEIVER_MODS : 0;
        const member = (s: Dsymbol): void => {
            if (listable(s) && accessible(s, place) && (instance ? callableOn(s, mod) : isStaticMember(s)))
                add(s, 1);
        };
        aggregateMembers(ad, member);
        const through = instance ? aliasThisType(ad) : null;
        const inner = through !== null ? aggregateOf(through) : null;
        if (inner !== null)
            aggregateMembers(inner, (s) => {
                if (listable(s) && accessible(s, place) && callableOn(s, mod))
                    add(s, 1);
            });
    }
    const own = asDsymbol(place.m).isScopeDsymbol()!;
    for (const e of moduleItems(own)) {
        if ((listable(e.sym) || e.sym.isImport() !== null) && !items.has(e.label))
            items.set(e.label, { ...itemOf(e), group: 2 });
    }
    const imported = (sds: ScopeDsymbol): void => {
        for (const e of moduleItems(sds)) {
            if (listable(e.sym) && e.sym.isPackage() === null && accessible(e.sym, place) && !items.has(e.label))
                items.set(e.label, itemOf(e));
        }
    };
    const seen = new Set<ScopeDsymbol>([own]);
    const visit = (sds: ScopeDsymbol, all: boolean): void => {
        (sds.importedScopes?.opSlice() ?? []).forEach((x, i) => {
            const mod = x?.isModule() ?? null;
            const next = mod !== null ? asDsymbol(mod).isScopeDsymbol() : null;
            if (next === null || seen.has(next) || !(all || sds.visibilities?.[i] === Visibility.Kind.public_))
                return;
            seen.add(next);
            imported(next);
            visit(next, false);
        });
    };
    visit(own, true);
    for (const imp of place.imports) {
        const sds = imp.mod !== null ? asDsymbol(imp.mod).isScopeDsymbol() : null;
        if (sds !== null && imp.aliasId === null && imp.names.length === 0 && !seen.has(sds)) {
            seen.add(sds);
            imported(sds);
            visit(sds, false);
        }
        for (const al of imp.aliasdecls.opSlice())
            if (al !== null)
                add(al, 3);
    }
    return [...items.values()];
}

/**
 * The locals and parameters of `fd` visible at the place, latest declaration first: those the walk met (at their
 * names) and those of the function's table it did not (a body with errors; nested functions and aggregates), at their
 * own locations, declared before the place, in a block or a statement head still open there (`openAt`); parameters
 * always. Compiler-made names left out.
 */
function localsBefore(place: Place, fd: FuncDeclaration): Dsymbol[] {
    const found = new Map<Dsymbol, number>();
    for (const l of localsOf(place.ix, fd))
        found.set(l.v, l.at);
    for (const [, s] of fd.localsymtab?.tab.asRange() ?? []) {
        const at = found.has(s) ? null : localOffset(place, s);
        if (at !== null)
            found.set(s, at);
    }
    for (const p of fd.parameters?.opSlice() ?? [])
        if (p !== null && !found.has(p))
            found.set(p, -1);
    return [...found].filter(([s, at]) => !isCompilerName(s) && at < place.off
        && (s.isVarDeclaration()?.isParameter() === true || at < 0 || openAt(place.ix, at, place.off)))
        .sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/**
 * Whether a declaration at byte `at` of the compiled text is still in scope at `off` (after it), on the text: no block
 * opened before it closes in between; a declaration inside parentheses (`foreach (x; ...)`, `if (auto x = ...)`,
 * `catch (E e)`) only within the statement that follows them (`statementEnd`).
 */
function openAt(ix: FileIndex, at: number, off: number): boolean {
    const t = ix.bytes;
    let braces = 0;
    let parens = 0;
    let open = true;
    scanCode(t, ix.nonCode, at, (c, q) => {
        if (q >= off)
            return true;
        if (c === 0x7b) {
            braces++;
        } else if (c === 0x7d && --braces < 0) {
            open = false;
            return true;
        } else if (c === 0x28) {
            parens++;
        } else if (c === 0x29 && --parens < 0) {
            open = off < statementEnd(t, ix.nonCode, q + 1);
            return true;
        }
        return false;
    });
    return open;
}

/** An entry of a module's table for a completion without a dot, its item printed at its first need (`moduleItems`). */
interface ModuleEntry {
    sym: Dsymbol;
    label: string;
    item: CompletionItem | null;
}

/**
 * Every entry of a module's table but the compiler's names, kept for the compile (`moduleItemCache`, emptied by
 * `dropQueryIndex`): a module's names and their items do not depend on where the completion is. The caller checks the
 * visibility and prints an entry's item once (`itemOf`).
 */
function moduleItems(sds: ScopeDsymbol): readonly ModuleEntry[] {
    let list = moduleItemCache.get(sds);
    if (list === undefined) {
        list = [];
        for (const [, sym] of sds.symtab?.tab.asRange() ?? []) {
            if (sym.ident !== null && !isCompilerName(sym))
                list.push({ sym, label: identText(sym.ident), item: null });
        }
        moduleItemCache.set(sds, list);
    }
    return list;
}

/** A module entry's item in group 3 (`completionItem`), printed at the first need and kept with the entry. */
function itemOf(e: ModuleEntry): CompletionItem {
    return e.item ??= completionItem(e.sym, e.label, 3, e.sym, true);
}

/** The request's text `from` and the compiled `to` as one edit apart (`Edit`). */
function editOf(from: Uint8Array, to: Uint8Array): Edit {
    const shortest = Math.min(from.length, to.length);
    let prefix = 0;
    while (prefix < shortest && from[prefix] === to[prefix])
        prefix++;
    let suffix = 0;
    while (suffix < shortest - prefix && from[from.length - 1 - suffix] === to[to.length - 1 - suffix])
        suffix++;
    return { prefix, suffix, delta: to.length - from.length };
}

/**
 * Byte `off` of the request's text (`length` bytes) in the compiled text (the move djs-vscode's hints use): before or
 * at the change's start it keeps its place, in the unchanged end it shifts by the length difference, inside the
 * changed span it goes to the span's start.
 */
function movedOffset(edit: Edit, length: number, off: number): number {
    if (off <= edit.prefix)
        return off;
    return off >= length - edit.suffix ? off + edit.delta : edit.prefix;
}

/** Whether two places' targets are the same: one kind, and one type (by its mangled name) or one scope. */
function sameTarget(a: Target, b: Target): boolean {
    if (a.kind === "scope" || b.kind === "scope")
        return a.kind === "scope" && b.kind === "scope" && a.sds === b.sds;
    const same = a.type === b.type || (a.type.deco !== null && a.type.deco === b.type.deco);
    const mod = (t: Target): number => (t.kind === "value" ? t.mod : 0);
    return a.kind === b.kind && same && mod(a) === mod(b);
}

/**
 * The analysed scopes at byte `off`: of the innermost function bodies holding it, the analysed ones (a function
 * template's body: one per instance whose copy was analysed); the module when no body holds it; null when the
 * innermost body was not analysed.
 */
function scopesAt(m: Module, ix: FileIndex, off: number): Dsymbol[] | null {
    let size = Infinity;
    let found: Body[] = [];
    for (const f of ix.functions) {
        if (f.start > off || off > f.end)
            continue;
        const s = f.end - f.start;
        if (s < size) {
            size = s;
            found = [f];
        } else if (s === size) {
            found.push(f);
        }
    }
    if (found.length === 0)
        return [asDsymbol(m)];
    const analysed = found.filter((f) => f.fd !== null).map((f) => f.fd!);
    return analysed.length !== 0 ? [...new Set(analysed)] : null;
}

/** Whether `p` is inside a comment of `nc` (a range starting with `//`, `/*` or `/+`). */
function isComment(t: Uint8Array, nc: [number, number][], p: number): boolean {
    const k = rangeHolding(nc, p);
    return k >= 0 && t[nc[k]![0]] === 0x2f && t[nc[k]![0] + 1] !== 0x22;
}

/** The offset where the code before `p` ends: whitespace (newlines too) and comments skipped backwards. */
function codeBefore(t: Uint8Array, nc: [number, number][], p: number): number {
    for (;;) {
        while (p > 0 && isSpace(t[p - 1]!))
            p--;
        if (p === 0 || !isComment(t, nc, p - 1))
            return p;
        p = nc[rangeHolding(nc, p - 1)]![0];
    }
}

/**
 * The `[` matching the `]` at `close`, comments and literals skipped; -1 when a `;`, `{` or `}` comes first (the
 * statement's start) or the text's start.
 */
function openingBracket(t: Uint8Array, nc: [number, number][], close: number): number {
    let depth = 0;
    for (let p = close; p >= 0; p--) {
        const k = rangeHolding(nc, p);
        if (k >= 0) {
            p = nc[k]![0];
            continue;
        }
        const c = t[p];
        if (c === 0x5d)
            depth++;
        else if (c === 0x5b && --depth === 0)
            return p;
        else if (c === 0x3b || c === 0x7b || c === 0x7d)
            return -1;
    }
    return -1;
}

/**
 * The identifier chain that ends just before the `.` at `dot` (COMPLETION in the header): its links, first to last,
 * and whether a `.` with no operand leads it (the module scope). The chain may span lines, whitespace and comments
 * between its parts; it ends at what is not part of one (a `;`, `{` or `}`, an operator). A string says why the text
 * before the dot is not such a chain.
 */
function chainBefore(t: Uint8Array, nc: [number, number][], dot: number):
    { links: Link[]; leadingDot: boolean } | string {
    const links: Link[] = [];
    for (let p = dot; ;) {
        let q = codeBefore(t, nc, p);
        const ops: ("call" | "index")[] = [];
        while (t[q - 1] === 0x29 || t[q - 1] === 0x5d) {
            let open: number;
            if (t[q - 1] === 0x29) {
                open = codeBefore(t, nc, q - 1) - 1;
                if (t[open] !== 0x28)
                    return "a call with arguments";
                ops.unshift("call");
            } else {
                open = openingBracket(t, nc, q - 1);
                if (open < 0)
                    return "an unbalanced `]`";
                ops.unshift("index");
            }
            q = codeBefore(t, nc, open);
        }
        if (q > 0 && rangeHolding(nc, q - 1) >= 0)
            return "a literal before the `.`";
        const s = identBefore(t, q);
        if (s < 0)
            return links.length === 0 ? "not an identifier chain" : `not an identifier before \`.${links[0]!.name}\``;
        const name = utf8.decode(t.subarray(s, q));
        if (KEYWORDS.has(name) && !(name === "this" || name === "super"))
            return `\`${name}\` is a keyword`;
        links.unshift({ name, start: s, end: q, ops });
        const b = codeBefore(t, nc, s);
        if (t[b - 1] !== 0x2e || t[b - 2] === 0x2e)
            return { links, leadingDot: false };
        // the `.` before the link: another link's when an operand ends before it, else the module scope's
        const c = codeBefore(t, nc, b - 1);
        const operand = isIdentByte(t[c - 1]) || t[c - 1] === 0x29 || t[c - 1] === 0x5d
            || (c > 0 && rangeHolding(nc, c - 1) >= 0);
        if (!operand)
            return { links, leadingDot: true };
        p = b - 1;
    }
}

/**
 * What the chain names, read-only: the first link from the place (`this`, `super`; the symbol the index has at the
 * identifier when it is in the text the compile read; a function-local import's name; else `lookupFrom`; a leading
 * `.`, the module's own scope), each next one as a member of what the previous names (`memberNamed`). A string says
 * which link is not resolved and why.
 */
function chainTarget(place: Place, links: readonly Link[], leadingDot: boolean): Target | string {
    const [first, ...rest] = links;
    let target: Target | string;
    if (!leadingDot && (first!.name === "this" || first!.name === "super")) {
        const self = thisOf(place.scope);
        const ad = self?.isThis() ?? null;
        const type = first!.name === "this" ? ad?.type ?? null : ad?.isClassDeclaration()?.baseClass?.type ?? null;
        const mod = self?.type?.mod ?? 0;   // `this` in a `const` method is `const`
        target = type === null ? `no \`${first!.name}\` at the position`
            : applyOps({ kind: "value", type, mod: type.mod | mod }, first!);
    } else {
        const id = Identifier.lookup(encoder.encode(first!.name));
        const sym = id === null ? null : leadingDot ? lookupLexical(asDsymbol(place.m), id)
            : indexedSymbol(place) ?? localImport(place, id) ?? lookupFrom(place, id);
        target = sym === null ? `\`${first!.name}\` is not found` : typeof sym === "string" ? sym
            : symbolTarget(sym, first!, 0);
    }
    for (const link of rest) {
        if (typeof target === "string")
            return target;
        const id = Identifier.lookup(encoder.encode(link.name));
        const sym = id === null ? null : memberNamed(target, id);
        target = sym === null ? `\`${link.name}\` is not a member`
            : symbolTarget(sym, link, target.kind === "value" ? target.mod : 0);
    }
    return target;
}

/**
 * The symbol the index has at the first link, when the link is in the text the compile read (before the edit): the
 * analysis resolved it there, so it is the declaration in scope at that point (of two locals of one name, of a local
 * and a later one shadowing a global), from the place's own copy of a template's code. Else null.
 */
function indexedSymbol(place: Place): Dsymbol | null {
    return place.firstHits?.get(enclosingInstance(place.scope)) ?? null;
}

/** The innermost member function holding `scope` (through nested functions), whose `this` is its aggregate's. */
function thisOf(scope: Dsymbol): FuncDeclaration | null {
    for (let s: Dsymbol | null = scope; s !== null; s = s.parent) {
        const fd = s.isFuncDeclaration();
        if (fd === null)
            return null;
        if (fd.isThis() !== null)
            return fd;
    }
    return null;
}

/**
 * The import named `id` declared in a function body holding the place, before it (`import io = std.stdio;`, `import
 * std.stdio;` named by `std`): such an import is in the body's scope, which no symbol table of the function holds.
 */
function localImport(place: Place, id: Identifier): Dsymbol | null {
    return place.imports.find((imp) => imp.ident === id) ?? null;
}

/**
 * The imports declared in the function bodies holding byte `off`, before it, in the walk's order (one per import
 * declaration, however many instances' copies the walk met).
 */
function localImports(ix: FileIndex, off: number): Import[] {
    const bodies = ix.functions.filter((f) => f.start <= off && off <= f.end);
    const found = new Map<number, Import>();
    for (const { at, imp } of ix.imports) {
        if (at < off && !found.has(at) && bodies.some((f) => f.start <= at && at <= f.end))
            found.set(at, imp);
    }
    return [...found.values()];
}

/**
 * `id` looked up from the place as the first link of a chain: `lookupLexical`, with an aggregate's base classes and
 * template mixins searched as its own table (`memberOf`), and a function's locals by position: a local declared after
 * the `.` is not in scope there (the lookup goes on outward), and a name that several locals of one function declare
 * (in disjoint blocks, whose types may differ) is not resolved: the function's table holds only the first. A local the
 * walk did not meet takes its position from its own location. In a body with errors (an `ErrorStatement` to the walk:
 * no hits, no locals but the parameters; the common case in an editor, where the function being typed carries the
 * error) such a local's name is not resolved when its position is not known or the body's text declares the name
 * more than once (`declarations`). A string says so.
 */
function lookupFrom(place: Place, id: Identifier): Dsymbol | string | null {
    for (let s: Dsymbol | null = place.scope; s !== null; s = s.parent) {
        if (s.isModule() !== null)
            return lookupLexical(s, id);
        const fd = s.isFuncDeclaration();
        if (fd !== null) {
            // printed only when returned: an instance's name prints its arguments (CTFE-built literals, large)
            const several = (): string => `\`${identText(id)}\` names several locals of \`${str(fd.toPrettyChars())}\``;
            const named = localsOf(place.ix, fd).filter((l) => l.v.ident === id);
            if (named.length > 1)
                return several();
            const local = fd.localsymtab?.lookup(id) ?? null;
            const walked = local !== null ? named.find((l) => l.v === local)?.at : undefined;
            const at = walked ?? (local !== null ? localOffset(place, local) : null);
            const erroneous = (fd.fbody?.isErrorStatement() ?? null) !== null;
            if (local !== null && walked === undefined && erroneous
                && (at === null || declarations(place, fd, id) > 1))
                return several();
            if (local !== null && (at === null || at < place.off))
                return local;
        }
        const sds = s.isScopeDsymbol();
        const found = sds !== null ? memberOf(sds, id) : null;
        if (found !== null)
            return found;
    }
    return null;
}

/** The locals the walk met in `fd` (`FileIndex.locals`), grouped by function at the first need. */
function localsOf(ix: FileIndex, fd: FuncDeclaration): readonly { at: number; v: VarDeclaration }[] {
    if (ix.localsByFunction === null) {
        ix.localsByFunction = new Map();
        for (const l of ix.locals) {
            const owner = l.v.toParent2()!.isFuncDeclaration()!;
            const list = ix.localsByFunction.get(owner) ?? [];
            list.push(l);
            ix.localsByFunction.set(owner, list);
        }
    }
    return ix.localsByFunction.get(fd) ?? [];
}

/** The byte offset of a local's own location in the place's file (its name), or null when it is elsewhere. */
function localOffset(place: Place, v: Dsymbol): number | null {
    const name = v.loc.filename();
    if (name === null || resolve(str(name)) !== resolve(str(place.m.srcfile.toChars())))
        return null;
    const off = v.loc.fileOffset();
    return off < place.ix.bytes.length ? off : null;
}

/** Words before a name that do not declare it (`return x;`, `case x:`, `else x = 1;`). */
const NOT_DECLARING: ReadonlySet<string> = new Set(["return", "case", "goto", "throw", "else", "do", "in", "is", "new",
    "delete", "typeof", "assert", "cast", "mixin", "import", "module", "version", "debug", "break", "continue"]);

/** The words before a parenthesis that make a type (`const(int) x;`, `typeof(y) z;`). */
const TYPE_PARENS: ReadonlySet<string> = new Set(["const", "immutable", "shared", "inout", "typeof", "__vector"]);

/**
 * How many times the text of `fd`'s body (`Body`, in the compiled text) appears to declare `id`, in code: the name
 * after a word that may end a type (an identifier other than NOT_DECLARING, a `]`, a `*`, or the `)` of
 * `const(...)`, `typeof(...)` and their kin, TYPE_PARENS) and followed by what follows a declaration's name (a `;`,
 * an `=` that is not `==`, a `,`, a `)`, a `{` or a `(`); or after `(` or `,` and before `;` or `,` (a `foreach`
 * variable). An expression statement (`if (c) t.x = 1;`, `a = b;`) is never one. An over-count where it errs: a miss
 * where the walk cannot tell the locals apart, never the wrong one.
 */
function declarations(place: Place, fd: FuncDeclaration, id: Identifier): number {
    const body = place.ix.functions.find((f) => f.fd === fd);
    if (body === undefined)
        return Infinity;
    const t = place.ix.bytes;
    const name = encoder.encode(identText(id));
    let n = 0;
    for (let p = body.start; p + name.length <= body.end; p++) {
        if (isIdentByte(t[p - 1]) || isIdentByte(t[p + name.length]) || !name.every((b, i) => t[p + i] === b)
            || !inCode(place.ix, p))
            continue;
        let q = p;
        while (q > 0 && isSpace(t[q - 1]!))
            q--;
        let r = p + name.length;
        while (r < body.end && isSpace(t[r]!))
            r++;
        const c = t[q - 1];
        const after = t[r];
        if ((c === 0x28 || c === 0x2c) && (after === 0x3b || after === 0x2c)) {     // `foreach (i, e; ...)`
            n++;
            continue;
        }
        const named = after === 0x3b || (after === 0x3d && t[r + 1] !== 0x3d) || after === 0x2c || after === 0x29
            || after === 0x7b || after === 0x28;
        let typed = c === 0x5d || c === 0x2a;
        if (isIdentByte(c)) {
            const w = identBefore(t, q);
            typed = w >= 0 && !NOT_DECLARING.has(utf8.decode(t.subarray(w, q)));
        } else if (c === 0x29) {
            let open = q - 1;
            for (let depth = 0; open >= body.start; open--) {
                if (t[open] === 0x29)
                    depth++;
                else if (t[open] === 0x28 && --depth === 0)
                    break;
            }
            let w = open;
            while (w > 0 && isSpace(t[w - 1]!))
                w--;
            const start = identBefore(t, w);
            const word = start >= 0 ? utf8.decode(t.subarray(start, w)) : "";
            typed = TYPE_PARENS.has(word);
        }
        if (typed && named)
            n++;
    }
    return n;
}

/** The member `id` of `sds`, read-only: its table, then its template mixins' (`importedScopes`), its base classes'. */
function memberOf(sds: ScopeDsymbol, id: Identifier): Dsymbol | null {
    const own = sds.symtab?.lookup(id) ?? null;
    if (own !== null)
        return own;
    for (const s of sds.importedScopes ?? []) {
        const tm = s?.isTemplateMixin() ?? null;
        const found = tm !== null ? memberOf(tm, id) : null;
        if (found !== null)
            return found;
    }
    for (const b of sds.isClassDeclaration()?.baseclasses ?? []) {
        const found = b?.sym !== null && b?.sym !== undefined ? memberOf(b.sym, id) : null;
        if (found !== null)
            return found;
    }
    return null;
}

/**
 * The modules whose members a module scope `m.` offers: `m` itself (a package's package.d), then, transitively, the
 * modules it imports publicly.
 */
function exportingModules(sds: ScopeDsymbol): ScopeDsymbol[] {
    const out: ScopeDsymbol[] = [];
    const visit = (s: ScopeDsymbol): void => {
        if (out.includes(s))
            return;
        out.push(s);
        (s.importedScopes?.opSlice() ?? []).forEach((x, i) => {
            const mod = x?.isModule() ?? null;
            if (mod !== null && s.visibilities?.[i] === Visibility.Kind.public_)
                visit(asDsymbol(mod).isScopeDsymbol()!);
        });
    };
    visit(sds);
    return out;
}

/** The module a scope target's members come from: a module itself, a package its package.d (else null). */
function scopeModule(sds: ScopeDsymbol): ScopeDsymbol | null {
    const m = sds.isModule() ?? sds.isPackage()?.isPackageMod() ?? null;
    return m !== null ? asDsymbol(m).isScopeDsymbol() : null;
}

/**
 * The aggregate whose members a value or type of `type` has after a `.` (through a pointer, an enum's base type),
 * else null; an enum type's own members come from its declaration (`completionItems`).
 */
function aggregateOf(type: Type): AggregateDeclaration | null {
    const t = baseOf(type);
    return typeSymbol(t.isTypePointer()?.next ?? t)?.isAggregateDeclaration() ?? null;
}

/** An enum type's base type, through enums of enums, read-only (`memtype`; not `toBasetype`, which may analyse). */
function baseOf(type: Type): Type {
    let t = type;
    for (let te = t.isTypeEnum(); te !== null && te.sym?.memtype !== null && te.sym?.memtype !== undefined;
        te = t.isTypeEnum())
        t = te.sym.memtype;
    return t;
}

/**
 * The member `id` after the `.` of `target`: a scope's table entry (a package's submodule, else its package.d's
 * member; a module's own member, else what its imports that are not private give, `searchModule`: null when two give
 * different symbols), an aggregate's member (through `alias this` for a value), an enum's member.
 */
function memberNamed(target: Target, id: Identifier): Dsymbol | null {
    if (target.kind === "scope") {
        const sub = target.sds.isModule() === null ? target.sds.symtab?.lookup(id) ?? null : null;
        if (sub !== null)
            return sub;
        const m = scopeModule(target.sds);
        return m !== null ? single(searchModule(m, id)) : null;
    }
    const te = target.kind === "type" ? target.type.isTypeEnum() : null;
    if (te !== null)
        return te.sym?.symtab?.lookup(id) ?? null;
    const ad = aggregateOf(target.type);
    if (ad === null)
        return null;
    const found = memberOf(ad, id);
    const through = target.kind === "value" && found === null ? aliasThisType(ad) : null;
    const inner = through !== null ? aggregateOf(through) : null;
    return found ?? (inner !== null ? memberOf(inner, id) : null);
}

/** The type an aggregate's `alias this` gives (a field's, a function's return type), else null. */
function aliasThisType(ad: AggregateDeclaration): Type | null {
    const sym = ad.aliasthis?.sym ?? null;
    if (sym === null)
        return null;
    const fd = sym.isFuncDeclaration();
    if (fd !== null)
        return fd.type?.isTypeFunction()?.next ?? null;
    return sym.isVarDeclaration()?.type ?? null;
}

/**
 * What `sym`, named by `link`, gives after a `.`: a variable or an enum member a value of its type (a field read
 * through a value qualified `outer` takes its qualifiers: D's transitive `const`); a function the value it returns,
 * `()` written or not (D's optional parentheses), when every overload is callable with no arguments, returns one type,
 * not `void`, and none is a template (`returnType`); an aggregate or an enum its type; an alias its target; an import,
 * a module or a package its scope. Then the link's `()` and `[...]` (`applyOps`). A string says why not.
 */
function symbolTarget(sym: Dsymbol, link: Link, outer: number, depth = 0): Target | string {
    const al = sym.isAliasDeclaration();
    if (al !== null && sym.isFuncAliasDeclaration() === null) {
        const to = aliasTarget(al);
        if (to !== null && depth < ALIAS_DEPTH)
            return symbolTarget(to, link, outer, depth + 1);
        return al.type !== null && al.type.ty !== TY.Tident ? applyOps({ kind: "type", type: al.type }, link)
            : `\`${link.name}\` is an alias the analysis did not resolve`;
    }
    const imp = sym.isImport();
    if (imp !== null) {
        const sds = imp.aliasId === null ? imp.pkg : imp.mod !== null ? asDsymbol(imp.mod).isScopeDsymbol() : null;
        return sds !== null ? applyOps({ kind: "scope", sds }, link)
            : `\`${link.name}\` is an import the analysis did not resolve`;
    }
    if (sym.isModule() !== null || sym.isPackage() !== null)
        return applyOps({ kind: "scope", sds: sym.isScopeDsymbol()! }, link);
    const em = sym.isEnumMember();
    if (em !== null)
        return em.ed?.type !== null && em.ed?.type !== undefined
            ? applyOps({ kind: "value", type: em.ed.type, mod: em.ed.type.mod }, link)
            : `\`${link.name}\`'s enum has no type`;
    const v = sym.isVarDeclaration();
    if (v !== null) {
        if (v.type === null || v.type.ty === TY.Tident)
            return `\`${link.name}\` has no analysed type`;
        const mod = v.type.mod | (v.isField() ? outer & (MODFlags.const_ | MODFlags.immutable_ | MODFlags.wild) : 0);
        return applyOps({ kind: "value", type: v.type, mod }, link);
    }
    const fd = sym.isFuncDeclaration();
    if (fd !== null) {
        const ret = returnType(fd, link.name);
        if (typeof ret === "string")
            return ret;
        const ops = link.ops[0] === "call" ? link.ops.slice(1) : link.ops;   // the call the return type stands for
        return applyOps({ kind: "value", type: ret, mod: ret.mod }, { ...link, ops });
    }
    const ad = sym.isAggregateDeclaration();
    const ed = sym.isEnumDeclaration();
    const type = ad?.type ?? ed?.type ?? null;
    if (type !== null)
        return applyOps({ kind: "type", type }, link);
    return sym.isTemplateDeclaration() !== null || sym.isOverloadSet() !== null ? `\`${link.name}\` is a template`
        : `\`${link.name}\` is a ${str(sym.kind())}`;
}

/**
 * The type the overload set of `fd` returns when called with no arguments: every overload a function (not a template)
 * whose parameters all have defaults (or an `@property` one), returning that one type, not `void`; else why not.
 */
function returnType(fd: FuncDeclaration, name: string): Type | string {
    let ret: Type | null = null;
    for (const s of overloadSet(fd)) {
        const tf = s.isFuncDeclaration()?.type?.isTypeFunction() ?? null;
        if (s.isTemplateDeclaration() !== null)
            return `\`${name}\` is a template`;
        const params = tf?.parameterList.parameters?.opSlice() ?? [];
        if (tf !== null && !tf.isProperty && params.some((p) => p !== null && p.defaultArg === null))
            return `\`${name}\` needs arguments`;
        const next = tf?.next ?? null;
        if (next === null || next.ty === TY.Tident)
            return `\`${name}\`'s return type is not inferred`;
        if (next.ty === TY.Tvoid)
            return `\`${name}\` returns \`void\``;
        if (ret !== null && next !== ret && (next.deco === null || next.deco !== ret.deco))
            return `\`${name}\` is overloaded with other return types`;
        ret = next;
    }
    return ret!;
}

/** `target` after the link's `()` and `[...]`: an index gives an array's or a pointer's element, an AA's value. */
function applyOps(target: Target, link: Link): Target | string {
    let t = target;
    for (const op of link.ops) {
        if (t.kind !== "value")
            return `\`${link.name}\` is not a value`;
        if (op === "call")
            return `\`${link.name}()\` calls what is not a function`;
        const next = elementType(t.type);
        if (next === null || t.type.isTypeReference() !== null)
            return `\`${link.name}[...]\` indexes what is not an array or a pointer`;
        t = { kind: "value", type: next, mod: next.mod | (t.mod & (MODFlags.const_ | MODFlags.immutable_)) };
    }
    return t;
}

/** The items after the `.` of `target` (COMPLETION in the header), one per name, unsorted. */
function completionItems(place: Place, target: Target): CompletionItem[] {
    const items = new Map<string, CompletionItem>();
    const add = (sym: Dsymbol, group: 0 | 1, detailOf: Dsymbol = sym): void => {
        const label = identText(sym.ident);
        if (!items.has(label))
            items.set(label, completionItem(sym, label, group, detailOf, group === 0));
    };
    if (target.kind === "scope") {
        if (target.sds.isModule() === null) {
            for (const [, s] of target.sds.symtab?.tab.asRange() ?? []) {
                if (s.isPackage() !== null)
                    add(s, 0);
            }
        }
        const m = scopeModule(target.sds);
        for (const sds of m !== null ? exportingModules(m) : []) {
            for (const [, s] of sds.symtab?.tab.asRange() ?? []) {
                if (listable(s) && accessible(s, place))
                    add(s, 0);
            }
        }
        return [...items.values()];
    }
    const te = target.kind === "type" ? target.type.isTypeEnum() : null;
    for (const [, s] of te?.sym?.symtab?.tab.asRange() ?? []) {
        if (s.isEnumMember() !== null)
            add(s, 0);
    }
    const ad = te === null ? aggregateOf(target.type) : null;
    const mod = target.kind === "value" ? receiverMod(target) : 0;
    if (ad !== null) {
        const instance = target.kind === "value";
        aggregateMembers(ad, (s) => {
            if (listable(s) && accessible(s, place) && (instance ? callableOn(s, mod) : isStaticMember(s)))
                add(s, 0);
        });
        const through = instance ? aliasThisType(ad) : null;
        const inner = through !== null ? aggregateOf(through) : null;
        if (inner !== null)
            aggregateMembers(inner, (s) => {
                if (listable(s) && accessible(s, place) && callableOn(s, mod))
                    add(s, 0);
            });
    }
    if (target.kind === "value") {
        for (const [s, fd] of ufcsCandidates(place, target.type, target.mod))
            add(s, 1, fd);
    }
    const valueEnum = target.kind === "value" ? target.type.isTypeEnum() : null;
    const type = target.kind === "value" ? baseOf(target.type) : target.type;
    for (const b of builtins(type, ad, valueEnum !== null ? target.type : null))
        if (!items.has(b.label))
            items.set(b.label, b);
    return [...items.values()];
}

/** A value's qualifiers as a receiver of its members' methods: a pointer's, with its target's (`const(S)*`). */
function receiverMod(target: { type: Type; mod: number }): number {
    const next = baseOf(target.type).isTypePointer()?.next ?? null;
    return (target.mod | (next?.mod ?? 0)) & RECEIVER_MODS;
}

/**
 * Whether a member `s` reached through a value qualified `mod` may be offered: not a function, or a function (one of
 * its overloads, a member template's eponymous function) that is static or whose `this` qualifier the receiver
 * converts to (`modConverts`: a `const` receiver calls `const`, `inout` and `immutable`-less methods, ...).
 */
function callableOn(s: Dsymbol, mod: number): boolean {
    const root = s.isFuncDeclaration() ?? s.isTemplateDeclaration();
    if (root === null)
        return true;
    return overloadSet(root).some((f) => {
        const fd = f.isFuncDeclaration() ?? f.isTemplateDeclaration()?.onemember?.isFuncDeclaration() ?? null;
        return fd === null || fd.isStatic() || modConverts(mod, thisMod(fd));
    });
}

/**
 * The qualifier of a member function's `this`: its type's, with the storage classes that make it (a member template's
 * function is not analysed, and its parsed type carries none of them).
 */
function thisMod(fd: FuncDeclaration): number {
    const stc = fd.storage_class;
    return (fd.type?.mod ?? 0) | ((stc & STC.const_) !== 0n ? MODFlags.const_ : 0)
        | ((stc & STC.immutable_) !== 0n ? MODFlags.immutable_ : 0) | ((stc & STC.wild) !== 0n ? MODFlags.wild : 0)
        | ((stc & STC.shared_) !== 0n ? MODFlags.shared_ : 0);
}

/**
 * D's implicit conversion of a head qualifier `from` to `to` (dmd/mtype.d `MODimplicitConv`), with `inout` matching
 * every unshared qualifier as a parameter's does by deduction: the same; anything unshared to `const`, `inout` or
 * `inout const`; shared only to shared (`shared const`, `shared inout`); `immutable` also to `shared const`.
 */
function modConverts(from: number, to: number): boolean {
    const shared = MODFlags.shared_;
    if ((from & MODFlags.immutable_) !== 0 && to === (MODFlags.const_ | shared))
        return true;
    if ((from & shared) !== (to & shared))
        return false;
    const f = from & ~shared;
    const t = to & ~shared;
    return f === t || t === MODFlags.const_ || t === MODFlags.wild || t === MODFlags.wildconst;
}

/** Calls `f` with each member of `ad`'s table, its template mixins' and its base classes', each table once. */
function aggregateMembers(sds: ScopeDsymbol, f: (s: Dsymbol) => void, seen = new Set<ScopeDsymbol>()): void {
    if (seen.has(sds))
        return;
    seen.add(sds);
    for (const [, s] of sds.symtab?.tab.asRange() ?? [])
        f(s);
    for (const s of sds.importedScopes ?? []) {
        const tm = s?.isTemplateMixin() ?? null;
        if (tm !== null)
            aggregateMembers(tm, f, seen);
    }
    for (const b of sds.isClassDeclaration()?.baseclasses ?? []) {
        if (b?.sym !== null && b?.sym !== undefined)
            aggregateMembers(b.sym, f, seen);
    }
}

/**
 * Whether a table entry is a name to offer: not a compiler-made one (`__ctor`, `__dtor`, `__postblit`, `__invariant`,
 * `__unittest...`, `this`), not an import's package name.
 */
function listable(s: Dsymbol): boolean {
    return !isCompilerName(s) && s.isImport() === null;
}

/**
 * Whether a member is reached through its type (`S.x`): a static or `__gshared` variable, a manifest constant, an
 * enum member, a static function (the first of its overloads, a function template's eponymous one), a type, an
 * alias, a template.
 */
function isStaticMember(s: Dsymbol): boolean {
    const v = s.isVarDeclaration();
    if (v !== null)
        return v.isEnumMember() !== null || (v.storage_class & (STC.static_ | STC.gshared | STC.manifest)) !== 0n;
    const fd = s.isFuncDeclaration() ?? s.isTemplateDeclaration()?.onemember?.isFuncDeclaration() ?? null;
    return fd === null || fd.isStatic();
}

/**
 * Whether `s` is visible from the place (approximated): `private` from its own module only; `package` from a module
 * of its package (`package(p)`'s, else its module's parent package; two modules of no package share it); `protected`
 * from its own module or inside a class derived from its class; `none` never; the rest always.
 */
function accessible(s: Dsymbol, place: Place): boolean {
    const vis = s.visible();
    const home = s.getModule();
    switch (vis.kind) {
        case Visibility.Kind.none:
            return false;
        case Visibility.Kind.private_:
            return home === place.m;
        case Visibility.Kind.package_: {
            const pkg = vis.pkg ?? home?.parent?.isPackage() ?? null;
            return home === place.m || (pkg === null ? place.m.parent === null
                : pkg.isAncestorPackageOf(asDsymbol(place.m).isPackage()));
        }
        case Visibility.Kind.protected_: {
            const cd = s.toParent()?.isClassDeclaration() ?? null;
            let from: Dsymbol | null = place.scope;
            while (from !== null && from.isAggregateDeclaration() === null)
                from = from.parent;
            const fromClass = from?.isClassDeclaration() ?? null;
            return home === place.m || (cd !== null && fromClass !== null && derives(fromClass, cd));
        }
        default:
            return true;
    }
}

/** Whether `cd` is `base` or derives from it, through base classes and interfaces. */
function derives(cd: ClassDeclaration, base: ClassDeclaration): boolean {
    if (cd === base)
        return true;
    for (const b of cd.baseclasses) {
        if (b?.sym !== null && b?.sym !== undefined && derives(b.sym, base))
            return true;
    }
    return false;
}

/**
 * A table entry as an item: its kind, the hover's signature on one line, the doc comment's summary as dmd's section
 * split gives it (`DocComment.parse`, the hover's), on one line.
 */
function completionItem(sym: Dsymbol, label: string, group: CompletionGroup, detailOf: Dsymbol, counted: boolean):
    CompletionItem {
    const fd = detailOf.isFuncDeclaration();
    const overloads = fd !== null && counted ? overloadCount(fd) - 1 : 0;
    const signature = withContext(contextOf(detailOf), () => signatureOf(detailOf)).replace(/\s*\n\s*/g, " ");
    // the overload the item shows (a UFCS candidate's, the one taking the receiver) has the first say
    const own = summaryOf(detailOf);
    return { label, kind: completionKind(sym), detail: overloads > 0 ? `${signature} (+${overloads} overloads)`
        : signature, documentation: own !== "" || detailOf === sym ? own : summaryOf(sym), group };
}

/**
 * The item kind of `sym`: a variable `enumMember`, `constant` (a manifest constant), `field` or `variable`; an
 * `@property` function `property`; else its semantic token's type (`tokenKind`), `namespace` as `module`, `type` (an
 * alias of a non-aggregate type, a template without an eponymous member) and `parameter` as `typeParameter` and
 * `variable`.
 */
function completionKind(sym: Dsymbol): CompletionKind {
    const v = sym.isVarDeclaration();
    if (v !== null)
        return v.isEnumMember() !== null ? "enumMember" : (v.storage_class & STC.manifest) !== 0n ? "constant"
            : v.isField() ? "field" : "variable";
    if (sym.isFuncDeclaration()?.type?.isTypeFunction()?.isProperty === true)
        return "property";
    const k = tokenKind(sym);
    const name = k === null ? "variable" : SEMANTIC_TOKEN_TYPES[k.type]!;
    return name === "namespace" ? "module" : name === "type" ? "typeParameter" : name === "parameter" ? "variable"
        : name as CompletionKind;
}

/**
 * The UFCS candidates for a receiver of type `receiver` (COMPLETION in the header), by name, with the function whose
 * first parameter matched: the free functions of the place's module, of the modules it imports (their public
 * imports followed), of its selective imports and of the function-local imports before the place; a function
 * template by an instance the last compile made. Read-only: the tables and the instance table, no lookup that
 * analyses.
 */
function ufcsCandidates(place: Place, receiver: Type, mod: number): Map<Dsymbol, FuncDeclaration> {
    const out = new Map<Dsymbol, FuncDeclaration>();
    const names = new Set<Identifier>();
    const consider = (s: Dsymbol): void => {
        if (s.ident === null || names.has(s.ident) || isCompilerName(s) || !accessible(s, place))
            return;
        const al = s.isAliasDeclaration();
        const target = al !== null && s.isFuncAliasDeclaration() === null ? aliasTarget(al) : s;
        if (target === null || (target.isFuncDeclaration() === null && target.isTemplateDeclaration() === null))
            return;
        for (const f of overloadSet(target)) {
            const fd = f.isFuncDeclaration() !== null ? f.isFuncDeclaration()!
                : instancesOf(f).map((ti) => ti.aliasdecl?.isFuncDeclaration() ?? null)
                    .find((x) => x !== null && receives(x, receiver, mod)) ?? null;
            if (fd !== null && (f.parent?.isModule() ?? null) !== null && receives(fd, receiver, mod)) {
                names.add(s.ident);
                out.set(s, fd);
                return;
            }
        }
    };
    const scopes = new Set<ScopeDsymbol>();
    const visit = (sds: ScopeDsymbol): void => {
        if (scopes.has(sds))
            return;
        scopes.add(sds);
        for (const [, s] of sds.symtab?.tab.asRange() ?? [])
            consider(s);
        const imported = sds.importedScopes?.opSlice() ?? [];
        imported.forEach((s, i) => {
            const own = sds === asDsymbol(place.m);
            if (s !== null && (own || sds.visibilities?.[i] === Visibility.Kind.public_))
                visit(s.isScopeDsymbol()!);
        });
    };
    visit(asDsymbol(place.m).isScopeDsymbol()!);
    for (const imp of place.imports) {
        if (imp.mod !== null && imp.aliasId === null && imp.names.length === 0)
            visit(asDsymbol(imp.mod).isScopeDsymbol()!);
        for (const al of imp.aliasdecls.opSlice())
            if (al !== null)
                consider(al);
    }
    return out;
}

/** The head qualifiers' prefix of a mangled type name: `shared` `O`, `const` `x`, `immutable` `y`, `inout` `Ng`. */
const HEAD_MODS = /^(?:O|x|y|Ng)+/;

/** A type's mangled name less its head qualifiers, or null before the type is merged. */
function nakedDeco(t: Type): string | null {
    return t.deco?.replace(HEAD_MODS, "") ?? null;
}

/**
 * Whether `fd` takes a receiver of type `receiver`, qualified `mod`, as its first parameter, as D passes it: the
 * same type with its qualifiers converted as D converts them (`converts`), or a class it derives from (by value); a
 * by-value parameter of a type without indirections (a basic type) also drops the receiver's qualifier, as a copy
 * may. A `ref` or `out` parameter binds the same type, its head qualifier converted. No other conversion, no
 * template constraint: never a guess.
 */
function receives(fd: FuncDeclaration, receiver: Type, mod: number): boolean {
    const param = fd.type?.isTypeFunction()?.parameterList.parameters?.opSlice()[0] ?? null;
    const p = param?.type ?? null;
    if (param === null || p === null)
        return false;
    if ((param.storageClass & (STC.ref_ | STC.out_)) !== 0n)
        return nakedDeco(p) !== null && nakedDeco(p) === nakedDeco(receiver) && modConverts(mod, p.mod);
    const from = receiver.isTypeClass()?.sym ?? null;
    const to = p.isTypeClass()?.sym ?? null;
    if (from !== null && to !== null)
        return derives(from, to) && modConverts(mod, p.mod);
    return converts(receiver, p, mod) || (nakedDeco(p) !== null && nakedDeco(p) === nakedDeco(receiver)
        && !mutableIndirections(receiver, new Set()));
}

/**
 * Whether a copy of a `type` value shares mutable data with it, decided read-only: a basic type, an enum of one, a
 * static array of such, a struct whose analysed fields (its size final) have none, a slice or pointer of `const` or
 * `immutable` data (as a field declares it), a function pointer, do not; a class reference, an associative array, a
 * delegate, a slice or pointer of other data do; anything else (a struct not yet sized, a type not decided here)
 * counts as one, keeping the miss.
 */
function mutableIndirections(type: Type, seen: Set<AggregateDeclaration>): boolean {
    const t = baseOf(type);
    if (t.isTypeBasic() !== null)
        return false;
    const sa = t.isTypeSArray();
    if (sa !== null)
        return sa.next === null || mutableIndirections(sa.next, seen);
    const target = t.isTypeDArray()?.next ?? t.isTypePointer()?.next ?? null;
    if (target !== null)
        return !target.isImmutable() && !target.isConst() && target.isTypeFunction() === null;
    const sd = t.isTypeStruct()?.sym ?? null;
    if (sd === null || sd.sizeok !== Sizeok.done)
        return true;
    if (seen.has(sd))
        return false;
    seen.add(sd);
    return sd.fields.opSlice().some((v) => v === null || v.type === null || mutableIndirections(v.type, seen));
}

/**
 * Whether a value of type `from`, qualified `mod`, converts to `to` by its qualifiers alone (dmd/mtype.d
 * `MODimplicitConv`, through a slice's or a pointer's target): the head by `modConverts`, then the target of a slice or
 * a pointer, which takes the head's `const` or `immutable` (transitive), the same way.
 */
function converts(from: Type, to: Type, mod: number): boolean {
    if (!modConverts(mod, to.mod))
        return false;
    if (nakedDeco(from) !== null && nakedDeco(from) === nakedDeco(to))
        return true;
    const both = (from.isTypeDArray() !== null && to.isTypeDArray() !== null)
        || (from.isTypePointer() !== null && to.isTypePointer() !== null);
    const a = both ? elementType(from) : null;
    const b = both ? elementType(to) : null;
    return a !== null && b !== null && converts(a, b, a.mod | (mod & (MODFlags.const_ | MODFlags.immutable_)));
}

/**
 * The built-in properties of a value or type of `type` (group 2), the spec's fixed lists: every type's `init`,
 * `sizeof`, `alignof`, `mangleof`, `stringof`; an array's `length`, `ptr`, `dup`, `idup`; an associative array's
 * `length`, `keys`, `values`, `byKey`, `byValue`, `byKeyValue`, `get`, `remove`, `clear`, `dup`; an enum's and an
 * integral type's `min`, `max`; a floating type's `infinity`, `nan`, `dig`, `epsilon`, `mant_dig`, `max_10_exp`,
 * `max_exp`, `min_10_exp`, `min_exp`, `max`, `min_normal`, `re`, `im`; a class's `classinfo`; an aggregate's (`ad`)
 * `tupleof`. The detail is the type where the spec fixes it. For an enum value (`valueEnum`, `type` its base type),
 * `min` and `max` are the enum's.
 */
function builtins(type: Type, ad: AggregateDeclaration | null, valueEnum: Type | null): CompletionItem[] {
    const name = (t: Type): string => str(t.toChars());
    const self = name(type);
    const list: [string, string][] = [["init", self], ["sizeof", "size_t"], ["alignof", "size_t"],
        ["mangleof", "string"], ["stringof", "string"]];
    if (valueEnum !== null)
        list.push(["min", name(valueEnum)], ["max", name(valueEnum)]);
    const array = type.isTypeDArray() ?? type.isTypeSArray();
    const aa = type.isTypeAArray();
    if (array !== null && array.next !== null) {
        const e = name(array.next);
        list.push(["length", "size_t"], ["ptr", `${e}*`], ["dup", `${e}[]`],
            ["idup", array.next.isImmutable() ? `${e}[]` : `immutable(${e})[]`]);
    } else if (aa !== null && aa.next !== null && aa.index !== null) {
        const [k, v] = [name(aa.index), name(aa.next)];
        list.push(["length", "size_t"], ["keys", `${k}[]`], ["values", `${v}[]`], ["byKey", ""], ["byValue", ""],
            ["byKeyValue", ""], ["get", `${v} get(${k} key, lazy ${v} defaultValue)`],
            ["remove", `bool remove(${k} key)`], ["clear", "void clear()"], ["dup", self]);
    } else if (valueEnum === null && (type.isTypeEnum() !== null || INTEGRAL.has(type.ty))) {
        list.push(["min", self], ["max", self]);
    } else if (FLOATING.has(type.ty)) {
        list.push(["infinity", self], ["nan", self], ["dig", "int"], ["epsilon", self], ["mant_dig", "int"],
            ["max_10_exp", "int"], ["max_exp", "int"], ["min_10_exp", "int"], ["min_exp", "int"], ["max", self],
            ["min_normal", self], ["re", ""], ["im", ""]);
    }
    if (type.isTypeClass() !== null)
        list.push(["classinfo", "TypeInfo_Class"]);
    if (ad !== null && type.isTypePointer() === null)
        list.push(["tupleof", ""]);
    return list.map(([label, detail]) => ({ label, kind: "property", detail, documentation: "", group: 2 }));
}


// ── resolution on hover ──────────────────────────────────────────────────────────────────────────────────────

/**
 * One part of a hover's Resolved section (RESOLVED in the header): the token it is for, a label, hdrgen's text (printed
 * once, when first asked), and whether that text may name the compiler's temporaries (a lowered `foreach` does).
 */
interface Resolution {
    start: number;
    end: number;
    label: string;
    text: () => string;
    inst: TemplateInstance | null;
    temporaries: boolean;
    /** The function a lowering calls (an operator's overload, `opApply`), whose doc summary follows the part. */
    called: FuncDeclaration | null;
}

/** A temporary the compiler named (`__r12`, `__key38`, `__tmpfordtor4`): genIdent's names end with a number. */
const TEMPORARY = /\b__[a-z][A-Za-z]*\d+\b/;

const LOWERED = "Lowered:";

/** The D operators a lowering's location may be at, longest first (`in` and `!in` apart). */
const OPERATORS = [">>>=", ">>>", ">>=", "<<=", "^^=", "==", "!=", "<=", ">=", "<<", ">>", "+=", "-=", "*=", "/=",
    "%=", "&=", "|=", "^=", "~=", "^^", "++", "--", "+", "-", "*", "/", "%", "&", "|", "^", "~", "!", "<", ">", "=",
    "[", "$"].map((op) => encoder.encode(op));

/** The end of the operator token at `p` (`in` and `!in` included), or -1 when none starts there. */
function operatorEnd(t: Uint8Array, p: number): number {
    if (wordAt(t, p) === "in")
        return p + 2;
    if (t[p] === 0x21 && wordAt(t, p + 1) === "in")
        return p + 3;
    for (const op of OPERATORS) {
        if (op.every((b, i) => t[p + i] === b))
            return p + op.length;
    }
    return -1;
}

/** The last code byte before the expression starting at `p`, past the `(` of a parenthesised one; -1 if none. */
function beforeOperand(t: Uint8Array, nc: [number, number][], p: number): number {
    let q = prevCode(t, nc, p);
    while (q >= 0 && t[q] === 0x28)
        q = prevCode(t, nc, q);
    return q;
}

/** The offset of the `cast` of a written `cast(...)` before the expression starting at `p`, else -1. */
function castBefore(t: Uint8Array, nc: [number, number][], p: number): number {
    let q = beforeOperand(t, nc, p);
    if (q < 0 || t[q] !== 0x29)
        return -1;
    let depth = 0;
    for (; q >= 0; q = prevCode(t, nc, q)) {
        if (t[q] === 0x29)
            depth++;
        else if (t[q] === 0x28 && --depth === 0)
            break;
    }
    const w = q >= 0 ? prevCode(t, nc, q) : -1;
    return w >= 0 && wordEndingAt(t, w) === "cast" ? w - 3 : -1;
}

/**
 * The operator overloads the analysis locates at their object, not at their operator (dmd/opover.d, a template call
 * at `e.e1.loc`): their token is found from the object, before it (`-a`, `++a`, `cast(int) a`, `-a[i]`) or after it
 * (`a[i] += x`).
 */
const LOCATED_AT_OBJECT: ReadonlySet<string> = new Set(["opUnary", "opCast", "opIndexUnary", "opSliceUnary",
    "opIndexOpAssign", "opSliceOpAssign"]);

/**
 * The operator token of a call `ce` of one of LOCATED_AT_OBJECT's overloads whose object starts at `object`: the
 * template's string argument (`-` of `opUnary!"-"`; `+=` for `opIndexOpAssign!"+"`), `cast` for `opCast`; the token
 * before the object, or for an assignment the first one after it at its nesting level. Null when the text there is not
 * that operator (a postfix `a++`, a call written by hand).
 */
function operatorAtObject(t: Uint8Array, nc: [number, number][], ce: CallExp, name: string, object: number):
    [number, number] | null {
    if (object < 0)
        return null;
    if (name === "opCast") {
        const c = castBefore(t, nc, object);
        return c >= 0 ? [c, c + 4] : null;
    }
    const ti = ce.f!.parent?.isTemplateInstance() ?? null;
    const arg = ti !== null && ti.tiargs !== null && ti.tiargs.length !== 0 ? ti.tiargs.opIndex(0) : null;
    const lit = arg !== null && arg.dyncast() === DYNCAST.expression ? (arg as Expression).isStringExp() : null;
    if (lit === null)
        return null;
    const op = encoder.encode(`${exprText(lit).slice(1, -1)}${name.endsWith("OpAssign") ? "=" : ""}`);
    const at = (p: number): boolean => op.every((b, i) => t[p + i] === b);
    if (!name.endsWith("OpAssign")) {
        const q = beforeOperand(t, nc, object);
        return q >= 0 && at(q - op.length + 1) ? [q - op.length + 1, q + 1] : null;
    }
    let depth = 0;
    const p = scanCode(t, nc, object, (c, i) => {
        if (c === 0x28 || c === 0x5b || c === 0x7b)
            depth++;
        else if (c === 0x29 || c === 0x5d || c === 0x7d)
            return --depth < 0;
        return c === 0x3b || (depth === 0 && at(i) && t[i + op.length] !== 0x3d);
    });
    return p < t.length && at(p) ? [p, p + op.length] : null;
}

/**
 * Whether `a` and `b` are one type but for their modifiers (`int` and `const(int)`, `char[]` and `const(char)[]`): a
 * conversion between them says nothing. Read-only: the types are compared by kind and symbol, never made.
 */
function sameBase(a: Type, b: Type): boolean {
    if (a.ty !== b.ty)
        return false;
    const sa = typeSymbol(a);
    const sb = typeSymbol(b);
    if (sa !== null || sb !== null)
        return sa === sb;
    const na = elementType(a);
    const nb = elementType(b);
    return na === null || nb === null || sameBase(na, nb);
}

/**
 * How many functions and templates the overload set of `fd` declares, read-only: from the first declaration of its
 * name in the scope declaring it (or its template, for an instance's function), along `overnext`, a template's
 * `funcroot`, and the aliases and overload aliases in the set. Overload sets merged across modules at lookup
 * (`OverloadSet`) are not seen.
 */
function overloadCount(fd: FuncDeclaration): number {
    const ti = fd.parent?.isTemplateInstance() ?? null;
    const decl: Dsymbol = ti !== null && ti.tempdecl !== null && ti.name === fd.ident ? ti.tempdecl : fd;
    const scope = decl.parent?.isScopeDsymbol() ?? null;
    return overloadSet((decl.ident !== null ? scope?.symtab?.lookup(decl.ident) : null) ?? decl).length;
}

/**
 * The functions and templates of the overload set starting at `root` (a scope's symbol of that name), in order,
 * read-only: along `overnext`, a template's `funcroot`, and the aliases and overload aliases in the set.
 */
function overloadSet(root: Dsymbol): (FuncDeclaration | TemplateDeclaration)[] {
    const seen = new Set<Dsymbol>();
    const out: (FuncDeclaration | TemplateDeclaration)[] = [];
    const walk = (start: Dsymbol | null): void => {
        let s = start;
        while (s !== null && !seen.has(s)) {
            seen.add(s);
            const fa = s.isFuncAliasDeclaration();
            const f = s.isFuncDeclaration();
            const td = s.isTemplateDeclaration();
            const od = s.isOverDeclaration();
            const al = s.isAliasDeclaration();
            if (fa !== null) {
                walk(fa.funcalias);
                s = fa.overnext;
            } else if (f !== null) {
                out.push(f);
                s = f.overnext;
            } else if (td !== null) {
                out.push(td);
                walk(td.funcroot);
                s = td.overnext;
            } else if (od !== null) {
                walk(od.aliassym);
                s = od.overnext;
            } else if (al !== null) {
                walk(al.aliassym);
                s = al.overnext;
            } else {
                s = null;
            }
        }
    };
    walk(root);
    return out;
}

/**
 * A call as the analysis resolved it, printed through hdrgen: the callee as `object.name` or `name`, an instance's
 * function by its instance (`a.opBinary!"+"`; of nested eponymous instances the outermost, `to!string` for the
 * `to!uint` it holds), then the analysed arguments (`f(a, b)` for UFCS `a.f(b)`).
 */
function callText(ce: CallExp): string {
    const fd = ce.f!;
    const ti = fd.parent?.isTemplateInstance() ?? null;
    const name = ti !== null && ti.name === fd.ident ? str(outermost(ti).toChars()) : identText(fd.ident);
    const dv = ce.e1?.isDotVarExp() ?? null;
    let head = name;
    if (dv !== null && dv.e1 !== null) {
        const o = dv.e1;
        const inner = o.isCallExp();
        const object = inner !== null && inner.f !== null ? callText(inner) : exprText(o);
        const prefixed = (o.isBinExp() !== null && o.isIndexExp() === null) || [o.isCondExp(), o.isCastExp(),
            o.isPtrExp(), o.isNegExp(), o.isNotExp(), o.isComExp(), o.isAddrExp(), o.isUAddExp(), o.isPreExp()]
            .some((x) => x !== null);
        head = `${prefixed ? `(${object})` : object}.${name}`;
    }
    const args = (ce.arguments_?.opSlice() ?? []).map((a) => (a !== null ? exprText(a) : ""));
    return `${head}(${args.join(", ")})`;
}

/** An operator's lowering: the call, or the comparison (`a.opCmp(b) < 0`) or negation (`!a.opEquals(b)`) around it. */
function loweredText(e: Expression): string {
    const ce = e.isCallExp();
    if (ce !== null)
        return callText(ce);
    const not = e.isNotExp();
    if (not !== null)
        return `!${loweredText(not.e1!)}`;
    const cmp = e as CmpExp;   // the walk notes a call, a negation or a comparison (`visitCmpExp`)
    return `${loweredText(cmp.e1!)} ${str(EXPtoString(cmp.op))} ${exprText(cmp.e2!)}`;
}

/** A `foreach` over `opApply`: the call, its delegate (the loop's body) shown by its signature only. */
function opApplyText(ce: CallExp): string {
    const args = (ce.arguments_?.opSlice() ?? []).map((a) => {
        const s = a !== null ? exprText(a) : "";
        const fe = a?.isFuncExp() ?? null;
        return fe !== null ? `${s.replace(/\s*(=>|\{)[\s\S]*$/, "")} { ... }` : s;
    });
    const dv = ce.e1?.isDotVarExp() ?? null;
    const name = identText(ce.f!.ident);
    return `${dv !== null && dv.e1 !== null ? `${exprText(dv.e1)}.${name}` : name}(${args.join(", ")})`;
}

/**
 * A `foreach` over a range lowered to a `for` (dmd/statementsem.d, `visitForeach`): the statements before it (the
 * range's copy), its head, and in its body the loop variables' declarations, the loop's own body elided.
 */
function foreachText(list: readonly Statement[]): string {
    const fs = list[list.length - 1]!.isForStatement()!;
    const lines = list.slice(0, -1).map((s) => statementText(s));
    const init = fs._init !== null ? statementText(fs._init).trim().replace(/;$/, "") : "";
    const cond = fs.condition !== null ? exprText(fs.condition) : "";
    const incr = fs.increment !== null ? exprText(fs.increment) : "";
    lines.push(`for (${init}; ${cond}; ${incr})\n{\n`);
    let body = fs._body;
    while (body !== null && body.isScopeStatement() !== null)
        body = body.isScopeStatement()!.statement;
    const stmts = body?.isCompoundStatement()?.statements?.opSlice() ?? [];
    for (const s of stmts.slice(0, -1))
        if (s !== null)
            lines.push(statementText(s, 1));
    lines.push("    ...\n}\n");
    return lines.join("");
}

/**
 * The Resolved sections of the file by token (RESOLVED in the header), built once per index from the walk's notes. At
 * one token and one analysed copy, one section of each label: the outermost node's (a comparison before its call).
 */
function resolvedOf(m: Module, ix: FileIndex): Map<number, Resolution[]> {
    if (ix.resolved !== null)
        return ix.resolved;
    hitsOf(m, ix);
    const notes = ix.notes!;
    const t = ix.bytes;
    const map = new Map<number, Resolution[]>();
    const add = (start: number, end: number, label: string, print: () => string, inst: TemplateInstance | null,
        temporaries = false, called: FuncDeclaration | null = null) => {
        const list = map.get(start) ?? [];
        let printed: string | null = null;
        const text = (): string => (printed ??= print());
        if (!list.some((r) => r.label === label && r.inst === inst))
            list.push({ start, end, label, text, inst, temporaries, called });
        map.set(start, list);
    };
    /** The member access of an `alias this` access: itself, or the access a call to an `alias this` function calls. */
    const accessOf = (x: Expression): DotVarExp | null => x.isDotVarExp() ?? x.isCallExp()?.e1?.isDotVarExp() ?? null;
    /** Whether the access `x` names its member in the text (`o.inner.x` written, not reached through `alias this`). */
    const written = (x: Expression): boolean => {
        const dv = accessOf(x);
        const key = dv !== null ? notes.keys.get(dv) : undefined;
        return key !== undefined && dv!.var_ !== null && wordAt(t, key) === identText(dv!.var_.ident);
    };
    const covered = new Set<Expression>();
    for (const n of notes.lowered) {
        if (n.kind === "foreach") {
            const word = wordAt(t, n.at);
            add(n.at, n.at + word.length, LOWERED, () => foreachText(n.node as Statement[]), n.inst, true);
            continue;
        }
        const e = n.node as Expression;
        if (n.kind === "aliasThis") {   // a member reached through an access, or the access itself (its object's key)
            const access = accessOf(e);
            const key = access !== null ? notes.keys.get(access) : undefined;
            const inner = e.isDotVarExp()?.e1 ?? null;
            if (key === undefined)
                continue;
            if (inner !== null && isAliasThisAccess(inner) && !written(inner)) {
                covered.add(inner);
                add(key, identEnd(t, key), "Through `alias this`:", () => exprText(e), n.inst);
            } else if (isAliasThisAccess(e) && !covered.has(e) && !written(e)) {
                add(key, identEnd(t, key), "Through `alias this`:", () => exprText(e), n.inst);
            }
            continue;
        }
        if (n.kind === "cast") {
            const ce = e.isCastExp()!;
            const from = ce.e1?.type ?? null;
            if (ce.to === null || from === null || ce.to.ty === TY.Tvoid || isLiteral(ce.e1!) || sameBase(ce.to, from)
                || castBefore(t, ix.nonCode, n.first >= 0 ? n.first : n.at) >= 0)
                continue;
            const key = notes.keys.get(ce.e1!) ?? notes.keys.get(ce.e1!.isCallExp()?.e1 ?? ce.e1!);
            const end = key !== undefined ? identEnd(t, key) : isIdentStart(t[n.at]) ? identEnd(t, n.at)
                : operatorEnd(t, n.at);
            if (end >= 0)
                add(key ?? n.at, end, "Implicit conversion:", () => exprText(e), n.inst);
            continue;
        }
        const ce = e.isCallExp();
        if (ce === null) {   // a comparison or a negation around an operator's call, at the operator
            const end = operatorEnd(t, n.at);
            const inner = (e.isNotExp()?.e1 ?? (e as CmpExp).e1)?.isCallExp()?.f ?? null;
            if (end >= 0)
                add(n.at, end, LOWERED, () => loweredText(e), n.inst, false, inner);
            continue;
        }
        const fd = ce.f!;
        const name = identText(fd.ident);
        if (OPERATOR_FUNCTION.test(name)) {
            const word = wordAt(t, n.at);
            const loop = word === "foreach" || word === "foreach_reverse";
            if ((name === "opApply" || name === "opApplyReverse") && loop) {
                add(n.at, n.at + word.length, LOWERED, () => opApplyText(ce), n.inst, false, fd);
                continue;
            }
            if (LOCATED_AT_OBJECT.has(name)) {
                const op = operatorAtObject(t, ix.nonCode, ce, name, n.object);
                if (op !== null)
                    add(op[0], op[1], LOWERED, () => loweredText(ce), n.inst, false, fd);
                continue;
            }
            const end = operatorEnd(t, n.at);
            if (end >= 0 && t[n.at] !== 0x28) {
                add(n.at, end, LOWERED, () => loweredText(ce), n.inst, false, fd);
                continue;
            }
        }
        const key = ce.e1 !== null ? notes.keys.get(ce.e1) : undefined;
        if (key === undefined)
            continue;
        const end = identEnd(t, key);
        const next = t[skipTrivia(t, end)];
        const dot = prevCode(t, ix.nonCode, key);
        if (ce.e1!.isVarExp() !== null && fd.isMember2() === null && t[dot] === 0x2e && n.first >= 0 && n.first < dot)
            add(key, end, "UFCS:", () => callText(ce), n.inst);
        else if (next !== 0x28 && next !== 0x21 && wordAt(t, key) === name)
            add(key, end, "Property call:", () => callText(ce), n.inst);
        const count = overloadCount(fd);
        if (count > 1)
            add(key, end, `Overload picked among ${count} candidates:`, () => signatureOf(fd), n.inst);
    }
    ix.resolved = map;
    return map;
}

/** The Resolved section of `list` (one analysed copy's): its heading, then each part's label and code block. */
function resolvedSection(m: Module, ix: FileIndex, off: number, list: readonly Resolution[]): string {
    // the context of `spellFresh`: the function the token is in, the instance whose copy the parts print
    const fn = scopeAt(m, ix, off);
    return withContext([...contextOf(fn ?? asDsymbol(m)), list[0]?.inst ?? null], () =>
        ["**Resolved**", ...list.map((r) => {
            const doc = r.called !== null ? summaryOf(r.called) : "";
            return `${r.label}\n\n${codeBlock([r.text().trimEnd()])}${doc !== "" ? `\n\n${doc}` : ""}`;
        })].join("\n\n"));
}

/**
 * The parts of one analysed copy among `list`, the first part's, less those whose text names a compiler's temporary
 * (`cast(int)__r12.length` at an array's `foreach`: the user wrote nothing it could name).
 */
function firstCopy(list: readonly Resolution[]): Resolution[] {
    const shown = list.filter((r) => r.temporaries || !TEMPORARY.test(r.text()));
    return shown.filter((r) => r.inst === shown[0]!.inst);
}

/**
 * The hover of a token with no symbol where a lowering sits, at byte `off` of the compiled text of `m`: its Resolved
 * section only, kind `statement` for `foreach`, `expression` for another word (`new`, `cast`), else `operator`; null
 * when none is there.
 */
function resolvedHover(m: Module, ix: FileIndex, off: number): HoverAnswer | null {
    const t = ix.bytes;
    const map = resolvedOf(m, ix);
    let start = off;
    while (isIdentByte(t[start - 1]) && isIdentByte(t[start]))
        start--;
    for (const s of [start, off - 1, off - 2, off - 3]) {
        const parts = firstCopy((map.get(s) ?? []).filter((r) => r.start <= off && off < r.end));
        if (parts.length === 0)
            continue;
        const name = utf8.decode(t.subarray(s, parts[0]!.end));
        const word = isIdentStart(t[s]) && name !== "in";
        const kind = !word ? "operator" : name.startsWith("foreach") ? "statement" : "expression";
        return { result: { kind, name, markdown: resolvedSection(m, ix, s, parts), range: { start: positionOf(t, s),
            end: positionOf(t, parts[0]!.end) } } };
    }
    return null;
}

/**
 * Runs `f` with hdrgen's `optimize` slot set to the identity, then restores optimize.ts's `optimize`. The printer
 * folds a variable template argument and a `size_t` expression with `optimize` (dmd/hdrgen.d:3825, :4049), which on
 * a variable whose initializer the analysis has not run yet runs it (`expandVar`: `initializerSemantic`, then
 * `_scope` cleared): semantic at query time. Without it an argument prints as the analysis left it (a variable by
 * its name).
 *
 * Also swaps how a literal of an enum type finds its member's name (`registerEnumMemberInteger`): a member whose
 * initializer failed has no integer value, names no literal, and the literal prints as `cast(E)4u` when no other
 * member matches, where the compile's reader faults as D does (fail_compilation/fail109.d). And after a kept compile
 * that numbered generated identifiers otherwise, every query prints them as a fresh compile numbers them
 * (`spellFresh`, in the context of `printStack`).
 */
function printing<T>(f: () => T, fold: typeof optimize = (e) => e): T {
    registerOptimize(fold);
    registerEnumMemberInteger((em) => memberValue(em)?.isIntegerExp() ?? null);
    const unspell = keepRenumbered() ? spellFresh(printStack) : null;
    try {
        return f();
    } finally {
        unspell?.();
        printStack.length = 0;
        registerOptimize(optimize);
        registerEnumMemberInteger(faithfulEnumMemberInteger);
    }
}

/**
 * The symbols a print is inside, innermost last: `spellFresh`'s context, which decides an identifier that units of
 * different compiles made (`withContext`; the AST view's and an instance's dump push each symbol as it prints).
 */
const printStack: Dsymbol[] = [];

/** Runs `f`, a print, with `syms` (outermost first) on `printStack`. */
function withContext<T>(syms: readonly (Dsymbol | null)[], f: () => T): T {
    const depth = printStack.length;
    for (const s of syms) {
        if (s !== null)
            printStack.push(s);
    }
    try {
        return f();
    } finally {
        printStack.length = depth;
    }
}

/** A symbol's context for `withContext`: its module, then its parents down to it. */
function contextOf(sym: Dsymbol): Dsymbol[] {
    const chain: Dsymbol[] = [];
    for (let p: Dsymbol | null = sym; p !== null; p = p.parent)
        chain.unshift(p);
    return chain;
}

/**
 * The `optimize` of the AST view's print (`queryAst`), in `printing`'s place. hdrgen folds a variable that is a
 * template argument (dmd/hdrgen.d:4049, `Foo!(maxIndex)` prints as `Foo!(1114112LU)`) and an array dimension
 * (dmd/hdrgen.d:3825) with `optimize`, which may run the variable's semantic. This is `optimize`'s fold of a variable
 * (dmd/optimize.d `fromConstInitializer`, `expandVar`) where nothing is analysed or reported: the variable analysed,
 * not in use, its initializer a constant (`isConstant`) of the variable's type, which the semantic that
 * `getConstInitializer` runs on an initializer not yet analysed would leave as it is; the constant painted to the
 * reference's type as `fromConstInitializer` paints it, on a copy. Any other expression, and a variable that `optimize`
 * would analyse or convert (an initializer not yet folded, `enum n = Args.length - 1` read first by hdrgen), prints as
 * written: there the text differs from `-vcg-ast`'s, whose print runs that semantic.
 */
function foldVariable(e: Expression, result: number): Expression {
    const v = e.isVarExp()?.var_.isVarDeclaration() ?? null;
    const x = v !== null ? constantOf(v, result, 0) : null;
    if (x === null)
        return e;
    if (x.type !== e.type && e.type !== null && e.type.ty !== TY.Tident) {
        const painted = x.copy();
        painted.type = e.type;
        return painted;
    }
    return x;
}

/**
 * How many variables `foldVariable` follows when one's initializer is another (`expandVar` recurses through
 * `optimize`, `v.inuse` stopping a cycle, which the analysis reported already): a bound on the print's work, not D's.
 */
const FOLD_DEPTH = 8;

/** `expandVar`'s value of `v` (see `foldVariable`), or null where it has none or would analyse or convert. */
function constantOf(v: VarDeclaration, result: number, depth: number): Expression | null {
    const manifest = (v.storage_class & STC.manifest) !== 0n;
    if (depth > FOLD_DEPTH || (v.originalType === null && v.semanticRun < PASS.semanticdone) || v.type === null
        || !(v.isConst() || v.isImmutable() || manifest) || v.inuse !== 0)
        return null;
    let tb: Type = v.type;
    for (let te = tb.isTypeEnum(); te !== null; te = tb.isTypeEnum()) {
        if (te.sym === null || te.sym.memtype === null)
            return null;    // toBasetype would analyse the enum
        tb = te.sym.memtype;
    }
    if (!manifest && !isScalar(tb) && !((result & WANTexpand) !== 0 && tb.ty !== TY.Tsarray && tb.ty !== TY.Tstruct))
        return null;
    let ei = v._init?.isExpInitializer()?.exp ?? null;
    if (ei === null || tb.ty === TY.Tsarray)
        return null;        // another initializer, or a static array's (`initializerToExpression` may build one)
    if (v._scope !== null) {
        // `getConstInitializer` runs the initializer's semantic first, which leaves a constant of the variable's type
        // as it is (no AA literal: `lowerStaticAAs` would lower it); anything else it would analyse
        return ei.type === v.type && isConstant(ei, false) ? ei : null;
    }
    if (ei.op === EXP.construct || ei.op === EXP.blit) {
        ei = (ei as unknown as AssignExp).e2!;
        if (ei.isConst() !== 1 && ei.op !== EXP.string_)
            return null;
        if (ei.op === EXP.string_ && (result & WANTexpand) === 0 && ei.type?.ty === TY.Tpointer)
            return null;
    } else if (!manifest && ei.isConst() !== 1 && ei.op !== EXP.string_ && ei.op !== EXP.address)
        return null;
    if (ei.type === null || ei.type !== v.type)
        return null;        // `castTo` would convert it
    const inner = ei.isVarExp()?.var_.isVarDeclaration() ?? null;
    if (inner !== null)
        return constantOf(inner, result, depth + 1);
    return isConstant(ei, true) ? ei : null;
}

/**
 * A constant that `optimize` leaves as it is: a literal (a function literal, a class instance CTFE made), or an
 * aggregate or array literal of such; an associative array literal only where `aa`.
 */
function isConstant(e: Expression | null, aa: boolean): boolean {
    if (e === null)
        return true;
    const all = (list: Iterable<Expression | null> | null): boolean => [...list ?? []].every((x) => isConstant(x, aa));
    switch (e.op) {
        case EXP.int64: case EXP.float64: case EXP.complex80: case EXP.null_: case EXP.string_: case EXP.symbolOffset:
        case EXP.function_: case EXP.classReference:
            return true;
        case EXP.structLiteral:
            return all(e.isStructLiteralExp()!.elements);
        case EXP.arrayLiteral:
            return isConstant(e.isArrayLiteralExp()!.basis, aa) && all(e.isArrayLiteralExp()!.elements);
        case EXP.assocArrayLiteral:
            return aa && all(e.isAssocArrayLiteralExp()!.keys) && all(e.isAssocArrayLiteralExp()!.values);
        default:
            return false;
    }
}

// ── what a hover says ────────────────────────────────────────────────────────────────────────────────────────

/** The innermost template instance or mixin `sym` is a member of, else null. */
function enclosingInstance(sym: Dsymbol): TemplateInstance | null {
    for (let p = sym.parent; p !== null; p = p.parent) {
        const ti = p.isTemplateInstance();
        if (ti !== null)
            return ti;
    }
    return null;
}

/** dmd's kind (`Dsymbol.kind`), refined for variables: `parameter`, `field`, `local variable`. */
function kindOf(sym: Dsymbol): string {
    const v = sym.isVarDeclaration();
    if (v !== null && sym.isEnumMember() === null) {
        if (v.isParameter())
            return "parameter";
        if (v.isField())
            return "field";
        // not `isDataseg()`: it caches its answer on the variable, and on one without a parent (`__ctfe`) it reports
        // "forward referenced" and sets the type to `terror` (dmd/declaration.d:588-621)
        const p = v.toParent2();
        if (p !== null && p.isFuncDeclaration() !== null
            && (v.storage_class & (STC.static_ | STC.extern_ | STC.gshared)) === 0n)
            return "local variable";
    }
    return str(sym.kind());
}

/** The declaration as code: a function's signature, a variable's type and name, an aggregate's kind and bases, ... */
function signatureOf(sym: Dsymbol): string {
    const fd = sym.isFuncDeclaration();
    if (fd !== null) {
        const tf = fd.type?.isTypeFunction() ?? null;
        if (tf === null)
            return str(fd.toChars());
        const buf = new OutBuffer();
        functionToBufferFull(tf, buf, fd.ident, new HdrGenState(), null);
        return str(buf.extractSlice());
    }
    const em = sym.isEnumMember();
    if (em !== null) {
        const value = memberValue(em);
        return `${str(sym.toPrettyChars())}${value !== null ? ` = ${str(expressionToChars(value))}` : ""}`;
    }
    const v = sym.isVarDeclaration();
    if (v !== null) {
        const type = v.type !== null ? str(v.type.toChars()) : "auto";
        const manifest = (v.storage_class & STC.manifest) !== 0n;
        const init = manifest && v._init !== null ? ` = ${str(initializerToChars(v._init))}` : "";
        return `${manifest ? "enum " : ""}${type} ${identText(v.ident)}${init}`;
    }
    const ad = sym.isAggregateDeclaration();
    if (ad !== null) {
        const cd = ad.isClassDeclaration();
        const bases = cd !== null && cd.baseclasses.length !== 0
            ? ` : ${cd.baseclasses.opSlice().map((b) => (b?.sym !== null && b?.sym !== undefined
                ? str(b.sym.toPrettyChars()) : str(b?.type?.toChars() ?? null))).join(", ")}` : "";
        return `${str(ad.kind())} ${str(ad.toPrettyChars())}${bases}`;
    }
    const ed = sym.isEnumDeclaration();
    if (ed !== null)
        return `enum ${str(ed.toPrettyChars())}${ed.memtype !== null ? ` : ${str(ed.memtype.toChars())}` : ""}`;
    const al = sym.isAliasDeclaration();
    if (al !== null) {
        const target = al.aliassym !== null ? str(al.aliassym.toPrettyChars())
            : al.type !== null ? str(al.type.toChars()) : "";
        return `alias ${identText(al.ident)} = ${target}`;
    }
    const td = sym.isTemplateDeclaration();
    if (td !== null)
        return `template ${str(dsymbolToChars(td))}`;
    if (sym.isModule() !== null || sym.isPackage() !== null)
        return `${str(sym.kind())} ${str(sym.toPrettyChars())}`;
    return str(sym.toChars());
}

/**
 * The doc comment of `sym`: its own; for a member of a template instance (whose copies carry none), the comment of
 * the template when the member is the instance's eponymous one (the template's own original when the template is a
 * member of an instance, `Vec!int.opBinary!"+"`), else the one of the template member it was copied from (same name,
 * same location). A `ditto` comment stands for the previous documented declaration's (`dittoOf`).
 */
function docOf(sym: Dsymbol): DString | null {
    const own = sym.comment();
    if (own !== null)
        return isDitto(own) ? dittoOf(sym.parent?.isScopeDsymbol()?.members ?? null, sym) : own;
    for (let p = sym.parent; p !== null && p.isModule() === null; p = p.parent) {
        const ti = p.isTemplateInstance();
        const td = ti?.tempdecl?.isTemplateDeclaration() ?? null;
        if (ti === null || td === null)
            continue;
        if (sym.parent === ti && sym.ident === td.ident) {
            const c = td.comment();
            if (c === null)   // a member template of an instance: the template is a copy too
                return td.parent !== null && td.parent.isModule() === null ? docOf(td) : null;
            return isDitto(c) ? dittoOf(td.parent?.isScopeDsymbol()?.members ?? null, td) : c;
        }
        const orig = original(td.members ?? null, sym);
        if (orig === null)
            return null;
        const c = orig.s.comment()!;
        return isDitto(c) ? dittoOf(orig.members, orig.s) : c;
    }
    return null;
}

/**
 * The declaration among `members` (and their nested scopes) with `sym`'s name and location and a comment, with the
 * list that holds it.
 */
function original(members: Iterable<Dsymbol | null> | null, sym: Dsymbol):
    { s: Dsymbol; members: Iterable<Dsymbol | null> } | null {
    const off = sym.loc.fileOffset();
    for (const s of members ?? []) {
        if (s === null)
            continue;
        if (s.ident === sym.ident && s.loc.fileOffset() === off && s.comment() !== null)
            return { s, members: members! };
        const attrib = s.isAttribDeclaration();
        const nested = attrib !== null ? attrib.decl : s.isScopeDsymbol()?.members ?? null;
        const found = nested !== null ? original(nested, sym) : null;
        if (found !== null)
            return found;
    }
    return null;
}

/** dmd/doc.d:1948 `isDitto`: the comment is the word `ditto` alone. */
function isDitto(comment: DString): boolean {
    return /^\s*ditto\s*$/i.test(str(comment));
}

/**
 * The comment `ditto` stands for at `sym`, one of `members`: the last comment before it that is not `ditto`, in the
 * scope's order with attribute blocks opened (dmd/doc.d emits a ditto'd declaration under the previous documented
 * one, `lastdc`). Null when none precedes it.
 */
function dittoOf(members: Iterable<Dsymbol | null> | null, sym: Dsymbol): DString | null {
    const flat: Dsymbol[] = [];
    const open = (list: Iterable<Dsymbol | null> | null): void => {
        for (const s of list ?? []) {
            const attrib = s?.isAttribDeclaration() ?? null;
            if (attrib !== null && attrib.decl !== null)
                open(attrib.decl);
            else if (s !== null)
                flat.push(s);
        }
    };
    open(members);
    let last: DString | null = null;
    for (const s of flat) {
        if (s === sym)
            return last;
        const c = s.comment();
        if (c !== null && !isDitto(c))
            last = c;
    }
    return null;
}

/** The Ddoc macros a hover writes as code (the first argument), the others as their arguments' text. */
const CODE_MACROS: ReadonlySet<string> = new Set(["D", "D_PARAM", "REF", "LREF", "D_CODE", "D_INLINECODE",
    "D_KEYWORD"]);

/** Simplifies Ddoc macros: `$(D x)` and its kin to `` `x` ``, any other `$(NAME args)` to its arguments' text. */
function simplifyMacros(s: string): string {
    let out = "";
    let i = 0;
    while (i < s.length) {
        if (s[i] !== "$" || s[i + 1] !== "(") {
            out += s[i++];
            continue;
        }
        let j = i + 2;
        let depth = 1;
        while (j < s.length && depth > 0) {
            if (s[j] === "(")
                depth++;
            else if (s[j] === ")")
                depth--;
            j++;
        }
        const inner = s.slice(i + 2, depth === 0 ? j - 1 : j);
        const m = /^([A-Za-z_][A-Za-z0-9_]*)[\s,]?([\s\S]*)$/.exec(inner);
        const name = m?.[1] ?? "";
        const args = simplifyMacros((m?.[2] ?? inner).trim());
        if (CODE_MACROS.has(name)) {
            const first = name === "REF" || name === "LREF" ? args.split(",")[0]!.trim() : args;
            out += `\`${first}\``;
        } else {
            out += args;
        }
        i = j;
    }
    return out;
}

/** A section body as Markdown: common indentation removed, `---` code blocks fenced as D, macros simplified. */
function renderBody(body: string): string {
    const lines = body.replace(/\r/g, "").split("\n");
    const indents = lines.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
    const cut = indents.length !== 0 ? Math.min(...indents) : 0;
    let inCode = false;
    const out: string[] = [];
    for (const l of lines.map((x) => x.slice(cut))) {
        if (/^\s*(---+|```+|~~~+)\s*$/.test(l)) {
            out.push(inCode ? "```" : "```d");
            inCode = !inCode;
        } else {
            out.push(inCode ? l : simplifyMacros(l));
        }
    }
    if (inCode)
        out.push("```");
    return out.join("\n").trim();
}

/** `Params:` as a list: each `name = text` starts an entry, a following line continues it. */
function renderParams(body: string): string {
    const items: string[] = [];
    for (const raw of body.replace(/\r/g, "").split("\n")) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
        if (m !== null)
            items.push(`- \`${m[1]}\`: ${simplifyMacros(m[2]!.trim())}`);
        else if (raw.trim() !== "" && items.length !== 0)
            items[items.length - 1] += ` ${simplifyMacros(raw.trim())}`;
    }
    return items.join("\n");
}

/**
 * The doc comment as Markdown, through dmd's own section split (`DocComment.parse`, dmd/doc.d:234): summary and
 * description, then Params as a list, then Returns, Throws, See_Also and the other sections by name. Macros and
 * Copyright are left out (Ddoc output only).
 */
function renderDoc(sym: Dsymbol, comment: DString): string {
    const dc = DocComment.parse(sym, comment);
    const out: string[] = [];
    for (const sec of dc.sections) {
        if (sec === null || sec.nooutput)
            continue;
        const name = str(sec.name);
        const body = str(sec.body_);
        if (name === "") {
            const text = renderBody(body);
            if (text !== "")
                out.push(text);
        } else if (/^params$/i.test(name)) {
            out.push(`**Params**\n\n${renderParams(body)}`);
        } else if (!/^(macros|copyright)$/i.test(name)) {
            out.push(`**${name.replace(/_/g, " ")}**\n\n${renderBody(body)}`);
        }
    }
    return out.join("\n\n");
}

// ── document symbols ─────────────────────────────────────────────────────────────────────────────────────────

/** The symbol kinds `queryDocumentSymbols` gives, LSP's names. */
export type SymbolKindName = "module" | "namespace" | "class" | "struct" | "interface" | "enum" | "enumMember"
    | "function" | "method" | "constructor" | "property" | "field" | "variable" | "constant" | "typeParameter";

/** One declaration of a file's outline (DOCUMENT SYMBOLS in the header). */
export interface DocumentSymbol {
    name: string;
    kind: SymbolKindName;
    /** The signature or type, short (cut at 60 characters); `(mixin) ` before a string mixin's declarations. */
    detail: string;
    /** The whole declaration, and its name, which `range` contains. */
    range: QueryRange;
    selectionRange: QueryRange;
    children: DocumentSymbol[];
}

/** The outline of one file: its declarations as a tree, each level sorted by position. */
export interface DocumentSymbolsResult {
    symbols: DocumentSymbol[];
}

/** The answer of `queryDocumentSymbols`: the outline, or a miss (the file is not in the last compile; `stale`). */
export type DocumentSymbolsAnswer = { result: DocumentSymbolsResult } | QueryMiss;

/**
 * The declarations of `file`, whose editor text is `text`, as a tree (DOCUMENT SYMBOLS in the header), from the last
 * compile; read-only, between compiles (THE CONTRACT). Misses: the file is not in the last compile; `stale`
 * (STALE_REASON) when `text` is not the text that compile read. Cost: the file's index when no query built it since
 * the compile (the nested declarations come from it), then one pass over the module's members, printing each detail.
 */
export function queryDocumentSymbols(file: string, text: string): DocumentSymbolsAnswer {
    return printing(() => {
        const m = moduleOf(file);
        if (m === null)
            return miss("the file is not in the last compile");
        const ix = indexOf(m);
        if (text !== ix.text)
            return miss(STALE_REASON, true);
        hitsOf(m, ix);
        return { result: { symbols: new Outline(m, ix).symbols() } };
    });
}

/** An outline node in byte offsets, converted to positions at the end. */
interface OutlineNode {
    name: string;
    kind: SymbolKindName;
    detail: string;
    range: [number, number];
    selection: [number, number];
    children: OutlineNode[];
}

/** The walk of `queryDocumentSymbols` over one module's members (DOCUMENT SYMBOLS in the header). */
class Outline {
    private readonly file: string;
    private readonly t: Uint8Array;
    /** The nodes made, by name and selection start: a `static foreach` copy or a second branch adds none. */
    private readonly seen = new Set<string>();

    constructor(private readonly m: Module, private readonly ix: FileIndex) {
        this.file = str(m.srcfile.toChars());
        this.t = ix.bytes;
    }

    symbols(): DocumentSymbol[] {
        const nodes: OutlineNode[] = [];
        const md = this.m.md;
        const at = md !== null ? this.offsetIn(md.loc) : null;
        const name = moduleNameAt(this.m, this.ix);
        if (md !== null && at !== null && name >= 0) {
            const full = [...md.packages, md.id!].map(identText).join(".");
            nodes.push(this.make(full, "module", "", [at, this.end(at)], this.selectionAt(name)));
        }
        nodes.push(...this.members(this.m.members, null, ""));
        const convert = (n: OutlineNode): DocumentSymbol => ({
            name: n.name, kind: n.kind, detail: n.detail,
            range: { start: positionOf(this.t, n.range[0]), end: positionOf(this.t, n.range[1]) },
            selectionRange: { start: positionOf(this.t, n.selection[0]), end: positionOf(this.t, n.selection[1]) },
            children: n.children.map(convert),
        });
        return sortNodes(nodes).map(convert);
    }

    /** The byte offset of `loc` when it is in this file, else null. */
    private offsetIn(loc: Loc): number | null {
        const name = loc.isValid() ? loc.filename() : null;
        if (name === null || str(name) !== this.file)
            return null;
        const off = loc.fileOffset();
        return off < this.t.length ? off : null;
    }

    /** The end of the declaration at `off` (`statementEnd`). */
    private end(off: number): number {
        return statementEnd(this.t, this.ix.nonCode, off);
    }

    private selectionAt(start: number): [number, number] {
        return [start, identEnd(this.t, start)];
    }

    private make(name: string, kind: SymbolKindName, detail: string, range: [number, number],
        selection: [number, number], children: OutlineNode[] = []): OutlineNode {
        return { name, kind, detail, range: [Math.min(range[0], selection[0]), Math.max(range[1], selection[1])],
            selection, children: sortNodes(children) };
    }

    /**
     * The nodes of a member list: conditionals by the branch the analysis chose (both when it decided none), the
     * other attributes transparent, a string mixin's declarations at its site (`site`) with `(mixin) ` before their
     * detail (`marker`), the imports in one `imports` node.
     */
    private members(list: Iterable<Dsymbol | null> | null, site: [number, number] | null, marker: string,
        inAggregate = false): OutlineNode[] {
        const out: OutlineNode[] = [];
        const imports: OutlineNode[] = [];
        for (const s of list ?? []) {
            if (s === null)
                continue;
            if (s instanceof ConditionalDeclaration) {
                const inc = s.condition?.inc ?? Include.notComputed;
                if (inc !== Include.no)
                    out.push(...this.members(s.decl, site, marker, inAggregate));
                if (inc !== Include.yes)
                    out.push(...this.members(s.elsedecl, site, marker, inAggregate));
            } else if (s instanceof StaticForeachDeclaration) {
                out.push(...this.members(s.cache, site, marker, inAggregate));
            } else if (s.isMixinDeclaration() !== null) {
                const at = this.offsetIn(s.loc);
                const mixed = site ?? (at !== null ? [at, this.end(at)] as [number, number] : null);
                if (mixed !== null)
                    out.push(...this.members(s.isMixinDeclaration()!.decl, mixed, "(mixin) ", inAggregate));
            } else if (s.isAttribDeclaration() !== null) {
                out.push(...this.members(s.isAttribDeclaration()!.decl, site, marker, inAggregate));
            } else if (s.isImport() !== null) {
                const n = this.importNode(s.isImport()!, site);
                if (n !== null)
                    imports.push(n);
            } else {
                out.push(...this.node(s, site, marker, inAggregate));
            }
        }
        if (imports.length !== 0) {
            const first = imports.reduce((a, b) => (b.range[0] < a.range[0] ? b : a));
            const last = Math.max(...imports.map((n) => n.range[1]));
            out.push(this.make("imports", "namespace", "", [first.range[0], last], first.selection, imports));
        }
        return out;
    }

    /** An import: the module's name as written, its selective names and renames as the detail. */
    private importNode(imp: Import, site: [number, number] | null): OutlineNode | null {
        const off = this.offsetIn(imp.loc);
        const ids = [...(imp.packages ?? []), imp.id!];
        const name = ids.map(identText).join(".");
        const named = off !== null ? findName(this.t, off, [identText(ids[0]!)]) : -1;
        const selection = site ?? (named >= 0 ? this.selectionAt(named) : null);
        if (selection === null || !this.fresh(name, selection[0]))
            return null;
        const names: string[] = [];
        for (let i = 0; i < imp.names.length; i++) {
            const alias = i < imp.aliases.length ? imp.aliases.opIndex(i) : null;
            const n = identText(imp.names.opIndex(i));
            names.push(alias !== null ? `${identText(alias)} = ${n}` : n);
        }
        const detail = (imp.aliasId !== null ? `${identText(imp.aliasId)} = ` : "") + (names.length !== 0
            ? `: ${names.join(", ")}` : "");
        return this.make(name, "module", clip(detail), site ?? [off!, this.end(off!)], selection);
    }

    /** Whether no node has `name` at `start` yet; notes it. */
    private fresh(name: string, start: number): boolean {
        const key = `${start}:${name}`;
        if (this.seen.has(key))
            return false;
        this.seen.add(key);
        return true;
    }

    /** The node of a declaration (none for one the outline skips; an anonymous enum's members). */
    private node(s: Dsymbol, site: [number, number] | null, marker: string, inAggregate = false): OutlineNode[] {
        const off = this.offsetIn(s.loc);
        if (site === null && off === null)
            return [];
        const named = this.named(s, inAggregate);
        if (named === null) {
            const ed = s.isEnumDeclaration();
            return ed !== null ? this.members(ed.members, site, marker, inAggregate) : [];
        }
        let selection = site;
        if (selection === null) {
            const k = keyAt(this.t, off!, namesOf(s));
            selection = k !== null ? this.selectionAt(k.start) : [off!, off!];
        }
        if (!this.fresh(named.name, selection[0]))
            return [];
        const range: [number, number] = site ?? (s.isEnumMember() !== null ? selection
            : [declarationStart(this.t, off!), this.end(off!)]);
        const children = this.childrenOf(s, site, marker, off, inAggregate);
        return [this.make(named.name, named.kind, marker + clip(this.detailOf(s)), range, selection, children)];
    }

    /**
     * The name and kind the outline shows `s` with, `inAggregate` when it is a member of an aggregate (a template's
     * members, not analysed, have no parent to say so); null for an anonymous enum and the declarations it skips.
     */
    private named(s: Dsymbol, inAggregate: boolean): { name: string; kind: SymbolKindName } | null {
        const fd = s.isFuncDeclaration();
        if (fd !== null) {
            if (fd.isFuncLiteralDeclaration() !== null || fd.isNewDeclaration() !== null || fd.isGenerated)
                return null;
            if (fd.isUnitTestDeclaration() !== null)
                return { name: "unittest", kind: "function" };
            if (fd.isCtorDeclaration() !== null)
                return { name: "this", kind: "constructor" };
            if (fd.isPostBlitDeclaration() !== null)
                return { name: "this(this)", kind: "method" };
            if (fd.isDtorDeclaration() !== null)
                return { name: "~this", kind: "method" };
            if (fd.isInvariantDeclaration() !== null)
                return { name: "invariant", kind: "method" };
            const shared = fd.isSharedStaticCtorDeclaration() !== null || fd.isSharedStaticDtorDeclaration() !== null
                ? "shared " : "";
            if (fd.isStaticCtorDeclaration() !== null)
                return { name: `${shared}static this`, kind: "constructor" };
            if (fd.isStaticDtorDeclaration() !== null)
                return { name: `${shared}static ~this`, kind: "function" };
        }
        if (s.ident === null || isCompilerName(s))
            return null;
        const name = identText(s.ident);
        const td = s.isTemplateDeclaration();
        if (td !== null) {
            const one = eponymousOnly(td);
            return { name, kind: one !== null ? this.named(one, inAggregate)?.kind ?? "namespace" : "namespace" };
        }
        if (fd !== null) {
            const property = fd.type?.isTypeFunction()?.isProperty === true;
            const method = inAggregate || fd.isMember2() !== null;
            return { name, kind: property ? "property" : method ? "method" : "function" };
        }
        const ad = s.isAggregateDeclaration();
        if (ad !== null)
            return { name, kind: ad.isInterfaceDeclaration() !== null ? "interface"
                : ad.isClassDeclaration() !== null ? "class" : "struct" };
        if (s.isEnumDeclaration() !== null)
            return { name, kind: "enum" };
        if (s.isEnumMember() !== null)
            return { name, kind: "enumMember" };
        const v = s.isVarDeclaration();
        if (v !== null) {
            const field = inAggregate || v.isField();
            return { name, kind: (v.storage_class & STC.manifest) !== 0n ? "constant" : field ? "field" : "variable" };
        }
        if (s.isAliasDeclaration() !== null)
            return { name, kind: completionKind(s) };
        if (s.isTemplateMixin() !== null)
            return { name, kind: "namespace" };
        return null;
    }

    /** The detail: a function's or variable's type, an aggregate's bases, an alias's target, template parameters. */
    private detailOf(s: Dsymbol): string {
        const td = s.isTemplateDeclaration();
        if (td !== null) {
            const printed = str(dsymbolToChars(td)).slice(identText(td.ident).length);
            let depth = 0;
            let close = 0;
            while (close < printed.length && (printed[close] !== ")" || --depth !== 0))
                depth += printed[close++] === "(" ? 1 : 0;
            const params = printed.slice(0, close + 1);
            const one = eponymousOnly(td);
            return `${params} ${one !== null ? this.detailOf(one) : ""}`.trim();
        }
        const fd = s.isFuncDeclaration();
        if (fd !== null)
            return fd.type !== null ? str(fd.type.toChars()) : "";
        const em = s.isEnumMember();
        if (em !== null)
            return em.origValue !== null ? str(expressionToChars(em.origValue)) : "";
        const v = s.isVarDeclaration();
        if (v !== null) {
            const type = v.type ?? v.originalType;
            return type !== null ? str(type.toChars()) : "";
        }
        const ed = s.isEnumDeclaration();
        if (ed !== null)
            return ed.memtype !== null ? str(ed.memtype.toChars()) : "";
        const ad = s.isAggregateDeclaration();
        if (ad !== null) {
            const sig = signatureOf(ad);
            const colon = sig.indexOf(" : ");
            return colon >= 0 ? sig.slice(colon + 1) : "";
        }
        const al = s.isAliasDeclaration();
        if (al !== null)
            return al.aliassym !== null ? `= ${str(al.aliassym.toPrettyChars())}`
                : al.type !== null ? `= ${str(al.type.toChars())}` : "";
        const tm = s.isTemplateMixin();
        if (tm !== null)
            return `mixin ${str(tm.toChars())}`;
        return "";
    }

    /**
     * A declaration's children: an aggregate's, an enum's, a template's and a template mixin's members (a template
     * mixin's at its own site), an eponymous template's member's, a function's nested declarations.
     */
    private childrenOf(s: Dsymbol, site: [number, number] | null, marker: string, off: number | null,
        inAggregate: boolean): OutlineNode[] {
        const td = s.isTemplateDeclaration();
        if (td !== null) {
            const one = eponymousOnly(td);
            if (one !== null)
                return this.childrenOf(one, site, marker, off, inAggregate);
            return this.members(td.members, site, marker, inAggregate);
        }
        const tm = s.isTemplateMixin();
        if (tm !== null)
            return this.members(tm.members, site ?? (off !== null ? [off, this.end(off)] : null), marker, inAggregate);
        if (s.isAggregateDeclaration() !== null || s.isEnumDeclaration() !== null)
            return this.members(s.isScopeDsymbol()!.members, site, marker, s.isAggregateDeclaration() !== null);
        const fd = s.isFuncDeclaration();
        return fd !== null && site === null && off !== null ? this.nested(off) : [];
    }

    /**
     * The functions, aggregates, enums and templates declared in the body of the function whose location is `off`,
     * from the index (the declarations the walk met at their names, of every analysed copy of the body): those whose
     * nearest enclosing named function is located there. None in a body no analysis ran.
     */
    private nested(off: number): OutlineNode[] {
        const body = this.ix.functions.find((b) => b.start === off);
        if (body === undefined)
            return [];
        const out: OutlineNode[] = [];
        for (const [key, hits] of this.ix.hits!) {
            if (key <= off || key >= body.end)
                continue;
            for (const h of hits) {
                const s = h.sym;
                const declares = s.isFuncDeclaration() !== null || s.isAggregateDeclaration() !== null
                    || s.isEnumDeclaration() !== null || s.isTemplateDeclaration() !== null;
                if (declares && this.enclosingFunctionAt(s) === off && isDeclarationAt(this.m, this.ix, this.file, s,
                    key))
                    out.push(...this.node(s, null, ""));
            }
        }
        return out;
    }

    /** The offset of the nearest named function enclosing `s` (literals skipped), or -1. */
    private enclosingFunctionAt(s: Dsymbol): number {
        for (let p = s.parent; p !== null; p = p.parent) {
            const fd = p.isFuncDeclaration();
            if (fd !== null && fd.isFuncLiteralDeclaration() === null)
                return this.offsetIn(fd.loc) ?? -1;
        }
        return -1;
    }
}

/**
 * The first member of `td` when every member is named as `td` (one, or overloads), through attribute blocks; else
 * null. Read-only: `td.onemember` is computed at the first analysis that needs it (templatesem.d `computeOneMember`).
 */
function eponymousOnly(td: TemplateDeclaration): Dsymbol | null {
    const all: Dsymbol[] = [];
    const collect = (list: Iterable<Dsymbol | null> | null): void => {
        for (const s of list ?? []) {
            const attrib = s?.isAttribDeclaration() ?? null;
            if (attrib !== null && !(s instanceof ConditionalDeclaration))
                collect(attrib.decl);
            else if (s !== null)
                all.push(s);
        }
    };
    collect(td.members);
    return all.length !== 0 && all.every((s) => s.ident === td.ident) ? all[0]! : null;
}

/** Nodes in source order. */
function sortNodes(nodes: OutlineNode[]): OutlineNode[] {
    return nodes.sort((a, b) => a.range[0] - b.range[0] || a.selection[0] - b.selection[0]);
}

// ── references ───────────────────────────────────────────────────────────────────────────────────────────────

/** One reference (REFERENCES in the header): the file as the compiler names it, the identifier's range. */
export interface ReferenceSite {
    file: string;
    range: QueryRange;
    /** Whether the token is the declaration's own name (a template parameter's in its parameter list). */
    declaration: boolean;
}

/** The references of the symbol under a position, sorted by file then position. */
export interface ReferencesResult {
    /** The symbol's qualified name; a template parameter's as `Template.T`. */
    name: string;
    references: ReferenceSite[];
}

/** The answer of `queryReferences`: the references, or a miss (as `queryHover`'s). */
export type ReferencesAnswer = { result: ReferencesResult } | QueryMiss;

/** What `queryReferences` looks for: a symbol by its declaration (`referenceKey`), or a template's parameter. */
type ReferenceTarget =
    | { kind: "symbol"; sym: Dsymbol; key: string | Dsymbol; name: string; aggregate: boolean }
    | { kind: "parameter"; m: Module; ix: FileIndex; td: TemplateDeclaration; name: string; at: number;
        extent: [number, number] };

/**
 * The references of the symbol at (line, character) of `file`, whose editor text is `text` (REFERENCES in the
 * header), in every module the last compile analysed (its roots and the modules `-i` compiled); read-only, between
 * compiles (THE CONTRACT). Misses: those of `queryHover` (the file is not in the last compile; `stale`; no identifier
 * or no symbol at the position; in an inactive branch, INACTIVE_REASON). Cost: the index of each analysed module whose
 * text holds the name (its first query after a compile builds it), then one lookup per occurrence of the name.
 */
export function queryReferences(file: string, line: number, character: number, text: string): ReferencesAnswer {
    return printing(() => {
        const r = referenceTarget(file, line, character, text);
        if ("reason" in r)
            return r;
        const t = r.target;
        const name = t.kind === "symbol" ? str(t.sym.toPrettyChars())
            : `${str(t.td.toPrettyChars())}.${t.name}`;
        return { result: { name, references: referencesOf(t) } };
    });
}

/** The start of the identifier at (line, character) of the compiled text `bytes` (the one before it), or why none. */
function identifierStart(bytes: Uint8Array, line: number, character: number): number | QueryMiss {
    let off = byteOffset(bytes, line, character);
    if (off === null)
        return miss("the position is outside the text");
    if (!isIdentByte(bytes[off]) && off > 0 && isIdentByte(bytes[off - 1]))
        off--;
    if (!isIdentByte(bytes[off]))
        return miss("no identifier at the position");
    while (off > 0 && isIdentByte(bytes[off - 1]))
        off--;
    return isIdentStart(bytes[off]) ? off : miss("no identifier at the position");
}

/**
 * What the identifier at a position names, for the references and the rename: a parameter of a template declared in
 * the file whose extent holds it (not after a `.`), else the token's symbol (`tokenSymbol`), a constructor named by its
 * aggregate's name (`S(1)`, `new S`) standing for the aggregate; nothing in an inactive branch (INACTIVE_REASON).
 */
function referenceTarget(file: string, line: number, character: number, text: string)
    : { target: ReferenceTarget; m: Module; ix: FileIndex; start: number } | QueryMiss {
    const m = moduleOf(file);
    if (m === null)
        return miss("the file is not in the last compile");
    const ix = indexOf(m);
    if (text !== ix.text)
        return miss(STALE_REASON, true);
    hitsOf(m, ix);
    const start = identifierStart(ix.bytes, line, character);
    if (typeof start !== "number")
        return start;
    if (rangeHolding(inactiveOf(m, ix), start) >= 0)
        return miss(INACTIVE_REASON);
    const word = utf8.decode(ix.bytes.subarray(start, identEnd(ix.bytes, start)));
    const param = parameterAt(m, ix, start, word);
    if (param !== null)
        return { target: param, m, ix, start };
    let sym = tokenSymbol(m, ix, start, null);
    if (sym === null || (isCompilerName(sym) && sym.isCtorDeclaration() === null))
        return miss("no symbol at the position");
    if (sym.isCtorDeclaration() !== null && word !== "this")
        sym = sym.parent?.isAggregateDeclaration() ?? sym;
    sym = canonicalOf(sym);
    const target: ReferenceTarget = { kind: "symbol", sym, key: referenceKey(sym),
        name: sym.isCtorDeclaration() !== null ? "this" : identText(sym.ident), aggregate:
        sym.isAggregateDeclaration() !== null };
    return { target, m, ix, start };
}

/** The first inactive range of `m` that ends after `off` (`tokenSymbol`'s argument), or null. */
function inactiveFrom(m: Module, ix: FileIndex, off: number): [number, number] | null {
    const ranges = inactiveOf(m, ix);
    return ranges[firstRangeFrom(ranges, off)] ?? null;
}

/** A template instance stands for its template. */
function canonicalOf(sym: Dsymbol): Dsymbol {
    const ti = sym.isTemplateInstance();
    return ti !== null && ti.tempdecl !== null ? ti.tempdecl : sym;
}

/**
 * The identity of a symbol for the references: its declaration's identifier (`declarationOf`), shared by a
 * template's member and its copies in every instance, by a function template and its instances' functions; the
 * symbol itself when it has none (no location, declared in a string mixin).
 */
function referenceKey(sym: Dsymbol): string | Dsymbol {
    const d = declarationOf(canonicalOf(sym), true);
    return typeof d === "string" ? canonicalOf(sym) : `${d.file}\n${d.range.start.line}:${d.range.start.character}`;
}

/** Whether `sym` is a reference of `t`: the same key, or a constructor of the aggregate `t` names. */
function isReferenceOf(sym: Dsymbol, t: ReferenceTarget & { kind: "symbol" }): boolean {
    if (referenceKey(sym) === t.key)
        return true;
    const owner = t.aggregate && sym.isCtorDeclaration() !== null ? sym.parent : null;
    return owner !== null && referenceKey(owner) === t.key;
}

/**
 * The template declared in the file whose parameter the identifier at `start` (`word`) is: the innermost whose
 * extent (from its line's first token to its end) holds the token and whose parameters declare `word`, the token not
 * after a `.`; null when none.
 */
function parameterAt(m: Module, ix: FileIndex, start: number, word: string)
    : (ReferenceTarget & { kind: "parameter" }) | null {
    const t = ix.bytes;
    let p = start;
    while (p > 0 && (t[p - 1] === 0x20 || t[p - 1] === 0x09 || t[p - 1] === 0x0a || t[p - 1] === 0x0d))
        p--;
    if (p > 0 && t[p - 1] === 0x2e && inCode(ix, p - 1))
        return null;
    let best: (ReferenceTarget & { kind: "parameter" }) | null = null;
    for (const x of templatesOf(m, ix)) {
        if (start < x.extent[0] || start >= x.extent[1] || x.params.get(word) === undefined)
            continue;
        if (best === null || x.extent[0] >= best.extent[0])
            best = { kind: "parameter", m, ix, td: x.td, name: word, at: x.params.get(word)!, extent: x.extent };
    }
    return best;
}

/** `templatesOf`'s answer per index, found once (a hover at a template parameter asks it at every miss). */
const templatesByIndex = new WeakMap<FileIndex, { td: TemplateDeclaration; extent: [number, number];
    params: Map<string, number> }[]>();

/**
 * The templates the index met at their declarations in the file (the walk records a template at its name, a
 * member template through its instances' copies), each with its extent and its parameters' names at their tokens.
 * Found at the first need after the index's build (`templatesByIndex`).
 */
function templatesOf(m: Module, ix: FileIndex): { td: TemplateDeclaration; extent: [number, number];
    params: Map<string, number> }[] {
    const known = templatesByIndex.get(ix);
    if (known !== undefined)
        return known;
    const file = str(m.srcfile.toChars());
    const out: { td: TemplateDeclaration; extent: [number, number]; params: Map<string, number> }[] = [];
    const seen = new Set<number>();
    for (const [key, hits] of hitsOf(m, ix)) {
        for (const h of hits) {
            const td = h.sym.isTemplateDeclaration();
            if (td === null || seen.has(key) || !isDeclarationAt(m, ix, file, td, key))
                continue;
            seen.add(key);
            const off = td.loc.fileOffset();
            const params = new Map<string, number>();
            for (const tp of td.parameters ?? []) {
                const at = tp !== null && tp.ident !== null && tp.loc.isValid() && tp.loc.fileOffset() < ix.bytes.length
                    ? keyAt(ix.bytes, tp.loc.fileOffset(), [identText(tp.ident)]) : null;
                if (at !== null && at.named)
                    params.set(identText(tp!.ident), at.start);
            }
            out.push({ td, extent: [declarationStart(ix.bytes, off), statementEnd(ix.bytes, ix.nonCode, off)],
                params });
        }
    }
    templatesByIndex.set(ix, out);
    return out;
}

/**
 * The start of the declaration whose location is `off`: back over what precedes it on its line (a type, the
 * attributes) up to a `;`, `{` or `}`, then forward over whitespace.
 */
function declarationStart(t: Uint8Array, off: number): number {
    let p = off;
    while (p > 0 && ![0x0a, 0x3b, 0x7b, 0x7d].includes(t[p - 1]!))
        p--;
    while (p < off && (t[p] === 0x20 || t[p] === 0x09 || t[p] === 0x0d))
        p++;
    return p;
}

/** The modules the last compile analysed: its roots and those `-i` compiled, not those only imported. */
function analysedModules(): Module[] {
    const included = new Set(compiledImports.opSlice());
    return Module.amodules.opSlice().filter((m): m is Module => m !== null && m.src !== null
        && (m.isRoot() || included.has(m)));
}

/** The starts of the identifiers spelled `name` in `t`, outside comments and literals (`ix`'s `nonCode`). */
function occurrences(ix: FileIndex, name: string): number[] {
    const t = Buffer.from(ix.bytes.buffer, ix.bytes.byteOffset, ix.bytes.length);
    const out: number[] = [];
    for (let p = t.indexOf(name); p >= 0; p = t.indexOf(name, p + 1)) {
        if (!isIdentByte(t[p - 1]) && !isIdentByte(t[p + Buffer.byteLength(name)]) && inCode(ix, p))
            out.push(p);
    }
    return out;
}

/** The references of `t` (REFERENCES in the header), sorted by file then position. */
function referencesOf(t: ReferenceTarget): ReferenceSite[] {
    if (t.kind === "parameter") {
        const file = str(t.m.srcfile.toChars());
        const shadows = templatesOf(t.m, t.ix).filter((x) => x.td !== t.td && x.params.has(t.name)
            && x.extent[0] >= t.extent[0] && x.extent[1] <= t.extent[1]);
        return occurrences(t.ix, t.name).filter((p) => p >= t.extent[0] && p < t.extent[1]
            && !shadows.some((x) => p >= x.extent[0] && p < x.extent[1])
            && parameterAt(t.m, t.ix, p, t.name)?.td === t.td)
            .map((p) => ({ file, range: identRange(t.ix.bytes, p), declaration: p === t.at }));
    }
    const out: ReferenceSite[] = [];
    // a declaration in a string mixin is written inside a literal, where no occurrence is looked for
    const mixed = typeof declarationOf(t.sym, true) === "string" ? mixinSite(t.sym) : null;
    if (mixed !== null && mixed.named && analysedModules().some((m) => resolve(str(m.srcfile.toChars()))
        === resolve(mixed.file)))
        out.push({ file: mixed.file, range: mixed.range, declaration: true });
    for (const m of analysedModules()) {
        const ix = indexOf(m);
        if (!ix.text.includes(t.name))
            continue;
        hitsOf(m, ix);
        const file = str(m.srcfile.toChars());
        for (const p of occurrences(ix, t.name)) {
            const syms = choose(m, ix, p).map((h) => h.sym);
            const own = tokenSymbol(m, ix, p, inactiveFrom(m, ix, p));
            if (own !== null)
                syms.push(own);
            const hits = syms.filter((s) => isReferenceOf(s, t));
            if (hits.length !== 0)
                out.push({ file, range: identRange(ix.bytes, p),
                    declaration: hits.some((s) => isDeclarationAt(m, ix, file, s, p)) });
        }
    }
    return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
        || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

// ── rename ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What a rename at a position would change: the identifier there, and its current text. */
export interface PrepareRenameResult {
    range: QueryRange;
    placeholder: string;
}

/** The answer of `queryPrepareRename`: the identifier, or a miss whose reason says why it cannot be renamed. */
export type PrepareRenameAnswer = { result: PrepareRenameResult } | QueryMiss;

/** A rename's edits: each range (a reference, `queryReferences`'s) replaced by the new name. */
export interface RenameResult {
    newName: string;
    edits: { file: string; range: QueryRange }[];
}

/** The answer of `queryRename`: the edits, or a miss (`queryPrepareRename`'s, or the new name refused). */
export type RenameAnswer = { result: RenameResult } | QueryMiss;

/** Names D calls with no token of their own: a `foreach` over a range, `$`, a conversion, a hash. */
const IMPLICIT_NAMES: ReadonlySet<string> = new Set(["front", "back", "empty", "popFront", "popBack", "save", "length",
    "toString", "toHash"]);

/**
 * Whether the symbol at (line, character) of `file`, whose editor text is `text`, can be renamed (RENAME in the
 * header): its identifier and name, else a miss whose reason says why not. Read-only, between compiles. Cost: a
 * `queryReferences`, and a scan of the string mixins of the modules that spell the name.
 */
export function queryPrepareRename(file: string, line: number, character: number, text: string): PrepareRenameAnswer {
    return printing(() => {
        const r = renameTarget(file, line, character, text);
        if ("reason" in r)
            return r;
        return { result: { range: identRange(r.ix.bytes, r.start), placeholder: r.target.name } };
    });
}

/**
 * The edits renaming the symbol at (line, character) of `file` to `newName` (RENAME in the header): every reference
 * of `queryReferences`, the declaration's name included. Misses: `queryPrepareRename`'s; a new name that is not a D
 * identifier, is a keyword or starts with `__`; one the symbol's scope already declares (a template parameter: one the
 * template already spells).
 */
export function queryRename(file: string, line: number, character: number, text: string, newName: string)
    : RenameAnswer {
    return printing(() => {
        const r = renameTarget(file, line, character, text);
        if ("reason" in r)
            return r;
        const t = r.target;
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(newName) || KEYWORDS.has(newName) || newName.startsWith("__"))
            return miss(`\`${newName}\` is not a name a declaration can take`);
        if (t.kind === "parameter") {
            if (occurrences(t.ix, newName).some((p) => p >= t.extent[0] && p < t.extent[1]))
                return miss(`\`${newName}\` is already used in the template`);
        } else {
            const id = Identifier.lookup(encoder.encode(newName));
            const scope = t.sym.parent?.isScopeDsymbol() ?? null;
            const clash = id !== null ? scope?.symtab?.lookup(id) ?? null : null;
            if (clash !== null && clash !== t.sym)
                return miss(`\`${newName}\` is already declared in \`${str(scope!.toPrettyChars())}\``);
        }
        return { result: { newName, edits: r.references.map((x) => ({ file: x.file, range: x.range })) } };
    });
}

/**
 * The target of a rename at a position and its references, or why it cannot be renamed: a module or package (its
 * file), a constructor or another special function (`this`), a name D calls implicitly (`IMPLICIT_NAMES`, an
 * operator's `opBinary`), a symbol declared in a string mixin or without a declaration, one declared in a module the
 * last compile only imports (the bundled import tree's included: its other uses are not analysed), one whose name a
 * string mixin's text spells in an analysed module (a token string, or a literal in a `mixin(...)`'s arguments), a
 * symbol whose name is spelled in an inactive branch of an analysed module (`inactiveSpelling`: the references do not
 * look there, and a build for a target that compiles the branch would break); and nothing in an inactive branch
 * (`referenceTarget`). A template parameter's references are textual, inactive branches included.
 */
function renameTarget(file: string, line: number, character: number, text: string)
    : { target: ReferenceTarget; ix: FileIndex; start: number; references: ReferenceSite[] } | QueryMiss {
    const r = referenceTarget(file, line, character, text);
    if ("reason" in r)
        return r;
    const t = r.target;
    if (t.kind === "symbol") {
        const s = t.sym;
        if (s.isModule() !== null || s.isPackage() !== null)
            return miss("a module is renamed with its file");
        if (s.isFuncDeclaration() !== null && (s.isCtorDeclaration() !== null || s.isDtorDeclaration() !== null
            || s.isPostBlitDeclaration() !== null || s.isInvariantDeclaration() !== null
            || s.isUnitTestDeclaration() !== null || s.isStaticCtorDeclaration() !== null
            || s.isStaticDtorDeclaration() !== null))
            return miss("a special function has no name of its own");
        if (OPERATOR_FUNCTION.test(t.name) || IMPLICIT_NAMES.has(t.name))
            return miss(`D calls \`${t.name}\` with no token of its name (an operator, a \`foreach\`, a conversion)`);
        const d = declarationOf(s, true);
        if (typeof d === "string")
            return miss(`\`${t.name}\` cannot be renamed: ${d}`);
        const declaring = analysedModules().find((m) => resolve(str(m.srcfile.toChars())) === resolve(d.file));
        if (declaring === undefined)
            return miss(`\`${t.name}\` is declared in ${d.file}, which the last compile only imports: its other uses `
                + "are not analysed");
    }
    const spelled = mixinSpelling(t);
    if (spelled !== null)
        return miss(`\`${t.name}\` is spelled in the text of a string mixin at ${spelled}`);
    const inactive = t.kind === "symbol" ? inactiveSpelling(t.name) : null;
    if (inactive !== null)
        return miss(`\`${t.name}\` is spelled in a branch not compiled for this target and flags at ${inactive}: its `
            + "uses there are not analysed");
    return { target: t, ix: r.ix, start: r.start, references: referencesOf(t) };
}

/**
 * Where a string mixin's text spells `t`'s name as a word in a module the references search (the template's own file
 * for a parameter): a token string anywhere, or a string literal in the arguments of a `mixin (...)`; `file:line`
 * (line from 1), or null when none.
 */
function mixinSpelling(t: ReferenceTarget): string | null {
    const word = new RegExp(`(?<![\\p{L}\\p{N}_])${t.name}(?![\\p{L}\\p{N}_])`, "u");
    const modules = t.kind === "parameter" ? [t.m] : analysedModules();
    for (const m of modules) {
        const ix = indexOf(m);
        if (!ix.text.includes(t.name))
            continue;
        hitsOf(m, ix);
        const b = ix.bytes;
        const mixins = occurrences(ix, "mixin").map((at) => [at, mixinEnd(b, ix.nonCode, at)] as [number, number])
            .filter(([, e]) => e >= 0);
        for (const [s, e] of ix.nonCode) {
            const isString = b[s] !== 0x2f;
            const tokenString = b[s] === 0x71 && b[s + 1] === 0x7b;
            if (!isString || !(tokenString || mixins.some(([a, z]) => s >= a && e <= z)))
                continue;
            if (word.test(utf8.decode(b.subarray(s, e))))
                return `${str(m.srcfile.toChars())}:${positionOf(b, s).line + 1}`;
        }
    }
    return null;
}

/**
 * Where the identifier `name` is spelled in code in an inactive branch of a module the references search (`file:line`,
 * line from 1), or null: the uses there have no analysis, so the references miss them and a rename would leave them.
 * Cost: one scan of each analysed module whose text holds the name, and its inactive ranges.
 */
function inactiveSpelling(name: string): string | null {
    for (const m of analysedModules()) {
        const ix = indexOf(m);
        if (!ix.text.includes(name))
            continue;
        hitsOf(m, ix);
        const ranges = inactiveOf(m, ix);
        const p = ranges.length === 0 ? undefined : occurrences(ix, name).find((q) => rangeHolding(ranges, q) >= 0);
        if (p !== undefined)
            return `${str(m.srcfile.toChars())}:${positionOf(ix.bytes, p).line + 1}`;
    }
    return null;
}

// ── signature help ───────────────────────────────────────────────────────────────────────────────────────────

/** One candidate of a call (SIGNATURE HELP in the header): its label, its parameters' spans in it, its doc summary. */
export interface SignatureInformation {
    /** `int grow(Shape s, int by)`; a constructor's as `Shape(int s)`; a template's with its parameters. */
    label: string;
    /** Each parameter's span in `label`, UTF-16 offsets, end exclusive. */
    parameters: [number, number][];
    /** The doc comment's summary on one line, "" when none. */
    documentation: string;
}

/** The candidates of the call around a position, the one the compile picked first. */
export interface SignatureHelpResult {
    signatures: SignatureInformation[];
    activeSignature: number;
    /** The argument the position is in, from 0 (a UFCS receiver is the first). */
    activeParameter: number;
}

/** The answer of `querySignatureHelp`: the candidates, or a miss (as `queryHover`'s; not in a call; no function). */
export type SignatureHelpAnswer = { result: SignatureHelpResult } | QueryMiss;

/** How far back from a position the call's `(` is looked for. */
const CALL_WINDOW = 4096;

/**
 * The candidates of the call whose parentheses hold (line, character) of `file`, whose editor text is `text` (SIGNATURE
 * HELP in the header): the function the compile resolved the call to first, then the rest of its overload set; the
 * argument the position is in. Read-only, between compiles (THE CONTRACT). Misses: those of `queryHover` (not in the
 * last compile; `stale`; in an inactive branch, INACTIVE_REASON); not inside a call's parentheses; no function named
 * before them. Cost: a backward scan of the statement, the file's index when no query built it since the compile, one
 * print per candidate.
 */
export function querySignatureHelp(file: string, line: number, character: number, text: string): SignatureHelpAnswer {
    return printing(() => {
        const m = moduleOf(file);
        if (m === null)
            return miss("the file is not in the last compile");
        const ix = indexOf(m);
        if (text !== ix.text)
            return miss(STALE_REASON, true);
        hitsOf(m, ix);
        const t = ix.bytes;
        const off = byteOffset(t, line, character);
        if (off === null)
            return miss("the position is outside the text");
        if (rangeHolding(inactiveOf(m, ix), off) >= 0)
            return miss(INACTIVE_REASON);
        const paren = openParen(ix, off);
        if (paren < 0)
            return miss("not inside a call's parentheses");
        const call = ix.calls.find((c) => c.paren === paren) ?? null;
        let callee = identBefore(t, paren);
        const bang = callee >= 0 ? prevCode(t, ix.nonCode, callee) : -1;
        if (bang >= 0 && t[bang] === 0x21)   // `foo!int(`
            callee = identBefore(t, bang);
        else if (callee < 0 && t[prevCode(t, ix.nonCode, paren)] === 0x29)   // `foo!(int)(`
            callee = calleeBeforeArguments(ix, prevCode(t, ix.nonCode, paren));
        const named = callee >= 0 ? choose(m, ix, callee)[0]?.sym
            ?? (inCode(ix, callee) ? fallback(m, ix, callee, 0) : null) : null;
        const picked = call?.fd ?? null;
        const candidates = callCandidates(picked, named);
        if (candidates.length === 0)
            return miss("no function at the call");
        const dot = callee >= 0 ? prevCode(t, ix.nonCode, callee) : -1;
        const free = (picked ?? candidates[0]!).isMember2() === null && !(picked ?? candidates[0]!).isNested();
        const ufcs = call !== null ? call.ufcs : dot >= 0 && t[dot] === 0x2e && free;
        const active = commasBefore(ix, paren, off) + (ufcs ? 1 : 0);
        return { result: { signatures: candidates.map(signatureInformation), activeSignature: 0,
            activeParameter: active } };
    });
}

/**
 * The `(` of the innermost parentheses open at `off`: backwards over the code (comments and literals skipped),
 * balancing `()`, `[]` and `{}`; -1 when a `;`, an unbalanced `{`, `}` or `[`, or CALL_WINDOW bytes come first.
 */
function openParen(ix: FileIndex, off: number): number {
    const t = ix.bytes;
    let depth = 0;
    for (let q = off - 1; q >= 0 && q >= off - CALL_WINDOW; q--) {
        const k = rangeHolding(ix.nonCode, q);
        if (k >= 0) {
            q = ix.nonCode[k]![0];
            continue;
        }
        const c = t[q];
        if (c === 0x29 || c === 0x5d || c === 0x7d) {
            depth++;
        } else if (c === 0x28 || c === 0x5b || c === 0x7b) {
            if (depth === 0)
                return c === 0x28 ? q : -1;
            depth--;
        } else if (c === 0x3b && depth === 0) {
            return -1;
        }
    }
    return -1;
}

/** At the `)` ending `!(...)` before a call's `(`: the template's name before the `!`, or -1. */
function calleeBeforeArguments(ix: FileIndex, close: number): number {
    const t = ix.bytes;
    let depth = 0;
    for (let q = close; q >= 0; q--) {
        if (rangeHolding(ix.nonCode, q) >= 0)
            continue;
        if (t[q] === 0x29)
            depth++;
        else if (t[q] === 0x28 && --depth === 0) {
            const bang = prevCode(t, ix.nonCode, q);
            return bang >= 0 && t[bang] === 0x21 ? identBefore(t, bang) : -1;
        }
    }
    return -1;
}

/** The arguments written before `off` in the call whose `(` is at `paren`: the commas at its own depth. */
function commasBefore(ix: FileIndex, paren: number, off: number): number {
    const t = ix.bytes;
    let depth = 0;
    let commas = 0;
    for (let q = paren + 1; q < off; q++) {
        const k = rangeHolding(ix.nonCode, q);
        if (k >= 0) {
            q = ix.nonCode[k]![1] - 1;
            continue;
        }
        const c = t[q];
        if (c === 0x28 || c === 0x5b || c === 0x7b)
            depth++;
        else if (c === 0x29 || c === 0x5d || c === 0x7d)
            depth--;
        else if (c === 0x2c && depth === 0)
            commas++;
    }
    return commas;
}

/**
 * The functions a call may resolve to: the one the compile picked (an instance's function when it instantiated a
 * template), then the rest of the overload set of the name (`overloadSet`: functions, and the templates not
 * instantiated for this call as their eponymous functions); a constructor call's set is the aggregate's constructors.
 */
function callCandidates(picked: FuncDeclaration | null, named: Dsymbol | null): FuncDeclaration[] {
    let root: Dsymbol | null = null;
    if (picked !== null) {
        const ti = picked.parent?.isTemplateInstance() ?? null;
        const decl: Dsymbol = ti !== null && ti.tempdecl !== null && ti.name === picked.ident ? ti.tempdecl : picked;
        const scope = decl.parent?.isScopeDsymbol() ?? null;
        root = (decl.ident !== null ? scope?.symtab?.lookup(decl.ident) : null) ?? decl;
    } else if (named !== null) {
        const al = named.isAliasDeclaration();
        const plain = al !== null && named.isFuncAliasDeclaration() === null;
        const s = canonicalOf(plain ? aliasTarget(al) ?? named : named);
        const ad = s.isAggregateDeclaration();
        root = ad !== null ? ad.symtab?.lookup(Id.ctor!) ?? null : s;
    }
    if (root === null)
        return [];
    const out: FuncDeclaration[] = picked !== null ? [picked] : [];
    const pickedTemplate = picked?.parent?.isTemplateInstance()?.tempdecl ?? null;
    for (const f of overloadSet(root)) {
        const fd = f.isFuncDeclaration() ?? (f !== pickedTemplate ? eponymousOnly(f as TemplateDeclaration)
            ?.isFuncDeclaration() ?? null : null);
        if (fd !== null && fd !== picked && !out.includes(fd))
            out.push(fd);
    }
    return out;
}

/**
 * A candidate as signature help shows it: `ret name(params)` (a constructor `S(params)`, a template's eponymous
 * function with the template's parameters after its name), each parameter as hdrgen prints it, the variadic `...`; the
 * doc comment's summary (the template's for its function).
 */
function signatureInformation(fd: FuncDeclaration): SignatureInformation {
    const tf = fd.type?.isTypeFunction() ?? null;
    const td = fd.parent?.isTemplateDeclaration() ?? null;
    const params = (tf?.parameterList.parameters?.opSlice() ?? []).map((p) => str(parameterToChars(p, tf!, false)));
    if (tf !== null && tf.parameterList.varargs === VarArg.variadic)
        params.push("...");
    const ctor = fd.isCtorDeclaration() !== null;
    const owner = fd.toParent()?.isAggregateDeclaration() ?? null;
    let tparams = "";
    if (td !== null) {
        const printed = str(dsymbolToChars(td)).slice(identText(td.ident).length);
        let depth = 0;
        let close = 0;
        while (close < printed.length && (printed[close] !== ")" || --depth !== 0))
            depth += printed[close++] === "(" ? 1 : 0;
        tparams = printed.slice(0, close + 1);
    }
    let label = ctor && owner !== null ? identText(owner.ident)
        : `${tf?.next !== null && tf?.next !== undefined ? str(tf.next.toChars()) : "auto"} ${identText(fd.ident)}`;
    label += `${tparams}(`;
    const spans: [number, number][] = [];
    params.forEach((p, i) => {
        if (i !== 0)
            label += ", ";
        spans.push([label.length, label.length + p.length]);
        label += p;
    });
    label += ")";
    return { label, parameters: spans, documentation: summaryOf(td !== null && docOf(td) !== null ? td : fd) };
}

/** The doc comment's summary of `sym` as dmd's section split gives it (`DocComment.parse`), on one line; "" if none. */
function summaryOf(sym: Dsymbol): string {
    const doc = docOf(sym);
    const summary = doc === null ? null : DocComment.parse(sym, doc).summary;
    return simplifyMacros(str(summary?.body_ ?? null).replace(/\s+/g, " ").trim());
}

// ── unused code ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What an unused declaration is (UNUSED in the header). */
export type UnusedKind = "function" | "method" | "constructor" | "template" | "struct" | "union" | "class"
    | "interface" | "enum" | "variable";

/**
 * Why a declaration is unused: nothing names it; only itself, or code nested in it, does; or only declarations that
 * are themselves unused (and code no analysis ran, a template without instances) do.
 */
export type UnusedWhy = "unreferenced" | "only self-referenced" | "only referenced from unreachable code";

/** One unused declaration, at its identifier, the file as the compiler names it. */
export interface UnusedDeclaration {
    file: string;
    range: QueryRange;
    kind: UnusedKind;
    /** The qualified name, a template's member through the template (`app.Box.unused`, not `app.Box!int.unused`). */
    name: string;
    why: UnusedWhy;
}

/** The unused declarations of the program, sorted by file then position, and the program's entry. */
export interface UnusedResult {
    entry: string;
    declarations: UnusedDeclaration[];
}

/** The answer of `queryUnused`: the declarations, or why there is none (the program has no entry, errors). */
export type UnusedAnswer = { result: UnusedResult } | QueryMiss;

/**
 * The declarations of the last compile's program that its entry cannot reach (UNUSED in the header), in the modules
 * it analysed (its roots and those `-i` compiled), never in druntime's and Phobos's; read-only, between compiles
 * (THE CONTRACT). Misses: no module of the compile declares a `main` (a library: what is unused depends on its
 * users), the compile reported errors (an analysis cut short names less than the program does). Cost: one walk of the
 * analysed code of every declaration of those modules and of the template instances the program reaches, the index
 * of each of those modules (the token net), then a pass over the graph.
 */
export function queryUnused(): UnusedAnswer {
    return printing(() => {
        if (global.errors !== 0)
            return miss("the last compile reported errors");
        return new Reach().run();
    });
}

/** A symbol's identity in the report: `referenceKey`, memoized per run. */
type ReachKey = string | Dsymbol;

/** A family of virtual functions joined by `foverrides`, one vtable slot; `library` when a member is not the user's. */
interface Family {
    members: FuncDeclaration[];
    called: boolean;
    library: boolean;
}

/** What holds a token of the code for the nets: a node, a function body no analysis ran, a skipped unittest. */
type Holder = Dsymbol | "unanalysed" | "unittest";

/** An extent of a module's text and what holds the code in it (`Reach.holders`). */
interface HolderExtent {
    start: number;
    end: number;
    holder: Holder;
}

/** Special members the compiler or druntime calls without a node in the analysed code (TypeInfo, the vtable). */
const IMPLICIT_MEMBERS: ReadonlySet<string> = new Set(["opEquals", "opCmp", "toHash", "toString", "opAssign"]);

/**
 * What one declaration's analysed code names (UNUSED in the header): every symbol an expression refers to and every
 * aggregate or enum in a type it uses, lowered nodes and string-mixin code included (both are ordinary AST once
 * analysed); the declarations nested in it are collected apart (`declared`), not walked: each is its own node.
 * Read-only, like IndexWalker (the base class's recursion flag on struct literals replaced by a set of its own).
 */
class ReachWalker extends SemanticTimeTransitiveVisitor {
    readonly named = new Set<Dsymbol>();
    readonly declared: Dsymbol[] = [];
    private readonly types = new Set<Type>();
    private readonly literals = new Set<StructLiteralExp>();

    private add(s: Dsymbol | null): void {
        if (s !== null)
            this.named.add(s);
    }

    /** The aggregates and enums `t` is made of: its elements, a function's return and parameter types. */
    typeRefs(t: Type | null): void {
        if (t === null || this.types.has(t))
            return;
        this.types.add(t);
        this.add(typeSymbol(t));
        const tf = t.isTypeFunction() ?? t.isTypeDelegate()?.next?.isTypeFunction() ?? null;
        if (tf !== null) {
            this.typeRefs(tf.next);
            for (const p of tf.parameterList.parameters ?? [])
                this.typeRefs(p?.type ?? null);
            return;
        }
        this.typeRefs(t.isTypeAArray()?.index ?? null);
        this.typeRefs(t.isTypeVector()?.basetype ?? null);
        for (const p of t.isTypeTuple()?.arguments ?? [])
            this.typeRefs(p?.type ?? null);
        this.typeRefs(elementType(t) ?? t.isTypePointer()?.next ?? null);
    }

    /** The analysed types only: the base class walks the parse-time shapes too. */
    override visitTypeHelper(t: Type | null): void {
        this.typeRefs(t);
    }

    override visitExpression(e: Expression): void {
        this.typeRefs(e.type);
    }

    override visitUnaExp(e: UnaExp): void {
        this.typeRefs(e.type);
        super.visitUnaExp(e);
    }

    override visitBinExp(e: BinExp): void {
        this.typeRefs(e.type);
        super.visitBinExp(e);
    }

    /** A TypeInfo's variable (`typeid(S)`) names the type it describes. */
    override visitVarExp(e: VarExp): void {
        this.add(e.var_);
        this.typeRefs(e.type);
        this.typeRefs(e.var_?.isTypeInfoDeclaration()?.tinfo ?? null);
    }

    override visitSymOffExp(e: SymOffExp): void {
        this.add(e.var_);
        this.typeRefs(e.type);
    }

    override visitDotVarExp(e: DotVarExp): void {
        this.add(e.var_);
        this.typeRefs(e.type);
        super.visitDotVarExp(e);
    }

    override visitDsymbolExp(e: DsymbolExp): void {
        this.add(e.s);
    }

    override visitScopeExp(e: ScopeExp): void {
        this.add(e.sds);
        super.visitScopeExp(e);
    }

    override visitTemplateExp(e: TemplateExp): void {
        this.add(e.fd ?? e.td);
    }

    override visitDotTemplateExp(e: DotTemplateExp): void {
        this.add(e.td);
        super.visitDotTemplateExp(e);
    }

    override visitDotTemplateInstanceExp(e: DotTemplateInstanceExp): void {
        this.add(e.ti);
        super.visitDotTemplateInstanceExp(e);
    }

    override visitDotTypeExp(e: DotTypeExp): void {
        this.add(e.sym);
        super.visitDotTypeExp(e);
    }

    override visitDelegateExp(e: DelegateExp): void {
        this.add(e.func);
        this.typeRefs(e.type);
        super.visitDelegateExp(e);
    }

    override visitTypeExp(e: TypeExp): void {
        this.typeRefs(e.type);
    }

    override visitNewExp(e: NewExp): void {
        this.add(e.member);
        this.typeRefs(e.newtype);
        this.typeRefs(e.type);
        super.visitNewExp(e);
    }

    override visitCallExp(e: CallExp): void {
        this.add(e.f);
        this.typeRefs(e.type);
        super.visitCallExp(e);
    }

    override visitCastExp(e: CastExp): void {
        this.typeRefs(e.to);
        super.visitCastExp(e);
    }

    override visitStructLiteralExp(e: StructLiteralExp): void {
        if (this.literals.has(e))
            return;
        this.add(e.sd);
        this.literals.add(e);
        for (const el of e.elements ?? [])
            el?.accept(this);
        this.literals.delete(e);
    }

    /** A function literal is its own node: named here, walked when the program reaches it. */
    override visitFuncExp(e: FuncExp): void {
        this.add(e.fd);
    }

    override visitExpStatement(s: ExpStatement): void {
        const de = s.exp?.isDeclarationExp() ?? null;
        if (de !== null)
            this.visitDeclarationExp(de);
        else
            s.exp?.accept(this);
    }

    /** A local variable (an alias, a tuple) is part of the function; a nested function or type is a node of its own. */
    override visitDeclarationExp(e: DeclarationExp): void {
        const d = e.declaration!;
        const v = d.isVarDeclaration();
        if (v !== null)
            this.visitVarDecl(v);
        else if (d.isFuncDeclaration() !== null || d.isAggregateDeclaration() !== null || d.isEnumDeclaration() !== null
            || d.isTemplateDeclaration() !== null)
            this.declared.push(d);
        else if (d.isTemplateMixin() !== null)
            this.declared.push(...flatMembers([d]));
        else
            d.accept(this);
    }

    override visitAliasDeclaration(d: AliasDeclaration): void {
        this.add(d.aliassym);
        this.typeRefs(d.type);
    }

    override visitVarDecl(v: VarDeclaration): void {
        this.typeRefs(v.type);
        super.visitVarDecl(v);
    }

    override visitCatch(c: Catch): void {
        this.typeRefs(c.type);
        super.visitCatch(c);
    }

    /** A function's own code: its type, its parameters' default arguments, its lowered contracts and its body. */
    walkFunction(fd: FuncDeclaration): void {
        this.typeRefs(fd.type);
        for (const p of fd.type?.isTypeFunction()?.parameterList.parameters ?? [])
            p?.defaultArg?.accept(this);
        this.add(fd.fdrequire());
        this.add(fd.fdensure());
        fd.frequire()?.accept(this);
        fd.fensure()?.accept(this);
        fd.fbody?.accept(this);
    }
}

/**
 * The members of a scope as the analysis has them: through attribute declarations, the branch each condition chose,
 * a `static foreach`'s expanded members, a string mixin's declarations; a template mixin, then its members.
 */
function flatMembers(list: Iterable<Dsymbol | null> | null): Dsymbol[] {
    const out: Dsymbol[] = [];
    const visit = (items: Iterable<Dsymbol | null> | null): void => {
        for (const s of items ?? []) {
            if (s === null)
                continue;
            if (s instanceof ConditionalDeclaration) {
                const inc = s.condition?.inc ?? Include.notComputed;
                visit(inc === Include.yes ? s.decl : inc === Include.no ? s.elsedecl : null);
            } else if (s instanceof StaticForeachDeclaration) {
                visit(s.cache);
            } else if (s.isAttribDeclaration() !== null) {
                visit(s.isAttribDeclaration()!.decl);
            } else if (s.isTemplateMixin() !== null) {
                out.push(s);
                visit(s.isTemplateMixin()!.members);
            } else {
                out.push(s);
            }
        }
    };
    visit(list);
    return out;
}

/** Whether `s` sits in a template instance (or a template mixin): its code was analysed for the instance. */
function inInstance(s: Dsymbol): boolean {
    for (let p: Dsymbol | null = s; p !== null; p = p.parent) {
        if (p.isTemplateInstance() !== null)
            return true;
    }
    return false;
}

/** A variable that is a function's local, a parameter or a field: part of its owner, never a node of its own. */
function isPartVariable(v: VarDeclaration): boolean {
    return v.isField() || (v.toParent2()?.isFuncDeclaration() ?? null) !== null;
}

/**
 * The reach of the program's entry over the last compile (UNUSED in the header): the user's nodes and their edges
 * (`enumerate`), the roots, the propagation (`live`), then the report. One instance per query.
 */
class Reach {
    /** The modules whose declarations are reported. */
    private readonly user = new Set<Module>();
    private readonly keys = new Map<Dsymbol, ReachKey>();
    /** Every node of the user's modules, a template's instances' members included. */
    private readonly nodes: Dsymbol[] = [];
    private readonly isNode = new Set<Dsymbol>();
    private readonly byName = new Map<string, Dsymbol[]>();
    /** The aggregates, enums and templates of each module, whose extents hold code for the nets. */
    private readonly scopes = new Map<Module, Dsymbol[]>();
    private readonly edges = new Map<Dsymbol, ReachWalker>();
    /** The token net and the string net, by the referrer's key (UNUSED: what the analysis folded away). */
    private readonly keyEdges = new Map<ReachKey, Set<Dsymbol>>();
    private readonly keyNames = new Map<ReachKey, Set<string>>();
    /** What names each key, from the edges of the user's nodes and the nets: the referrers, for `why`. */
    private readonly referrers = new Map<ReachKey, Set<Dsymbol>>();
    /** The names written in function bodies no analysis ran (a template without instances, a skipped unittest). */
    private readonly unanalysedNames = new Set<string>();
    private readonly families = new Map<FuncDeclaration, Family>();
    private readonly live = new Set<Dsymbol>();
    private readonly liveKeys = new Set<ReachKey>();
    private readonly firedKeys = new Set<ReachKey>();
    private readonly queue: Dsymbol[] = [];
    private readonly roots: Dsymbol[] = [];
    private entry: FuncDeclaration | null = null;
    private factory = false;

    run(): UnusedAnswer {
        const included = new Set(compiledImports.opSlice());
        for (const m of Module.amodules) {
            // a C module (ImportC: its headers' declarations, the system's) and a .di (declarations of code compiled
            // elsewhere) declare what other code defines
            if (m !== null && m.src !== null && (m.isRoot() || included.has(m)) && m.filetype === FileType.d
                && !DEFAULT_LIBRARY.has(rootPackageOf(asDsymbol(m))))
                this.user.add(m);
        }
        for (const m of this.user)
            this.enumerate(asDsymbol(m), null);
        if (this.entry === null)
            return miss("the program has no entry: no module of the compile declares a main");
        for (const m of this.user)
            this.nets(m);
        for (const r of this.roots)
            this.markLive(r);
        while (this.queue.length !== 0)
            this.process(this.queue.pop()!);
        return { result: { entry: str(this.entry.toPrettyChars()), declarations: this.report() } };
    }

    private keyOf(s: Dsymbol): ReachKey {
        let k = this.keys.get(s);
        if (k === undefined) {
            k = referenceKey(s);
            this.keys.set(s, k);
        }
        return k;
    }

    private isUser(s: Dsymbol): boolean {
        const m = s.getModule();
        return m !== null && this.user.has(m);
    }

    /**
     * Adds `s`, a declaration of the user's modules, and what is declared in it, as nodes: a scope's members, a
     * template's instances' members, a function's nested declarations (found by its walk); notes the roots, the
     * entry and the virtual families. `owner` is the node `s` is declared in.
     */
    private enumerate(s: Dsymbol, owner: Dsymbol | null): void {
        if (this.isNode.has(s))
            return;
        this.isNode.add(s);
        this.nodes.push(s);
        if (s.ident !== null) {
            const list = this.byName.get(identText(s.ident)) ?? [];
            list.push(s);
            this.byName.set(identText(s.ident), list);
        }
        if (owner === null && s.isModule() !== null)
            this.roots.push(s);
        const scope = s.isAggregateDeclaration() ?? s.isEnumDeclaration() ?? s.isTemplateDeclaration();
        if (scope !== null) {
            const list = this.scopes.get(s.getModule()!) ?? [];
            list.push(s);
            this.scopes.set(s.getModule()!, list);
        }
        this.noteRoot(s);
        const fd = s.isFuncDeclaration();
        if (fd !== null)
            this.joinFamily(fd);
        const w = this.walk(s);
        for (const t of w?.named ?? [])
            this.refer(t, s);
        for (const d of w?.declared ?? [])
            this.enumerate(d, s);
        const td = s.isTemplateDeclaration();
        if (td !== null) {
            for (const ti of instancesOf(td))
                this.enumerate(ti, s);
        }
        const sds = fd === null ? s.isScopeDsymbol() : null;
        if (sds !== null && td === null) {
            for (const c of flatMembers(sds.members)) {
                // a module's members hold the instances it made (`appendToModuleMember`), of any module's templates:
                // the user's are enumerated through their template
                const v = c.isVarDeclaration();
                if (c.isImport() === null && (v === null || !v.isField())
                    && (c.isTemplateInstance() === null || c.isTemplateMixin() !== null))
                    this.enumerate(c, s);
            }
        }
    }

    /** Notes `s` as a root when the runtime, a foreign caller or the linker may reach it (UNUSED: the roots). */
    private noteRoot(s: Dsymbol): void {
        const fd = s.isFuncDeclaration();
        if (fd !== null) {
            if (fd.isMain() || fd.isCMain() || fd.isWinMain() || fd.isDllMain()) {
                this.entry ??= fd;
                this.roots.push(fd);
            } else if (fd.isStaticCtorDeclaration() !== null || fd.isStaticDtorDeclaration() !== null || fd.isCrtCtor
                || fd.isCrtDtor || (fd.isUnitTestDeclaration() !== null && global.params.useUnitTests)
                || (fd.fbody !== null && this.exported(fd))) {
                this.roots.push(fd);
            }
            return;
        }
        const v = s.isVarDeclaration();
        if (v !== null && !isPartVariable(v) && (v.storage_class & STC.extern_) === 0n && this.exported(v))
            this.roots.push(v);
        const ad = s.isAggregateDeclaration();
        if (ad !== null && ad.classKind !== ClassKind.d)
            this.roots.push(ad);
    }

    /** A definition another language or the linker may name: non-D linkage, `export`, `pragma(mangle)`. */
    private exported(d: Declaration): boolean {
        return d.resolvedLinkage() !== LINK.d || d.isExport() || d.mangleOverride !== null;
    }

    /** Joins a virtual function to the family of the functions it overrides (`foverrides`, transitively). */
    private joinFamily(fd: FuncDeclaration): Family | null {
        if (this.families.has(fd))
            return this.families.get(fd)!;
        if (fd.isMember2() === null || !isVirtualMethod(fd))
            return null;
        const fam: Family = { members: [fd], called: false, library: !this.isUser(fd) };
        this.families.set(fd, fam);
        for (const base of fd.foverrides ?? []) {
            if (base === null)
                continue;
            const other = this.joinFamily(base);
            if (other === null || other === fam)
                continue;
            for (const m of other.members) {
                fam.members.push(m);
                this.families.set(m, fam);
            }
            fam.called ||= other.called;
            fam.library ||= other.library;
        }
        return fam;
    }

    /** The walk of `s`'s own code, once (`ReachWalker`); null for a node without code of its own. */
    private walk(s: Dsymbol): ReachWalker | null {
        if (this.edges.has(s))
            return this.edges.get(s)!;
        const w = new ReachWalker();
        const fd = s.isFuncDeclaration();
        const v = s.isVarDeclaration();
        const ad = s.isAggregateDeclaration();
        const ed = s.isEnumDeclaration();
        const al = s.isAliasDeclaration();
        if (fd !== null) {
            if (fd.semanticRun >= PASS.semantic3done)
                w.walkFunction(fd);
            else
                w.typeRefs(fd.type);
        } else if (v !== null) {
            w.visitVarDecl(v);
        } else if (ad !== null) {
            for (const b of ad.isClassDeclaration()?.baseclasses ?? [])
                w.named.add(b!.sym!);
            for (const c of flatMembers(ad.members)) {
                const f = c.isVarDeclaration();
                if (f !== null && f.isField())
                    w.visitVarDecl(f);
            }
        } else if (ed !== null) {
            w.typeRefs(ed.memtype);
            for (const em of ed.members ?? [])
                memberValue(em as EnumMember)?.accept(w);
        } else if (al !== null) {
            w.visitAliasDeclaration(al);
        } else if (s.isTemplateMixin() !== null) {
            w.named.add(s.isTemplateMixin()!.tempdecl!);
        } else {
            return null;
        }
        this.edges.set(s, w);
        return w;
    }

    /** Notes that `from`, a user's node, names `target`. */
    private refer(target: Dsymbol, from: Dsymbol): void {
        if (!this.isUser(target))
            return;
        const k = this.keyOf(canonicalOf(target));
        const set = this.referrers.get(k) ?? new Set();
        set.add(from);
        this.referrers.set(k, set);
    }

    /**
     * The token net and the string net of a user's module (UNUSED in the header): each identifier of its code
     * resolved as the tokens resolve it, from the innermost analysed function or the aggregate, enum or template
     * whose extent holds it (outside them, the module: a root); the names written inside string literals when its
     * code spells `mixin(` or `__traits(`; the names written in bodies no analysis ran.
     */
    private nets(m: Module): void {
        const ix = indexOf(m);
        hitsOf(m, ix);
        const t = ix.bytes;
        const file = str(m.srcfile.toChars());
        const inactive = inactiveOf(m, ix);
        const holders = this.holders(m, ix, file);
        const scan = this.holderScan(holders);
        let ia = 0;
        let strings = false;
        let k = 0;
        for (let p = 0; p < t.length;) {
            if (k < ix.nonCode.length && p >= ix.nonCode[k]![0]) {
                p = Math.max(p, ix.nonCode[k]![1]);
                k++;
                continue;
            }
            if (!isIdentStart(t[p]) || isIdentByte(t[p - 1])) {
                p++;
                continue;
            }
            const e = identEnd(t, p);
            const word = utf8.decode(t.subarray(p, e));
            const next = t[skipTrivia(t, e)];
            if ((word === "mixin" || word === "__traits") && next === 0x28)
                strings = true;
            while (ia < inactive.length && inactive[ia]![1] <= p)
                ia++;
            const literalAffix = t[e] === 0x22 || t[e] === 0x60 || t[p - 1] === 0x22 || t[p - 1] === 0x60;
            if (!literalAffix && !KEYWORDS.has(word)) {
                const holder = scan.at(p);
                const range = inactive[ia] ?? null;
                if (range !== null && range[0] <= p) {
                    // a function in the branch is not analysed: its name keeps the declarations from the module
                    this.keyName(typeof holder === "string" ? null : holder, word);
                } else if (holder === "unittest") {
                    this.keyName(null, word);
                } else if (holder === "unanalysed") {
                    // a body starts at its function's name, which names nothing
                    if (!scan.startsAt(p))
                        this.unanalysedNames.add(word);
                } else {
                    const sym = tokenSymbol(m, ix, p, range);
                    if (sym !== null && !isDeclarationAt(m, ix, file, sym, p))
                        this.keyEdge(holder, sym);
                }
            }
            p = e;
        }
        if (!strings)
            return;
        const literals = this.holderScan(holders);
        for (const [s, e] of ix.nonCode) {
            const c = t[s];
            const literal = c === 0x22 || c === 0x60 || (c === 0x71 && (t[s + 1] === 0x22 || t[s + 1] === 0x7b));
            const found = literal ? literals.at(s) : "unanalysed";
            if (found === "unanalysed")
                continue;
            const holder = found === "unittest" ? null : found;
            for (const word of utf8.decode(t.subarray(s, e)).match(/[A-Za-z_]\w*/g) ?? [])
                this.keyName(holder, word);
        }
    }

    /**
     * The extents that hold code in a module, innermost last at equal starts: the bodies of its functions (an
     * analysed one by its function, one no analysis ran as `unanalysed`), and its aggregates, enums and templates.
     */
    private holders(m: Module, ix: FileIndex, file: string): HolderExtent[] {
        const out: HolderExtent[] = [];
        for (const s of this.scopes.get(m) ?? []) {
            const name = s.loc.isValid() ? s.loc.filename() : null;
            if (name === null || str(name) !== file || s.loc.fileOffset() >= ix.bytes.length)
                continue;
            const off = s.loc.fileOffset();
            out.push({ start: declarationStart(ix.bytes, off), end: statementEnd(ix.bytes, ix.nonCode, off),
                holder: s });
        }
        for (const b of ix.functions) {
            const skipped = b.fd === null && wordAt(ix.bytes, b.start) === "unittest";
            out.push({ start: b.start, end: b.end, holder: b.fd ?? (skipped ? "unittest" : "unanalysed") });
        }
        return out.sort((a, b) => a.start - b.start);
    }

    /**
     * The innermost extent holding each position, asked in increasing order (`at`), or null for the module: the
     * extents nest, so the ones open at a position are a stack.
     */
    private holderScan(holders: readonly HolderExtent[])
        : { at(p: number): Holder | null; startsAt(p: number): boolean } {
        let next = 0;
        const open: HolderExtent[] = [];
        return {
            at(p: number): Holder | null {
                while (next < holders.length && holders[next]!.start <= p)
                    open.push(holders[next++]!);
                while (open.length !== 0 && open[open.length - 1]!.end <= p)
                    open.pop();
                return open.length !== 0 ? open[open.length - 1]!.holder : null;
            },
            startsAt(p: number): boolean {
                return open.length !== 0 && open[open.length - 1]!.start === p;
            },
        };
    }

    private keyEdge(holder: Dsymbol | null, sym: Dsymbol): void {
        if (holder === null) {
            this.roots.push(sym);
            return;
        }
        this.refer(sym, holder);
        const k = this.keyOf(holder);
        const set = this.keyEdges.get(k) ?? new Set();
        set.add(sym);
        this.keyEdges.set(k, set);
    }

    private keyName(holder: Dsymbol | null, word: string): void {
        if (!this.byName.has(word))
            return;
        if (holder === null) {
            this.roots.push(...this.byName.get(word)!);
            return;
        }
        for (const s of this.byName.get(word)!)
            this.refer(s, holder);
        const k = this.keyOf(holder);
        const set = this.keyNames.get(k) ?? new Set();
        set.add(word);
        this.keyNames.set(k, set);
    }

    /** Marks `s` live; a local, a parameter, an import or a module is not a node and spreads nothing. */
    private markLive(s: Dsymbol): void {
        const v = s.isVarDeclaration();
        if (this.live.has(s) || (v !== null && isPartVariable(v) && !v.isField()) || s.isImport() !== null
            || (s.isPackage() !== null && s.isModule() === null))
            return;
        this.live.add(s);
        this.queue.push(s);
    }

    /**
     * Spreads `s`'s liveness: to what its code names, to what the nets note for its key, to the declaration it sits
     * in, to an aggregate's implicitly called members and its virtual functions of a called family; a function whose
     * body no analysis ran keeps every user's declaration of each name written in it (UNUSED in the header).
     */
    private process(s: Dsymbol): void {
        const user = this.isUser(s);
        const k = user ? this.keyOf(canonicalOf(s)) : null;
        if (k !== null)
            this.liveKeys.add(k);
        const ti = s.isTemplateInstance();
        if (ti !== null && ti.tempdecl !== null)
            this.markLive(ti.tempdecl);
        if (s.parent !== null && s.isModule() === null)
            this.markLive(s.parent);
        // a template mixin's code is its scope's: live with it
        const sds = s.isModule() !== null || s.isAggregateDeclaration() !== null ? s.isScopeDsymbol() : null;
        for (const c of sds !== null ? flatMembers(sds.members) : []) {
            if (c.isTemplateMixin() !== null)
                this.markLive(c);
        }
        if (user || inInstance(s)) {
            for (const t of this.walk(s)?.named ?? [])
                this.reach(t);
        }
        if (k !== null && !this.firedKeys.has(k)) {
            this.firedKeys.add(k);
            for (const t of this.keyEdges.get(k) ?? [])
                this.reach(t);
            for (const word of this.keyNames.get(k) ?? [])
                this.byName.get(word)!.forEach((n) => this.markLive(n));
        }
        const fd = s.isFuncDeclaration();
        if (fd !== null && fd.fbody !== null && fd.semanticRun < PASS.semantic3done && this.isUser(fd))
            this.unanalysedBody(fd);
        const ad = s.isAggregateDeclaration();
        if (ad !== null && (this.isUser(ad) || inInstance(ad)))
            this.aggregateLive(ad);
        const al = s.isAliasDeclaration();
        if (al !== null && al.aliassym !== null)
            this.reach(al.aliassym);
    }

    /** `t` is named by live code. */
    private reach(t: Dsymbol): void {
        const fd = t.isFuncDeclaration();
        if (fd !== null) {
            const owner = fd.toParent()?.isClassDeclaration() ?? null;
            if (owner !== null && rootPackageOf(owner) === "object" && ((identText(owner.ident) === "Object"
                && identText(fd.ident) === "factory") || (identText(owner.ident) === "TypeInfo_Class"
                && identText(fd.ident) === "find")))
                this.objectFactory();
            const fam = this.joinFamily(fd);
            if (fam !== null && !fam.called) {
                fam.called = true;
                for (const m of fam.members) {
                    if (this.live.has(m.isMember2()!))
                        this.markLive(m);
                }
            }
        }
        const os = t.isOverloadSet();
        for (const a of os?.a ?? [])
            this.markLive(a!);
        const od = t.isOverDeclaration();
        if (od !== null && od.aliassym !== null)
            this.markLive(od.aliassym);
        this.markLive(t);
    }

    /** A live aggregate: its implicitly called members, and its virtual functions whose family is called. */
    private aggregateLive(ad: AggregateDeclaration): void {
        if (ad.aliasthis?.sym !== null && ad.aliasthis?.sym !== undefined)
            this.reach(ad.aliasthis.sym);
        for (const c of flatMembers(ad.members)) {
            const fd = c.isFuncDeclaration();
            if (fd === null)
                continue;
            const implicit = fd.isDtorDeclaration() !== null || fd.isPostBlitDeclaration() !== null
                || fd.isInvariantDeclaration() !== null || (fd.isCtorDeclaration()?.isCpCtor ?? false)
                || IMPLICIT_MEMBERS.has(identText(fd.ident));
            const fam = this.families.get(fd) ?? null;
            if (implicit || (fam !== null && (fam.called || fam.library)))
                this.markLive(fd);
        }
    }

    /** `Object.factory` (or `TypeInfo_Class.find`) is reached: every user's class may be made by its name. */
    private objectFactory(): void {
        if (this.factory)
            return;
        this.factory = true;
        for (const s of this.nodes) {
            const cd = s.isClassDeclaration();
            if (cd !== null && cd.isInterfaceDeclaration() === null)
                this.markLive(cd);
        }
    }

    /** The names written in a live function's body that no analysis ran keep every user's declaration so named. */
    private unanalysedBody(fd: FuncDeclaration): void {
        const m = fd.getModule()!;
        const t = indexOf(m).bytes;
        const start = fd.loc.fileOffset();
        const end = Math.min(fd.endloc.fileOffset(), t.length);
        if (str(fd.loc.filename()) !== str(m.srcfile.toChars()) || end <= start)
            return;
        for (const word of utf8.decode(t.subarray(start, end)).match(/[A-Za-z_]\w*/g) ?? [])
            this.byName.get(word)?.forEach((n) => this.markLive(n));
    }

    /**
     * The unused declarations: the user's nodes of a reported kind (`unusedKind`) declared at an identifier of a
     * user's file, whose key no live node has, the outermost only (a member of an unused aggregate, template or
     * function is not listed again).
     */
    private report(): UnusedDeclaration[] {
        const dead = new Map<ReachKey, Dsymbol>();
        for (const s of this.nodes) {
            const k = this.keyOf(canonicalOf(s));
            if (typeof k === "string" && !this.liveKeys.has(k) && !dead.has(k) && unusedKind(s) !== null
                && !isCompilerName(s))
                dead.set(k, canonicalOf(s));
        }
        const out: UnusedDeclaration[] = [];
        for (const [k, s] of dead) {
            if (this.deadOwner(s, dead))
                continue;
            const d = declarationOf(s, true);
            if (typeof d === "string")
                continue;
            out.push({ file: d.file, range: d.range, kind: unusedKind(s)!, name: unusedName(s), why: this.why(k) });
        }
        return out.sort((a, b) => a.file.localeCompare(b.file) || a.range.start.line - b.range.start.line
            || a.range.start.character - b.range.start.character);
    }

    /** Whether a declaration `s` sits in (through a template instance, its template) is unused too. */
    private deadOwner(s: Dsymbol, dead: ReadonlyMap<ReachKey, Dsymbol>): boolean {
        for (let p = s.parent; p !== null && p.isModule() === null; p = p.parent) {
            const owner = canonicalOf(p);
            if (dead.has(this.keyOf(owner)))
                return true;
            if (owner !== p)
                p = owner;
        }
        return false;
    }

    /** Why the declaration of key `k` is unused, from what names it (`referrers`). */
    private why(k: ReachKey): UnusedWhy {
        const refs = [...this.referrers.get(k) ?? []];
        if (refs.length === 0) {
            const name = typeof k === "string" ? null : k;
            const s = name ?? this.nodes.find((n) => this.keyOf(canonicalOf(n)) === k) ?? null;
            return s !== null && s.ident !== null && this.unanalysedNames.has(identText(s.ident))
                ? "only referenced from unreachable code" : "unreferenced";
        }
        const self = refs.every((r) => {
            for (let p: Dsymbol | null = r; p !== null; p = p.parent) {
                if (this.keyOf(canonicalOf(p)) === k)
                    return true;
            }
            return false;
        });
        return self ? "only self-referenced" : "only referenced from unreachable code";
    }
}

/** The kind a declaration is reported as, or null when it is not reported (UNUSED in the header). */
function unusedKind(s: Dsymbol): UnusedKind | null {
    const fd = s.isFuncDeclaration();
    if (fd !== null) {
        if (fd.isFuncLiteralDeclaration() !== null || fd.isUnitTestDeclaration() !== null
            || fd.isStaticCtorDeclaration() !== null || fd.isStaticDtorDeclaration() !== null
            || fd.isInvariantDeclaration() !== null || fd.isPostBlitDeclaration() !== null
            || fd.isDtorDeclaration() !== null || fd.isNewDeclaration() !== null || fd.isMain() || fd.isCMain())
            return null;
        if (fd.isCtorDeclaration() !== null)
            return "constructor";
        return fd.isMember2() !== null ? "method" : "function";
    }
    if (s.isTemplateDeclaration() !== null)
        return "template";
    if (s.isInterfaceDeclaration() !== null)
        return "interface";
    if (s.isClassDeclaration() !== null)
        return "class";
    if (s.isUnionDeclaration() !== null)
        return "union";
    if (s.isStructDeclaration() !== null)
        return "struct";
    if (s.isEnumDeclaration() !== null)
        return s.ident !== null ? "enum" : null;
    const v = s.isVarDeclaration();
    if (v !== null && !isPartVariable(v)
        && (v.storage_class & (STC.manifest | STC.const_ | STC.immutable_ | STC.extern_)) === 0n
        && v.type !== null && !v.type.isConst() && !v.type.isImmutable() && v.isTypeInfoDeclaration() === null)
        return "variable";
    return null;
}

/** The qualified name of `s`, a template instance's member through its template (`app.Box.get`). */
function unusedName(s: Dsymbol): string {
    const parts: string[] = [];
    for (let p: Dsymbol | null = s; p !== null; p = p.parent) {
        const ti = p.isTemplateInstance();
        if (ti !== null && ti.isTemplateMixin() === null && ti.tempdecl !== null)
            p = ti.tempdecl;
        if (p.isModule() !== null) {
            parts.push(str(p.toPrettyChars()));
            break;
        }
        const name = p.isCtorDeclaration() !== null ? "this" : identText(p.ident);
        // an eponymous member is named by its template alone
        if ((ti === null || ti.isTemplateMixin() === null) && (ti === null || parts[parts.length - 1] !== name))
            parts.push(name);
    }
    return parts.reverse().join(".");
}
