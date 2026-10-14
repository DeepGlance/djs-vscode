// Ported from dmd/json.d (module dmd.json).
//
// Code for generating .json descriptions of the module when passing the `-X` flag to dmd.
//
// TRANSLATION NOTES (keyed to the guide)
// * VERSION RESOLUTION (_config.md §1). json.d has no `version (IN_LLVM)` arm. `version (Windows)` (json.d:45) is
//   OFF: the POSIX `getcwd` import is live, and `getcwd(null, 0)` (json.d:904) is Node's `process.cwd()`, which
//   is the same libc call. `import core.stdc.stdio; import core.stdc.string;` are runtime imports (01 §3.7).
// * VISITOR (13 §7 census): `grep -c 'class .*Visitor' dmd/json.d` is 1, `ToJsonVisitor` (json.d:55), Idiom A:
//   each `override void visit(X)` is the named method `visitX` (13 §1), driven through `accept`; the
//   `alias visit = Visitor.visit;` line (json.d:57) is dropped, there is no overload hiding in TS. The class is
//   module-private in D and not exported here; `json_generate` is its one entry.
// * OVERLOAD SETS (04 §1). Form B everywhere: same arity, different parameter types. The string form of each set
//   keeps the bare name (it is the most-called form; there is no dependent outside this file, the class is
//   private); the other forms take `<name>From<Type>` (04 §1 rule 3):
//     - `value(const char[])` / `value(int)` -> `value` / `valueFromInt`;
//     - `item(const char[])` / `item(int)` -> `item` / `itemFromInt`;
//     - `property(name, const char[])` keeps `property`; `property(name, int)` -> `propertyFromInt`,
//       `(name, TRUST)` -> `propertyFromTrust`, `(name, PURE)` -> `propertyFromPurity`, `(name, LINK)` ->
//       `propertyFromLinkage`, `(name, Type)` -> `propertyFromType`, `(name, Parameters*)` ->
//       `propertyFromParameters`; the arity-3 forms `(linename, charname, Loc)` -> `propertyFromLoc` and
//       `(name, deconame, Type)` -> `propertyFromTypeDeco`.
//     - `jsonProperties(Dsymbol)` / `(Declaration)` / `(TemplateDeclaration)` split on the receiver (04 §1 rule 2):
//       the Dsymbol form, called from four D sites, keeps `jsonProperties`; the others are
//       `jsonPropertiesDeclaration` and `jsonPropertiesTemplateDeclaration`. Each call site is resolved by the
//       argument's STATIC type as D resolves it: an AggregateDeclaration, an EnumDeclaration and a TemplateMixin
//       are ScopeDsymbols, so they take the Dsymbol form.
// * STRINGS (02 §11.2). `.toDString` on a `const(char)*` that cannot be null (`kind()`, `toPrettyChars()`) is
//   `cstr`; on one that can (`comment`) it is root/string's `toDString`, which keeps the null. A null slice and
//   an empty one differ in `property` (null is skipped) and `requiredProperty` (null prints `null`), so every
//   slice parameter here is `DString | null`. `Type.deco` is held as a JS string by the tree (mtype.ts), so its
//   `.toDString` is `dsUtf8`, the inverse of the `dsToJs` that stored it (typesem.ts `merge`).
// * INTEGERS. D passes `uint` values (`offset`, `linnum`, `versionNumber()`, `alignment.get()`) to
//   `property(name, int)`: the implicit uint -> int conversion is `| 0`. `value(int)` hands a non-negative `int` to
//   `OutBuffer.print(ulong)`, a sign extension, `BigInt.asUintN(64, …)`.
// * `final switch` (06 §3.2): the three enum-switch overloads end in the `never` check and `SwitchError`.
// * LOAD ORDER (01 §4.8). `Visitor` is the first import (the class extends it at module evaluation). The value
//   imports into the sema half of the core SCC (`hdrgen`, `dsymbolsem` for `include`, json.d:27, `templatesem`
//   for `computeOneMember`, json.d:28) come last. No walls: every callee is ported.

import { Visitor } from "./visitor/index.js";
import { Visibility } from "./dsymbol.js";
import { Id } from "./id.js";
import { JsonFieldFlags, global } from "./globals.js";
import { LINK, PURE, STC, TRUST, Tfunction } from "./astenums.js";
import { SourceLoc } from "./location.js";
import { Module } from "./dmodule.js";
import { Include } from "./cond.js";
import { OS, target } from "./target.js";
import { messageNoLoc } from "./errors.js";
import { OutBuffer } from "./common/outbuffer.js";
import { toDString } from "./root/string.js";
import { cstr, ds, dsEquals, dsUtf8 } from "../dstring.js";
import type { DString } from "../dstring.js";
import { SwitchError, assert } from "../assert.js";
// last: 01 §4.8 — value imports into the sema half of the core SCC.
import { initializerToString, stcToString, visibilityToString } from "./hdrgen.js";
import { include } from "./dsymbolsem.js";
import { computeOneMember } from "./templatesem.js";

import type { AggregateDeclaration } from "./aggregate.js";
import type { Modules, Parameters } from "./arraytypes.js";
import type { AttribDeclaration, ConditionalDeclaration } from "./attrib.js";
import type { Declaration, TypeInfoDeclaration, VarDeclaration } from "./declaration.js";
import type { EnumDeclaration, EnumMember } from "./denum.js";
import type { Dsymbol } from "./dsymbol.js";
import type { Import } from "./dimport.js";
import type { FuncDeclaration, PostBlitDeclaration } from "./func.js";
import type { TemplateDeclaration, TemplateMixin } from "./dtemplate.js";
import type { Loc } from "./location.js";
import type { Type } from "./mtype.js";
import type { Ref } from "./hdrgen.js";

/**
 * The `-X` writer (dmd/json.d:55 — `private extern (C++) final class ToJsonVisitor : Visitor`). Appends a
 * pretty-printed JSON text to `buf`: one space of indentation per nesting level, `" : "` between a property name
 * and its value, and a `,\n` after every item, which `arrayEnd`/`objectEnd` take back from the last one.
 * `filename` is the file of the last `"file"` property written, so a member declared in the same file as its
 * container does not repeat it.
 */
class ToJsonVisitor extends Visitor {
    // dropped: alias visit = Visitor.visit — no overload hiding in TS
    buf: OutBuffer;
    indentLevel = 0;
    filename: DString | null = null;

    /** dmd/json.d:63 — `extern (D) this(OutBuffer* buf) scope @safe`. */
    constructor(buf: OutBuffer) {
        super();
        this.buf = buf;
    }

    /** dmd/json.d:69 — `void indent()`. Writes `indentLevel` spaces when the buffer is at a line start. */
    indent(): void {
        if (this.buf.length() >= 1 && this.buf.opIndex(this.buf.length() - 1) === 0x0a)
            for (let i = 0; i < this.indentLevel; i++)
                this.buf.writeByte(0x20);
    }

    /** dmd/json.d:76 — `void removeComma()`. Takes back a trailing `",\n"` or `", "`. */
    removeComma(): void {
        const buf = this.buf;
        if (buf.length() >= 2 && buf.opIndex(buf.length() - 2) === 0x2c
            && (buf.opIndex(buf.length() - 1) === 0x0a || buf.opIndex(buf.length() - 1) === 0x20))
            buf.setsize(buf.length() - 2);
    }

    /** dmd/json.d:82 — `void comma()`. Inside any array or object, ends an item with `",\n"`. */
    comma(): void {
        if (this.indentLevel > 0)
            this.buf.writestring(ds(",\n"));
    }

    /** dmd/json.d:88 — `void stringStart()`. */
    stringStart(): void {
        this.buf.writeByte(0x22);   // '\"'
    }

    /** dmd/json.d:93 — `void stringEnd()`. */
    stringEnd(): void {
        this.buf.writeByte(0x22);   // '\"'
    }

    /**
     * dmd/json.d:98 — `extern(D) void stringPart(const char[] s)`. Writes `s` with JSON escapes, byte by byte:
     * UTF-8 sequences pass through unchanged; a control byte without a short escape is `\u00XX`.
     */
    stringPart(s: DString | null): void {
        for (const c of s ?? []) {
            switch (c) {
                case 0x0a:   // '\n'
                    this.buf.writestring(ds("\\n"));
                    break;
                case 0x0d:   // '\r'
                    this.buf.writestring(ds("\\r"));
                    break;
                case 0x09:   // '\t'
                    this.buf.writestring(ds("\\t"));
                    break;
                case 0x22:   // '\"'
                    this.buf.writestring(ds("\\\""));
                    break;
                case 0x5c:   // '\\'
                    this.buf.writestring(ds("\\\\"));
                    break;
                case 0x08:   // '\b'
                    this.buf.writestring(ds("\\b"));
                    break;
                case 0x0c:   // '\f'
                    this.buf.writestring(ds("\\f"));
                    break;
                default:
                    if (c < 0x20)
                        this.buf.printf(ds("\\u%04x"), c);
                    else {
                        // Note that UTF-8 chars pass through here just fine
                        this.buf.writeByte(c);
                    }
                    break;
            }
        }
    }

    // Json value functions
    /** dmd/json.d:142 — `extern(D) void value(const char[] s)`. Encode string into buf, wrapped in double quotes. */
    value(s: DString | null): void {
        this.stringStart();
        this.stringPart(s);
        this.stringEnd();
    }

    /** dmd/json.d:149 — `void value(int value)` (04 §1 rule 3: `valueFromInt`). */
    valueFromInt(value: number): void {
        if (value < 0) {
            this.buf.writeByte(0x2d);   // '-'
            value = -value | 0;
        }
        this.buf.print(BigInt.asUintN(64, BigInt(value)));   // `print(ulong)`: the int sign-extends
    }

    /** dmd/json.d:159 — `void valueBool(bool value)`. */
    valueBool(value: boolean): void {
        this.buf.writestring(value ? ds("true") : ds("false"));
    }

    /** dmd/json.d:167 — `extern(D) void item(const char[] s)`. Item is an indented value and a comma, for arrays. */
    item(s: DString | null): void {
        this.indent();
        this.value(s);
        this.comma();
    }

    /** dmd/json.d:174 — `void item(int i)` (04 §1 rule 3: `itemFromInt`). */
    itemFromInt(i: number): void {
        this.indent();
        this.valueFromInt(i);
        this.comma();
    }

    /** dmd/json.d:181 — `void itemBool(const bool b)`. */
    itemBool(b: boolean): void {
        this.indent();
        this.valueBool(b);
        this.comma();
    }

    // Json array functions
    /** dmd/json.d:189 — `void arrayStart()`. */
    arrayStart(): void {
        this.indent();
        this.buf.writestring(ds("[\n"));
        this.indentLevel++;
    }

    /** dmd/json.d:196 — `void arrayEnd()`. An empty array closes as `[]`. */
    arrayEnd(): void {
        const buf = this.buf;
        this.indentLevel--;
        this.removeComma();
        if (buf.length() >= 2 && buf.opIndex(buf.length() - 2) === 0x5b && buf.opIndex(buf.length() - 1) === 0x0a)
            buf.setsize(buf.length() - 1);
        else if (!(buf.length() >= 1 && buf.opIndex(buf.length() - 1) === 0x5b)) {
            buf.writestring(ds("\n"));
            this.indent();
        }
        buf.writestring(ds("]"));
        this.comma();
    }

    // Json object functions
    /** dmd/json.d:212 — `void objectStart()`. */
    objectStart(): void {
        this.indent();
        this.buf.writestring(ds("{\n"));
        this.indentLevel++;
    }

    /** dmd/json.d:219 — `void objectEnd()`. An empty object closes as `{}`. */
    objectEnd(): void {
        const buf = this.buf;
        this.indentLevel--;
        this.removeComma();
        if (buf.length() >= 2 && buf.opIndex(buf.length() - 2) === 0x7b && buf.opIndex(buf.length() - 1) === 0x0a)
            buf.setsize(buf.length() - 1);
        else {
            buf.writestring(ds("\n"));
            this.indent();
        }
        buf.writestring(ds("}"));
        this.comma();
    }

    // Json object property functions
    /** dmd/json.d:235 — `extern(D) void propertyStart(const char[] name)`. */
    propertyStart(name: DString): void {
        this.indent();
        this.value(name);
        this.buf.writestring(ds(" : "));
    }

    /**
     * dmd/json.d:249 — `extern(D) void property(const char[] name, const char[] s)`. Write the given string object
     * property only if `s` is not null (an empty non-null slice is written).
     */
    property(name: DString, s: DString | null): void {
        if (s === null)
            return;
        this.propertyStart(name);
        this.value(s);
        this.comma();
    }

    /**
     * dmd/json.d:265 — `extern(D) void requiredProperty(const char[] name, const char[] s)`. Write the given string
     * object property; a null `s` is written as the JSON `null`.
     */
    requiredProperty(name: DString, s: DString | null): void {
        this.propertyStart(name);
        if (s === null)
            this.buf.writestring(ds("null"));
        else
            this.value(s);
        this.comma();
    }

    /** dmd/json.d:275 — `extern(D) void property(const char[] name, int i)` (04 §1 rule 3: `propertyFromInt`). */
    propertyFromInt(name: DString, i: number): void {
        this.propertyStart(name);
        this.valueFromInt(i);
        this.comma();
    }

    /** dmd/json.d:282 — `extern(D) void propertyBool(const char[] name, const bool b)`. */
    propertyBool(name: DString, b: boolean): void {
        this.propertyStart(name);
        this.valueBool(b);
        this.comma();
    }

    /**
     * dmd/json.d:289 — `extern(D) void property(const char[] name, TRUST trust)` (04 §1 rule 3:
     * `propertyFromTrust`). `TRUST.default_` writes nothing.
     */
    propertyFromTrust(name: DString, trust: TRUST): void {
        switch (trust) {
            case TRUST.default_:
                // Should not be printed
                break;
            case TRUST.system:  return this.property(name, ds("system"));
            case TRUST.trusted: return this.property(name, ds("trusted"));
            case TRUST.safe:    return this.property(name, ds("safe"));
            default: {
                // final switch: D throws SwitchError on an unhandled value
                const _exhaustive: never = trust; void _exhaustive;
                throw new SwitchError();
            }
        }
    }

    /**
     * dmd/json.d:303 — `extern(D) void property(const char[] name, PURE purity)` (04 §1 rule 3:
     * `propertyFromPurity`). `PURE.impure` writes nothing; `PURE.const_` is spelled `strong`.
     */
    propertyFromPurity(name: DString, purity: PURE): void {
        switch (purity) {
            case PURE.impure:
                // Should not be printed
                break;
            case PURE.weak:     return this.property(name, ds("weak"));
            case PURE.const_:   return this.property(name, ds("strong"));
            case PURE.fwdref:   return this.property(name, ds("fwdref"));
            default: {
                // final switch: D throws SwitchError on an unhandled value
                const _exhaustive: never = purity; void _exhaustive;
                throw new SwitchError();
            }
        }
    }

    /**
     * dmd/json.d:317 — `extern(D) void property(const char[] name, const LINK linkage)` (04 §1 rule 3:
     * `propertyFromLinkage`). `LINK.default_` and `LINK.d` write nothing.
     */
    propertyFromLinkage(name: DString, linkage: LINK): void {
        switch (linkage) {
            case LINK.default_:
                // Should not be printed
                break;
            case LINK.d:
                // Should not be printed
                break;
            case LINK.system:   return this.property(name, ds("system"));
            case LINK.c:        return this.property(name, ds("c"));
            case LINK.cpp:      return this.property(name, ds("cpp"));
            case LINK.windows:  return this.property(name, ds("windows"));
            case LINK.objc:     return this.property(name, ds("objc"));
            default: {
                // final switch: D throws SwitchError on an unhandled value
                const _exhaustive: never = linkage; void _exhaustive;
                throw new SwitchError();
            }
        }
    }

    /**
     * dmd/json.d:337 — `extern(D) void propertyStorageClass(const char[] name, STC stc)`. Writes the visible
     * storage classes of `stc` as an array of keywords, in hdrgen's table order; nothing when none is visible.
     */
    propertyStorageClass(name: DString, stc: STC): void {
        stc = (stc & STC.visibleStorageClasses) as STC;   // `stc &= …`: branded flag re-cast (02 §11.5c #4)
        if (stc) {
            this.propertyStart(name);
            this.arrayStart();
            const box: Ref<STC> = { value: stc };   // `stcToString(ref STC)` reduces `stc`
            while (box.value) {
                const p = stcToString(box);
                assert(p.length !== 0);
                this.item(p);
            }
            this.arrayEnd();
        }
    }

    /**
     * dmd/json.d:354 — `extern(D) void property(const char[] linename, const char[] charname, Loc loc)` (04 §1
     * rule 3: `propertyFromLoc`). For a valid `loc`: a `"file"` property when the file changed since the last one
     * written, then the line and, when known, the column.
     */
    propertyFromLoc(linename: DString, charname: DString, loc: Loc): void {
        if (loc.isValid()) {
            const sl = SourceLoc.fromLoc(loc);
            if (sl.filename.length > 0 && (this.filename === null || !dsEquals(sl.filename, this.filename))) {
                this.filename = sl.filename;
                this.property(ds("file"), sl.filename);
            }

            if (sl.linnum) {
                this.propertyFromInt(linename, sl.linnum | 0);
                if (sl.charnum)
                    this.propertyFromInt(charname, sl.charnum | 0);
            }
        }
    }

    /** dmd/json.d:374 — `extern(D) void property(const char[] name, Type type)` (`propertyFromType`). */
    propertyFromType(name: DString, type: Type | null): void {
        if (type) {
            this.property(name, type.toString());
        }
    }

    /**
     * dmd/json.d:382 — `extern(D) void property(const char[] name, const char[] deconame, Type type)` (04 §1 rule 3:
     * `propertyFromTypeDeco`). The mangled type under `deconame` once semantic has given it one, else the
     * printed type under `name`.
     */
    propertyFromTypeDeco(name: DString, deconame: DString, type: Type | null): void {
        if (type) {
            if (type.deco)
                this.property(deconame, dsUtf8(type.deco));
            else
                this.property(name, type.toString());
        }
    }

    /**
     * dmd/json.d:393 — `extern(D) void property(const char[] name, Parameters* parameters)` (04 §1 rule 3:
     * `propertyFromParameters`). Nothing for a null or empty list.
     */
    propertyFromParameters(name: DString, parameters: Parameters | null): void {
        if (parameters === null || parameters.length === 0)
            return;
        this.propertyStart(name);
        this.arrayStart();
        if (parameters) {
            for (let i = 0; i < parameters.length; i++) {
                const p = parameters.opIndex(i)!;
                this.objectStart();
                if (p.ident)
                    this.property(ds("name"), p.ident.toString());
                this.propertyFromTypeDeco(ds("type"), ds("deco"), p.type);
                this.propertyStorageClass(ds("storageClass"), p.storageClass);
                if (p.defaultArg)
                    this.property(ds("default"), p.defaultArg.toString());
                this.objectEnd();
            }
        }
        this.arrayEnd();
    }

    /* ========================================================================== */
    /**
     * dmd/json.d:418 — `void jsonProperties(Dsymbol s)`. The properties every symbol object carries: name, kind,
     * protection, an enum member's value, comment, and the location.
     */
    jsonProperties(s: Dsymbol): void {
        if (s.isModule())
            return;
        if (!s.isTemplateDeclaration()) { // TemplateDeclaration::kind() acts weird sometimes
            this.property(ds("name"), s.toString());
            if (s.isStaticCtorDeclaration()) {
                this.property(ds("kind"), s.isSharedStaticCtorDeclaration()
                    ? ds("shared static constructor") : ds("static constructor"));
            }
            else if (s.isStaticDtorDeclaration()) {
                this.property(ds("kind"), s.isSharedStaticDtorDeclaration()
                    ? ds("shared static destructor") : ds("static destructor"));
            }
            else
                this.property(ds("kind"), cstr(s.kind()));
        }
        // TODO: How about package(names)?
        this.property(ds("protection"), visibilityToString(s.visible().kind));
        const em = s.isEnumMember();
        if (em !== null) {
            if (em.origValue)
                this.property(ds("value"), em.origValue.toString());
        }
        this.property(ds("comment"), toDString(s.comment()));
        this.propertyFromLoc(ds("line"), ds("char"), s.loc);
    }

    /**
     * dmd/json.d:449 — `void jsonProperties(Declaration d)` (04 §1 rule 2: `jsonPropertiesDeclaration`). The
     * Dsymbol properties plus storage classes, linkage, type, and the original type when it prints differently.
     * A `STC.local` declaration writes nothing.
     */
    jsonPropertiesDeclaration(d: Declaration): void {
        if (d.storage_class & STC.local)
            return;
        this.jsonProperties(d);
        this.propertyStorageClass(ds("storageClass"), d.storage_class);
        this.propertyFromLinkage(ds("linkage"), d._linkage);
        this.propertyFromTypeDeco(ds("type"), ds("deco"), d.type);
        // Emit originalType if it differs from type
        if (d.type !== d.originalType && d.originalType) {
            const ostr = d.originalType.toString();
            if (d.type) {
                const tstr = d.type.toString();
                if (!dsEquals(ostr, tstr)) {
                    this.property(ds("originalType"), ostr);
                }
            }
            else
                this.property(ds("originalType"), ostr);
        }
    }

    /**
     * dmd/json.d:475 — `void jsonProperties(TemplateDeclaration td)` (04 §1 rule 2:
     * `jsonPropertiesTemplateDeclaration`). The Dsymbol properties, then the name again: `this` for a constructor
     * template, the bare identifier otherwise. Computes `td.onemember` when not yet done.
     */
    jsonPropertiesTemplateDeclaration(td: TemplateDeclaration): void {
        this.jsonProperties(td);
        computeOneMember(td);
        if (td.onemember && td.onemember.isCtorDeclaration())
            this.property(ds("name"), ds("this")); // __ctor -> this
        else
            this.property(ds("name"), td.ident!.toString()); // Foo(T) -> Foo
    }

    /* ========================================================================== */
    /** dmd/json.d:486 — `override void visit(Dsymbol s)`. A symbol with no JSON form writes nothing. */
    override visitDsymbol(_s: Dsymbol): void {
    }

    /** dmd/json.d:490 — `override void visit(Module s)`. */
    override visitModule(s: Module): void {
        this.objectStart();
        if (s.md)
            this.property(ds("name"), s.md.toString());
        this.property(ds("kind"), cstr(s.kind()));
        this.filename = s.srcfile.toString();
        this.property(ds("file"), this.filename);
        this.property(ds("comment"), toDString(s.comment()));
        this.propertyStart(ds("members"));
        this.arrayStart();
        for (let i = 0; i < s.members!.length; i++) {
            s.members!.opIndex(i)!.accept(this);
        }
        this.arrayEnd();
        this.objectEnd();
    }

    /** dmd/json.d:509 — `override void visit(Import s)`. The implicit `import object;` writes nothing. */
    override visitImport(s: Import): void {
        if (s.id === Id.object)
            return;
        this.objectStart();
        this.propertyStart(ds("name"));
        this.stringStart();
        for (const pid of s.packages ?? []) {   // a null slice iterates zero times
            this.stringPart(pid.toString());
            this.buf.writeByte(0x2e);   // '.'
        }
        this.stringPart(s.id!.toString());
        this.stringEnd();
        this.comma();
        this.property(ds("kind"), cstr(s.kind()));
        this.property(ds("comment"), toDString(s.comment()));
        this.propertyFromLoc(ds("line"), ds("char"), s.loc);
        if (s.visible().kind !== Visibility.Kind.public_)
            this.property(ds("protection"), visibilityToString(s.visible().kind));
        if (s.aliasId)
            this.property(ds("alias"), s.aliasId.toString());
        let hasRenamed = false;
        let hasSelective = false;
        for (let i = 0; i < s.aliases.length; i++) {
            // avoid empty "renamed" and "selective" sections
            if (hasRenamed && hasSelective)
                break;
            else if (s.aliases.opIndex(i))
                hasRenamed = true;
            else
                hasSelective = true;
        }
        if (hasRenamed) {
            // import foo : alias1 = target1;
            this.propertyStart(ds("renamed"));
            this.objectStart();
            for (let i = 0; i < s.aliases.length; i++) {
                const name = s.names.opIndex(i)!;
                const _alias = s.aliases.opIndex(i);
                if (_alias)
                    this.property(_alias.toString(), name.toString());
            }
            this.objectEnd();
        }
        if (hasSelective) {
            // import foo : target1;
            this.propertyStart(ds("selective"));
            this.arrayStart();
            for (let i = 0; i < s.names.length; i++) {
                const name = s.names.opIndex(i)!;
                if (!s.aliases.opIndex(i))
                    this.item(name.toString());
            }
            this.arrayEnd();
        }
        this.objectEnd();
    }

    /** dmd/json.d:571 — `override void visit(AttribDeclaration d)`. Visits the included declarations. */
    override visitAttribDeclaration(d: AttribDeclaration): void {
        const ds_ = include(d, null);
        if (ds_) {
            for (let i = 0; i < ds_.length; i++) {
                const s = ds_.opIndex(i)!;
                s.accept(this);
            }
        }
    }

    /**
     * dmd/json.d:584 — `override void visit(ConditionalDeclaration d)`. A condition already evaluated visits the
     * included branch; otherwise the `if` branch when there is one, else the `else` branch.
     */
    override visitConditionalDeclaration(d: ConditionalDeclaration): void {
        if (d.condition.inc !== Include.notComputed) {
            this.visitAttribDeclaration(d);
            return; // Don't visit the if/else bodies again below
        }
        const ds_ = d.decl ? d.decl : d.elsedecl;
        for (let i = 0; i < ds_!.length; i++) {   // D reads `ds.length` unchecked
            const s = ds_!.opIndex(i)!;
            s.accept(this);
        }
    }

    /** dmd/json.d:599 — `override void visit(TypeInfoDeclaration d)`. */
    override visitTypeInfoDeclaration(_d: TypeInfoDeclaration): void {
    }

    /** dmd/json.d:603 — `override void visit(PostBlitDeclaration d)`. */
    override visitPostBlitDeclaration(_d: PostBlitDeclaration): void {
    }

    /** dmd/json.d:607 — `override void visit(Declaration d)`. */
    override visitDeclaration(d: Declaration): void {
        this.objectStart();
        //property("unknown", "declaration");
        this.jsonPropertiesDeclaration(d);
        this.objectEnd();
    }

    /**
     * dmd/json.d:615 — `override void visit(AggregateDeclaration d)`. A class adds its base class (unless `Object`)
     * and its interfaces, fully qualified with template arguments.
     */
    override visitAggregateDeclaration(d: AggregateDeclaration): void {
        this.objectStart();
        this.jsonProperties(d);
        const cd = d.isClassDeclaration();
        if (cd) {
            if (cd.baseClass && cd.baseClass.ident !== Id.Object) {
                this.property(ds("base"), cstr(cd.baseClass.toPrettyChars(true)));
            }
            const interfaces = cd.interfaces ?? [];   // a null slice has length 0
            if (interfaces.length) {
                this.propertyStart(ds("interfaces"));
                this.arrayStart();
                for (const b of interfaces) {
                    this.item(cstr(b!.sym!.toPrettyChars(true)));
                }
                this.arrayEnd();
            }
        }
        if (d.members) {
            this.propertyStart(ds("members"));
            this.arrayStart();
            for (let i = 0; i < d.members.length; i++) {
                const s = d.members.opIndex(i)!;
                s.accept(this);
            }
            this.arrayEnd();
        }
        this.objectEnd();
    }

    /**
     * dmd/json.d:651 — `override void visit(FuncDeclaration d)`. Adds parameters, the end location, the functions
     * it overrides, and the `in`/`out` contract functions as nested objects.
     */
    override visitFuncDeclaration(d: FuncDeclaration): void {
        this.objectStart();
        this.jsonPropertiesDeclaration(d);
        // D `cast(TypeFunction)d.type` reinterprets without a check; the adjacent `ty == Tfunction` test is the
        // tag proof that makes the checked downcast non-null.
        const tf = d.type;
        if (tf && tf.ty === Tfunction)
            this.propertyFromParameters(ds("parameters"), tf.isTypeFunction()!.parameterList.parameters);
        this.propertyFromLoc(ds("endline"), ds("endchar"), d.endloc);
        if (d.foverrides.length) {
            this.propertyStart(ds("overrides"));
            this.arrayStart();
            for (let i = 0; i < d.foverrides.length; i++) {
                const fd = d.foverrides.opIndex(i)!;
                this.item(cstr(fd.toPrettyChars()));
            }
            this.arrayEnd();
        }
        if (d.fdrequire()) {
            this.propertyStart(ds("in"));
            d.fdrequire()!.accept(this);
        }
        if (d.fdensure()) {
            this.propertyStart(ds("out"));
            d.fdensure()!.accept(this);
        }
        this.objectEnd();
    }

    /**
     * dmd/json.d:683 — `override void visit(TemplateDeclaration d)`. Kind `template`, the template parameters
     * with their kinds, specializations and defaults, the constraint, and the members.
     */
    override visitTemplateDeclaration(d: TemplateDeclaration): void {
        this.objectStart();
        // TemplateDeclaration::kind returns the kind of its Aggregate onemember, if it is one
        this.property(ds("kind"), ds("template"));
        this.jsonPropertiesTemplateDeclaration(d);
        this.propertyStart(ds("parameters"));
        this.arrayStart();
        for (let i = 0; i < d.parameters!.length; i++) {
            const s = d.parameters!.opIndex(i)!;
            this.objectStart();
            this.property(ds("name"), s.ident!.toString());

            const type = s.isTemplateTypeParameter();
            if (type) {
                if (s.isTemplateThisParameter())
                    this.property(ds("kind"), ds("this"));
                else
                    this.property(ds("kind"), ds("type"));
                this.propertyFromTypeDeco(ds("type"), ds("deco"), type.specType);
                this.propertyFromTypeDeco(ds("default"), ds("defaultDeco"), type.defaultType);
            }

            const value = s.isTemplateValueParameter();
            if (value) {
                this.property(ds("kind"), ds("value"));
                this.propertyFromTypeDeco(ds("type"), ds("deco"), value.valType);
                if (value.specValue)
                    this.property(ds("specValue"), value.specValue.toString());
                if (value.defaultValue)
                    this.property(ds("defaultValue"), value.defaultValue.toString());
            }

            const _alias = s.isTemplateAliasParameter();
            if (_alias) {
                this.property(ds("kind"), ds("alias"));
                this.propertyFromTypeDeco(ds("type"), ds("deco"), _alias.specType);
                if (_alias.specAlias)
                    this.property(ds("specAlias"), _alias.specAlias.toString());
                if (_alias.defaultAlias)
                    this.property(ds("defaultAlias"), _alias.defaultAlias.toString());
            }

            const tuple = s.isTemplateTupleParameter();
            if (tuple) {
                this.property(ds("kind"), ds("tuple"));
            }

            this.objectEnd();
        }
        this.arrayEnd();
        const expression = d.constraint;
        if (expression) {
            this.property(ds("constraint"), expression.toString());
        }
        this.propertyStart(ds("members"));
        this.arrayStart();
        for (let i = 0; i < d.members!.length; i++) {
            const s = d.members!.opIndex(i)!;
            s.accept(this);
        }
        this.arrayEnd();
        this.objectEnd();
    }

    /**
     * dmd/json.d:751 — `override void visit(EnumDeclaration d)`. An anonymous enum writes its members in place, in
     * the enclosing array; a named one is an object with its base type and members.
     */
    override visitEnumDeclaration(d: EnumDeclaration): void {
        if (d.isAnonymous()) {
            if (d.members) {
                for (let i = 0; i < d.members.length; i++) {
                    const s = d.members.opIndex(i)!;
                    s.accept(this);
                }
            }
            return;
        }
        this.objectStart();
        this.jsonProperties(d);
        this.propertyFromTypeDeco(ds("base"), ds("baseDeco"), d.memtype);
        if (d.members) {
            this.propertyStart(ds("members"));
            this.arrayStart();
            for (let i = 0; i < d.members.length; i++) {
                const s = d.members.opIndex(i)!;
                s.accept(this);
            }
            this.arrayEnd();
        }
        this.objectEnd();
    }

    /** dmd/json.d:782 — `override void visit(EnumMember s)`. */
    override visitEnumMember(s: EnumMember): void {
        this.objectStart();
        this.jsonProperties(s);
        this.propertyFromTypeDeco(ds("type"), ds("deco"), s.origType);
        this.objectEnd();
    }

    /**
     * dmd/json.d:790 — `override void visit(VarDeclaration d)`. Adds the initializer, a field's offset and an
     * explicit alignment. A `STC.local` variable writes nothing.
     */
    override visitVarDeclaration(d: VarDeclaration): void {
        if (d.storage_class & STC.local)
            return;
        this.objectStart();
        this.jsonPropertiesDeclaration(d);
        if (d._init)
            this.property(ds("init"), initializerToString(d._init));
        if (d.isField())
            this.propertyFromInt(ds("offset"), d.offset | 0);
        if (!d.alignment.isUnknown() && !d.alignment.isDefault())
            this.propertyFromInt(ds("align"), d.alignment.get() | 0);
        this.objectEnd();
    }

    /** dmd/json.d:805 — `override void visit(TemplateMixin d)`. */
    override visitTemplateMixin(d: TemplateMixin): void {
        this.objectStart();
        this.jsonProperties(d);
        this.objectEnd();
    }

    /**
     * dmd/json.d:819 — `private void generateModules(ref Modules modules)`. Generate an array of module objects
     * that represent the syntax of each "root module". Under `-v`, prints `json gen <module>` for each.
     */
    generateModules(modules: Modules): void {
        this.arrayStart();
        for (const m of modules) {
            if (global.params.v.verbose)
                messageNoLoc(ds("json gen %s"), m!.toChars());
            m!.accept(this);
        }
        this.arrayEnd();
    }

    /**
     * dmd/json.d:835 — `private void generateCompilerInfo()`. Generate the "compilerInfo" object which contains
     * information about the compiler such as the filename, version, supported features, etc.
     */
    generateCompilerInfo(): void {
        // `import dmd.target : target;` (json.d:837) is the module-level import above.
        this.objectStart();
        this.requiredProperty(ds("vendor"), global.compileEnv.vendor);
        this.requiredProperty(ds("version"), global.versionString());
        this.propertyFromInt(ds("__VERSION__"), global.versionNumber() | 0);
        this.requiredProperty(ds("interface"), determineCompilerInterface());
        this.propertyFromInt(ds("size_t"), 8);   // `size_t.sizeof` of the ldc2 binary itself, a 64-bit host
        this.propertyStart(ds("platforms"));
        this.arrayStart();
        if (target.os === OS.Windows) {
            this.item(ds("windows"));
        }
        else {
            this.item(ds("posix"));
            if (target.os === OS.linux)
                this.item(ds("linux"));
            else if (target.os === OS.OSX)
                this.item(ds("osx"));
            else if (target.os === OS.FreeBSD) {
                this.item(ds("freebsd"));
                this.item(ds("bsd"));
            }
            else if (target.os === OS.OpenBSD) {
                this.item(ds("openbsd"));
                this.item(ds("bsd"));
            }
            else if (target.os === OS.Solaris) {
                this.item(ds("solaris"));
                this.item(ds("bsd"));
            }
        }
        this.arrayEnd();

        this.propertyStart(ds("architectures"));
        this.arrayStart();
        this.item(target.architectureName);
        this.arrayEnd();

        this.propertyStart(ds("predefinedVersions"));
        this.arrayStart();
        for (const versionid of global.versionids) {
            this.item(versionid!.toString());
        }
        this.arrayEnd();

        this.propertyStart(ds("supportedFeatures"));
        {
            this.objectStart();
            try {
                this.propertyBool(ds("includeImports"), true);
            } finally {
                this.objectEnd();   // scope(exit)
            }
        }
        this.objectEnd();
    }

    /**
     * dmd/json.d:901 — `private void generateBuildInfo()`. Generate the "buildInfo" object which contains
     * information specific to the current build such as CWD, importPaths, configFile, etc.
     */
    generateBuildInfo(): void {
        this.objectStart();
        this.requiredProperty(ds("cwd"), dsUtf8(process.cwd()));   // `getcwd(null, 0).toDString` (json.d:52)
        this.requiredProperty(ds("argv0"), global.params.argv0);
        this.requiredProperty(ds("config"), global.inifilename);
        this.requiredProperty(ds("libName"), global.params.libname);

        this.propertyStart(ds("importPaths"));
        this.arrayStart();
        for (const importPath of global.params.imppath) {
            this.item(cstr(importPath!.path));
        }
        this.arrayEnd();

        this.propertyStart(ds("objectFiles"));
        this.arrayStart();
        for (const objfile of global.params.objfiles) {
            this.item(cstr(objfile!));
        }
        this.arrayEnd();

        this.propertyStart(ds("libraryFiles"));
        this.arrayStart();
        for (const lib of global.params.libfiles) {
            this.item(cstr(lib!));
        }
        this.arrayEnd();

        this.propertyStart(ds("ddocFiles"));
        this.arrayStart();
        for (const ddocFile of global.params.ddoc.files) {
            this.item(cstr(ddocFile!));
        }
        this.arrayEnd();

        this.requiredProperty(ds("mapFile"), global.params.mapfile);
        this.requiredProperty(ds("resourceFile"), global.params.resfile);
        this.requiredProperty(ds("defFile"), global.params.deffile);

        this.objectEnd();
    }

    /**
     * dmd/json.d:953 — `private void generateSemantics()`. Generate the "semantics" object which contains a
     * 'modules' field representing semantic information about all the modules used in the compilation such as
     * module name, isRoot, contentImportedFiles, etc.
     */
    generateSemantics(): void {
        this.objectStart();
        this.propertyStart(ds("modules"));
        this.arrayStart();
        for (const m of Module.amodules) {
            this.objectStart();
            this.requiredProperty(ds("name"), m!.md ? m!.md.toString() : null);
            this.requiredProperty(ds("file"), m!.srcfile.toString());
            this.propertyBool(ds("isRoot"), m!.isRoot());
            if (m!.contentImportedFiles.length > 0) {
                this.propertyStart(ds("contentImports"));
                this.arrayStart();
                for (const file of m!.contentImportedFiles) {
                    this.item(cstr(file!));
                }
                this.arrayEnd();
            }
            this.objectEnd();
        }
        this.arrayEnd();
        this.objectEnd();
    }
}

/**
 * dmd/json.d:987 — `void json_generate(ref Modules modules, ref OutBuffer buf)`. Appends the `-X` JSON for
 * `modules` (the root modules) to `buf`, followed by a newline.
 *
 * With no `-Xi` field selected (`global.params.jsonFieldFlags == 0`) the output is the original format: an array
 * of module objects. Otherwise it is one object holding the selected fields, in the fixed order compilerInfo,
 * buildInfo, modules, semantics. The modules are read after semantic3 (main.d calls this from `generateJson`,
 * mars.d:147): templates' `onemember` may be computed on the way (`computeOneMember`), and `AttribDeclaration`s
 * evaluate their condition through `include`, but the AST is otherwise unchanged. buildInfo reads the process's
 * working directory.
 */
export function json_generate(modules: Modules, buf: OutBuffer): void {
    const json = new ToJsonVisitor(buf);
    // write trailing newline
    try {
        if (global.params.jsonFieldFlags === 0) {
            // Generate the original format, which is just an array
            // of modules representing their syntax.
            json.generateModules(modules);
            json.removeComma();
            return;
        }

        // Generate the new format which is an object where each
        // output option is its own field.

        json.objectStart();
        if (global.params.jsonFieldFlags & JsonFieldFlags.compilerInfo) {
            json.propertyStart(ds("compilerInfo"));
            json.generateCompilerInfo();
        }
        if (global.params.jsonFieldFlags & JsonFieldFlags.buildInfo) {
            json.propertyStart(ds("buildInfo"));
            json.generateBuildInfo();
        }
        if (global.params.jsonFieldFlags & JsonFieldFlags.modules) {
            json.propertyStart(ds("modules"));
            json.generateModules(modules);
        }
        if (global.params.jsonFieldFlags & JsonFieldFlags.semantics) {
            json.propertyStart(ds("semantics"));
            json.generateSemantics();
        }
        json.objectEnd();
    } finally {
        buf.writeByte(0x0a);   // scope(exit) buf.writeByte('\n')
    }
}

/**
 * dmd/json.d:1032 — `enum jsonFieldNames = () {`. A string listing the name of each JSON field, for error messages:
 * every `JsonFieldFlags` member after `none`, backquoted, comma-separated. D builds it by CTFE over
 * `__traits(allMembers, JsonFieldFlags)`; resolved at translation time (07) against globals.d:62.
 */
export const jsonFieldNames: DString = ds("`compilerInfo`, `buildInfo`, `modules`, `semantics`");

/**
 * dmd/json.d:1055 — `JsonFieldFlags tryParseJsonField(const(char)* fieldName)`. Parse the given `fieldName` (a
 * `-Xi=` value; the bytes up to the first NUL) and return its corresponding JsonFieldFlags value, or
 * `JsonFieldFlags.none` when it names no field. Case-sensitive. The driver (driver/main.cpp:404) ORs the result
 * into `global.params.jsonFieldFlags` and reports `none` as an error.
 */
export function tryParseJsonField(fieldName: DString): JsonFieldFlags {
    const fieldNameString = toDString(fieldName)!;
    // `static foreach` over `__traits(allMembers, JsonFieldFlags)` from index 1 (globals.d:62), unrolled (07).
    if (dsEquals(fieldNameString, ds("compilerInfo")))
        return JsonFieldFlags.compilerInfo;
    if (dsEquals(fieldNameString, ds("buildInfo")))
        return JsonFieldFlags.buildInfo;
    if (dsEquals(fieldNameString, ds("modules")))
        return JsonFieldFlags.modules;
    if (dsEquals(fieldNameString, ds("semantics")))
        return JsonFieldFlags.semantics;
    return JsonFieldFlags.none;
}

/**
 * dmd/json.d:1073 — `private extern(D) string determineCompilerInterface()`. Determines and returns the compiler
 * interface which is one of `dmd`, `ldc`, `gdc` or `sdc`. Returns `null` if no interface can be determined.
 */
function determineCompilerInterface(): DString | null {
    if (dsEquals(global.compileEnv.vendor, ds("Digital Mars D")))
        return ds("dmd");
    if (dsEquals(global.compileEnv.vendor, ds("LDC")))
        return ds("ldc");
    if (dsEquals(global.compileEnv.vendor, ds("GNU D")))
        return ds("gdc");
    if (dsEquals(global.compileEnv.vendor, ds("SDC")))
        return ds("sdc");
    return null;
}
