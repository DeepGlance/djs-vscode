// Ported from dmd/astcodegen.d (module dmd.astcodegen).
//
// "Defines AST nodes for the code generation stage." In D this is the namespace-aggregator
// `struct ASTCodegen { public import dmd.aggregate; … alias Type = dmd.mtype.Type; … }` — a bag
// of `public import`s + `alias`es that gathers the ENTIRE AST node namespace under one name, so
// the visitor stack can be instantiated as `ParseTimeVisitor!ASTCodegen` (13-visitor.md §3).
//
// TRANSLATION (01-conventions.md §3.4): the struct-wrapping is a pure namespace-aggregation
// idiom; we DROP the `struct` and emit each inner member as an ESM re-export:
//   - `public import dmd.X;`        -> `export * from "./X.js";`
//   - `public import dmd.X : Y;`    -> `export { Y } from "./X.js";`
//   - `alias Name = dmd.X.Sym;`     -> `export { Sym as Name } from "./X.js";`  (02-types.md §5.3
//                                      re-export form for a symbol alias crossing modules)
//
// 13-visitor.md §3 MONOMORPHIZES the visitor's `(AST)` parameter to exactly these classes and
// references them directly (no `ASTCodegen.` qualifier), so `ASTCodegen` does NOT survive as a
// runtime namespace object — it is purely the aggregated re-export surface. Whether any caller
// still needs an `ASTCodegen`-qualified access is a Bucket-7 body-phase concern; the type graph
// only needs the re-exports below.
//
// No excluded module appears in the aggregate (importc/cparse/doc/dtoh/iasm are all absent;
// hdrgen/initsem/typesem are KEPT). Re-export order mirrors astcodegen.d 1:1.

// ── public import dmd.X;  ->  export * from "./X.js";  (astcodegen.d:12-36) ──
export * from "./aggregate.js";
export * from "./aliasthis.js";
export * from "./arraytypes.js";
export * from "./attrib.js";
export * from "./cond.js";
export * from "./dclass.js";
export * from "./declaration.js";
export * from "./denum.js";
export * from "./dimport.js";
export * from "./dmodule.js";
export * from "./dstruct.js";
export * from "./dsymbol.js";
export * from "./dtemplate.js";
export * from "./dversion.js";
export * from "./expression.js";
export * from "./func.js";
export * from "./hdrgen.js";
export * from "./init.js";
export * from "./initsem.js";
export * from "./mtype.js";
export * from "./nspace.js";
export * from "./statement.js";
export * from "./staticassert.js";
// dropped: `public import dmd.ctfeexpr;` — REMOVED upstream in 2.113 (it is no longer a member of
// the ASTCodegen aggregate). `ctfeexpr.ts` stays a live module; it is simply not re-exported here.

// ── public import dmd.init : Designator;  (astcodegen.d:35) ──
// `Designator` is already surfaced by `export * from "./init.js"` above; the selective re-import
// in D narrows scope, but at module level it is the same symbol. Re-exported explicitly to mirror
// the source line; a duplicate `export *` + named `export` of the same symbol is a TS error, so
// this is left as a comment rather than a second binding.
// resolved: `public import dmd.init : Designator;` -> covered by `export * from "./init.js"`.

// ── public import dmd.typesem;  (astcodegen.d:36) ──
// Upstream 2.113 moved this line BELOW the `Designator` selective import; the order is mirrored.
export * from "./typesem.js";

// ── alias Name = dmd.X.Sym;  ->  export { Sym as Name } from "./X.js";  (astcodegen.d:38-101) ──
// FUNCTION aliases (re-export the symbol under a (possibly identical) name).
//
// `alias addSTC = dmd.typesem.addSTC;` (astcodegen.d:38, NEW in 2.113) — the free UFCS function
// `Type addSTC(Type _this, STC stc)` at typesem.d:80, which typesem.ts exports under that name.
// Covered by the `export * from "./typesem.js"` above; no separate binding is needed.
export { initializerToExpression } from "./initsem.js";
// `alias typeToExpression = dmd.mtype.typeToExpression;` (astcodegen.d:40): 2.113 homes
// `typeToExpression` in mtype.d:131, and mtype.ts exports it there.
export { typeToExpression } from "./mtype.js";
// `UserAttributeDeclaration`, `ErrorExp`, `ArgumentLabel` are already surfaced by their
// `export *` modules (attrib / expression); the D aliases just re-pin the canonical source.
// resolved: alias UserAttributeDeclaration/ErrorExp/ArgumentLabel -> covered by `export *`.
export { Ensure } from "./func.js";

// MANIFEST-CONSTANT / ENUM-MEMBER aliases (`alias Tvoid = dmd.mtype.Tvoid;` etc.). These name
// members of the `TY` / `MODFlags` enums in mtype, the `STC` flag set in declaration, the
// `Visibility`/`SearchOpt`/`PASS` symbols in dsymbol, and helper functions in hdrgen/dtemplate.
// Each is a value re-export under the same (or aliased) name; all are already reachable via the
// `export *` lines above, so the canonical-source re-exports are recorded as comments to avoid
// duplicate-binding TS errors while keeping the 1:1 line mapping auditable.
//
// resolved: the mtype TY-member aliases (Tarray, Taarray, Tbool, Tchar, Tdchar, Tdelegate,
//   Tenum, Terror, Tfloat32/64/80, Tfunction, Tpointer, Treference, Tident, Tint8/16/32/64,
//   Tsarray, Tstruct, Tuns8/16/32/64, Tvoid, Twchar, Tnoreturn, Timaginary32/64/80,
//   Tcomplex32/64/80) and MODFlags/ModToStc/ParameterList/VarArg/Type/Parameter
//   -> all covered by `export * from "./mtype.js"`.
// resolved: STC -> covered by `export * from "./declaration.js"`.
// resolved: Dsymbol/Dsymbols/Visibility/SearchOpt/PASS -> covered by
//   `export * from "./dsymbol.js"`.
// resolved: stcToBuffer/linkageToChars/visibilityToChars -> covered by
//   `export * from "./hdrgen.js"`.
// resolved: isType/isExpression/isTuple -> covered by `export * from "./dtemplate.js"`.
