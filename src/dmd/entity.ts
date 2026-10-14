/**
 * Defines the named entities to support the "\&Entity;" escape sequence for strings / character literals.
 *
 * Specification $(LINK2 https://dlang.org/spec/entity.html, Named Character Entities)
 *
 * Copyright:   Copyright (C) 1999-2025 by The D Language Foundation, All Rights Reserved
 * Authors:     $(LINK2 https://www.digitalmars.com, Walter Bright)
 * License:     $(LINK2 https://www.boost.org/LICENSE_1_0.txt, Boost License 1.0)
 * Source:      $(LINK2 https://github.com/dlang/dmd/blob/master/compiler/src/dmd/entity.d, _entity.d)
 * Documentation:  https://dlang.org/phobos/dmd_entity.html
 * Coverage:    https://codecov.io/gh/dlang/dmd/src/master/compiler/src/dmd/entity.d
 *
 * Port of dmd/entity.d (module dmd.entity). FAITHFUL 1:1: this is a large static DATA table
 * (the HTML-named-character-entity set, ~2194 rows) plus one lookup function. De-stubs the lexer's
 * `\&name;` escape (lexer.ts previously carried a 4-entry MINIMAL_ENTITIES placeholder).
 *
 * GOVERNING RESOLUTIONS:
 *   - `nothrow:` ERASE (04 §8).
 *   - `import core.stdc.ctype;` — only `tolower` is used (entity.d:30). Inlined as a local C-locale
 *     shim (01 §3.7: a libc shim is not a module), matching the lexer's own ctype inlining. VERIFIED
 *     ldc2: C `tolower` maps only ASCII 'A'..'Z' to lowercase; every other byte (incl. high bytes
 *     like 0xC1) passes through unchanged.
 *   - `pure @nogc @safe` on `HtmlNamedEntity` ERASE (04 §8).
 *   - `private:` section (entity.d:43) — `NameId`, `namesTable`, and the 26 per-letter `namesX`
 *     arrays are module-private. They are NOT exported (only the lookup `HtmlNamedEntity` is public).
 *
 * VALUE SEMANTICS: `struct NameId` is a value type, but every table entry is CONSTRUCTED ONCE at
 * module load and only ever READ (the lookup reads `.name`/`.value`/`.value2`, never copies or
 * mutates an entry). So no `.copy()` discipline applies at the read sites (03). `value`/`value2`
 * are `uint` code points — well within the 32-bit `number` domain (09 §1.1).
 */

import { ds, dsEquals } from "../dstring.js";
import type { DString } from "../dstring.js";
import { DError } from "../assert.js";

// ── core.stdc.ctype (C-locale, byte-domain) — imported by entity.d as `core.stdc.ctype` ─────────
// entity.d:30 calls `tolower(name[0])`. The default C locale (08 §16) lowercases only ASCII
// 'A'..'Z'; all other bytes (digits, punctuation, high bytes) pass through unchanged (VERIFIED ldc2,
// tolower(0xC1)==0xC1). Inlined (01 §3.7: a libc shim is not a module).
function tolower(c: number): number {
    return (c >= 0x41 /* 'A' */ && c <= 0x5a /* 'Z' */) ? c + 0x20 : c;
}

/**********************************
 * See if `name` is an HTML Named Entity
 * Params:
 *      name = name of the entity
 * Returns:
 *      code point corresponding to the named entity (as `[value, value2]`)
 *      `[0, 0]` for not recognized as a named entity
 *
 * Precondition (entity.d:30, `name[0]`): `name` is non-empty. D's `name[0]` on an empty slice is a
 * bounds error; the lexer never passes an empty name (its scan loop requires a leading alpha char).
 * Reproduced as a LOUD failure (boundary-validation.md / crash-only): an empty `name` is a contract
 * violation, thrown rather than silently reading `undefined`.
 */
export function HtmlNamedEntity(name: DString): [number, number] {
    if (name.length === 0) {
        throw new DError("HtmlNamedEntity: empty name (index [0] out of bounds for array of length 0)");
    }
    const firstC = tolower(name[0]);
    if (firstC >= 0x61 /* 'a' */ && firstC <= 0x7a /* 'z' */) {
        // Linear search (use hash table instead?)
        for (const entity of namesTable[firstC - 0x61 /* 'a' */]) {
            if (dsEquals(entity.name, name))
                return [entity.value, entity.value2];
        }
    }
    return [0, 0];
}

// ── private: ────────────────────────────────────────────────────────────────────────────────────

/*********************************************
 * Convert from named entity to its encoding.
 * For reference:
 *      https://www.htmlhelp.com/reference/html40/entities/
 *      https://www.w3.org/2003/entities/2007/w3centities-f.ent
 *
 * `struct NameId { string name; uint value; uint value2; }` (entity.d:51). `value2` defaults to 0
 * (the D aggregate-literal default for the omitted third field). VALUE type, but read-only in
 * practice — no `.copy()` needed (see module header).
 */
class NameId {
    name: DString;
    value: number;
    value2: number;
    constructor(name: DString, value: number, value2 = 0) {
        this.name = name;
        this.value = value;
        this.value2 = value2;
    }
}

const namesA: readonly NameId[] = [
    new NameId(ds("Aacgr"), 0x00386),  // GREEK CAPITAL LETTER ALPHA WITH TONOS
    new NameId(ds("aacgr"), 0x003AC),  // GREEK SMALL LETTER ALPHA WITH TONOS
    new NameId(ds("Aacute"), 0x000C1),  // LATIN CAPITAL LETTER A WITH ACUTE
    new NameId(ds("aacute"), 0x000E1),  // LATIN SMALL LETTER A WITH ACUTE
    new NameId(ds("Abreve"), 0x00102),  // LATIN CAPITAL LETTER A WITH BREVE
    new NameId(ds("abreve"), 0x00103),  // LATIN SMALL LETTER A WITH BREVE
    new NameId(ds("ac"), 0x0223E),  // INVERTED LAZY S
    new NameId(ds("acd"), 0x0223F),  // SINE WAVE
    new NameId(ds("acE"), 0x0223E, 0x00333),  // INVERTED LAZY S with double underline
    new NameId(ds("Acirc"), 0x000C2),  // LATIN CAPITAL LETTER A WITH CIRCUMFLEX
    new NameId(ds("acirc"), 0x000E2),  // LATIN SMALL LETTER A WITH CIRCUMFLEX
    new NameId(ds("acute"), 0x000B4),  // ACUTE ACCENT
    new NameId(ds("Acy"), 0x00410),  // CYRILLIC CAPITAL LETTER A
    new NameId(ds("acy"), 0x00430),  // CYRILLIC SMALL LETTER A
    new NameId(ds("AElig"), 0x000C6),  // LATIN CAPITAL LETTER AE
    new NameId(ds("aelig"), 0x000E6),  // LATIN SMALL LETTER AE
    new NameId(ds("af"), 0x02061),  // FUNCTION APPLICATION
    new NameId(ds("Afr"), 0x1D504),  // MATHEMATICAL FRAKTUR CAPITAL A
    new NameId(ds("afr"), 0x1D51E),  // MATHEMATICAL FRAKTUR SMALL A
    new NameId(ds("Agr"), 0x00391),  // GREEK CAPITAL LETTER ALPHA
    new NameId(ds("agr"), 0x003B1),  // GREEK SMALL LETTER ALPHA
    new NameId(ds("Agrave"), 0x000C0),  // LATIN CAPITAL LETTER A WITH GRAVE
    new NameId(ds("agrave"), 0x000E0),  // LATIN SMALL LETTER A WITH GRAVE
    new NameId(ds("alefsym"), 0x02135),  // ALEF SYMBOL
    new NameId(ds("aleph"), 0x02135),  // ALEF SYMBOL
    new NameId(ds("Alpha"), 0x00391),  // GREEK CAPITAL LETTER ALPHA
    new NameId(ds("alpha"), 0x003B1),  // GREEK SMALL LETTER ALPHA
    new NameId(ds("Amacr"), 0x00100),  // LATIN CAPITAL LETTER A WITH MACRON
    new NameId(ds("amacr"), 0x00101),  // LATIN SMALL LETTER A WITH MACRON
    new NameId(ds("amalg"), 0x02A3F),  // AMALGAMATION OR COPRODUCT
    new NameId(ds("amp"), 0x00026),  // AMPERSAND
    new NameId(ds("AMP"), 0x00026),  // AMPERSAND
    new NameId(ds("and"), 0x02227),  // LOGICAL AND
    new NameId(ds("And"), 0x02A53),  // DOUBLE LOGICAL AND
    new NameId(ds("andand"), 0x02A55),  // TWO INTERSECTING LOGICAL AND
    new NameId(ds("andd"), 0x02A5C),  // LOGICAL AND WITH HORIZONTAL DASH
    new NameId(ds("andslope"), 0x02A58),  // SLOPING LARGE AND
    new NameId(ds("andv"), 0x02A5A),  // LOGICAL AND WITH MIDDLE STEM
    new NameId(ds("ang"), 0x02220),  // ANGLE
    new NameId(ds("ange"), 0x029A4),  // ANGLE WITH UNDERBAR
    new NameId(ds("angle"), 0x02220),  // ANGLE
    new NameId(ds("angmsd"), 0x02221),  // MEASURED ANGLE
    new NameId(ds("angmsdaa"), 0x029A8),  // MEASURED ANGLE WITH OPEN ARM ENDING IN ARROW POINTING UP AND RIGHT
    new NameId(ds("angmsdab"), 0x029A9),  // MEASURED ANGLE WITH OPEN ARM ENDING IN ARROW POINTING UP AND LEFT
    new NameId(ds("angmsdac"), 0x029AA),  // MEASURED ANGLE WITH OPEN ARM ENDING IN ARROW POINTING DOWN AND RIGHT
    new NameId(ds("angmsdad"), 0x029AB),  // MEASURED ANGLE WITH OPEN ARM ENDING IN ARROW POINTING DOWN AND LEFT
    new NameId(ds("angmsdae"), 0x029AC),  // MEASURED ANGLE WITH OPEN ARM ENDING IN ARROW POINTING RIGHT AND UP
    new NameId(ds("angmsdaf"), 0x029AD),  // MEASURED ANGLE WITH OPEN ARM ENDING IN ARROW POINTING LEFT AND UP
    new NameId(ds("angmsdag"), 0x029AE),  // MEASURED ANGLE WITH OPEN ARM ENDING IN ARROW POINTING RIGHT AND DOWN
    new NameId(ds("angmsdah"), 0x029AF),  // MEASURED ANGLE WITH OPEN ARM ENDING IN ARROW POINTING LEFT AND DOWN
    new NameId(ds("angrt"), 0x0221F),  // RIGHT ANGLE
    new NameId(ds("angrtvb"), 0x022BE),  // RIGHT ANGLE WITH ARC
    new NameId(ds("angrtvbd"), 0x0299D),  // MEASURED RIGHT ANGLE WITH DOT
    new NameId(ds("angsph"), 0x02222),  // SPHERICAL ANGLE
    new NameId(ds("angst"), 0x000C5),  // LATIN CAPITAL LETTER A WITH RING ABOVE
    new NameId(ds("angzarr"), 0x0237C),  // RIGHT ANGLE WITH DOWNWARDS ZIGZAG ARROW
    new NameId(ds("Aogon"), 0x00104),  // LATIN CAPITAL LETTER A WITH OGONEK
    new NameId(ds("aogon"), 0x00105),  // LATIN SMALL LETTER A WITH OGONEK
    new NameId(ds("Aopf"), 0x1D538),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL A
    new NameId(ds("aopf"), 0x1D552),  // MATHEMATICAL DOUBLE-STRUCK SMALL A
    new NameId(ds("ap"), 0x02248),  // ALMOST EQUAL TO
    new NameId(ds("apacir"), 0x02A6F),  // ALMOST EQUAL TO WITH CIRCUMFLEX ACCENT
    new NameId(ds("ape"), 0x0224A),  // ALMOST EQUAL OR EQUAL TO
    new NameId(ds("apE"), 0x02A70),  // APPROXIMATELY EQUAL OR EQUAL TO
    new NameId(ds("apid"), 0x0224B),  // TRIPLE TILDE
    new NameId(ds("apos"), 0x00027),  // APOSTROPHE
    new NameId(ds("ApplyFunction"), 0x02061),  // FUNCTION APPLICATION
    new NameId(ds("approx"), 0x02248),  // ALMOST EQUAL TO
    new NameId(ds("approxeq"), 0x0224A),  // ALMOST EQUAL OR EQUAL TO
    new NameId(ds("Aring"), 0x000C5),  // LATIN CAPITAL LETTER A WITH RING ABOVE
    new NameId(ds("aring"), 0x000E5),  // LATIN SMALL LETTER A WITH RING ABOVE
    new NameId(ds("Ascr"), 0x1D49C),  // MATHEMATICAL SCRIPT CAPITAL A
    new NameId(ds("ascr"), 0x1D4B6),  // MATHEMATICAL SCRIPT SMALL A
    new NameId(ds("Assign"), 0x02254),  // COLON EQUALS
    new NameId(ds("ast"), 0x0002A),  // ASTERISK
    new NameId(ds("asymp"), 0x02248),  // ALMOST EQUAL TO
    new NameId(ds("asympeq"), 0x0224D),  // EQUIVALENT TO
    new NameId(ds("Atilde"), 0x000C3),  // LATIN CAPITAL LETTER A WITH TILDE
    new NameId(ds("atilde"), 0x000E3),  // LATIN SMALL LETTER A WITH TILDE
    new NameId(ds("Auml"), 0x000C4),  // LATIN CAPITAL LETTER A WITH DIAERESIS
    new NameId(ds("auml"), 0x000E4),  // LATIN SMALL LETTER A WITH DIAERESIS
    new NameId(ds("awconint"), 0x02233),  // ANTICLOCKWISE CONTOUR INTEGRAL
    new NameId(ds("awint"), 0x02A11),  // ANTICLOCKWISE INTEGRATION
];

const namesB: readonly NameId[] = [
    new NameId(ds("backcong"), 0x0224C),  // ALL EQUAL TO
    new NameId(ds("backepsilon"), 0x003F6),  // GREEK REVERSED LUNATE EPSILON SYMBOL
    new NameId(ds("backprime"), 0x02035),  // REVERSED PRIME
    new NameId(ds("backsim"), 0x0223D),  // REVERSED TILDE
    new NameId(ds("backsimeq"), 0x022CD),  // REVERSED TILDE EQUALS
    new NameId(ds("Backslash"), 0x02216),  // SET MINUS
    new NameId(ds("Barv"), 0x02AE7),  // SHORT DOWN TACK WITH OVERBAR
    new NameId(ds("barvee"), 0x022BD),  // NOR
    new NameId(ds("barwed"), 0x02305),  // PROJECTIVE
    new NameId(ds("Barwed"), 0x02306),  // PERSPECTIVE
    new NameId(ds("barwedge"), 0x02305),  // PROJECTIVE
    new NameId(ds("bbrk"), 0x023B5),  // BOTTOM SQUARE BRACKET
    new NameId(ds("bbrktbrk"), 0x023B6),  // BOTTOM SQUARE BRACKET OVER TOP SQUARE BRACKET
    new NameId(ds("bcong"), 0x0224C),  // ALL EQUAL TO
    new NameId(ds("Bcy"), 0x00411),  // CYRILLIC CAPITAL LETTER BE
    new NameId(ds("bcy"), 0x00431),  // CYRILLIC SMALL LETTER BE
    new NameId(ds("bdquo"), 0x0201E),  // DOUBLE LOW-9 QUOTATION MARK
    new NameId(ds("becaus"), 0x02235),  // BECAUSE
    new NameId(ds("because"), 0x02235),  // BECAUSE
    new NameId(ds("Because"), 0x02235),  // BECAUSE
    new NameId(ds("bemptyv"), 0x029B0),  // REVERSED EMPTY SET
    new NameId(ds("bepsi"), 0x003F6),  // GREEK REVERSED LUNATE EPSILON SYMBOL
    new NameId(ds("bernou"), 0x0212C),  // SCRIPT CAPITAL B
    new NameId(ds("Bernoullis"), 0x0212C),  // SCRIPT CAPITAL B
    new NameId(ds("Beta"), 0x00392),  // GREEK CAPITAL LETTER BETA
    new NameId(ds("beta"), 0x003B2),  // GREEK SMALL LETTER BETA
    new NameId(ds("beth"), 0x02136),  // BET SYMBOL
    new NameId(ds("between"), 0x0226C),  // BETWEEN
    new NameId(ds("Bfr"), 0x1D505),  // MATHEMATICAL FRAKTUR CAPITAL B
    new NameId(ds("bfr"), 0x1D51F),  // MATHEMATICAL FRAKTUR SMALL B
    new NameId(ds("Bgr"), 0x00392),  // GREEK CAPITAL LETTER BETA
    new NameId(ds("bgr"), 0x003B2),  // GREEK SMALL LETTER BETA
    new NameId(ds("bigcap"), 0x022C2),  // N-ARY INTERSECTION
    new NameId(ds("bigcirc"), 0x025EF),  // LARGE CIRCLE
    new NameId(ds("bigcup"), 0x022C3),  // N-ARY UNION
    new NameId(ds("bigodot"), 0x02A00),  // N-ARY CIRCLED DOT OPERATOR
    new NameId(ds("bigoplus"), 0x02A01),  // N-ARY CIRCLED PLUS OPERATOR
    new NameId(ds("bigotimes"), 0x02A02),  // N-ARY CIRCLED TIMES OPERATOR
    new NameId(ds("bigsqcup"), 0x02A06),  // N-ARY SQUARE UNION OPERATOR
    new NameId(ds("bigstar"), 0x02605),  // BLACK STAR
    new NameId(ds("bigtriangledown"), 0x025BD),  // WHITE DOWN-POINTING TRIANGLE
    new NameId(ds("bigtriangleup"), 0x025B3),  // WHITE UP-POINTING TRIANGLE
    new NameId(ds("biguplus"), 0x02A04),  // N-ARY UNION OPERATOR WITH PLUS
    new NameId(ds("bigvee"), 0x022C1),  // N-ARY LOGICAL OR
    new NameId(ds("bigwedge"), 0x022C0),  // N-ARY LOGICAL AND
    new NameId(ds("bkarow"), 0x0290D),  // RIGHTWARDS DOUBLE DASH ARROW
    new NameId(ds("blacklozenge"), 0x029EB),  // BLACK LOZENGE
    new NameId(ds("blacksquare"), 0x025AA),  // BLACK SMALL SQUARE
    new NameId(ds("blacktriangle"), 0x025B4),  // BLACK UP-POINTING SMALL TRIANGLE
    new NameId(ds("blacktriangledown"), 0x025BE),  // BLACK DOWN-POINTING SMALL TRIANGLE
    new NameId(ds("blacktriangleleft"), 0x025C2),  // BLACK LEFT-POINTING SMALL TRIANGLE
    new NameId(ds("blacktriangleright"), 0x025B8),  // BLACK RIGHT-POINTING SMALL TRIANGLE
    new NameId(ds("blank"), 0x02423),  // OPEN BOX
    new NameId(ds("blk12"), 0x02592),  // MEDIUM SHADE
    new NameId(ds("blk14"), 0x02591),  // LIGHT SHADE
    new NameId(ds("blk34"), 0x02593),  // DARK SHADE
    new NameId(ds("block"), 0x02588),  // FULL BLOCK
    new NameId(ds("bne"), 0x0003D, 0x020E5),  // EQUALS SIGN with reverse slash
    new NameId(ds("bnequiv"), 0x02261, 0x020E5),  // IDENTICAL TO with reverse slash
    new NameId(ds("bnot"), 0x02310),  // REVERSED NOT SIGN
    new NameId(ds("bNot"), 0x02AED),  // REVERSED DOUBLE STROKE NOT SIGN
    new NameId(ds("Bopf"), 0x1D539),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL B
    new NameId(ds("bopf"), 0x1D553),  // MATHEMATICAL DOUBLE-STRUCK SMALL B
    new NameId(ds("bot"), 0x022A5),  // UP TACK
    new NameId(ds("bottom"), 0x022A5),  // UP TACK
    new NameId(ds("bowtie"), 0x022C8),  // BOWTIE
    new NameId(ds("boxbox"), 0x029C9),  // TWO JOINED SQUARES
    new NameId(ds("boxdl"), 0x02510),  // BOX DRAWINGS LIGHT DOWN AND LEFT
    new NameId(ds("boxdL"), 0x02555),  // BOX DRAWINGS DOWN SINGLE AND LEFT DOUBLE
    new NameId(ds("boxDl"), 0x02556),  // BOX DRAWINGS DOWN DOUBLE AND LEFT SINGLE
    new NameId(ds("boxDL"), 0x02557),  // BOX DRAWINGS DOUBLE DOWN AND LEFT
    new NameId(ds("boxdr"), 0x0250C),  // BOX DRAWINGS LIGHT DOWN AND RIGHT
    new NameId(ds("boxdR"), 0x02552),  // BOX DRAWINGS DOWN SINGLE AND RIGHT DOUBLE
    new NameId(ds("boxDr"), 0x02553),  // BOX DRAWINGS DOWN DOUBLE AND RIGHT SINGLE
    new NameId(ds("boxDR"), 0x02554),  // BOX DRAWINGS DOUBLE DOWN AND RIGHT
    new NameId(ds("boxh"), 0x02500),  // BOX DRAWINGS LIGHT HORIZONTAL
    new NameId(ds("boxH"), 0x02550),  // BOX DRAWINGS DOUBLE HORIZONTAL
    new NameId(ds("boxhd"), 0x0252C),  // BOX DRAWINGS LIGHT DOWN AND HORIZONTAL
    new NameId(ds("boxHd"), 0x02564),  // BOX DRAWINGS DOWN SINGLE AND HORIZONTAL DOUBLE
    new NameId(ds("boxhD"), 0x02565),  // BOX DRAWINGS DOWN DOUBLE AND HORIZONTAL SINGLE
    new NameId(ds("boxHD"), 0x02566),  // BOX DRAWINGS DOUBLE DOWN AND HORIZONTAL
    new NameId(ds("boxhu"), 0x02534),  // BOX DRAWINGS LIGHT UP AND HORIZONTAL
    new NameId(ds("boxHu"), 0x02567),  // BOX DRAWINGS UP SINGLE AND HORIZONTAL DOUBLE
    new NameId(ds("boxhU"), 0x02568),  // BOX DRAWINGS UP DOUBLE AND HORIZONTAL SINGLE
    new NameId(ds("boxHU"), 0x02569),  // BOX DRAWINGS DOUBLE UP AND HORIZONTAL
    new NameId(ds("boxminus"), 0x0229F),  // SQUARED MINUS
    new NameId(ds("boxplus"), 0x0229E),  // SQUARED PLUS
    new NameId(ds("boxtimes"), 0x022A0),  // SQUARED TIMES
    new NameId(ds("boxul"), 0x02518),  // BOX DRAWINGS LIGHT UP AND LEFT
    new NameId(ds("boxuL"), 0x0255B),  // BOX DRAWINGS UP SINGLE AND LEFT DOUBLE
    new NameId(ds("boxUl"), 0x0255C),  // BOX DRAWINGS UP DOUBLE AND LEFT SINGLE
    new NameId(ds("boxUL"), 0x0255D),  // BOX DRAWINGS DOUBLE UP AND LEFT
    new NameId(ds("boxur"), 0x02514),  // BOX DRAWINGS LIGHT UP AND RIGHT
    new NameId(ds("boxuR"), 0x02558),  // BOX DRAWINGS UP SINGLE AND RIGHT DOUBLE
    new NameId(ds("boxUr"), 0x02559),  // BOX DRAWINGS UP DOUBLE AND RIGHT SINGLE
    new NameId(ds("boxUR"), 0x0255A),  // BOX DRAWINGS DOUBLE UP AND RIGHT
    new NameId(ds("boxv"), 0x02502),  // BOX DRAWINGS LIGHT VERTICAL
    new NameId(ds("boxV"), 0x02551),  // BOX DRAWINGS DOUBLE VERTICAL
    new NameId(ds("boxvh"), 0x0253C),  // BOX DRAWINGS LIGHT VERTICAL AND HORIZONTAL
    new NameId(ds("boxvH"), 0x0256A),  // BOX DRAWINGS VERTICAL SINGLE AND HORIZONTAL DOUBLE
    new NameId(ds("boxVh"), 0x0256B),  // BOX DRAWINGS VERTICAL DOUBLE AND HORIZONTAL SINGLE
    new NameId(ds("boxVH"), 0x0256C),  // BOX DRAWINGS DOUBLE VERTICAL AND HORIZONTAL
    new NameId(ds("boxvl"), 0x02524),  // BOX DRAWINGS LIGHT VERTICAL AND LEFT
    new NameId(ds("boxvL"), 0x02561),  // BOX DRAWINGS VERTICAL SINGLE AND LEFT DOUBLE
    new NameId(ds("boxVl"), 0x02562),  // BOX DRAWINGS VERTICAL DOUBLE AND LEFT SINGLE
    new NameId(ds("boxVL"), 0x02563),  // BOX DRAWINGS DOUBLE VERTICAL AND LEFT
    new NameId(ds("boxvr"), 0x0251C),  // BOX DRAWINGS LIGHT VERTICAL AND RIGHT
    new NameId(ds("boxvR"), 0x0255E),  // BOX DRAWINGS VERTICAL SINGLE AND RIGHT DOUBLE
    new NameId(ds("boxVr"), 0x0255F),  // BOX DRAWINGS VERTICAL DOUBLE AND RIGHT SINGLE
    new NameId(ds("boxVR"), 0x02560),  // BOX DRAWINGS DOUBLE VERTICAL AND RIGHT
    new NameId(ds("bprime"), 0x02035),  // REVERSED PRIME
    new NameId(ds("breve"), 0x002D8),  // BREVE
    new NameId(ds("Breve"), 0x002D8),  // BREVE
    new NameId(ds("brvbar"), 0x000A6),  // BROKEN BAR
    new NameId(ds("Bscr"), 0x0212C),  // SCRIPT CAPITAL B
    new NameId(ds("bscr"), 0x1D4B7),  // MATHEMATICAL SCRIPT SMALL B
    new NameId(ds("bsemi"), 0x0204F),  // REVERSED SEMICOLON
    new NameId(ds("bsim"), 0x0223D),  // REVERSED TILDE
    new NameId(ds("bsime"), 0x022CD),  // REVERSED TILDE EQUALS
    new NameId(ds("bsol"), 0x0005C),  // REVERSE SOLIDUS
    new NameId(ds("bsolb"), 0x029C5),  // SQUARED FALLING DIAGONAL SLASH
    new NameId(ds("bsolhsub"), 0x027C8),  // REVERSE SOLIDUS PRECEDING SUBSET
    new NameId(ds("bull"), 0x02022),  // BULLET
    new NameId(ds("bullet"), 0x02022),  // BULLET
    new NameId(ds("bump"), 0x0224E),  // GEOMETRICALLY EQUIVALENT TO
    new NameId(ds("bumpe"), 0x0224F),  // DIFFERENCE BETWEEN
    new NameId(ds("bumpE"), 0x02AAE),  // EQUALS SIGN WITH BUMPY ABOVE
    new NameId(ds("Bumpeq"), 0x0224E),  // GEOMETRICALLY EQUIVALENT TO
    new NameId(ds("bumpeq"), 0x0224F),  // DIFFERENCE BETWEEN
];

const namesC: readonly NameId[] = [
    new NameId(ds("Cacute"), 0x00106),  // LATIN CAPITAL LETTER C WITH ACUTE
    new NameId(ds("cacute"), 0x00107),  // LATIN SMALL LETTER C WITH ACUTE
    new NameId(ds("cap"), 0x02229),  // INTERSECTION
    new NameId(ds("Cap"), 0x022D2),  // DOUBLE INTERSECTION
    new NameId(ds("capand"), 0x02A44),  // INTERSECTION WITH LOGICAL AND
    new NameId(ds("capbrcup"), 0x02A49),  // INTERSECTION ABOVE BAR ABOVE UNION
    new NameId(ds("capcap"), 0x02A4B),  // INTERSECTION BESIDE AND JOINED WITH INTERSECTION
    new NameId(ds("capcup"), 0x02A47),  // INTERSECTION ABOVE UNION
    new NameId(ds("capdot"), 0x02A40),  // INTERSECTION WITH DOT
    new NameId(ds("CapitalDifferentialD"), 0x02145),  // DOUBLE-STRUCK ITALIC CAPITAL D
    new NameId(ds("caps"), 0x02229, 0x0FE00),  // INTERSECTION with serifs
    new NameId(ds("caret"), 0x02041),  // CARET INSERTION POINT
    new NameId(ds("caron"), 0x002C7),  // CARON
    new NameId(ds("Cayleys"), 0x0212D),  // BLACK-LETTER CAPITAL C
    new NameId(ds("ccaps"), 0x02A4D),  // CLOSED INTERSECTION WITH SERIFS
    new NameId(ds("Ccaron"), 0x0010C),  // LATIN CAPITAL LETTER C WITH CARON
    new NameId(ds("ccaron"), 0x0010D),  // LATIN SMALL LETTER C WITH CARON
    new NameId(ds("Ccedil"), 0x000C7),  // LATIN CAPITAL LETTER C WITH CEDILLA
    new NameId(ds("ccedil"), 0x000E7),  // LATIN SMALL LETTER C WITH CEDILLA
    new NameId(ds("Ccirc"), 0x00108),  // LATIN CAPITAL LETTER C WITH CIRCUMFLEX
    new NameId(ds("ccirc"), 0x00109),  // LATIN SMALL LETTER C WITH CIRCUMFLEX
    new NameId(ds("Cconint"), 0x02230),  // VOLUME INTEGRAL
    new NameId(ds("ccups"), 0x02A4C),  // CLOSED UNION WITH SERIFS
    new NameId(ds("ccupssm"), 0x02A50),  // CLOSED UNION WITH SERIFS AND SMASH PRODUCT
    new NameId(ds("Cdot"), 0x0010A),  // LATIN CAPITAL LETTER C WITH DOT ABOVE
    new NameId(ds("cdot"), 0x0010B),  // LATIN SMALL LETTER C WITH DOT ABOVE
    new NameId(ds("cedil"), 0x000B8),  // CEDILLA
    new NameId(ds("Cedilla"), 0x000B8),  // CEDILLA
    new NameId(ds("cemptyv"), 0x029B2),  // EMPTY SET WITH SMALL CIRCLE ABOVE
    new NameId(ds("cent"), 0x000A2),  // CENT SIGN
    new NameId(ds("centerdot"), 0x000B7),  // MIDDLE DOT
    new NameId(ds("CenterDot"), 0x000B7),  // MIDDLE DOT
    new NameId(ds("Cfr"), 0x0212D),  // BLACK-LETTER CAPITAL C
    new NameId(ds("cfr"), 0x1D520),  // MATHEMATICAL FRAKTUR SMALL C
    new NameId(ds("CHcy"), 0x00427),  // CYRILLIC CAPITAL LETTER CHE
    new NameId(ds("chcy"), 0x00447),  // CYRILLIC SMALL LETTER CHE
    new NameId(ds("check"), 0x02713),  // CHECK MARK
    new NameId(ds("checkmark"), 0x02713),  // CHECK MARK
    new NameId(ds("Chi"), 0x003A7),  // GREEK CAPITAL LETTER CHI
    new NameId(ds("chi"), 0x003C7),  // GREEK SMALL LETTER CHI
    new NameId(ds("cir"), 0x025CB),  // WHITE CIRCLE
    new NameId(ds("circ"), 0x002C6),  // MODIFIER LETTER CIRCUMFLEX ACCENT
    new NameId(ds("circeq"), 0x02257),  // RING EQUAL TO
    new NameId(ds("circlearrowleft"), 0x021BA),  // ANTICLOCKWISE OPEN CIRCLE ARROW
    new NameId(ds("circlearrowright"), 0x021BB),  // CLOCKWISE OPEN CIRCLE ARROW
    new NameId(ds("circledast"), 0x0229B),  // CIRCLED ASTERISK OPERATOR
    new NameId(ds("circledcirc"), 0x0229A),  // CIRCLED RING OPERATOR
    new NameId(ds("circleddash"), 0x0229D),  // CIRCLED DASH
    new NameId(ds("CircleDot"), 0x02299),  // CIRCLED DOT OPERATOR
    new NameId(ds("circledR"), 0x000AE),  // REGISTERED SIGN
    new NameId(ds("circledS"), 0x024C8),  // CIRCLED LATIN CAPITAL LETTER S
    new NameId(ds("CircleMinus"), 0x02296),  // CIRCLED MINUS
    new NameId(ds("CirclePlus"), 0x02295),  // CIRCLED PLUS
    new NameId(ds("CircleTimes"), 0x02297),  // CIRCLED TIMES
    new NameId(ds("cire"), 0x02257),  // RING EQUAL TO
    new NameId(ds("cirE"), 0x029C3),  // CIRCLE WITH TWO HORIZONTAL STROKES TO THE RIGHT
    new NameId(ds("cirfnint"), 0x02A10),  // CIRCULATION FUNCTION
    new NameId(ds("cirmid"), 0x02AEF),  // VERTICAL LINE WITH CIRCLE ABOVE
    new NameId(ds("cirscir"), 0x029C2),  // CIRCLE WITH SMALL CIRCLE TO THE RIGHT
    new NameId(ds("ClockwiseContourIntegral"), 0x02232),  // CLOCKWISE CONTOUR INTEGRAL
    new NameId(ds("CloseCurlyDoubleQuote"), 0x0201D),  // RIGHT DOUBLE QUOTATION MARK
    new NameId(ds("CloseCurlyQuote"), 0x02019),  // RIGHT SINGLE QUOTATION MARK
    new NameId(ds("clubs"), 0x02663),  // BLACK CLUB SUIT
    new NameId(ds("clubsuit"), 0x02663),  // BLACK CLUB SUIT
    new NameId(ds("colon"), 0x0003A),  // COLON
    new NameId(ds("Colon"), 0x02237),  // PROPORTION
    new NameId(ds("colone"), 0x02254),  // COLON EQUALS
    new NameId(ds("Colone"), 0x02A74),  // DOUBLE COLON EQUAL
    new NameId(ds("coloneq"), 0x02254),  // COLON EQUALS
    new NameId(ds("comma"), 0x0002C),  // COMMA
    new NameId(ds("commat"), 0x00040),  // COMMERCIAL AT
    new NameId(ds("comp"), 0x02201),  // COMPLEMENT
    new NameId(ds("compfn"), 0x02218),  // RING OPERATOR
    new NameId(ds("complement"), 0x02201),  // COMPLEMENT
    new NameId(ds("complexes"), 0x02102),  // DOUBLE-STRUCK CAPITAL C
    new NameId(ds("cong"), 0x02245),  // APPROXIMATELY EQUAL TO
    new NameId(ds("congdot"), 0x02A6D),  // CONGRUENT WITH DOT ABOVE
    new NameId(ds("Congruent"), 0x02261),  // IDENTICAL TO
    new NameId(ds("conint"), 0x0222E),  // CONTOUR INTEGRAL
    new NameId(ds("Conint"), 0x0222F),  // SURFACE INTEGRAL
    new NameId(ds("ContourIntegral"), 0x0222E),  // CONTOUR INTEGRAL
    new NameId(ds("Copf"), 0x02102),  // DOUBLE-STRUCK CAPITAL C
    new NameId(ds("copf"), 0x1D554),  // MATHEMATICAL DOUBLE-STRUCK SMALL C
    new NameId(ds("coprod"), 0x02210),  // N-ARY COPRODUCT
    new NameId(ds("Coproduct"), 0x02210),  // N-ARY COPRODUCT
    new NameId(ds("copy"), 0x000A9),  // COPYRIGHT SIGN
    new NameId(ds("COPY"), 0x000A9),  // COPYRIGHT SIGN
    new NameId(ds("copysr"), 0x02117),  // SOUND RECORDING COPYRIGHT
    new NameId(ds("CounterClockwiseContourIntegral"), 0x02233),  // ANTICLOCKWISE CONTOUR INTEGRAL
    new NameId(ds("crarr"), 0x021B5),  // DOWNWARDS ARROW WITH CORNER LEFTWARDS
    new NameId(ds("cross"), 0x02717),  // BALLOT X
    new NameId(ds("Cross"), 0x02A2F),  // VECTOR OR CROSS PRODUCT
    new NameId(ds("Cscr"), 0x1D49E),  // MATHEMATICAL SCRIPT CAPITAL C
    new NameId(ds("cscr"), 0x1D4B8),  // MATHEMATICAL SCRIPT SMALL C
    new NameId(ds("csub"), 0x02ACF),  // CLOSED SUBSET
    new NameId(ds("csube"), 0x02AD1),  // CLOSED SUBSET OR EQUAL TO
    new NameId(ds("csup"), 0x02AD0),  // CLOSED SUPERSET
    new NameId(ds("csupe"), 0x02AD2),  // CLOSED SUPERSET OR EQUAL TO
    new NameId(ds("ctdot"), 0x022EF),  // MIDLINE HORIZONTAL ELLIPSIS
    new NameId(ds("cudarrl"), 0x02938),  // RIGHT-SIDE ARC CLOCKWISE ARROW
    new NameId(ds("cudarrr"), 0x02935),  // ARROW POINTING RIGHTWARDS THEN CURVING DOWNWARDS
    new NameId(ds("cuepr"), 0x022DE),  // EQUAL TO OR PRECEDES
    new NameId(ds("cuesc"), 0x022DF),  // EQUAL TO OR SUCCEEDS
    new NameId(ds("cularr"), 0x021B6),  // ANTICLOCKWISE TOP SEMICIRCLE ARROW
    new NameId(ds("cularrp"), 0x0293D),  // TOP ARC ANTICLOCKWISE ARROW WITH PLUS
    new NameId(ds("cup"), 0x0222A),  // UNION
    new NameId(ds("Cup"), 0x022D3),  // DOUBLE UNION
    new NameId(ds("cupbrcap"), 0x02A48),  // UNION ABOVE BAR ABOVE INTERSECTION
    new NameId(ds("CupCap"), 0x0224D),  // EQUIVALENT TO
    new NameId(ds("cupcap"), 0x02A46),  // UNION ABOVE INTERSECTION
    new NameId(ds("cupcup"), 0x02A4A),  // UNION BESIDE AND JOINED WITH UNION
    new NameId(ds("cupdot"), 0x0228D),  // MULTISET MULTIPLICATION
    new NameId(ds("cupor"), 0x02A45),  // UNION WITH LOGICAL OR
    new NameId(ds("cups"), 0x0222A, 0x0FE00),  // UNION with serifs
    new NameId(ds("curarr"), 0x021B7),  // CLOCKWISE TOP SEMICIRCLE ARROW
    new NameId(ds("curarrm"), 0x0293C),  // TOP ARC CLOCKWISE ARROW WITH MINUS
    new NameId(ds("curlyeqprec"), 0x022DE),  // EQUAL TO OR PRECEDES
    new NameId(ds("curlyeqsucc"), 0x022DF),  // EQUAL TO OR SUCCEEDS
    new NameId(ds("curlyvee"), 0x022CE),  // CURLY LOGICAL OR
    new NameId(ds("curlywedge"), 0x022CF),  // CURLY LOGICAL AND
    new NameId(ds("curren"), 0x000A4),  // CURRENCY SIGN
    new NameId(ds("curvearrowleft"), 0x021B6),  // ANTICLOCKWISE TOP SEMICIRCLE ARROW
    new NameId(ds("curvearrowright"), 0x021B7),  // CLOCKWISE TOP SEMICIRCLE ARROW
    new NameId(ds("cuvee"), 0x022CE),  // CURLY LOGICAL OR
    new NameId(ds("cuwed"), 0x022CF),  // CURLY LOGICAL AND
    new NameId(ds("cwconint"), 0x02232),  // CLOCKWISE CONTOUR INTEGRAL
    new NameId(ds("cwint"), 0x02231),  // CLOCKWISE INTEGRAL
    new NameId(ds("cylcty"), 0x0232D),  // CYLINDRICITY
];

const namesD: readonly NameId[] = [
    new NameId(ds("dagger"), 0x02020),  // DAGGER
    new NameId(ds("Dagger"), 0x02021),  // DOUBLE DAGGER
    new NameId(ds("daleth"), 0x02138),  // DALET SYMBOL
    new NameId(ds("darr"), 0x02193),  // DOWNWARDS ARROW
    new NameId(ds("Darr"), 0x021A1),  // DOWNWARDS TWO HEADED ARROW
    new NameId(ds("dArr"), 0x021D3),  // DOWNWARDS DOUBLE ARROW
    new NameId(ds("dash"), 0x02010),  // HYPHEN
    new NameId(ds("dashv"), 0x022A3),  // LEFT TACK
    new NameId(ds("Dashv"), 0x02AE4),  // VERTICAL BAR DOUBLE LEFT TURNSTILE
    new NameId(ds("dbkarow"), 0x0290F),  // RIGHTWARDS TRIPLE DASH ARROW
    new NameId(ds("dblac"), 0x002DD),  // DOUBLE ACUTE ACCENT
    new NameId(ds("Dcaron"), 0x0010E),  // LATIN CAPITAL LETTER D WITH CARON
    new NameId(ds("dcaron"), 0x0010F),  // LATIN SMALL LETTER D WITH CARON
    new NameId(ds("Dcy"), 0x00414),  // CYRILLIC CAPITAL LETTER DE
    new NameId(ds("dcy"), 0x00434),  // CYRILLIC SMALL LETTER DE
    new NameId(ds("DD"), 0x02145),  // DOUBLE-STRUCK ITALIC CAPITAL D
    new NameId(ds("dd"), 0x02146),  // DOUBLE-STRUCK ITALIC SMALL D
    new NameId(ds("ddagger"), 0x02021),  // DOUBLE DAGGER
    new NameId(ds("ddarr"), 0x021CA),  // DOWNWARDS PAIRED ARROWS
    new NameId(ds("DDotrahd"), 0x02911),  // RIGHTWARDS ARROW WITH DOTTED STEM
    new NameId(ds("ddotseq"), 0x02A77),  // EQUALS SIGN WITH TWO DOTS ABOVE AND TWO DOTS BELOW
    new NameId(ds("deg"), 0x000B0),  // DEGREE SIGN
    new NameId(ds("Del"), 0x02207),  // NABLA
    new NameId(ds("Delta"), 0x00394),  // GREEK CAPITAL LETTER DELTA
    new NameId(ds("delta"), 0x003B4),  // GREEK SMALL LETTER DELTA
    new NameId(ds("demptyv"), 0x029B1),  // EMPTY SET WITH OVERBAR
    new NameId(ds("dfisht"), 0x0297F),  // DOWN FISH TAIL
    new NameId(ds("Dfr"), 0x1D507),  // MATHEMATICAL FRAKTUR CAPITAL D
    new NameId(ds("dfr"), 0x1D521),  // MATHEMATICAL FRAKTUR SMALL D
    new NameId(ds("Dgr"), 0x00394),  // GREEK CAPITAL LETTER DELTA
    new NameId(ds("dgr"), 0x003B4),  // GREEK SMALL LETTER DELTA
    new NameId(ds("dHar"), 0x02965),  // DOWNWARDS HARPOON WITH BARB LEFT BESIDE DOWNWARDS HARPOON WITH BARB RIGHT
    new NameId(ds("dharl"), 0x021C3),  // DOWNWARDS HARPOON WITH BARB LEFTWARDS
    new NameId(ds("dharr"), 0x021C2),  // DOWNWARDS HARPOON WITH BARB RIGHTWARDS
    new NameId(ds("DiacriticalAcute"), 0x000B4),  // ACUTE ACCENT
    new NameId(ds("DiacriticalDot"), 0x002D9),  // DOT ABOVE
    new NameId(ds("DiacriticalDoubleAcute"), 0x002DD),  // DOUBLE ACUTE ACCENT
    new NameId(ds("DiacriticalGrave"), 0x00060),  // GRAVE ACCENT
    new NameId(ds("DiacriticalTilde"), 0x002DC),  // SMALL TILDE
    new NameId(ds("diam"), 0x022C4),  // DIAMOND OPERATOR
    new NameId(ds("diamond"), 0x022C4),  // DIAMOND OPERATOR
    new NameId(ds("Diamond"), 0x022C4),  // DIAMOND OPERATOR
    new NameId(ds("diamondsuit"), 0x02666),  // BLACK DIAMOND SUIT
    new NameId(ds("diams"), 0x02666),  // BLACK DIAMOND SUIT
    new NameId(ds("die"), 0x000A8),  // DIAERESIS
    new NameId(ds("DifferentialD"), 0x02146),  // DOUBLE-STRUCK ITALIC SMALL D
    new NameId(ds("digamma"), 0x003DD),  // GREEK SMALL LETTER DIGAMMA
    new NameId(ds("disin"), 0x022F2),  // ELEMENT OF WITH LONG HORIZONTAL STROKE
    new NameId(ds("div"), 0x000F7),  // DIVISION SIGN
    new NameId(ds("divide"), 0x000F7),  // DIVISION SIGN
    new NameId(ds("divideontimes"), 0x022C7),  // DIVISION TIMES
    new NameId(ds("divonx"), 0x022C7),  // DIVISION TIMES
    new NameId(ds("DJcy"), 0x00402),  // CYRILLIC CAPITAL LETTER DJE
    new NameId(ds("djcy"), 0x00452),  // CYRILLIC SMALL LETTER DJE
    new NameId(ds("dlcorn"), 0x0231E),  // BOTTOM LEFT CORNER
    new NameId(ds("dlcrop"), 0x0230D),  // BOTTOM LEFT CROP
    new NameId(ds("dollar"), 0x00024),  // DOLLAR SIGN
    new NameId(ds("Dopf"), 0x1D53B),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL D
    new NameId(ds("dopf"), 0x1D555),  // MATHEMATICAL DOUBLE-STRUCK SMALL D
    new NameId(ds("Dot"), 0x000A8),  // DIAERESIS
    new NameId(ds("dot"), 0x002D9),  // DOT ABOVE
    new NameId(ds("DotDot"), 0x020DC),  // COMBINING FOUR DOTS ABOVE
    new NameId(ds("doteq"), 0x02250),  // APPROACHES THE LIMIT
    new NameId(ds("doteqdot"), 0x02251),  // GEOMETRICALLY EQUAL TO
    new NameId(ds("DotEqual"), 0x02250),  // APPROACHES THE LIMIT
    new NameId(ds("dotminus"), 0x02238),  // DOT MINUS
    new NameId(ds("dotplus"), 0x02214),  // DOT PLUS
    new NameId(ds("dotsquare"), 0x022A1),  // SQUARED DOT OPERATOR
    new NameId(ds("doublebarwedge"), 0x02306),  // PERSPECTIVE
    new NameId(ds("DoubleContourIntegral"), 0x0222F),  // SURFACE INTEGRAL
    new NameId(ds("DoubleDot"), 0x000A8),  // DIAERESIS
    new NameId(ds("DoubleDownArrow"), 0x021D3),  // DOWNWARDS DOUBLE ARROW
    new NameId(ds("DoubleLeftArrow"), 0x021D0),  // LEFTWARDS DOUBLE ARROW
    new NameId(ds("DoubleLeftRightArrow"), 0x021D4),  // LEFT RIGHT DOUBLE ARROW
    new NameId(ds("DoubleLeftTee"), 0x02AE4),  // VERTICAL BAR DOUBLE LEFT TURNSTILE
    new NameId(ds("DoubleLongLeftArrow"), 0x027F8),  // LONG LEFTWARDS DOUBLE ARROW
    new NameId(ds("DoubleLongLeftRightArrow"), 0x027FA),  // LONG LEFT RIGHT DOUBLE ARROW
    new NameId(ds("DoubleLongRightArrow"), 0x027F9),  // LONG RIGHTWARDS DOUBLE ARROW
    new NameId(ds("DoubleRightArrow"), 0x021D2),  // RIGHTWARDS DOUBLE ARROW
    new NameId(ds("DoubleRightTee"), 0x022A8),  // TRUE
    new NameId(ds("DoubleUpArrow"), 0x021D1),  // UPWARDS DOUBLE ARROW
    new NameId(ds("DoubleUpDownArrow"), 0x021D5),  // UP DOWN DOUBLE ARROW
    new NameId(ds("DoubleVerticalBar"), 0x02225),  // PARALLEL TO
    new NameId(ds("downarrow"), 0x02193),  // DOWNWARDS ARROW
    new NameId(ds("DownArrow"), 0x02193),  // DOWNWARDS ARROW
    new NameId(ds("Downarrow"), 0x021D3),  // DOWNWARDS DOUBLE ARROW
    new NameId(ds("DownArrowBar"), 0x02913),  // DOWNWARDS ARROW TO BAR
    new NameId(ds("DownArrowUpArrow"), 0x021F5),  // DOWNWARDS ARROW LEFTWARDS OF UPWARDS ARROW
    new NameId(ds("DownBreve"), 0x00311),  // COMBINING INVERTED BREVE
    new NameId(ds("downdownarrows"), 0x021CA),  // DOWNWARDS PAIRED ARROWS
    new NameId(ds("downharpoonleft"), 0x021C3),  // DOWNWARDS HARPOON WITH BARB LEFTWARDS
    new NameId(ds("downharpoonright"), 0x021C2),  // DOWNWARDS HARPOON WITH BARB RIGHTWARDS
    new NameId(ds("DownLeftRightVector"), 0x02950),  // LEFT BARB DOWN RIGHT BARB DOWN HARPOON
    new NameId(ds("DownLeftTeeVector"), 0x0295E),  // LEFTWARDS HARPOON WITH BARB DOWN FROM BAR
    new NameId(ds("DownLeftVector"), 0x021BD),  // LEFTWARDS HARPOON WITH BARB DOWNWARDS
    new NameId(ds("DownLeftVectorBar"), 0x02956),  // LEFTWARDS HARPOON WITH BARB DOWN TO BAR
    new NameId(ds("DownRightTeeVector"), 0x0295F),  // RIGHTWARDS HARPOON WITH BARB DOWN FROM BAR
    new NameId(ds("DownRightVector"), 0x021C1),  // RIGHTWARDS HARPOON WITH BARB DOWNWARDS
    new NameId(ds("DownRightVectorBar"), 0x02957),  // RIGHTWARDS HARPOON WITH BARB DOWN TO BAR
    new NameId(ds("DownTee"), 0x022A4),  // DOWN TACK
    new NameId(ds("DownTeeArrow"), 0x021A7),  // DOWNWARDS ARROW FROM BAR
    new NameId(ds("drbkarow"), 0x02910),  // RIGHTWARDS TWO-HEADED TRIPLE DASH ARROW
    new NameId(ds("drcorn"), 0x0231F),  // BOTTOM RIGHT CORNER
    new NameId(ds("drcrop"), 0x0230C),  // BOTTOM RIGHT CROP
    new NameId(ds("Dscr"), 0x1D49F),  // MATHEMATICAL SCRIPT CAPITAL D
    new NameId(ds("dscr"), 0x1D4B9),  // MATHEMATICAL SCRIPT SMALL D
    new NameId(ds("DScy"), 0x00405),  // CYRILLIC CAPITAL LETTER DZE
    new NameId(ds("dscy"), 0x00455),  // CYRILLIC SMALL LETTER DZE
    new NameId(ds("dsol"), 0x029F6),  // SOLIDUS WITH OVERBAR
    new NameId(ds("Dstrok"), 0x00110),  // LATIN CAPITAL LETTER D WITH STROKE
    new NameId(ds("dstrok"), 0x00111),  // LATIN SMALL LETTER D WITH STROKE
    new NameId(ds("dtdot"), 0x022F1),  // DOWN RIGHT DIAGONAL ELLIPSIS
    new NameId(ds("dtri"), 0x025BF),  // WHITE DOWN-POINTING SMALL TRIANGLE
    new NameId(ds("dtrif"), 0x025BE),  // BLACK DOWN-POINTING SMALL TRIANGLE
    new NameId(ds("duarr"), 0x021F5),  // DOWNWARDS ARROW LEFTWARDS OF UPWARDS ARROW
    new NameId(ds("duhar"), 0x0296F),  // DOWNWARDS HARPOON WITH BARB LEFT BESIDE UPWARDS HARPOON WITH BARB RIGHT
    new NameId(ds("dwangle"), 0x029A6),  // OBLIQUE ANGLE OPENING UP
    new NameId(ds("DZcy"), 0x0040F),  // CYRILLIC CAPITAL LETTER DZHE
    new NameId(ds("dzcy"), 0x0045F),  // CYRILLIC SMALL LETTER DZHE
    new NameId(ds("dzigrarr"), 0x027FF),  // LONG RIGHTWARDS SQUIGGLE ARROW
];

const namesE: readonly NameId[] = [
    new NameId(ds("Eacgr"), 0x00388),  // GREEK CAPITAL LETTER EPSILON WITH TONOS
    new NameId(ds("eacgr"), 0x003AD),  // GREEK SMALL LETTER EPSILON WITH TONOS
    new NameId(ds("Eacute"), 0x000C9),  // LATIN CAPITAL LETTER E WITH ACUTE
    new NameId(ds("eacute"), 0x000E9),  // LATIN SMALL LETTER E WITH ACUTE
    new NameId(ds("easter"), 0x02A6E),  // EQUALS WITH ASTERISK
    new NameId(ds("Ecaron"), 0x0011A),  // LATIN CAPITAL LETTER E WITH CARON
    new NameId(ds("ecaron"), 0x0011B),  // LATIN SMALL LETTER E WITH CARON
    new NameId(ds("ecir"), 0x02256),  // RING IN EQUAL TO
    new NameId(ds("Ecirc"), 0x000CA),  // LATIN CAPITAL LETTER E WITH CIRCUMFLEX
    new NameId(ds("ecirc"), 0x000EA),  // LATIN SMALL LETTER E WITH CIRCUMFLEX
    new NameId(ds("ecolon"), 0x02255),  // EQUALS COLON
    new NameId(ds("Ecy"), 0x0042D),  // CYRILLIC CAPITAL LETTER E
    new NameId(ds("ecy"), 0x0044D),  // CYRILLIC SMALL LETTER E
    new NameId(ds("eDDot"), 0x02A77),  // EQUALS SIGN WITH TWO DOTS ABOVE AND TWO DOTS BELOW
    new NameId(ds("Edot"), 0x00116),  // LATIN CAPITAL LETTER E WITH DOT ABOVE
    new NameId(ds("edot"), 0x00117),  // LATIN SMALL LETTER E WITH DOT ABOVE
    new NameId(ds("eDot"), 0x02251),  // GEOMETRICALLY EQUAL TO
    new NameId(ds("ee"), 0x02147),  // DOUBLE-STRUCK ITALIC SMALL E
    new NameId(ds("EEacgr"), 0x00389),  // GREEK CAPITAL LETTER ETA WITH TONOS
    new NameId(ds("eeacgr"), 0x003AE),  // GREEK SMALL LETTER ETA WITH TONOS
    new NameId(ds("EEgr"), 0x00397),  // GREEK CAPITAL LETTER ETA
    new NameId(ds("eegr"), 0x003B7),  // GREEK SMALL LETTER ETA
    new NameId(ds("efDot"), 0x02252),  // APPROXIMATELY EQUAL TO OR THE IMAGE OF
    new NameId(ds("Efr"), 0x1D508),  // MATHEMATICAL FRAKTUR CAPITAL E
    new NameId(ds("efr"), 0x1D522),  // MATHEMATICAL FRAKTUR SMALL E
    new NameId(ds("eg"), 0x02A9A),  // DOUBLE-LINE EQUAL TO OR GREATER-THAN
    new NameId(ds("Egr"), 0x00395),  // GREEK CAPITAL LETTER EPSILON
    new NameId(ds("egr"), 0x003B5),  // GREEK SMALL LETTER EPSILON
    new NameId(ds("Egrave"), 0x000C8),  // LATIN CAPITAL LETTER E WITH GRAVE
    new NameId(ds("egrave"), 0x000E8),  // LATIN SMALL LETTER E WITH GRAVE
    new NameId(ds("egs"), 0x02A96),  // SLANTED EQUAL TO OR GREATER-THAN
    new NameId(ds("egsdot"), 0x02A98),  // SLANTED EQUAL TO OR GREATER-THAN WITH DOT INSIDE
    new NameId(ds("el"), 0x02A99),  // DOUBLE-LINE EQUAL TO OR LESS-THAN
    new NameId(ds("Element"), 0x02208),  // ELEMENT OF
    new NameId(ds("elinters"), 0x023E7),  // ELECTRICAL INTERSECTION
    new NameId(ds("ell"), 0x02113),  // SCRIPT SMALL L
    new NameId(ds("els"), 0x02A95),  // SLANTED EQUAL TO OR LESS-THAN
    new NameId(ds("elsdot"), 0x02A97),  // SLANTED EQUAL TO OR LESS-THAN WITH DOT INSIDE
    new NameId(ds("Emacr"), 0x00112),  // LATIN CAPITAL LETTER E WITH MACRON
    new NameId(ds("emacr"), 0x00113),  // LATIN SMALL LETTER E WITH MACRON
    new NameId(ds("empty"), 0x02205),  // EMPTY SET
    new NameId(ds("emptyset"), 0x02205),  // EMPTY SET
    new NameId(ds("EmptySmallSquare"), 0x025FB),  // WHITE MEDIUM SQUARE
    new NameId(ds("emptyv"), 0x02205),  // EMPTY SET
    new NameId(ds("EmptyVerySmallSquare"), 0x025AB),  // WHITE SMALL SQUARE
    new NameId(ds("emsp"), 0x02003),  // EM SPACE
    new NameId(ds("emsp13"), 0x02004),  // THREE-PER-EM SPACE
    new NameId(ds("emsp14"), 0x02005),  // FOUR-PER-EM SPACE
    new NameId(ds("ENG"), 0x0014A),  // LATIN CAPITAL LETTER ENG
    new NameId(ds("eng"), 0x0014B),  // LATIN SMALL LETTER ENG
    new NameId(ds("ensp"), 0x02002),  // EN SPACE
    new NameId(ds("Eogon"), 0x00118),  // LATIN CAPITAL LETTER E WITH OGONEK
    new NameId(ds("eogon"), 0x00119),  // LATIN SMALL LETTER E WITH OGONEK
    new NameId(ds("Eopf"), 0x1D53C),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL E
    new NameId(ds("eopf"), 0x1D556),  // MATHEMATICAL DOUBLE-STRUCK SMALL E
    new NameId(ds("epar"), 0x022D5),  // EQUAL AND PARALLEL TO
    new NameId(ds("eparsl"), 0x029E3),  // EQUALS SIGN AND SLANTED PARALLEL
    new NameId(ds("eplus"), 0x02A71),  // EQUALS SIGN ABOVE PLUS SIGN
    new NameId(ds("epsi"), 0x003B5),  // GREEK SMALL LETTER EPSILON
    new NameId(ds("Epsilon"), 0x00395),  // GREEK CAPITAL LETTER EPSILON
    new NameId(ds("epsilon"), 0x003B5),  // GREEK SMALL LETTER EPSILON
    new NameId(ds("epsiv"), 0x003F5),  // GREEK LUNATE EPSILON SYMBOL
    new NameId(ds("eqcirc"), 0x02256),  // RING IN EQUAL TO
    new NameId(ds("eqcolon"), 0x02255),  // EQUALS COLON
    new NameId(ds("eqsim"), 0x02242),  // MINUS TILDE
    new NameId(ds("eqslantgtr"), 0x02A96),  // SLANTED EQUAL TO OR GREATER-THAN
    new NameId(ds("eqslantless"), 0x02A95),  // SLANTED EQUAL TO OR LESS-THAN
    new NameId(ds("Equal"), 0x02A75),  // TWO CONSECUTIVE EQUALS SIGNS
    new NameId(ds("equals"), 0x0003D),  // EQUALS SIGN
    new NameId(ds("EqualTilde"), 0x02242),  // MINUS TILDE
    new NameId(ds("equest"), 0x0225F),  // QUESTIONED EQUAL TO
    new NameId(ds("Equilibrium"), 0x021CC),  // RIGHTWARDS HARPOON OVER LEFTWARDS HARPOON
    new NameId(ds("equiv"), 0x02261),  // IDENTICAL TO
    new NameId(ds("equivDD"), 0x02A78),  // EQUIVALENT WITH FOUR DOTS ABOVE
    new NameId(ds("eqvparsl"), 0x029E5),  // IDENTICAL TO AND SLANTED PARALLEL
    new NameId(ds("erarr"), 0x02971),  // EQUALS SIGN ABOVE RIGHTWARDS ARROW
    new NameId(ds("erDot"), 0x02253),  // IMAGE OF OR APPROXIMATELY EQUAL TO
    new NameId(ds("escr"), 0x0212F),  // SCRIPT SMALL E
    new NameId(ds("Escr"), 0x02130),  // SCRIPT CAPITAL E
    new NameId(ds("esdot"), 0x02250),  // APPROACHES THE LIMIT
    new NameId(ds("esim"), 0x02242),  // MINUS TILDE
    new NameId(ds("Esim"), 0x02A73),  // EQUALS SIGN ABOVE TILDE OPERATOR
    new NameId(ds("Eta"), 0x00397),  // GREEK CAPITAL LETTER ETA
    new NameId(ds("eta"), 0x003B7),  // GREEK SMALL LETTER ETA
    new NameId(ds("ETH"), 0x000D0),  // LATIN CAPITAL LETTER ETH
    new NameId(ds("eth"), 0x000F0),  // LATIN SMALL LETTER ETH
    new NameId(ds("Euml"), 0x000CB),  // LATIN CAPITAL LETTER E WITH DIAERESIS
    new NameId(ds("euml"), 0x000EB),  // LATIN SMALL LETTER E WITH DIAERESIS
    new NameId(ds("euro"), 0x020AC),  // EURO SIGN
    new NameId(ds("excl"), 0x00021),  // EXCLAMATION MARK
    new NameId(ds("exist"), 0x02203),  // THERE EXISTS
    new NameId(ds("Exists"), 0x02203),  // THERE EXISTS
    new NameId(ds("expectation"), 0x02130),  // SCRIPT CAPITAL E
    new NameId(ds("exponentiale"), 0x02147),  // DOUBLE-STRUCK ITALIC SMALL E
    new NameId(ds("ExponentialE"), 0x02147),  // DOUBLE-STRUCK ITALIC SMALL E
];

const namesF: readonly NameId[] = [
    new NameId(ds("fallingdotseq"), 0x02252),  // APPROXIMATELY EQUAL TO OR THE IMAGE OF
    new NameId(ds("Fcy"), 0x00424),  // CYRILLIC CAPITAL LETTER EF
    new NameId(ds("fcy"), 0x00444),  // CYRILLIC SMALL LETTER EF
    new NameId(ds("female"), 0x02640),  // FEMALE SIGN
    new NameId(ds("ffilig"), 0x0FB03),  // LATIN SMALL LIGATURE FFI
    new NameId(ds("fflig"), 0x0FB00),  // LATIN SMALL LIGATURE FF
    new NameId(ds("ffllig"), 0x0FB04),  // LATIN SMALL LIGATURE FFL
    new NameId(ds("Ffr"), 0x1D509),  // MATHEMATICAL FRAKTUR CAPITAL F
    new NameId(ds("ffr"), 0x1D523),  // MATHEMATICAL FRAKTUR SMALL F
    new NameId(ds("filig"), 0x0FB01),  // LATIN SMALL LIGATURE FI
    new NameId(ds("FilledSmallSquare"), 0x025FC),  // BLACK MEDIUM SQUARE
    new NameId(ds("FilledVerySmallSquare"), 0x025AA),  // BLACK SMALL SQUARE
    new NameId(ds("fjlig"), 0x00066, 0x0006A),  // fj ligature
    new NameId(ds("flat"), 0x0266D),  // MUSIC FLAT SIGN
    new NameId(ds("fllig"), 0x0FB02),  // LATIN SMALL LIGATURE FL
    new NameId(ds("fltns"), 0x025B1),  // WHITE PARALLELOGRAM
    new NameId(ds("fnof"), 0x00192),  // LATIN SMALL LETTER F WITH HOOK
    new NameId(ds("Fopf"), 0x1D53D),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL F
    new NameId(ds("fopf"), 0x1D557),  // MATHEMATICAL DOUBLE-STRUCK SMALL F
    new NameId(ds("forall"), 0x02200),  // FOR ALL
    new NameId(ds("ForAll"), 0x02200),  // FOR ALL
    new NameId(ds("fork"), 0x022D4),  // PITCHFORK
    new NameId(ds("forkv"), 0x02AD9),  // ELEMENT OF OPENING DOWNWARDS
    new NameId(ds("Fouriertrf"), 0x02131),  // SCRIPT CAPITAL F
    new NameId(ds("fpartint"), 0x02A0D),  // FINITE PART INTEGRAL
    new NameId(ds("frac12"), 0x000BD),  // VULGAR FRACTION ONE HALF
    new NameId(ds("frac13"), 0x02153),  // VULGAR FRACTION ONE THIRD
    new NameId(ds("frac14"), 0x000BC),  // VULGAR FRACTION ONE QUARTER
    new NameId(ds("frac15"), 0x02155),  // VULGAR FRACTION ONE FIFTH
    new NameId(ds("frac16"), 0x02159),  // VULGAR FRACTION ONE SIXTH
    new NameId(ds("frac18"), 0x0215B),  // VULGAR FRACTION ONE EIGHTH
    new NameId(ds("frac23"), 0x02154),  // VULGAR FRACTION TWO THIRDS
    new NameId(ds("frac25"), 0x02156),  // VULGAR FRACTION TWO FIFTHS
    new NameId(ds("frac34"), 0x000BE),  // VULGAR FRACTION THREE QUARTERS
    new NameId(ds("frac35"), 0x02157),  // VULGAR FRACTION THREE FIFTHS
    new NameId(ds("frac38"), 0x0215C),  // VULGAR FRACTION THREE EIGHTHS
    new NameId(ds("frac45"), 0x02158),  // VULGAR FRACTION FOUR FIFTHS
    new NameId(ds("frac56"), 0x0215A),  // VULGAR FRACTION FIVE SIXTHS
    new NameId(ds("frac58"), 0x0215D),  // VULGAR FRACTION FIVE EIGHTHS
    new NameId(ds("frac78"), 0x0215E),  // VULGAR FRACTION SEVEN EIGHTHS
    new NameId(ds("frasl"), 0x02044),  // FRACTION SLASH
    new NameId(ds("frown"), 0x02322),  // FROWN
    new NameId(ds("Fscr"), 0x02131),  // SCRIPT CAPITAL F
    new NameId(ds("fscr"), 0x1D4BB),  // MATHEMATICAL SCRIPT SMALL F
];

const namesG: readonly NameId[] = [
    new NameId(ds("gacute"), 0x001F5),  // LATIN SMALL LETTER G WITH ACUTE
    new NameId(ds("Gamma"), 0x00393),  // GREEK CAPITAL LETTER GAMMA
    new NameId(ds("gamma"), 0x003B3),  // GREEK SMALL LETTER GAMMA
    new NameId(ds("Gammad"), 0x003DC),  // GREEK LETTER DIGAMMA
    new NameId(ds("gammad"), 0x003DD),  // GREEK SMALL LETTER DIGAMMA
    new NameId(ds("gap"), 0x02A86),  // GREATER-THAN OR APPROXIMATE
    new NameId(ds("Gbreve"), 0x0011E),  // LATIN CAPITAL LETTER G WITH BREVE
    new NameId(ds("gbreve"), 0x0011F),  // LATIN SMALL LETTER G WITH BREVE
    new NameId(ds("Gcedil"), 0x00122),  // LATIN CAPITAL LETTER G WITH CEDILLA
    new NameId(ds("Gcirc"), 0x0011C),  // LATIN CAPITAL LETTER G WITH CIRCUMFLEX
    new NameId(ds("gcirc"), 0x0011D),  // LATIN SMALL LETTER G WITH CIRCUMFLEX
    new NameId(ds("Gcy"), 0x00413),  // CYRILLIC CAPITAL LETTER GHE
    new NameId(ds("gcy"), 0x00433),  // CYRILLIC SMALL LETTER GHE
    new NameId(ds("Gdot"), 0x00120),  // LATIN CAPITAL LETTER G WITH DOT ABOVE
    new NameId(ds("gdot"), 0x00121),  // LATIN SMALL LETTER G WITH DOT ABOVE
    new NameId(ds("ge"), 0x02265),  // GREATER-THAN OR EQUAL TO
    new NameId(ds("gE"), 0x02267),  // GREATER-THAN OVER EQUAL TO
    new NameId(ds("gel"), 0x022DB),  // GREATER-THAN EQUAL TO OR LESS-THAN
    new NameId(ds("gEl"), 0x02A8C),  // GREATER-THAN ABOVE DOUBLE-LINE EQUAL ABOVE LESS-THAN
    new NameId(ds("geq"), 0x02265),  // GREATER-THAN OR EQUAL TO
    new NameId(ds("geqq"), 0x02267),  // GREATER-THAN OVER EQUAL TO
    new NameId(ds("geqslant"), 0x02A7E),  // GREATER-THAN OR SLANTED EQUAL TO
    new NameId(ds("ges"), 0x02A7E),  // GREATER-THAN OR SLANTED EQUAL TO
    new NameId(ds("gescc"), 0x02AA9),  // GREATER-THAN CLOSED BY CURVE ABOVE SLANTED EQUAL
    new NameId(ds("gesdot"), 0x02A80),  // GREATER-THAN OR SLANTED EQUAL TO WITH DOT INSIDE
    new NameId(ds("gesdoto"), 0x02A82),  // GREATER-THAN OR SLANTED EQUAL TO WITH DOT ABOVE
    new NameId(ds("gesdotol"), 0x02A84),  // GREATER-THAN OR SLANTED EQUAL TO WITH DOT ABOVE LEFT
    new NameId(ds("gesl"), 0x022DB, 0x0FE00),  // GREATER-THAN slanted EQUAL TO OR LESS-THAN
    new NameId(ds("gesles"), 0x02A94),  // GREATER-THAN ABOVE SLANTED EQUAL ABOVE LESS-THAN ABOVE SLANTED EQUAL
    new NameId(ds("Gfr"), 0x1D50A),  // MATHEMATICAL FRAKTUR CAPITAL G
    new NameId(ds("gfr"), 0x1D524),  // MATHEMATICAL FRAKTUR SMALL G
    new NameId(ds("gg"), 0x0226B),  // MUCH GREATER-THAN
    new NameId(ds("Gg"), 0x022D9),  // VERY MUCH GREATER-THAN
    new NameId(ds("ggg"), 0x022D9),  // VERY MUCH GREATER-THAN
    new NameId(ds("Ggr"), 0x00393),  // GREEK CAPITAL LETTER GAMMA
    new NameId(ds("ggr"), 0x003B3),  // GREEK SMALL LETTER GAMMA
    new NameId(ds("gimel"), 0x02137),  // GIMEL SYMBOL
    new NameId(ds("GJcy"), 0x00403),  // CYRILLIC CAPITAL LETTER GJE
    new NameId(ds("gjcy"), 0x00453),  // CYRILLIC SMALL LETTER GJE
    new NameId(ds("gl"), 0x02277),  // GREATER-THAN OR LESS-THAN
    new NameId(ds("gla"), 0x02AA5),  // GREATER-THAN BESIDE LESS-THAN
    new NameId(ds("glE"), 0x02A92),  // GREATER-THAN ABOVE LESS-THAN ABOVE DOUBLE-LINE EQUAL
    new NameId(ds("glj"), 0x02AA4),  // GREATER-THAN OVERLAPPING LESS-THAN
    new NameId(ds("gnap"), 0x02A8A),  // GREATER-THAN AND NOT APPROXIMATE
    new NameId(ds("gnapprox"), 0x02A8A),  // GREATER-THAN AND NOT APPROXIMATE
    new NameId(ds("gnE"), 0x02269),  // GREATER-THAN BUT NOT EQUAL TO
    new NameId(ds("gne"), 0x02A88),  // GREATER-THAN AND SINGLE-LINE NOT EQUAL TO
    new NameId(ds("gneq"), 0x02A88),  // GREATER-THAN AND SINGLE-LINE NOT EQUAL TO
    new NameId(ds("gneqq"), 0x02269),  // GREATER-THAN BUT NOT EQUAL TO
    new NameId(ds("gnsim"), 0x022E7),  // GREATER-THAN BUT NOT EQUIVALENT TO
    new NameId(ds("Gopf"), 0x1D53E),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL G
    new NameId(ds("gopf"), 0x1D558),  // MATHEMATICAL DOUBLE-STRUCK SMALL G
    new NameId(ds("grave"), 0x00060),  // GRAVE ACCENT
    new NameId(ds("GreaterEqual"), 0x02265),  // GREATER-THAN OR EQUAL TO
    new NameId(ds("GreaterEqualLess"), 0x022DB),  // GREATER-THAN EQUAL TO OR LESS-THAN
    new NameId(ds("GreaterFullEqual"), 0x02267),  // GREATER-THAN OVER EQUAL TO
    new NameId(ds("GreaterGreater"), 0x02AA2),  // DOUBLE NESTED GREATER-THAN
    new NameId(ds("GreaterLess"), 0x02277),  // GREATER-THAN OR LESS-THAN
    new NameId(ds("GreaterSlantEqual"), 0x02A7E),  // GREATER-THAN OR SLANTED EQUAL TO
    new NameId(ds("GreaterTilde"), 0x02273),  // GREATER-THAN OR EQUIVALENT TO
    new NameId(ds("gscr"), 0x0210A),  // SCRIPT SMALL G
    new NameId(ds("Gscr"), 0x1D4A2),  // MATHEMATICAL SCRIPT CAPITAL G
    new NameId(ds("gsim"), 0x02273),  // GREATER-THAN OR EQUIVALENT TO
    new NameId(ds("gsime"), 0x02A8E),  // GREATER-THAN ABOVE SIMILAR OR EQUAL
    new NameId(ds("gsiml"), 0x02A90),  // GREATER-THAN ABOVE SIMILAR ABOVE LESS-THAN
    new NameId(ds("gt"), 0x0003E),  // GREATER-THAN SIGN
    new NameId(ds("GT"), 0x0003E),  // GREATER-THAN SIGN
    new NameId(ds("Gt"), 0x0226B),  // MUCH GREATER-THAN
    new NameId(ds("gtcc"), 0x02AA7),  // GREATER-THAN CLOSED BY CURVE
    new NameId(ds("gtcir"), 0x02A7A),  // GREATER-THAN WITH CIRCLE INSIDE
    new NameId(ds("gtdot"), 0x022D7),  // GREATER-THAN WITH DOT
    new NameId(ds("gtlPar"), 0x02995),  // DOUBLE LEFT ARC GREATER-THAN BRACKET
    new NameId(ds("gtquest"), 0x02A7C),  // GREATER-THAN WITH QUESTION MARK ABOVE
    new NameId(ds("gtrapprox"), 0x02A86),  // GREATER-THAN OR APPROXIMATE
    new NameId(ds("gtrarr"), 0x02978),  // GREATER-THAN ABOVE RIGHTWARDS ARROW
    new NameId(ds("gtrdot"), 0x022D7),  // GREATER-THAN WITH DOT
    new NameId(ds("gtreqless"), 0x022DB),  // GREATER-THAN EQUAL TO OR LESS-THAN
    new NameId(ds("gtreqqless"), 0x02A8C),  // GREATER-THAN ABOVE DOUBLE-LINE EQUAL ABOVE LESS-THAN
    new NameId(ds("gtrless"), 0x02277),  // GREATER-THAN OR LESS-THAN
    new NameId(ds("gtrsim"), 0x02273),  // GREATER-THAN OR EQUIVALENT TO
    new NameId(ds("gvertneqq"), 0x02269, 0x0FE00),  // GREATER-THAN BUT NOT EQUAL TO - with vertical stroke
    new NameId(ds("gvnE"), 0x02269, 0x0FE00),  // GREATER-THAN BUT NOT EQUAL TO - with vertical stroke
];

const namesH: readonly NameId[] = [
    new NameId(ds("Hacek"), 0x002C7),  // CARON
    new NameId(ds("hairsp"), 0x0200A),  // HAIR SPACE
    new NameId(ds("half"), 0x000BD),  // VULGAR FRACTION ONE HALF
    new NameId(ds("hamilt"), 0x0210B),  // SCRIPT CAPITAL H
    new NameId(ds("HARDcy"), 0x0042A),  // CYRILLIC CAPITAL LETTER HARD SIGN
    new NameId(ds("hardcy"), 0x0044A),  // CYRILLIC SMALL LETTER HARD SIGN
    new NameId(ds("harr"), 0x02194),  // LEFT RIGHT ARROW
    new NameId(ds("hArr"), 0x021D4),  // LEFT RIGHT DOUBLE ARROW
    new NameId(ds("harrcir"), 0x02948),  // LEFT RIGHT ARROW THROUGH SMALL CIRCLE
    new NameId(ds("harrw"), 0x021AD),  // LEFT RIGHT WAVE ARROW
    new NameId(ds("Hat"), 0x0005E),  // CIRCUMFLEX ACCENT
    new NameId(ds("hbar"), 0x0210F),  // PLANCK CONSTANT OVER TWO PI
    new NameId(ds("Hcirc"), 0x00124),  // LATIN CAPITAL LETTER H WITH CIRCUMFLEX
    new NameId(ds("hcirc"), 0x00125),  // LATIN SMALL LETTER H WITH CIRCUMFLEX
    new NameId(ds("hearts"), 0x02665),  // BLACK HEART SUIT
    new NameId(ds("heartsuit"), 0x02665),  // BLACK HEART SUIT
    new NameId(ds("hellip"), 0x02026),  // HORIZONTAL ELLIPSIS
    new NameId(ds("hercon"), 0x022B9),  // HERMITIAN CONJUGATE MATRIX
    new NameId(ds("Hfr"), 0x0210C),  // BLACK-LETTER CAPITAL H
    new NameId(ds("hfr"), 0x1D525),  // MATHEMATICAL FRAKTUR SMALL H
    new NameId(ds("HilbertSpace"), 0x0210B),  // SCRIPT CAPITAL H
    new NameId(ds("hksearow"), 0x02925),  // SOUTH EAST ARROW WITH HOOK
    new NameId(ds("hkswarow"), 0x02926),  // SOUTH WEST ARROW WITH HOOK
    new NameId(ds("hoarr"), 0x021FF),  // LEFT RIGHT OPEN-HEADED ARROW
    new NameId(ds("homtht"), 0x0223B),  // HOMOTHETIC
    new NameId(ds("hookleftarrow"), 0x021A9),  // LEFTWARDS ARROW WITH HOOK
    new NameId(ds("hookrightarrow"), 0x021AA),  // RIGHTWARDS ARROW WITH HOOK
    new NameId(ds("Hopf"), 0x0210D),  // DOUBLE-STRUCK CAPITAL H
    new NameId(ds("hopf"), 0x1D559),  // MATHEMATICAL DOUBLE-STRUCK SMALL H
    new NameId(ds("horbar"), 0x02015),  // HORIZONTAL BAR
    new NameId(ds("HorizontalLine"), 0x02500),  // BOX DRAWINGS LIGHT HORIZONTAL
    new NameId(ds("Hscr"), 0x0210B),  // SCRIPT CAPITAL H
    new NameId(ds("hscr"), 0x1D4BD),  // MATHEMATICAL SCRIPT SMALL H
    new NameId(ds("hslash"), 0x0210F),  // PLANCK CONSTANT OVER TWO PI
    new NameId(ds("Hstrok"), 0x00126),  // LATIN CAPITAL LETTER H WITH STROKE
    new NameId(ds("hstrok"), 0x00127),  // LATIN SMALL LETTER H WITH STROKE
    new NameId(ds("HumpDownHump"), 0x0224E),  // GEOMETRICALLY EQUIVALENT TO
    new NameId(ds("HumpEqual"), 0x0224F),  // DIFFERENCE BETWEEN
    new NameId(ds("hybull"), 0x02043),  // HYPHEN BULLET
    new NameId(ds("hyphen"), 0x02010),  // HYPHEN
];

const namesI: readonly NameId[] = [
    new NameId(ds("Iacgr"), 0x0038A),  // GREEK CAPITAL LETTER IOTA WITH TONOS
    new NameId(ds("iacgr"), 0x003AF),  // GREEK SMALL LETTER IOTA WITH TONOS
    new NameId(ds("Iacute"), 0x000CD),  // LATIN CAPITAL LETTER I WITH ACUTE
    new NameId(ds("iacute"), 0x000ED),  // LATIN SMALL LETTER I WITH ACUTE
    new NameId(ds("ic"), 0x02063),  // INVISIBLE SEPARATOR
    new NameId(ds("Icirc"), 0x000CE),  // LATIN CAPITAL LETTER I WITH CIRCUMFLEX
    new NameId(ds("icirc"), 0x000EE),  // LATIN SMALL LETTER I WITH CIRCUMFLEX
    new NameId(ds("Icy"), 0x00418),  // CYRILLIC CAPITAL LETTER I
    new NameId(ds("icy"), 0x00438),  // CYRILLIC SMALL LETTER I
    new NameId(ds("idiagr"), 0x00390),  // GREEK SMALL LETTER IOTA WITH DIALYTIKA AND TONOS
    new NameId(ds("Idigr"), 0x003AA),  // GREEK CAPITAL LETTER IOTA WITH DIALYTIKA
    new NameId(ds("idigr"), 0x003CA),  // GREEK SMALL LETTER IOTA WITH DIALYTIKA
    new NameId(ds("Idot"), 0x00130),  // LATIN CAPITAL LETTER I WITH DOT ABOVE
    new NameId(ds("IEcy"), 0x00415),  // CYRILLIC CAPITAL LETTER IE
    new NameId(ds("iecy"), 0x00435),  // CYRILLIC SMALL LETTER IE
    new NameId(ds("iexcl"), 0x000A1),  // INVERTED EXCLAMATION MARK
    new NameId(ds("iff"), 0x021D4),  // LEFT RIGHT DOUBLE ARROW
    new NameId(ds("Ifr"), 0x02111),  // BLACK-LETTER CAPITAL I
    new NameId(ds("ifr"), 0x1D526),  // MATHEMATICAL FRAKTUR SMALL I
    new NameId(ds("Igr"), 0x00399),  // GREEK CAPITAL LETTER IOTA
    new NameId(ds("igr"), 0x003B9),  // GREEK SMALL LETTER IOTA
    new NameId(ds("Igrave"), 0x000CC),  // LATIN CAPITAL LETTER I WITH GRAVE
    new NameId(ds("igrave"), 0x000EC),  // LATIN SMALL LETTER I WITH GRAVE
    new NameId(ds("ii"), 0x02148),  // DOUBLE-STRUCK ITALIC SMALL I
    new NameId(ds("iiiint"), 0x02A0C),  // QUADRUPLE INTEGRAL OPERATOR
    new NameId(ds("iiint"), 0x0222D),  // TRIPLE INTEGRAL
    new NameId(ds("iinfin"), 0x029DC),  // INCOMPLETE INFINITY
    new NameId(ds("iiota"), 0x02129),  // TURNED GREEK SMALL LETTER IOTA
    new NameId(ds("IJlig"), 0x00132),  // LATIN CAPITAL LIGATURE IJ
    new NameId(ds("ijlig"), 0x00133),  // LATIN SMALL LIGATURE IJ
    new NameId(ds("Im"), 0x02111),  // BLACK-LETTER CAPITAL I
    new NameId(ds("Imacr"), 0x0012A),  // LATIN CAPITAL LETTER I WITH MACRON
    new NameId(ds("imacr"), 0x0012B),  // LATIN SMALL LETTER I WITH MACRON
    new NameId(ds("image"), 0x02111),  // BLACK-LETTER CAPITAL I
    new NameId(ds("ImaginaryI"), 0x02148),  // DOUBLE-STRUCK ITALIC SMALL I
    new NameId(ds("imagline"), 0x02110),  // SCRIPT CAPITAL I
    new NameId(ds("imagpart"), 0x02111),  // BLACK-LETTER CAPITAL I
    new NameId(ds("imath"), 0x00131),  // LATIN SMALL LETTER DOTLESS I
    new NameId(ds("imof"), 0x022B7),  // IMAGE OF
    new NameId(ds("imped"), 0x001B5),  // LATIN CAPITAL LETTER Z WITH STROKE
    new NameId(ds("Implies"), 0x021D2),  // RIGHTWARDS DOUBLE ARROW
    new NameId(ds("in"), 0x02208),  // ELEMENT OF
    new NameId(ds("incare"), 0x02105),  // CARE OF
    new NameId(ds("infin"), 0x0221E),  // INFINITY
    new NameId(ds("infintie"), 0x029DD),  // TIE OVER INFINITY
    new NameId(ds("inodot"), 0x00131),  // LATIN SMALL LETTER DOTLESS I
    new NameId(ds("int"), 0x0222B),  // INTEGRAL
    new NameId(ds("Int"), 0x0222C),  // DOUBLE INTEGRAL
    new NameId(ds("intcal"), 0x022BA),  // INTERCALATE
    new NameId(ds("integers"), 0x02124),  // DOUBLE-STRUCK CAPITAL Z
    new NameId(ds("Integral"), 0x0222B),  // INTEGRAL
    new NameId(ds("intercal"), 0x022BA),  // INTERCALATE
    new NameId(ds("Intersection"), 0x022C2),  // N-ARY INTERSECTION
    new NameId(ds("intlarhk"), 0x02A17),  // INTEGRAL WITH LEFTWARDS ARROW WITH HOOK
    new NameId(ds("intprod"), 0x02A3C),  // INTERIOR PRODUCT
    new NameId(ds("InvisibleComma"), 0x02063),  // INVISIBLE SEPARATOR
    new NameId(ds("InvisibleTimes"), 0x02062),  // INVISIBLE TIMES
    new NameId(ds("IOcy"), 0x00401),  // CYRILLIC CAPITAL LETTER IO
    new NameId(ds("iocy"), 0x00451),  // CYRILLIC SMALL LETTER IO
    new NameId(ds("Iogon"), 0x0012E),  // LATIN CAPITAL LETTER I WITH OGONEK
    new NameId(ds("iogon"), 0x0012F),  // LATIN SMALL LETTER I WITH OGONEK
    new NameId(ds("Iopf"), 0x1D540),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL I
    new NameId(ds("iopf"), 0x1D55A),  // MATHEMATICAL DOUBLE-STRUCK SMALL I
    new NameId(ds("Iota"), 0x00399),  // GREEK CAPITAL LETTER IOTA
    new NameId(ds("iota"), 0x003B9),  // GREEK SMALL LETTER IOTA
    new NameId(ds("iprod"), 0x02A3C),  // INTERIOR PRODUCT
    new NameId(ds("iquest"), 0x000BF),  // INVERTED QUESTION MARK
    new NameId(ds("Iscr"), 0x02110),  // SCRIPT CAPITAL I
    new NameId(ds("iscr"), 0x1D4BE),  // MATHEMATICAL SCRIPT SMALL I
    new NameId(ds("isin"), 0x02208),  // ELEMENT OF
    new NameId(ds("isindot"), 0x022F5),  // ELEMENT OF WITH DOT ABOVE
    new NameId(ds("isinE"), 0x022F9),  // ELEMENT OF WITH TWO HORIZONTAL STROKES
    new NameId(ds("isins"), 0x022F4),  // SMALL ELEMENT OF WITH VERTICAL BAR AT END OF HORIZONTAL STROKE
    new NameId(ds("isinsv"), 0x022F3),  // ELEMENT OF WITH VERTICAL BAR AT END OF HORIZONTAL STROKE
    new NameId(ds("isinv"), 0x02208),  // ELEMENT OF
    new NameId(ds("it"), 0x02062),  // INVISIBLE TIMES
    new NameId(ds("Itilde"), 0x00128),  // LATIN CAPITAL LETTER I WITH TILDE
    new NameId(ds("itilde"), 0x00129),  // LATIN SMALL LETTER I WITH TILDE
    new NameId(ds("Iukcy"), 0x00406),  // CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I
    new NameId(ds("iukcy"), 0x00456),  // CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
    new NameId(ds("Iuml"), 0x000CF),  // LATIN CAPITAL LETTER I WITH DIAERESIS
    new NameId(ds("iuml"), 0x000EF),  // LATIN SMALL LETTER I WITH DIAERESIS
];

const namesJ: readonly NameId[] = [
    new NameId(ds("Jcirc"), 0x00134),  // LATIN CAPITAL LETTER J WITH CIRCUMFLEX
    new NameId(ds("jcirc"), 0x00135),  // LATIN SMALL LETTER J WITH CIRCUMFLEX
    new NameId(ds("Jcy"), 0x00419),  // CYRILLIC CAPITAL LETTER SHORT I
    new NameId(ds("jcy"), 0x00439),  // CYRILLIC SMALL LETTER SHORT I
    new NameId(ds("Jfr"), 0x1D50D),  // MATHEMATICAL FRAKTUR CAPITAL J
    new NameId(ds("jfr"), 0x1D527),  // MATHEMATICAL FRAKTUR SMALL J
    new NameId(ds("jmath"), 0x00237),  // LATIN SMALL LETTER DOTLESS J
    new NameId(ds("Jopf"), 0x1D541),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL J
    new NameId(ds("jopf"), 0x1D55B),  // MATHEMATICAL DOUBLE-STRUCK SMALL J
    new NameId(ds("Jscr"), 0x1D4A5),  // MATHEMATICAL SCRIPT CAPITAL J
    new NameId(ds("jscr"), 0x1D4BF),  // MATHEMATICAL SCRIPT SMALL J
    new NameId(ds("Jsercy"), 0x00408),  // CYRILLIC CAPITAL LETTER JE
    new NameId(ds("jsercy"), 0x00458),  // CYRILLIC SMALL LETTER JE
    new NameId(ds("Jukcy"), 0x00404),  // CYRILLIC CAPITAL LETTER UKRAINIAN IE
    new NameId(ds("jukcy"), 0x00454),  // CYRILLIC SMALL LETTER UKRAINIAN IE
];

const namesK: readonly NameId[] = [
    new NameId(ds("Kappa"), 0x0039A),  // GREEK CAPITAL LETTER KAPPA
    new NameId(ds("kappa"), 0x003BA),  // GREEK SMALL LETTER KAPPA
    new NameId(ds("kappav"), 0x003F0),  // GREEK KAPPA SYMBOL
    new NameId(ds("Kcedil"), 0x00136),  // LATIN CAPITAL LETTER K WITH CEDILLA
    new NameId(ds("kcedil"), 0x00137),  // LATIN SMALL LETTER K WITH CEDILLA
    new NameId(ds("Kcy"), 0x0041A),  // CYRILLIC CAPITAL LETTER KA
    new NameId(ds("kcy"), 0x0043A),  // CYRILLIC SMALL LETTER KA
    new NameId(ds("Kfr"), 0x1D50E),  // MATHEMATICAL FRAKTUR CAPITAL K
    new NameId(ds("kfr"), 0x1D528),  // MATHEMATICAL FRAKTUR SMALL K
    new NameId(ds("Kgr"), 0x0039A),  // GREEK CAPITAL LETTER KAPPA
    new NameId(ds("kgr"), 0x003BA),  // GREEK SMALL LETTER KAPPA
    new NameId(ds("kgreen"), 0x00138),  // LATIN SMALL LETTER KRA
    new NameId(ds("KHcy"), 0x00425),  // CYRILLIC CAPITAL LETTER HA
    new NameId(ds("khcy"), 0x00445),  // CYRILLIC SMALL LETTER HA
    new NameId(ds("KHgr"), 0x003A7),  // GREEK CAPITAL LETTER CHI
    new NameId(ds("khgr"), 0x003C7),  // GREEK SMALL LETTER CHI
    new NameId(ds("KJcy"), 0x0040C),  // CYRILLIC CAPITAL LETTER KJE
    new NameId(ds("kjcy"), 0x0045C),  // CYRILLIC SMALL LETTER KJE
    new NameId(ds("Kopf"), 0x1D542),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL K
    new NameId(ds("kopf"), 0x1D55C),  // MATHEMATICAL DOUBLE-STRUCK SMALL K
    new NameId(ds("Kscr"), 0x1D4A6),  // MATHEMATICAL SCRIPT CAPITAL K
    new NameId(ds("kscr"), 0x1D4C0),  // MATHEMATICAL SCRIPT SMALL K
];

const namesL: readonly NameId[] = [
    new NameId(ds("lAarr"), 0x021DA),  // LEFTWARDS TRIPLE ARROW
    new NameId(ds("Lacute"), 0x00139),  // LATIN CAPITAL LETTER L WITH ACUTE
    new NameId(ds("lacute"), 0x0013A),  // LATIN SMALL LETTER L WITH ACUTE
    new NameId(ds("laemptyv"), 0x029B4),  // EMPTY SET WITH LEFT ARROW ABOVE
    new NameId(ds("lagran"), 0x02112),  // SCRIPT CAPITAL L
    new NameId(ds("Lambda"), 0x0039B),  // GREEK CAPITAL LETTER LAMDA
    new NameId(ds("lambda"), 0x003BB),  // GREEK SMALL LETTER LAMDA
    new NameId(ds("lang"), 0x027E8),  // MATHEMATICAL LEFT ANGLE BRACKET
    new NameId(ds("Lang"), 0x027EA),  // MATHEMATICAL LEFT DOUBLE ANGLE BRACKET
    new NameId(ds("langd"), 0x02991),  // LEFT ANGLE BRACKET WITH DOT
    new NameId(ds("langle"), 0x027E8),  // MATHEMATICAL LEFT ANGLE BRACKET
    new NameId(ds("lap"), 0x02A85),  // LESS-THAN OR APPROXIMATE
    new NameId(ds("Laplacetrf"), 0x02112),  // SCRIPT CAPITAL L
    new NameId(ds("laquo"), 0x000AB),  // LEFT-POINTING DOUBLE ANGLE QUOTATION MARK
    new NameId(ds("larr"), 0x02190),  // LEFTWARDS ARROW
    new NameId(ds("Larr"), 0x0219E),  // LEFTWARDS TWO HEADED ARROW
    new NameId(ds("lArr"), 0x021D0),  // LEFTWARDS DOUBLE ARROW
    new NameId(ds("larrb"), 0x021E4),  // LEFTWARDS ARROW TO BAR
    new NameId(ds("larrbfs"), 0x0291F),  // LEFTWARDS ARROW FROM BAR TO BLACK DIAMOND
    new NameId(ds("larrfs"), 0x0291D),  // LEFTWARDS ARROW TO BLACK DIAMOND
    new NameId(ds("larrhk"), 0x021A9),  // LEFTWARDS ARROW WITH HOOK
    new NameId(ds("larrlp"), 0x021AB),  // LEFTWARDS ARROW WITH LOOP
    new NameId(ds("larrpl"), 0x02939),  // LEFT-SIDE ARC ANTICLOCKWISE ARROW
    new NameId(ds("larrsim"), 0x02973),  // LEFTWARDS ARROW ABOVE TILDE OPERATOR
    new NameId(ds("larrtl"), 0x021A2),  // LEFTWARDS ARROW WITH TAIL
    new NameId(ds("lat"), 0x02AAB),  // LARGER THAN
    new NameId(ds("latail"), 0x02919),  // LEFTWARDS ARROW-TAIL
    new NameId(ds("lAtail"), 0x0291B),  // LEFTWARDS DOUBLE ARROW-TAIL
    new NameId(ds("late"), 0x02AAD),  // LARGER THAN OR EQUAL TO
    new NameId(ds("lates"), 0x02AAD, 0x0FE00),  // LARGER THAN OR slanted EQUAL
    new NameId(ds("lbarr"), 0x0290C),  // LEFTWARDS DOUBLE DASH ARROW
    new NameId(ds("lBarr"), 0x0290E),  // LEFTWARDS TRIPLE DASH ARROW
    new NameId(ds("lbbrk"), 0x02772),  // LIGHT LEFT TORTOISE SHELL BRACKET ORNAMENT
    new NameId(ds("lbrace"), 0x0007B),  // LEFT CURLY BRACKET
    new NameId(ds("lbrack"), 0x0005B),  // LEFT SQUARE BRACKET
    new NameId(ds("lbrke"), 0x0298B),  // LEFT SQUARE BRACKET WITH UNDERBAR
    new NameId(ds("lbrksld"), 0x0298F),  // LEFT SQUARE BRACKET WITH TICK IN BOTTOM CORNER
    new NameId(ds("lbrkslu"), 0x0298D),  // LEFT SQUARE BRACKET WITH TICK IN TOP CORNER
    new NameId(ds("Lcaron"), 0x0013D),  // LATIN CAPITAL LETTER L WITH CARON
    new NameId(ds("lcaron"), 0x0013E),  // LATIN SMALL LETTER L WITH CARON
    new NameId(ds("Lcedil"), 0x0013B),  // LATIN CAPITAL LETTER L WITH CEDILLA
    new NameId(ds("lcedil"), 0x0013C),  // LATIN SMALL LETTER L WITH CEDILLA
    new NameId(ds("lceil"), 0x02308),  // LEFT CEILING
    new NameId(ds("lcub"), 0x0007B),  // LEFT CURLY BRACKET
    new NameId(ds("Lcy"), 0x0041B),  // CYRILLIC CAPITAL LETTER EL
    new NameId(ds("lcy"), 0x0043B),  // CYRILLIC SMALL LETTER EL
    new NameId(ds("ldca"), 0x02936),  // ARROW POINTING DOWNWARDS THEN CURVING LEFTWARDS
    new NameId(ds("ldquo"), 0x0201C),  // LEFT DOUBLE QUOTATION MARK
    new NameId(ds("ldquor"), 0x0201E),  // DOUBLE LOW-9 QUOTATION MARK
    new NameId(ds("ldrdhar"), 0x02967),  // LEFTWARDS HARPOON WITH BARB DOWN ABOVE RIGHTWARDS HARPOON WITH BARB DOWN
    new NameId(ds("ldrushar"), 0x0294B),  // LEFT BARB DOWN RIGHT BARB UP HARPOON
    new NameId(ds("ldsh"), 0x021B2),  // DOWNWARDS ARROW WITH TIP LEFTWARDS
    new NameId(ds("le"), 0x02264),  // LESS-THAN OR EQUAL TO
    new NameId(ds("lE"), 0x02266),  // LESS-THAN OVER EQUAL TO
    new NameId(ds("LeftAngleBracket"), 0x027E8),  // MATHEMATICAL LEFT ANGLE BRACKET
    new NameId(ds("leftarrow"), 0x02190),  // LEFTWARDS ARROW
    new NameId(ds("LeftArrow"), 0x02190),  // LEFTWARDS ARROW
    new NameId(ds("Leftarrow"), 0x021D0),  // LEFTWARDS DOUBLE ARROW
    new NameId(ds("LeftArrowBar"), 0x021E4),  // LEFTWARDS ARROW TO BAR
    new NameId(ds("LeftArrowRightArrow"), 0x021C6),  // LEFTWARDS ARROW OVER RIGHTWARDS ARROW
    new NameId(ds("leftarrowtail"), 0x021A2),  // LEFTWARDS ARROW WITH TAIL
    new NameId(ds("LeftCeiling"), 0x02308),  // LEFT CEILING
    new NameId(ds("LeftDoubleBracket"), 0x027E6),  // MATHEMATICAL LEFT WHITE SQUARE BRACKET
    new NameId(ds("LeftDownTeeVector"), 0x02961),  // DOWNWARDS HARPOON WITH BARB LEFT FROM BAR
    new NameId(ds("LeftDownVector"), 0x021C3),  // DOWNWARDS HARPOON WITH BARB LEFTWARDS
    new NameId(ds("LeftDownVectorBar"), 0x02959),  // DOWNWARDS HARPOON WITH BARB LEFT TO BAR
    new NameId(ds("LeftFloor"), 0x0230A),  // LEFT FLOOR
    new NameId(ds("leftharpoondown"), 0x021BD),  // LEFTWARDS HARPOON WITH BARB DOWNWARDS
    new NameId(ds("leftharpoonup"), 0x021BC),  // LEFTWARDS HARPOON WITH BARB UPWARDS
    new NameId(ds("leftleftarrows"), 0x021C7),  // LEFTWARDS PAIRED ARROWS
    new NameId(ds("leftrightarrow"), 0x02194),  // LEFT RIGHT ARROW
    new NameId(ds("LeftRightArrow"), 0x02194),  // LEFT RIGHT ARROW
    new NameId(ds("Leftrightarrow"), 0x021D4),  // LEFT RIGHT DOUBLE ARROW
    new NameId(ds("leftrightarrows"), 0x021C6),  // LEFTWARDS ARROW OVER RIGHTWARDS ARROW
    new NameId(ds("leftrightharpoons"), 0x021CB),  // LEFTWARDS HARPOON OVER RIGHTWARDS HARPOON
    new NameId(ds("leftrightsquigarrow"), 0x021AD),  // LEFT RIGHT WAVE ARROW
    new NameId(ds("LeftRightVector"), 0x0294E),  // LEFT BARB UP RIGHT BARB UP HARPOON
    new NameId(ds("LeftTee"), 0x022A3),  // LEFT TACK
    new NameId(ds("LeftTeeArrow"), 0x021A4),  // LEFTWARDS ARROW FROM BAR
    new NameId(ds("LeftTeeVector"), 0x0295A),  // LEFTWARDS HARPOON WITH BARB UP FROM BAR
    new NameId(ds("leftthreetimes"), 0x022CB),  // LEFT SEMIDIRECT PRODUCT
    new NameId(ds("LeftTriangle"), 0x022B2),  // NORMAL SUBGROUP OF
    new NameId(ds("LeftTriangleBar"), 0x029CF),  // LEFT TRIANGLE BESIDE VERTICAL BAR
    new NameId(ds("LeftTriangleEqual"), 0x022B4),  // NORMAL SUBGROUP OF OR EQUAL TO
    new NameId(ds("LeftUpDownVector"), 0x02951),  // UP BARB LEFT DOWN BARB LEFT HARPOON
    new NameId(ds("LeftUpTeeVector"), 0x02960),  // UPWARDS HARPOON WITH BARB LEFT FROM BAR
    new NameId(ds("LeftUpVector"), 0x021BF),  // UPWARDS HARPOON WITH BARB LEFTWARDS
    new NameId(ds("LeftUpVectorBar"), 0x02958),  // UPWARDS HARPOON WITH BARB LEFT TO BAR
    new NameId(ds("LeftVector"), 0x021BC),  // LEFTWARDS HARPOON WITH BARB UPWARDS
    new NameId(ds("LeftVectorBar"), 0x02952),  // LEFTWARDS HARPOON WITH BARB UP TO BAR
    new NameId(ds("leg"), 0x022DA),  // LESS-THAN EQUAL TO OR GREATER-THAN
    new NameId(ds("lEg"), 0x02A8B),  // LESS-THAN ABOVE DOUBLE-LINE EQUAL ABOVE GREATER-THAN
    new NameId(ds("leq"), 0x02264),  // LESS-THAN OR EQUAL TO
    new NameId(ds("leqq"), 0x02266),  // LESS-THAN OVER EQUAL TO
    new NameId(ds("leqslant"), 0x02A7D),  // LESS-THAN OR SLANTED EQUAL TO
    new NameId(ds("les"), 0x02A7D),  // LESS-THAN OR SLANTED EQUAL TO
    new NameId(ds("lescc"), 0x02AA8),  // LESS-THAN CLOSED BY CURVE ABOVE SLANTED EQUAL
    new NameId(ds("lesdot"), 0x02A7F),  // LESS-THAN OR SLANTED EQUAL TO WITH DOT INSIDE
    new NameId(ds("lesdoto"), 0x02A81),  // LESS-THAN OR SLANTED EQUAL TO WITH DOT ABOVE
    new NameId(ds("lesdotor"), 0x02A83),  // LESS-THAN OR SLANTED EQUAL TO WITH DOT ABOVE RIGHT
    new NameId(ds("lesg"), 0x022DA, 0x0FE00),  // LESS-THAN slanted EQUAL TO OR GREATER-THAN
    new NameId(ds("lesges"), 0x02A93),  // LESS-THAN ABOVE SLANTED EQUAL ABOVE GREATER-THAN ABOVE SLANTED EQUAL
    new NameId(ds("lessapprox"), 0x02A85),  // LESS-THAN OR APPROXIMATE
    new NameId(ds("lessdot"), 0x022D6),  // LESS-THAN WITH DOT
    new NameId(ds("lesseqgtr"), 0x022DA),  // LESS-THAN EQUAL TO OR GREATER-THAN
    new NameId(ds("lesseqqgtr"), 0x02A8B),  // LESS-THAN ABOVE DOUBLE-LINE EQUAL ABOVE GREATER-THAN
    new NameId(ds("LessEqualGreater"), 0x022DA),  // LESS-THAN EQUAL TO OR GREATER-THAN
    new NameId(ds("LessFullEqual"), 0x02266),  // LESS-THAN OVER EQUAL TO
    new NameId(ds("LessGreater"), 0x02276),  // LESS-THAN OR GREATER-THAN
    new NameId(ds("lessgtr"), 0x02276),  // LESS-THAN OR GREATER-THAN
    new NameId(ds("LessLess"), 0x02AA1),  // DOUBLE NESTED LESS-THAN
    new NameId(ds("lesssim"), 0x02272),  // LESS-THAN OR EQUIVALENT TO
    new NameId(ds("LessSlantEqual"), 0x02A7D),  // LESS-THAN OR SLANTED EQUAL TO
    new NameId(ds("LessTilde"), 0x02272),  // LESS-THAN OR EQUIVALENT TO
    new NameId(ds("lfisht"), 0x0297C),  // LEFT FISH TAIL
    new NameId(ds("lfloor"), 0x0230A),  // LEFT FLOOR
    new NameId(ds("Lfr"), 0x1D50F),  // MATHEMATICAL FRAKTUR CAPITAL L
    new NameId(ds("lfr"), 0x1D529),  // MATHEMATICAL FRAKTUR SMALL L
    new NameId(ds("lg"), 0x02276),  // LESS-THAN OR GREATER-THAN
    new NameId(ds("lgE"), 0x02A91),  // LESS-THAN ABOVE GREATER-THAN ABOVE DOUBLE-LINE EQUAL
    new NameId(ds("Lgr"), 0x0039B),  // GREEK CAPITAL LETTER LAMDA
    new NameId(ds("lgr"), 0x003BB),  // GREEK SMALL LETTER LAMDA
    new NameId(ds("lHar"), 0x02962),  // LEFTWARDS HARPOON WITH BARB UP ABOVE LEFTWARDS HARPOON WITH BARB DOWN
    new NameId(ds("lhard"), 0x021BD),  // LEFTWARDS HARPOON WITH BARB DOWNWARDS
    new NameId(ds("lharu"), 0x021BC),  // LEFTWARDS HARPOON WITH BARB UPWARDS
    new NameId(ds("lharul"), 0x0296A),  // LEFTWARDS HARPOON WITH BARB UP ABOVE LONG DASH
    new NameId(ds("lhblk"), 0x02584),  // LOWER HALF BLOCK
    new NameId(ds("LJcy"), 0x00409),  // CYRILLIC CAPITAL LETTER LJE
    new NameId(ds("ljcy"), 0x00459),  // CYRILLIC SMALL LETTER LJE
    new NameId(ds("ll"), 0x0226A),  // MUCH LESS-THAN
    new NameId(ds("Ll"), 0x022D8),  // VERY MUCH LESS-THAN
    new NameId(ds("llarr"), 0x021C7),  // LEFTWARDS PAIRED ARROWS
    new NameId(ds("llcorner"), 0x0231E),  // BOTTOM LEFT CORNER
    new NameId(ds("Lleftarrow"), 0x021DA),  // LEFTWARDS TRIPLE ARROW
    new NameId(ds("llhard"), 0x0296B),  // LEFTWARDS HARPOON WITH BARB DOWN BELOW LONG DASH
    new NameId(ds("lltri"), 0x025FA),  // LOWER LEFT TRIANGLE
    new NameId(ds("Lmidot"), 0x0013F),  // LATIN CAPITAL LETTER L WITH MIDDLE DOT
    new NameId(ds("lmidot"), 0x00140),  // LATIN SMALL LETTER L WITH MIDDLE DOT
    new NameId(ds("lmoust"), 0x023B0),  // UPPER LEFT OR LOWER RIGHT CURLY BRACKET SECTION
    new NameId(ds("lmoustache"), 0x023B0),  // UPPER LEFT OR LOWER RIGHT CURLY BRACKET SECTION
    new NameId(ds("lnap"), 0x02A89),  // LESS-THAN AND NOT APPROXIMATE
    new NameId(ds("lnapprox"), 0x02A89),  // LESS-THAN AND NOT APPROXIMATE
    new NameId(ds("lnE"), 0x02268),  // LESS-THAN BUT NOT EQUAL TO
    new NameId(ds("lne"), 0x02A87),  // LESS-THAN AND SINGLE-LINE NOT EQUAL TO
    new NameId(ds("lneq"), 0x02A87),  // LESS-THAN AND SINGLE-LINE NOT EQUAL TO
    new NameId(ds("lneqq"), 0x02268),  // LESS-THAN BUT NOT EQUAL TO
    new NameId(ds("lnsim"), 0x022E6),  // LESS-THAN BUT NOT EQUIVALENT TO
    new NameId(ds("loang"), 0x027EC),  // MATHEMATICAL LEFT WHITE TORTOISE SHELL BRACKET
    new NameId(ds("loarr"), 0x021FD),  // LEFTWARDS OPEN-HEADED ARROW
    new NameId(ds("lobrk"), 0x027E6),  // MATHEMATICAL LEFT WHITE SQUARE BRACKET
    new NameId(ds("longleftarrow"), 0x027F5),  // LONG LEFTWARDS ARROW
    new NameId(ds("LongLeftArrow"), 0x027F5),  // LONG LEFTWARDS ARROW
    new NameId(ds("Longleftarrow"), 0x027F8),  // LONG LEFTWARDS DOUBLE ARROW
    new NameId(ds("longleftrightarrow"), 0x027F7),  // LONG LEFT RIGHT ARROW
    new NameId(ds("LongLeftRightArrow"), 0x027F7),  // LONG LEFT RIGHT ARROW
    new NameId(ds("Longleftrightarrow"), 0x027FA),  // LONG LEFT RIGHT DOUBLE ARROW
    new NameId(ds("longmapsto"), 0x027FC),  // LONG RIGHTWARDS ARROW FROM BAR
    new NameId(ds("longrightarrow"), 0x027F6),  // LONG RIGHTWARDS ARROW
    new NameId(ds("LongRightArrow"), 0x027F6),  // LONG RIGHTWARDS ARROW
    new NameId(ds("Longrightarrow"), 0x027F9),  // LONG RIGHTWARDS DOUBLE ARROW
    new NameId(ds("looparrowleft"), 0x021AB),  // LEFTWARDS ARROW WITH LOOP
    new NameId(ds("looparrowright"), 0x021AC),  // RIGHTWARDS ARROW WITH LOOP
    new NameId(ds("lopar"), 0x02985),  // LEFT WHITE PARENTHESIS
    new NameId(ds("Lopf"), 0x1D543),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL L
    new NameId(ds("lopf"), 0x1D55D),  // MATHEMATICAL DOUBLE-STRUCK SMALL L
    new NameId(ds("loplus"), 0x02A2D),  // PLUS SIGN IN LEFT HALF CIRCLE
    new NameId(ds("lotimes"), 0x02A34),  // MULTIPLICATION SIGN IN LEFT HALF CIRCLE
    new NameId(ds("lowast"), 0x02217),  // ASTERISK OPERATOR
    new NameId(ds("lowbar"), 0x0005F),  // LOW LINE
    new NameId(ds("LowerLeftArrow"), 0x02199),  // SOUTH WEST ARROW
    new NameId(ds("LowerRightArrow"), 0x02198),  // SOUTH EAST ARROW
    new NameId(ds("loz"), 0x025CA),  // LOZENGE
    new NameId(ds("lozenge"), 0x025CA),  // LOZENGE
    new NameId(ds("lozf"), 0x029EB),  // BLACK LOZENGE
    new NameId(ds("lpar"), 0x00028),  // LEFT PARENTHESIS
    new NameId(ds("lparlt"), 0x02993),  // LEFT ARC LESS-THAN BRACKET
    new NameId(ds("lrarr"), 0x021C6),  // LEFTWARDS ARROW OVER RIGHTWARDS ARROW
    new NameId(ds("lrcorner"), 0x0231F),  // BOTTOM RIGHT CORNER
    new NameId(ds("lrhar"), 0x021CB),  // LEFTWARDS HARPOON OVER RIGHTWARDS HARPOON
    new NameId(ds("lrhard"), 0x0296D),  // RIGHTWARDS HARPOON WITH BARB DOWN BELOW LONG DASH
    new NameId(ds("lrm"), 0x0200E),  // LEFT-TO-RIGHT MARK
    new NameId(ds("lrtri"), 0x022BF),  // RIGHT TRIANGLE
    new NameId(ds("lsaquo"), 0x02039),  // SINGLE LEFT-POINTING ANGLE QUOTATION MARK
    new NameId(ds("Lscr"), 0x02112),  // SCRIPT CAPITAL L
    new NameId(ds("lscr"), 0x1D4C1),  // MATHEMATICAL SCRIPT SMALL L
    new NameId(ds("lsh"), 0x021B0),  // UPWARDS ARROW WITH TIP LEFTWARDS
    new NameId(ds("Lsh"), 0x021B0),  // UPWARDS ARROW WITH TIP LEFTWARDS
    new NameId(ds("lsim"), 0x02272),  // LESS-THAN OR EQUIVALENT TO
    new NameId(ds("lsime"), 0x02A8D),  // LESS-THAN ABOVE SIMILAR OR EQUAL
    new NameId(ds("lsimg"), 0x02A8F),  // LESS-THAN ABOVE SIMILAR ABOVE GREATER-THAN
    new NameId(ds("lsqb"), 0x0005B),  // LEFT SQUARE BRACKET
    new NameId(ds("lsquo"), 0x02018),  // LEFT SINGLE QUOTATION MARK
    new NameId(ds("lsquor"), 0x0201A),  // SINGLE LOW-9 QUOTATION MARK
    new NameId(ds("Lstrok"), 0x00141),  // LATIN CAPITAL LETTER L WITH STROKE
    new NameId(ds("lstrok"), 0x00142),  // LATIN SMALL LETTER L WITH STROKE
    new NameId(ds("lt"), 0x0003C),  // LESS-THAN SIGN
    new NameId(ds("LT"), 0x0003C),  // LESS-THAN SIGN
    new NameId(ds("Lt"), 0x0226A),  // MUCH LESS-THAN
    new NameId(ds("ltcc"), 0x02AA6),  // LESS-THAN CLOSED BY CURVE
    new NameId(ds("ltcir"), 0x02A79),  // LESS-THAN WITH CIRCLE INSIDE
    new NameId(ds("ltdot"), 0x022D6),  // LESS-THAN WITH DOT
    new NameId(ds("lthree"), 0x022CB),  // LEFT SEMIDIRECT PRODUCT
    new NameId(ds("ltimes"), 0x022C9),  // LEFT NORMAL FACTOR SEMIDIRECT PRODUCT
    new NameId(ds("ltlarr"), 0x02976),  // LESS-THAN ABOVE LEFTWARDS ARROW
    new NameId(ds("ltquest"), 0x02A7B),  // LESS-THAN WITH QUESTION MARK ABOVE
    new NameId(ds("ltri"), 0x025C3),  // WHITE LEFT-POINTING SMALL TRIANGLE
    new NameId(ds("ltrie"), 0x022B4),  // NORMAL SUBGROUP OF OR EQUAL TO
    new NameId(ds("ltrif"), 0x025C2),  // BLACK LEFT-POINTING SMALL TRIANGLE
    new NameId(ds("ltrPar"), 0x02996),  // DOUBLE RIGHT ARC LESS-THAN BRACKET
    new NameId(ds("lurdshar"), 0x0294A),  // LEFT BARB UP RIGHT BARB DOWN HARPOON
    new NameId(ds("luruhar"), 0x02966),  // LEFTWARDS HARPOON WITH BARB UP ABOVE RIGHTWARDS HARPOON WITH BARB UP
    new NameId(ds("lvertneqq"), 0x02268, 0x0FE00),  // LESS-THAN BUT NOT EQUAL TO - with vertical stroke
    new NameId(ds("lvnE"), 0x02268, 0x0FE00),  // LESS-THAN BUT NOT EQUAL TO - with vertical stroke
];

const namesM: readonly NameId[] = [
    new NameId(ds("macr"), 0x000AF),  // MACRON
    new NameId(ds("male"), 0x02642),  // MALE SIGN
    new NameId(ds("malt"), 0x02720),  // MALTESE CROSS
    new NameId(ds("maltese"), 0x02720),  // MALTESE CROSS
    new NameId(ds("map"), 0x021A6),  // RIGHTWARDS ARROW FROM BAR
    new NameId(ds("Map"), 0x02905),  // RIGHTWARDS TWO-HEADED ARROW FROM BAR
    new NameId(ds("mapsto"), 0x021A6),  // RIGHTWARDS ARROW FROM BAR
    new NameId(ds("mapstodown"), 0x021A7),  // DOWNWARDS ARROW FROM BAR
    new NameId(ds("mapstoleft"), 0x021A4),  // LEFTWARDS ARROW FROM BAR
    new NameId(ds("mapstoup"), 0x021A5),  // UPWARDS ARROW FROM BAR
    new NameId(ds("marker"), 0x025AE),  // BLACK VERTICAL RECTANGLE
    new NameId(ds("mcomma"), 0x02A29),  // MINUS SIGN WITH COMMA ABOVE
    new NameId(ds("Mcy"), 0x0041C),  // CYRILLIC CAPITAL LETTER EM
    new NameId(ds("mcy"), 0x0043C),  // CYRILLIC SMALL LETTER EM
    new NameId(ds("mdash"), 0x02014),  // EM DASH
    new NameId(ds("mDDot"), 0x0223A),  // GEOMETRIC PROPORTION
    new NameId(ds("measuredangle"), 0x02221),  // MEASURED ANGLE
    new NameId(ds("MediumSpace"), 0x0205F),  // MEDIUM MATHEMATICAL SPACE
    new NameId(ds("Mellintrf"), 0x02133),  // SCRIPT CAPITAL M
    new NameId(ds("Mfr"), 0x1D510),  // MATHEMATICAL FRAKTUR CAPITAL M
    new NameId(ds("mfr"), 0x1D52A),  // MATHEMATICAL FRAKTUR SMALL M
    new NameId(ds("Mgr"), 0x0039C),  // GREEK CAPITAL LETTER MU
    new NameId(ds("mgr"), 0x003BC),  // GREEK SMALL LETTER MU
    new NameId(ds("mho"), 0x02127),  // INVERTED OHM SIGN
    new NameId(ds("micro"), 0x000B5),  // MICRO SIGN
    new NameId(ds("mid"), 0x02223),  // DIVIDES
    new NameId(ds("midast"), 0x0002A),  // ASTERISK
    new NameId(ds("midcir"), 0x02AF0),  // VERTICAL LINE WITH CIRCLE BELOW
    new NameId(ds("middot"), 0x000B7),  // MIDDLE DOT
    new NameId(ds("minus"), 0x02212),  // MINUS SIGN
    new NameId(ds("minusb"), 0x0229F),  // SQUARED MINUS
    new NameId(ds("minusd"), 0x02238),  // DOT MINUS
    new NameId(ds("minusdu"), 0x02A2A),  // MINUS SIGN WITH DOT BELOW
    new NameId(ds("MinusPlus"), 0x02213),  // MINUS-OR-PLUS SIGN
    new NameId(ds("mlcp"), 0x02ADB),  // TRANSVERSAL INTERSECTION
    new NameId(ds("mldr"), 0x02026),  // HORIZONTAL ELLIPSIS
    new NameId(ds("mnplus"), 0x02213),  // MINUS-OR-PLUS SIGN
    new NameId(ds("models"), 0x022A7),  // MODELS
    new NameId(ds("Mopf"), 0x1D544),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL M
    new NameId(ds("mopf"), 0x1D55E),  // MATHEMATICAL DOUBLE-STRUCK SMALL M
    new NameId(ds("mp"), 0x02213),  // MINUS-OR-PLUS SIGN
    new NameId(ds("Mscr"), 0x02133),  // SCRIPT CAPITAL M
    new NameId(ds("mscr"), 0x1D4C2),  // MATHEMATICAL SCRIPT SMALL M
    new NameId(ds("mstpos"), 0x0223E),  // INVERTED LAZY S
    new NameId(ds("Mu"), 0x0039C),  // GREEK CAPITAL LETTER MU
    new NameId(ds("mu"), 0x003BC),  // GREEK SMALL LETTER MU
    new NameId(ds("multimap"), 0x022B8),  // MULTIMAP
    new NameId(ds("mumap"), 0x022B8),  // MULTIMAP
];

const namesN: readonly NameId[] = [
    new NameId(ds("nabla"), 0x02207),  // NABLA
    new NameId(ds("Nacute"), 0x00143),  // LATIN CAPITAL LETTER N WITH ACUTE
    new NameId(ds("nacute"), 0x00144),  // LATIN SMALL LETTER N WITH ACUTE
    new NameId(ds("nang"), 0x02220, 0x020D2),  // ANGLE with vertical line
    new NameId(ds("nap"), 0x02249),  // NOT ALMOST EQUAL TO
    new NameId(ds("napE"), 0x02A70, 0x00338),  // APPROXIMATELY EQUAL OR EQUAL TO with slash
    new NameId(ds("napid"), 0x0224B, 0x00338),  // TRIPLE TILDE with slash
    new NameId(ds("napos"), 0x00149),  // LATIN SMALL LETTER N PRECEDED BY APOSTROPHE
    new NameId(ds("napprox"), 0x02249),  // NOT ALMOST EQUAL TO
    new NameId(ds("natur"), 0x0266E),  // MUSIC NATURAL SIGN
    new NameId(ds("natural"), 0x0266E),  // MUSIC NATURAL SIGN
    new NameId(ds("naturals"), 0x02115),  // DOUBLE-STRUCK CAPITAL N
    new NameId(ds("nbsp"), 0x000A0),  // NO-BREAK SPACE
    new NameId(ds("nbump"), 0x0224E, 0x00338),  // GEOMETRICALLY EQUIVALENT TO with slash
    new NameId(ds("nbumpe"), 0x0224F, 0x00338),  // DIFFERENCE BETWEEN with slash
    new NameId(ds("ncap"), 0x02A43),  // INTERSECTION WITH OVERBAR
    new NameId(ds("Ncaron"), 0x00147),  // LATIN CAPITAL LETTER N WITH CARON
    new NameId(ds("ncaron"), 0x00148),  // LATIN SMALL LETTER N WITH CARON
    new NameId(ds("Ncedil"), 0x00145),  // LATIN CAPITAL LETTER N WITH CEDILLA
    new NameId(ds("ncedil"), 0x00146),  // LATIN SMALL LETTER N WITH CEDILLA
    new NameId(ds("ncong"), 0x02247),  // NEITHER APPROXIMATELY NOR ACTUALLY EQUAL TO
    new NameId(ds("ncongdot"), 0x02A6D, 0x00338),  // CONGRUENT WITH DOT ABOVE with slash
    new NameId(ds("ncup"), 0x02A42),  // UNION WITH OVERBAR
    new NameId(ds("Ncy"), 0x0041D),  // CYRILLIC CAPITAL LETTER EN
    new NameId(ds("ncy"), 0x0043D),  // CYRILLIC SMALL LETTER EN
    new NameId(ds("ndash"), 0x02013),  // EN DASH
    new NameId(ds("ne"), 0x02260),  // NOT EQUAL TO
    new NameId(ds("nearhk"), 0x02924),  // NORTH EAST ARROW WITH HOOK
    new NameId(ds("nearr"), 0x02197),  // NORTH EAST ARROW
    new NameId(ds("neArr"), 0x021D7),  // NORTH EAST DOUBLE ARROW
    new NameId(ds("nearrow"), 0x02197),  // NORTH EAST ARROW
    new NameId(ds("nedot"), 0x02250, 0x00338),  // APPROACHES THE LIMIT with slash
    new NameId(ds("NegativeMediumSpace"), 0x0200B),  // ZERO WIDTH SPACE
    new NameId(ds("NegativeThickSpace"), 0x0200B),  // ZERO WIDTH SPACE
    new NameId(ds("NegativeThinSpace"), 0x0200B),  // ZERO WIDTH SPACE
    new NameId(ds("NegativeVeryThinSpace"), 0x0200B),  // ZERO WIDTH SPACE
    new NameId(ds("nequiv"), 0x02262),  // NOT IDENTICAL TO
    new NameId(ds("nesear"), 0x02928),  // NORTH EAST ARROW AND SOUTH EAST ARROW
    new NameId(ds("nesim"), 0x02242, 0x00338),  // MINUS TILDE with slash
    new NameId(ds("NestedGreaterGreater"), 0x0226B),  // MUCH GREATER-THAN
    new NameId(ds("NestedLessLess"), 0x0226A),  // MUCH LESS-THAN
    new NameId(ds("NewLine"), 0x0000A),  // LINE FEED (LF)
    new NameId(ds("nexist"), 0x02204),  // THERE DOES NOT EXIST
    new NameId(ds("nexists"), 0x02204),  // THERE DOES NOT EXIST
    new NameId(ds("Nfr"), 0x1D511),  // MATHEMATICAL FRAKTUR CAPITAL N
    new NameId(ds("nfr"), 0x1D52B),  // MATHEMATICAL FRAKTUR SMALL N
    new NameId(ds("ngE"), 0x02267, 0x00338),  // GREATER-THAN OVER EQUAL TO with slash
    new NameId(ds("nge"), 0x02271),  // NEITHER GREATER-THAN NOR EQUAL TO
    new NameId(ds("ngeq"), 0x02271),  // NEITHER GREATER-THAN NOR EQUAL TO
    new NameId(ds("ngeqq"), 0x02267, 0x00338),  // GREATER-THAN OVER EQUAL TO with slash
    new NameId(ds("ngeqslant"), 0x02A7E, 0x00338),  // GREATER-THAN OR SLANTED EQUAL TO with slash
    new NameId(ds("nges"), 0x02A7E, 0x00338),  // GREATER-THAN OR SLANTED EQUAL TO with slash
    new NameId(ds("nGg"), 0x022D9, 0x00338),  // VERY MUCH GREATER-THAN with slash
    new NameId(ds("Ngr"), 0x0039D),  // GREEK CAPITAL LETTER NU
    new NameId(ds("ngr"), 0x003BD),  // GREEK SMALL LETTER NU
    new NameId(ds("ngsim"), 0x02275),  // NEITHER GREATER-THAN NOR EQUIVALENT TO
    new NameId(ds("nGt"), 0x0226B, 0x020D2),  // MUCH GREATER THAN with vertical line
    new NameId(ds("ngt"), 0x0226F),  // NOT GREATER-THAN
    new NameId(ds("ngtr"), 0x0226F),  // NOT GREATER-THAN
    new NameId(ds("nGtv"), 0x0226B, 0x00338),  // MUCH GREATER THAN with slash
    new NameId(ds("nharr"), 0x021AE),  // LEFT RIGHT ARROW WITH STROKE
    new NameId(ds("nhArr"), 0x021CE),  // LEFT RIGHT DOUBLE ARROW WITH STROKE
    new NameId(ds("nhpar"), 0x02AF2),  // PARALLEL WITH HORIZONTAL STROKE
    new NameId(ds("ni"), 0x0220B),  // CONTAINS AS MEMBER
    new NameId(ds("nis"), 0x022FC),  // SMALL CONTAINS WITH VERTICAL BAR AT END OF HORIZONTAL STROKE
    new NameId(ds("nisd"), 0x022FA),  // CONTAINS WITH LONG HORIZONTAL STROKE
    new NameId(ds("niv"), 0x0220B),  // CONTAINS AS MEMBER
    new NameId(ds("NJcy"), 0x0040A),  // CYRILLIC CAPITAL LETTER NJE
    new NameId(ds("njcy"), 0x0045A),  // CYRILLIC SMALL LETTER NJE
    new NameId(ds("nlarr"), 0x0219A),  // LEFTWARDS ARROW WITH STROKE
    new NameId(ds("nlArr"), 0x021CD),  // LEFTWARDS DOUBLE ARROW WITH STROKE
    new NameId(ds("nldr"), 0x02025),  // TWO DOT LEADER
    new NameId(ds("nlE"), 0x02266, 0x00338),  // LESS-THAN OVER EQUAL TO with slash
    new NameId(ds("nle"), 0x02270),  // NEITHER LESS-THAN NOR EQUAL TO
    new NameId(ds("nleftarrow"), 0x0219A),  // LEFTWARDS ARROW WITH STROKE
    new NameId(ds("nLeftarrow"), 0x021CD),  // LEFTWARDS DOUBLE ARROW WITH STROKE
    new NameId(ds("nleftrightarrow"), 0x021AE),  // LEFT RIGHT ARROW WITH STROKE
    new NameId(ds("nLeftrightarrow"), 0x021CE),  // LEFT RIGHT DOUBLE ARROW WITH STROKE
    new NameId(ds("nleq"), 0x02270),  // NEITHER LESS-THAN NOR EQUAL TO
    new NameId(ds("nleqq"), 0x02266, 0x00338),  // LESS-THAN OVER EQUAL TO with slash
    new NameId(ds("nleqslant"), 0x02A7D, 0x00338),  // LESS-THAN OR SLANTED EQUAL TO with slash
    new NameId(ds("nles"), 0x02A7D, 0x00338),  // LESS-THAN OR SLANTED EQUAL TO with slash
    new NameId(ds("nless"), 0x0226E),  // NOT LESS-THAN
    new NameId(ds("nLl"), 0x022D8, 0x00338),  // VERY MUCH LESS-THAN with slash
    new NameId(ds("nlsim"), 0x02274),  // NEITHER LESS-THAN NOR EQUIVALENT TO
    new NameId(ds("nLt"), 0x0226A, 0x020D2),  // MUCH LESS THAN with vertical line
    new NameId(ds("nlt"), 0x0226E),  // NOT LESS-THAN
    new NameId(ds("nltri"), 0x022EA),  // NOT NORMAL SUBGROUP OF
    new NameId(ds("nltrie"), 0x022EC),  // NOT NORMAL SUBGROUP OF OR EQUAL TO
    new NameId(ds("nLtv"), 0x0226A, 0x00338),  // MUCH LESS THAN with slash
    new NameId(ds("nmid"), 0x02224),  // DOES NOT DIVIDE
    new NameId(ds("NoBreak"), 0x02060),  // WORD JOINER
    new NameId(ds("NonBreakingSpace"), 0x000A0),  // NO-BREAK SPACE
    new NameId(ds("Nopf"), 0x02115),  // DOUBLE-STRUCK CAPITAL N
    new NameId(ds("nopf"), 0x1D55F),  // MATHEMATICAL DOUBLE-STRUCK SMALL N
    new NameId(ds("not"), 0x000AC),  // NOT SIGN
    new NameId(ds("Not"), 0x02AEC),  // DOUBLE STROKE NOT SIGN
    new NameId(ds("NotCongruent"), 0x02262),  // NOT IDENTICAL TO
    new NameId(ds("NotCupCap"), 0x0226D),  // NOT EQUIVALENT TO
    new NameId(ds("NotDoubleVerticalBar"), 0x02226),  // NOT PARALLEL TO
    new NameId(ds("NotElement"), 0x02209),  // NOT AN ELEMENT OF
    new NameId(ds("NotEqual"), 0x02260),  // NOT EQUAL TO
    new NameId(ds("NotEqualTilde"), 0x02242, 0x00338),  // MINUS TILDE with slash
    new NameId(ds("NotExists"), 0x02204),  // THERE DOES NOT EXIST
    new NameId(ds("NotGreater"), 0x0226F),  // NOT GREATER-THAN
    new NameId(ds("NotGreaterEqual"), 0x02271),  // NEITHER GREATER-THAN NOR EQUAL TO
    new NameId(ds("NotGreaterFullEqual"), 0x02267, 0x00338),  // GREATER-THAN OVER EQUAL TO with slash
    new NameId(ds("NotGreaterGreater"), 0x0226B, 0x00338),  // MUCH GREATER THAN with slash
    new NameId(ds("NotGreaterLess"), 0x02279),  // NEITHER GREATER-THAN NOR LESS-THAN
    new NameId(ds("NotGreaterSlantEqual"), 0x02A7E, 0x00338),  // GREATER-THAN OR SLANTED EQUAL TO with slash
    new NameId(ds("NotGreaterTilde"), 0x02275),  // NEITHER GREATER-THAN NOR EQUIVALENT TO
    new NameId(ds("NotHumpDownHump"), 0x0224E, 0x00338),  // GEOMETRICALLY EQUIVALENT TO with slash
    new NameId(ds("NotHumpEqual"), 0x0224F, 0x00338),  // DIFFERENCE BETWEEN with slash
    new NameId(ds("notin"), 0x02209),  // NOT AN ELEMENT OF
    new NameId(ds("notindot"), 0x022F5, 0x00338),  // ELEMENT OF WITH DOT ABOVE with slash
    new NameId(ds("notinE"), 0x022F9, 0x00338),  // ELEMENT OF WITH TWO HORIZONTAL STROKES with slash
    new NameId(ds("notinva"), 0x02209),  // NOT AN ELEMENT OF
    new NameId(ds("notinvb"), 0x022F7),  // SMALL ELEMENT OF WITH OVERBAR
    new NameId(ds("notinvc"), 0x022F6),  // ELEMENT OF WITH OVERBAR
    new NameId(ds("NotLeftTriangle"), 0x022EA),  // NOT NORMAL SUBGROUP OF
    new NameId(ds("NotLeftTriangleBar"), 0x029CF, 0x00338),  // LEFT TRIANGLE BESIDE VERTICAL BAR with slash
    new NameId(ds("NotLeftTriangleEqual"), 0x022EC),  // NOT NORMAL SUBGROUP OF OR EQUAL TO
    new NameId(ds("NotLess"), 0x0226E),  // NOT LESS-THAN
    new NameId(ds("NotLessEqual"), 0x02270),  // NEITHER LESS-THAN NOR EQUAL TO
    new NameId(ds("NotLessGreater"), 0x02278),  // NEITHER LESS-THAN NOR GREATER-THAN
    new NameId(ds("NotLessLess"), 0x0226A, 0x00338),  // MUCH LESS THAN with slash
    new NameId(ds("NotLessSlantEqual"), 0x02A7D, 0x00338),  // LESS-THAN OR SLANTED EQUAL TO with slash
    new NameId(ds("NotLessTilde"), 0x02274),  // NEITHER LESS-THAN NOR EQUIVALENT TO
    new NameId(ds("NotNestedGreaterGreater"), 0x02AA2, 0x00338),  // DOUBLE NESTED GREATER-THAN with slash
    new NameId(ds("NotNestedLessLess"), 0x02AA1, 0x00338),  // DOUBLE NESTED LESS-THAN with slash
    new NameId(ds("notni"), 0x0220C),  // DOES NOT CONTAIN AS MEMBER
    new NameId(ds("notniva"), 0x0220C),  // DOES NOT CONTAIN AS MEMBER
    new NameId(ds("notnivb"), 0x022FE),  // SMALL CONTAINS WITH OVERBAR
    new NameId(ds("notnivc"), 0x022FD),  // CONTAINS WITH OVERBAR
    new NameId(ds("NotPrecedes"), 0x02280),  // DOES NOT PRECEDE
    new NameId(ds("NotPrecedesEqual"), 0x02AAF, 0x00338),  // PRECEDES ABOVE SINGLE-LINE EQUALS SIGN with slash
    new NameId(ds("NotPrecedesSlantEqual"), 0x022E0),  // DOES NOT PRECEDE OR EQUAL
    new NameId(ds("NotReverseElement"), 0x0220C),  // DOES NOT CONTAIN AS MEMBER
    new NameId(ds("NotRightTriangle"), 0x022EB),  // DOES NOT CONTAIN AS NORMAL SUBGROUP
    new NameId(ds("NotRightTriangleBar"), 0x029D0, 0x00338),  // VERTICAL BAR BESIDE RIGHT TRIANGLE with slash
    new NameId(ds("NotRightTriangleEqual"), 0x022ED),  // DOES NOT CONTAIN AS NORMAL SUBGROUP OR EQUAL
    new NameId(ds("NotSquareSubset"), 0x0228F, 0x00338),  // SQUARE IMAGE OF with slash
    new NameId(ds("NotSquareSubsetEqual"), 0x022E2),  // NOT SQUARE IMAGE OF OR EQUAL TO
    new NameId(ds("NotSquareSuperset"), 0x02290, 0x00338),  // SQUARE ORIGINAL OF with slash
    new NameId(ds("NotSquareSupersetEqual"), 0x022E3),  // NOT SQUARE ORIGINAL OF OR EQUAL TO
    new NameId(ds("NotSubset"), 0x02282, 0x020D2),  // SUBSET OF with vertical line
    new NameId(ds("NotSubsetEqual"), 0x02288),  // NEITHER A SUBSET OF NOR EQUAL TO
    new NameId(ds("NotSucceeds"), 0x02281),  // DOES NOT SUCCEED
    new NameId(ds("NotSucceedsEqual"), 0x02AB0, 0x00338),  // SUCCEEDS ABOVE SINGLE-LINE EQUALS SIGN with slash
    new NameId(ds("NotSucceedsSlantEqual"), 0x022E1),  // DOES NOT SUCCEED OR EQUAL
    new NameId(ds("NotSucceedsTilde"), 0x0227F, 0x00338),  // SUCCEEDS OR EQUIVALENT TO with slash
    new NameId(ds("NotSuperset"), 0x02283, 0x020D2),  // SUPERSET OF with vertical line
    new NameId(ds("NotSupersetEqual"), 0x02289),  // NEITHER A SUPERSET OF NOR EQUAL TO
    new NameId(ds("NotTilde"), 0x02241),  // NOT TILDE
    new NameId(ds("NotTildeEqual"), 0x02244),  // NOT ASYMPTOTICALLY EQUAL TO
    new NameId(ds("NotTildeFullEqual"), 0x02247),  // NEITHER APPROXIMATELY NOR ACTUALLY EQUAL TO
    new NameId(ds("NotTildeTilde"), 0x02249),  // NOT ALMOST EQUAL TO
    new NameId(ds("NotVerticalBar"), 0x02224),  // DOES NOT DIVIDE
    new NameId(ds("npar"), 0x02226),  // NOT PARALLEL TO
    new NameId(ds("nparallel"), 0x02226),  // NOT PARALLEL TO
    new NameId(ds("nparsl"), 0x02AFD, 0x020E5),  // DOUBLE SOLIDUS OPERATOR with reverse slash
    new NameId(ds("npart"), 0x02202, 0x00338),  // PARTIAL DIFFERENTIAL with slash
    new NameId(ds("npolint"), 0x02A14),  // LINE INTEGRATION NOT INCLUDING THE POLE
    new NameId(ds("npr"), 0x02280),  // DOES NOT PRECEDE
    new NameId(ds("nprcue"), 0x022E0),  // DOES NOT PRECEDE OR EQUAL
    new NameId(ds("npre"), 0x02AAF, 0x00338),  // PRECEDES ABOVE SINGLE-LINE EQUALS SIGN with slash
    new NameId(ds("nprec"), 0x02280),  // DOES NOT PRECEDE
    new NameId(ds("npreceq"), 0x02AAF, 0x00338),  // PRECEDES ABOVE SINGLE-LINE EQUALS SIGN with slash
    new NameId(ds("nrarr"), 0x0219B),  // RIGHTWARDS ARROW WITH STROKE
    new NameId(ds("nrArr"), 0x021CF),  // RIGHTWARDS DOUBLE ARROW WITH STROKE
    new NameId(ds("nrarrc"), 0x02933, 0x00338),  // WAVE ARROW POINTING DIRECTLY RIGHT with slash
    new NameId(ds("nrarrw"), 0x0219D, 0x00338),  // RIGHTWARDS WAVE ARROW with slash
    new NameId(ds("nrightarrow"), 0x0219B),  // RIGHTWARDS ARROW WITH STROKE
    new NameId(ds("nRightarrow"), 0x021CF),  // RIGHTWARDS DOUBLE ARROW WITH STROKE
    new NameId(ds("nrtri"), 0x022EB),  // DOES NOT CONTAIN AS NORMAL SUBGROUP
    new NameId(ds("nrtrie"), 0x022ED),  // DOES NOT CONTAIN AS NORMAL SUBGROUP OR EQUAL
    new NameId(ds("nsc"), 0x02281),  // DOES NOT SUCCEED
    new NameId(ds("nsccue"), 0x022E1),  // DOES NOT SUCCEED OR EQUAL
    new NameId(ds("nsce"), 0x02AB0, 0x00338),  // SUCCEEDS ABOVE SINGLE-LINE EQUALS SIGN with slash
    new NameId(ds("Nscr"), 0x1D4A9),  // MATHEMATICAL SCRIPT CAPITAL N
    new NameId(ds("nscr"), 0x1D4C3),  // MATHEMATICAL SCRIPT SMALL N
    new NameId(ds("nshortmid"), 0x02224),  // DOES NOT DIVIDE
    new NameId(ds("nshortparallel"), 0x02226),  // NOT PARALLEL TO
    new NameId(ds("nsim"), 0x02241),  // NOT TILDE
    new NameId(ds("nsime"), 0x02244),  // NOT ASYMPTOTICALLY EQUAL TO
    new NameId(ds("nsimeq"), 0x02244),  // NOT ASYMPTOTICALLY EQUAL TO
    new NameId(ds("nsmid"), 0x02224),  // DOES NOT DIVIDE
    new NameId(ds("nspar"), 0x02226),  // NOT PARALLEL TO
    new NameId(ds("nsqsube"), 0x022E2),  // NOT SQUARE IMAGE OF OR EQUAL TO
    new NameId(ds("nsqsupe"), 0x022E3),  // NOT SQUARE ORIGINAL OF OR EQUAL TO
    new NameId(ds("nsub"), 0x02284),  // NOT A SUBSET OF
    new NameId(ds("nsube"), 0x02288),  // NEITHER A SUBSET OF NOR EQUAL TO
    new NameId(ds("nsubE"), 0x02AC5, 0x00338),  // SUBSET OF ABOVE EQUALS SIGN with slash
    new NameId(ds("nsubset"), 0x02282, 0x020D2),  // SUBSET OF with vertical line
    new NameId(ds("nsubseteq"), 0x02288),  // NEITHER A SUBSET OF NOR EQUAL TO
    new NameId(ds("nsubseteqq"), 0x02AC5, 0x00338),  // SUBSET OF ABOVE EQUALS SIGN with slash
    new NameId(ds("nsucc"), 0x02281),  // DOES NOT SUCCEED
    new NameId(ds("nsucceq"), 0x02AB0, 0x00338),  // SUCCEEDS ABOVE SINGLE-LINE EQUALS SIGN with slash
    new NameId(ds("nsup"), 0x02285),  // NOT A SUPERSET OF
    new NameId(ds("nsupe"), 0x02289),  // NEITHER A SUPERSET OF NOR EQUAL TO
    new NameId(ds("nsupE"), 0x02AC6, 0x00338),  // SUPERSET OF ABOVE EQUALS SIGN with slash
    new NameId(ds("nsupset"), 0x02283, 0x020D2),  // SUPERSET OF with vertical line
    new NameId(ds("nsupseteq"), 0x02289),  // NEITHER A SUPERSET OF NOR EQUAL TO
    new NameId(ds("nsupseteqq"), 0x02AC6, 0x00338),  // SUPERSET OF ABOVE EQUALS SIGN with slash
    new NameId(ds("ntgl"), 0x02279),  // NEITHER GREATER-THAN NOR LESS-THAN
    new NameId(ds("Ntilde"), 0x000D1),  // LATIN CAPITAL LETTER N WITH TILDE
    new NameId(ds("ntilde"), 0x000F1),  // LATIN SMALL LETTER N WITH TILDE
    new NameId(ds("ntlg"), 0x02278),  // NEITHER LESS-THAN NOR GREATER-THAN
    new NameId(ds("ntriangleleft"), 0x022EA),  // NOT NORMAL SUBGROUP OF
    new NameId(ds("ntrianglelefteq"), 0x022EC),  // NOT NORMAL SUBGROUP OF OR EQUAL TO
    new NameId(ds("ntriangleright"), 0x022EB),  // DOES NOT CONTAIN AS NORMAL SUBGROUP
    new NameId(ds("ntrianglerighteq"), 0x022ED),  // DOES NOT CONTAIN AS NORMAL SUBGROUP OR EQUAL
    new NameId(ds("Nu"), 0x0039D),  // GREEK CAPITAL LETTER NU
    new NameId(ds("nu"), 0x003BD),  // GREEK SMALL LETTER NU
    new NameId(ds("num"), 0x00023),  // NUMBER SIGN
    new NameId(ds("numero"), 0x02116),  // NUMERO SIGN
    new NameId(ds("numsp"), 0x02007),  // FIGURE SPACE
    new NameId(ds("nvap"), 0x0224D, 0x020D2),  // EQUIVALENT TO with vertical line
    new NameId(ds("nvdash"), 0x022AC),  // DOES NOT PROVE
    new NameId(ds("nvDash"), 0x022AD),  // NOT TRUE
    new NameId(ds("nVdash"), 0x022AE),  // DOES NOT FORCE
    new NameId(ds("nVDash"), 0x022AF),  // NEGATED DOUBLE VERTICAL BAR DOUBLE RIGHT TURNSTILE
    new NameId(ds("nvge"), 0x02265, 0x020D2),  // GREATER-THAN OR EQUAL TO with vertical line
    new NameId(ds("nvgt"), 0x0003E, 0x020D2),  // GREATER-THAN SIGN with vertical line
    new NameId(ds("nvHarr"), 0x02904),  // LEFT RIGHT DOUBLE ARROW WITH VERTICAL STROKE
    new NameId(ds("nvinfin"), 0x029DE),  // INFINITY NEGATED WITH VERTICAL BAR
    new NameId(ds("nvlArr"), 0x02902),  // LEFTWARDS DOUBLE ARROW WITH VERTICAL STROKE
    new NameId(ds("nvle"), 0x02264, 0x020D2),  // LESS-THAN OR EQUAL TO with vertical line
    new NameId(ds("nvlt"), 0x0003C, 0x020D2),  // LESS-THAN SIGN with vertical line
    new NameId(ds("nvltrie"), 0x022B4, 0x020D2),  // NORMAL SUBGROUP OF OR EQUAL TO with vertical line
    new NameId(ds("nvrArr"), 0x02903),  // RIGHTWARDS DOUBLE ARROW WITH VERTICAL STROKE
    new NameId(ds("nvrtrie"), 0x022B5, 0x020D2),  // CONTAINS AS NORMAL SUBGROUP OR EQUAL TO with vertical line
    new NameId(ds("nvsim"), 0x0223C, 0x020D2),  // TILDE OPERATOR with vertical line
    new NameId(ds("nwarhk"), 0x02923),  // NORTH WEST ARROW WITH HOOK
    new NameId(ds("nwarr"), 0x02196),  // NORTH WEST ARROW
    new NameId(ds("nwArr"), 0x021D6),  // NORTH WEST DOUBLE ARROW
    new NameId(ds("nwarrow"), 0x02196),  // NORTH WEST ARROW
    new NameId(ds("nwnear"), 0x02927),  // NORTH WEST ARROW AND NORTH EAST ARROW
];

const namesO: readonly NameId[] = [
    new NameId(ds("Oacgr"), 0x0038C),  // GREEK CAPITAL LETTER OMICRON WITH TONOS
    new NameId(ds("oacgr"), 0x003CC),  // GREEK SMALL LETTER OMICRON WITH TONOS
    new NameId(ds("Oacute"), 0x000D3),  // LATIN CAPITAL LETTER O WITH ACUTE
    new NameId(ds("oacute"), 0x000F3),  // LATIN SMALL LETTER O WITH ACUTE
    new NameId(ds("oast"), 0x0229B),  // CIRCLED ASTERISK OPERATOR
    new NameId(ds("ocir"), 0x0229A),  // CIRCLED RING OPERATOR
    new NameId(ds("Ocirc"), 0x000D4),  // LATIN CAPITAL LETTER O WITH CIRCUMFLEX
    new NameId(ds("ocirc"), 0x000F4),  // LATIN SMALL LETTER O WITH CIRCUMFLEX
    new NameId(ds("Ocy"), 0x0041E),  // CYRILLIC CAPITAL LETTER O
    new NameId(ds("ocy"), 0x0043E),  // CYRILLIC SMALL LETTER O
    new NameId(ds("odash"), 0x0229D),  // CIRCLED DASH
    new NameId(ds("Odblac"), 0x00150),  // LATIN CAPITAL LETTER O WITH DOUBLE ACUTE
    new NameId(ds("odblac"), 0x00151),  // LATIN SMALL LETTER O WITH DOUBLE ACUTE
    new NameId(ds("odiv"), 0x02A38),  // CIRCLED DIVISION SIGN
    new NameId(ds("odot"), 0x02299),  // CIRCLED DOT OPERATOR
    new NameId(ds("odsold"), 0x029BC),  // CIRCLED ANTICLOCKWISE-ROTATED DIVISION SIGN
    new NameId(ds("OElig"), 0x00152),  // LATIN CAPITAL LIGATURE OE
    new NameId(ds("oelig"), 0x00153),  // LATIN SMALL LIGATURE OE
    new NameId(ds("ofcir"), 0x029BF),  // CIRCLED BULLET
    new NameId(ds("Ofr"), 0x1D512),  // MATHEMATICAL FRAKTUR CAPITAL O
    new NameId(ds("ofr"), 0x1D52C),  // MATHEMATICAL FRAKTUR SMALL O
    new NameId(ds("ogon"), 0x002DB),  // OGONEK
    new NameId(ds("Ogr"), 0x0039F),  // GREEK CAPITAL LETTER OMICRON
    new NameId(ds("ogr"), 0x003BF),  // GREEK SMALL LETTER OMICRON
    new NameId(ds("Ograve"), 0x000D2),  // LATIN CAPITAL LETTER O WITH GRAVE
    new NameId(ds("ograve"), 0x000F2),  // LATIN SMALL LETTER O WITH GRAVE
    new NameId(ds("ogt"), 0x029C1),  // CIRCLED GREATER-THAN
    new NameId(ds("OHacgr"), 0x0038F),  // GREEK CAPITAL LETTER OMEGA WITH TONOS
    new NameId(ds("ohacgr"), 0x003CE),  // GREEK SMALL LETTER OMEGA WITH TONOS
    new NameId(ds("ohbar"), 0x029B5),  // CIRCLE WITH HORIZONTAL BAR
    new NameId(ds("OHgr"), 0x003A9),  // GREEK CAPITAL LETTER OMEGA
    new NameId(ds("ohgr"), 0x003C9),  // GREEK SMALL LETTER OMEGA
    new NameId(ds("ohm"), 0x003A9),  // GREEK CAPITAL LETTER OMEGA
    new NameId(ds("oint"), 0x0222E),  // CONTOUR INTEGRAL
    new NameId(ds("olarr"), 0x021BA),  // ANTICLOCKWISE OPEN CIRCLE ARROW
    new NameId(ds("olcir"), 0x029BE),  // CIRCLED WHITE BULLET
    new NameId(ds("olcross"), 0x029BB),  // CIRCLE WITH SUPERIMPOSED X
    new NameId(ds("oline"), 0x0203E),  // OVERLINE
    new NameId(ds("olt"), 0x029C0),  // CIRCLED LESS-THAN
    new NameId(ds("Omacr"), 0x0014C),  // LATIN CAPITAL LETTER O WITH MACRON
    new NameId(ds("omacr"), 0x0014D),  // LATIN SMALL LETTER O WITH MACRON
    new NameId(ds("Omega"), 0x003A9),  // GREEK CAPITAL LETTER OMEGA
    new NameId(ds("omega"), 0x003C9),  // GREEK SMALL LETTER OMEGA
    new NameId(ds("Omicron"), 0x0039F),  // GREEK CAPITAL LETTER OMICRON
    new NameId(ds("omicron"), 0x003BF),  // GREEK SMALL LETTER OMICRON
    new NameId(ds("omid"), 0x029B6),  // CIRCLED VERTICAL BAR
    new NameId(ds("ominus"), 0x02296),  // CIRCLED MINUS
    new NameId(ds("Oopf"), 0x1D546),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL O
    new NameId(ds("oopf"), 0x1D560),  // MATHEMATICAL DOUBLE-STRUCK SMALL O
    new NameId(ds("opar"), 0x029B7),  // CIRCLED PARALLEL
    new NameId(ds("OpenCurlyDoubleQuote"), 0x0201C),  // LEFT DOUBLE QUOTATION MARK
    new NameId(ds("OpenCurlyQuote"), 0x02018),  // LEFT SINGLE QUOTATION MARK
    new NameId(ds("operp"), 0x029B9),  // CIRCLED PERPENDICULAR
    new NameId(ds("oplus"), 0x02295),  // CIRCLED PLUS
    new NameId(ds("or"), 0x02228),  // LOGICAL OR
    new NameId(ds("Or"), 0x02A54),  // DOUBLE LOGICAL OR
    new NameId(ds("orarr"), 0x021BB),  // CLOCKWISE OPEN CIRCLE ARROW
    new NameId(ds("ord"), 0x02A5D),  // LOGICAL OR WITH HORIZONTAL DASH
    new NameId(ds("order"), 0x02134),  // SCRIPT SMALL O
    new NameId(ds("orderof"), 0x02134),  // SCRIPT SMALL O
    new NameId(ds("ordf"), 0x000AA),  // FEMININE ORDINAL INDICATOR
    new NameId(ds("ordm"), 0x000BA),  // MASCULINE ORDINAL INDICATOR
    new NameId(ds("origof"), 0x022B6),  // ORIGINAL OF
    new NameId(ds("oror"), 0x02A56),  // TWO INTERSECTING LOGICAL OR
    new NameId(ds("orslope"), 0x02A57),  // SLOPING LARGE OR
    new NameId(ds("orv"), 0x02A5B),  // LOGICAL OR WITH MIDDLE STEM
    new NameId(ds("oS"), 0x024C8),  // CIRCLED LATIN CAPITAL LETTER S
    new NameId(ds("oscr"), 0x02134),  // SCRIPT SMALL O
    new NameId(ds("Oscr"), 0x1D4AA),  // MATHEMATICAL SCRIPT CAPITAL O
    new NameId(ds("Oslash"), 0x000D8),  // LATIN CAPITAL LETTER O WITH STROKE
    new NameId(ds("oslash"), 0x000F8),  // LATIN SMALL LETTER O WITH STROKE
    new NameId(ds("osol"), 0x02298),  // CIRCLED DIVISION SLASH
    new NameId(ds("Otilde"), 0x000D5),  // LATIN CAPITAL LETTER O WITH TILDE
    new NameId(ds("otilde"), 0x000F5),  // LATIN SMALL LETTER O WITH TILDE
    new NameId(ds("otimes"), 0x02297),  // CIRCLED TIMES
    new NameId(ds("Otimes"), 0x02A37),  // MULTIPLICATION SIGN IN DOUBLE CIRCLE
    new NameId(ds("otimesas"), 0x02A36),  // CIRCLED MULTIPLICATION SIGN WITH CIRCUMFLEX ACCENT
    new NameId(ds("Ouml"), 0x000D6),  // LATIN CAPITAL LETTER O WITH DIAERESIS
    new NameId(ds("ouml"), 0x000F6),  // LATIN SMALL LETTER O WITH DIAERESIS
    new NameId(ds("ovbar"), 0x0233D),  // APL FUNCTIONAL SYMBOL CIRCLE STILE
    new NameId(ds("OverBar"), 0x0203E),  // OVERLINE
    new NameId(ds("OverBrace"), 0x023DE),  // TOP CURLY BRACKET
    new NameId(ds("OverBracket"), 0x023B4),  // TOP SQUARE BRACKET
    new NameId(ds("OverParenthesis"), 0x023DC),  // TOP PARENTHESIS
];

const namesP: readonly NameId[] = [
    new NameId(ds("par"), 0x02225),  // PARALLEL TO
    new NameId(ds("para"), 0x000B6),  // PILCROW SIGN
    new NameId(ds("parallel"), 0x02225),  // PARALLEL TO
    new NameId(ds("parsim"), 0x02AF3),  // PARALLEL WITH TILDE OPERATOR
    new NameId(ds("parsl"), 0x02AFD),  // DOUBLE SOLIDUS OPERATOR
    new NameId(ds("part"), 0x02202),  // PARTIAL DIFFERENTIAL
    new NameId(ds("PartialD"), 0x02202),  // PARTIAL DIFFERENTIAL
    new NameId(ds("Pcy"), 0x0041F),  // CYRILLIC CAPITAL LETTER PE
    new NameId(ds("pcy"), 0x0043F),  // CYRILLIC SMALL LETTER PE
    new NameId(ds("percnt"), 0x00025),  // PERCENT SIGN
    new NameId(ds("period"), 0x0002E),  // FULL STOP
    new NameId(ds("permil"), 0x02030),  // PER MILLE SIGN
    new NameId(ds("perp"), 0x022A5),  // UP TACK
    new NameId(ds("pertenk"), 0x02031),  // PER TEN THOUSAND SIGN
    new NameId(ds("Pfr"), 0x1D513),  // MATHEMATICAL FRAKTUR CAPITAL P
    new NameId(ds("pfr"), 0x1D52D),  // MATHEMATICAL FRAKTUR SMALL P
    new NameId(ds("Pgr"), 0x003A0),  // GREEK CAPITAL LETTER PI
    new NameId(ds("pgr"), 0x003C0),  // GREEK SMALL LETTER PI
    new NameId(ds("PHgr"), 0x003A6),  // GREEK CAPITAL LETTER PHI
    new NameId(ds("phgr"), 0x003C6),  // GREEK SMALL LETTER PHI
    new NameId(ds("Phi"), 0x003A6),  // GREEK CAPITAL LETTER PHI
    new NameId(ds("phi"), 0x003C6),  // GREEK SMALL LETTER PHI
    new NameId(ds("phiv"), 0x003D5),  // GREEK PHI SYMBOL
    new NameId(ds("phmmat"), 0x02133),  // SCRIPT CAPITAL M
    new NameId(ds("phone"), 0x0260E),  // BLACK TELEPHONE
    new NameId(ds("Pi"), 0x003A0),  // GREEK CAPITAL LETTER PI
    new NameId(ds("pi"), 0x003C0),  // GREEK SMALL LETTER PI
    new NameId(ds("pitchfork"), 0x022D4),  // PITCHFORK
    new NameId(ds("piv"), 0x003D6),  // GREEK PI SYMBOL
    new NameId(ds("planck"), 0x0210F),  // PLANCK CONSTANT OVER TWO PI
    new NameId(ds("planckh"), 0x0210E),  // PLANCK CONSTANT
    new NameId(ds("plankv"), 0x0210F),  // PLANCK CONSTANT OVER TWO PI
    new NameId(ds("plus"), 0x0002B),  // PLUS SIGN
    new NameId(ds("plusacir"), 0x02A23),  // PLUS SIGN WITH CIRCUMFLEX ACCENT ABOVE
    new NameId(ds("plusb"), 0x0229E),  // SQUARED PLUS
    new NameId(ds("pluscir"), 0x02A22),  // PLUS SIGN WITH SMALL CIRCLE ABOVE
    new NameId(ds("plusdo"), 0x02214),  // DOT PLUS
    new NameId(ds("plusdu"), 0x02A25),  // PLUS SIGN WITH DOT BELOW
    new NameId(ds("pluse"), 0x02A72),  // PLUS SIGN ABOVE EQUALS SIGN
    new NameId(ds("PlusMinus"), 0x000B1),  // PLUS-MINUS SIGN
    new NameId(ds("plusmn"), 0x000B1),  // PLUS-MINUS SIGN
    new NameId(ds("plussim"), 0x02A26),  // PLUS SIGN WITH TILDE BELOW
    new NameId(ds("plustwo"), 0x02A27),  // PLUS SIGN WITH SUBSCRIPT TWO
    new NameId(ds("pm"), 0x000B1),  // PLUS-MINUS SIGN
    new NameId(ds("Poincareplane"), 0x0210C),  // BLACK-LETTER CAPITAL H
    new NameId(ds("pointint"), 0x02A15),  // INTEGRAL AROUND A POINT OPERATOR
    new NameId(ds("Popf"), 0x02119),  // DOUBLE-STRUCK CAPITAL P
    new NameId(ds("popf"), 0x1D561),  // MATHEMATICAL DOUBLE-STRUCK SMALL P
    new NameId(ds("pound"), 0x000A3),  // POUND SIGN
    new NameId(ds("pr"), 0x0227A),  // PRECEDES
    new NameId(ds("Pr"), 0x02ABB),  // DOUBLE PRECEDES
    new NameId(ds("prap"), 0x02AB7),  // PRECEDES ABOVE ALMOST EQUAL TO
    new NameId(ds("prcue"), 0x0227C),  // PRECEDES OR EQUAL TO
    new NameId(ds("pre"), 0x02AAF),  // PRECEDES ABOVE SINGLE-LINE EQUALS SIGN
    new NameId(ds("prE"), 0x02AB3),  // PRECEDES ABOVE EQUALS SIGN
    new NameId(ds("prec"), 0x0227A),  // PRECEDES
    new NameId(ds("precapprox"), 0x02AB7),  // PRECEDES ABOVE ALMOST EQUAL TO
    new NameId(ds("preccurlyeq"), 0x0227C),  // PRECEDES OR EQUAL TO
    new NameId(ds("Precedes"), 0x0227A),  // PRECEDES
    new NameId(ds("PrecedesEqual"), 0x02AAF),  // PRECEDES ABOVE SINGLE-LINE EQUALS SIGN
    new NameId(ds("PrecedesSlantEqual"), 0x0227C),  // PRECEDES OR EQUAL TO
    new NameId(ds("PrecedesTilde"), 0x0227E),  // PRECEDES OR EQUIVALENT TO
    new NameId(ds("preceq"), 0x02AAF),  // PRECEDES ABOVE SINGLE-LINE EQUALS SIGN
    new NameId(ds("precnapprox"), 0x02AB9),  // PRECEDES ABOVE NOT ALMOST EQUAL TO
    new NameId(ds("precneqq"), 0x02AB5),  // PRECEDES ABOVE NOT EQUAL TO
    new NameId(ds("precnsim"), 0x022E8),  // PRECEDES BUT NOT EQUIVALENT TO
    new NameId(ds("precsim"), 0x0227E),  // PRECEDES OR EQUIVALENT TO
    new NameId(ds("prime"), 0x02032),  // PRIME
    new NameId(ds("Prime"), 0x02033),  // DOUBLE PRIME
    new NameId(ds("primes"), 0x02119),  // DOUBLE-STRUCK CAPITAL P
    new NameId(ds("prnap"), 0x02AB9),  // PRECEDES ABOVE NOT ALMOST EQUAL TO
    new NameId(ds("prnE"), 0x02AB5),  // PRECEDES ABOVE NOT EQUAL TO
    new NameId(ds("prnsim"), 0x022E8),  // PRECEDES BUT NOT EQUIVALENT TO
    new NameId(ds("prod"), 0x0220F),  // N-ARY PRODUCT
    new NameId(ds("Product"), 0x0220F),  // N-ARY PRODUCT
    new NameId(ds("profalar"), 0x0232E),  // ALL AROUND-PROFILE
    new NameId(ds("profline"), 0x02312),  // ARC
    new NameId(ds("profsurf"), 0x02313),  // SEGMENT
    new NameId(ds("prop"), 0x0221D),  // PROPORTIONAL TO
    new NameId(ds("Proportion"), 0x02237),  // PROPORTION
    new NameId(ds("Proportional"), 0x0221D),  // PROPORTIONAL TO
    new NameId(ds("propto"), 0x0221D),  // PROPORTIONAL TO
    new NameId(ds("prsim"), 0x0227E),  // PRECEDES OR EQUIVALENT TO
    new NameId(ds("prurel"), 0x022B0),  // PRECEDES UNDER RELATION
    new NameId(ds("Pscr"), 0x1D4AB),  // MATHEMATICAL SCRIPT CAPITAL P
    new NameId(ds("pscr"), 0x1D4C5),  // MATHEMATICAL SCRIPT SMALL P
    new NameId(ds("PSgr"), 0x003A8),  // GREEK CAPITAL LETTER PSI
    new NameId(ds("psgr"), 0x003C8),  // GREEK SMALL LETTER PSI
    new NameId(ds("Psi"), 0x003A8),  // GREEK CAPITAL LETTER PSI
    new NameId(ds("psi"), 0x003C8),  // GREEK SMALL LETTER PSI
    new NameId(ds("puncsp"), 0x02008),  // PUNCTUATION SPACE
];

const namesQ: readonly NameId[] = [
    new NameId(ds("Qfr"), 0x1D514),  // MATHEMATICAL FRAKTUR CAPITAL Q
    new NameId(ds("qfr"), 0x1D52E),  // MATHEMATICAL FRAKTUR SMALL Q
    new NameId(ds("qint"), 0x02A0C),  // QUADRUPLE INTEGRAL OPERATOR
    new NameId(ds("Qopf"), 0x0211A),  // DOUBLE-STRUCK CAPITAL Q
    new NameId(ds("qopf"), 0x1D562),  // MATHEMATICAL DOUBLE-STRUCK SMALL Q
    new NameId(ds("qprime"), 0x02057),  // QUADRUPLE PRIME
    new NameId(ds("Qscr"), 0x1D4AC),  // MATHEMATICAL SCRIPT CAPITAL Q
    new NameId(ds("qscr"), 0x1D4C6),  // MATHEMATICAL SCRIPT SMALL Q
    new NameId(ds("quaternions"), 0x0210D),  // DOUBLE-STRUCK CAPITAL H
    new NameId(ds("quatint"), 0x02A16),  // QUATERNION INTEGRAL OPERATOR
    new NameId(ds("quest"), 0x0003F),  // QUESTION MARK
    new NameId(ds("questeq"), 0x0225F),  // QUESTIONED EQUAL TO
    new NameId(ds("quot"), 0x00022),  // QUOTATION MARK
    new NameId(ds("QUOT"), 0x00022),  // QUOTATION MARK
];

const namesR: readonly NameId[] = [
    new NameId(ds("rAarr"), 0x021DB),  // RIGHTWARDS TRIPLE ARROW
    new NameId(ds("race"), 0x0223D, 0x00331),  // REVERSED TILDE with underline
    new NameId(ds("Racute"), 0x00154),  // LATIN CAPITAL LETTER R WITH ACUTE
    new NameId(ds("racute"), 0x00155),  // LATIN SMALL LETTER R WITH ACUTE
    new NameId(ds("radic"), 0x0221A),  // SQUARE ROOT
    new NameId(ds("raemptyv"), 0x029B3),  // EMPTY SET WITH RIGHT ARROW ABOVE
    new NameId(ds("rang"), 0x027E9),  // MATHEMATICAL RIGHT ANGLE BRACKET
    new NameId(ds("Rang"), 0x027EB),  // MATHEMATICAL RIGHT DOUBLE ANGLE BRACKET
    new NameId(ds("rangd"), 0x02992),  // RIGHT ANGLE BRACKET WITH DOT
    new NameId(ds("range"), 0x029A5),  // REVERSED ANGLE WITH UNDERBAR
    new NameId(ds("rangle"), 0x027E9),  // MATHEMATICAL RIGHT ANGLE BRACKET
    new NameId(ds("raquo"), 0x000BB),  // RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK
    new NameId(ds("rarr"), 0x02192),  // RIGHTWARDS ARROW
    new NameId(ds("Rarr"), 0x021A0),  // RIGHTWARDS TWO HEADED ARROW
    new NameId(ds("rArr"), 0x021D2),  // RIGHTWARDS DOUBLE ARROW
    new NameId(ds("rarrap"), 0x02975),  // RIGHTWARDS ARROW ABOVE ALMOST EQUAL TO
    new NameId(ds("rarrb"), 0x021E5),  // RIGHTWARDS ARROW TO BAR
    new NameId(ds("rarrbfs"), 0x02920),  // RIGHTWARDS ARROW FROM BAR TO BLACK DIAMOND
    new NameId(ds("rarrc"), 0x02933),  // WAVE ARROW POINTING DIRECTLY RIGHT
    new NameId(ds("rarrfs"), 0x0291E),  // RIGHTWARDS ARROW TO BLACK DIAMOND
    new NameId(ds("rarrhk"), 0x021AA),  // RIGHTWARDS ARROW WITH HOOK
    new NameId(ds("rarrlp"), 0x021AC),  // RIGHTWARDS ARROW WITH LOOP
    new NameId(ds("rarrpl"), 0x02945),  // RIGHTWARDS ARROW WITH PLUS BELOW
    new NameId(ds("rarrsim"), 0x02974),  // RIGHTWARDS ARROW ABOVE TILDE OPERATOR
    new NameId(ds("rarrtl"), 0x021A3),  // RIGHTWARDS ARROW WITH TAIL
    new NameId(ds("Rarrtl"), 0x02916),  // RIGHTWARDS TWO-HEADED ARROW WITH TAIL
    new NameId(ds("rarrw"), 0x0219D),  // RIGHTWARDS WAVE ARROW
    new NameId(ds("ratail"), 0x0291A),  // RIGHTWARDS ARROW-TAIL
    new NameId(ds("rAtail"), 0x0291C),  // RIGHTWARDS DOUBLE ARROW-TAIL
    new NameId(ds("ratio"), 0x02236),  // RATIO
    new NameId(ds("rationals"), 0x0211A),  // DOUBLE-STRUCK CAPITAL Q
    new NameId(ds("rbarr"), 0x0290D),  // RIGHTWARDS DOUBLE DASH ARROW
    new NameId(ds("rBarr"), 0x0290F),  // RIGHTWARDS TRIPLE DASH ARROW
    new NameId(ds("RBarr"), 0x02910),  // RIGHTWARDS TWO-HEADED TRIPLE DASH ARROW
    new NameId(ds("rbbrk"), 0x02773),  // LIGHT RIGHT TORTOISE SHELL BRACKET ORNAMENT
    new NameId(ds("rbrace"), 0x0007D),  // RIGHT CURLY BRACKET
    new NameId(ds("rbrack"), 0x0005D),  // RIGHT SQUARE BRACKET
    new NameId(ds("rbrke"), 0x0298C),  // RIGHT SQUARE BRACKET WITH UNDERBAR
    new NameId(ds("rbrksld"), 0x0298E),  // RIGHT SQUARE BRACKET WITH TICK IN BOTTOM CORNER
    new NameId(ds("rbrkslu"), 0x02990),  // RIGHT SQUARE BRACKET WITH TICK IN TOP CORNER
    new NameId(ds("Rcaron"), 0x00158),  // LATIN CAPITAL LETTER R WITH CARON
    new NameId(ds("rcaron"), 0x00159),  // LATIN SMALL LETTER R WITH CARON
    new NameId(ds("Rcedil"), 0x00156),  // LATIN CAPITAL LETTER R WITH CEDILLA
    new NameId(ds("rcedil"), 0x00157),  // LATIN SMALL LETTER R WITH CEDILLA
    new NameId(ds("rceil"), 0x02309),  // RIGHT CEILING
    new NameId(ds("rcub"), 0x0007D),  // RIGHT CURLY BRACKET
    new NameId(ds("Rcy"), 0x00420),  // CYRILLIC CAPITAL LETTER ER
    new NameId(ds("rcy"), 0x00440),  // CYRILLIC SMALL LETTER ER
    new NameId(ds("rdca"), 0x02937),  // ARROW POINTING DOWNWARDS THEN CURVING RIGHTWARDS
    new NameId(ds("rdldhar"), 0x02969),  // RIGHTWARDS HARPOON WITH BARB DOWN ABOVE LEFTWARDS HARPOON WITH BARB DOWN
    new NameId(ds("rdquo"), 0x0201D),  // RIGHT DOUBLE QUOTATION MARK
    new NameId(ds("rdquor"), 0x0201D),  // RIGHT DOUBLE QUOTATION MARK
    new NameId(ds("rdsh"), 0x021B3),  // DOWNWARDS ARROW WITH TIP RIGHTWARDS
    new NameId(ds("Re"), 0x0211C),  // BLACK-LETTER CAPITAL R
    new NameId(ds("real"), 0x0211C),  // BLACK-LETTER CAPITAL R
    new NameId(ds("realine"), 0x0211B),  // SCRIPT CAPITAL R
    new NameId(ds("realpart"), 0x0211C),  // BLACK-LETTER CAPITAL R
    new NameId(ds("reals"), 0x0211D),  // DOUBLE-STRUCK CAPITAL R
    new NameId(ds("rect"), 0x025AD),  // WHITE RECTANGLE
    new NameId(ds("reg"), 0x000AE),  // REGISTERED SIGN
    new NameId(ds("REG"), 0x000AE),  // REGISTERED SIGN
    new NameId(ds("ReverseElement"), 0x0220B),  // CONTAINS AS MEMBER
    new NameId(ds("ReverseEquilibrium"), 0x021CB),  // LEFTWARDS HARPOON OVER RIGHTWARDS HARPOON
    new NameId(ds("ReverseUpEquilibrium"), 0x0296F),  // DOWNWARDS HARPOON WITH BARB LEFT BESIDE UPWARDS HARPOON WITH BARB RIGHT
    new NameId(ds("rfisht"), 0x0297D),  // RIGHT FISH TAIL
    new NameId(ds("rfloor"), 0x0230B),  // RIGHT FLOOR
    new NameId(ds("Rfr"), 0x0211C),  // BLACK-LETTER CAPITAL R
    new NameId(ds("rfr"), 0x1D52F),  // MATHEMATICAL FRAKTUR SMALL R
    new NameId(ds("Rgr"), 0x003A1),  // GREEK CAPITAL LETTER RHO
    new NameId(ds("rgr"), 0x003C1),  // GREEK SMALL LETTER RHO
    new NameId(ds("rHar"), 0x02964),  // RIGHTWARDS HARPOON WITH BARB UP ABOVE RIGHTWARDS HARPOON WITH BARB DOWN
    new NameId(ds("rhard"), 0x021C1),  // RIGHTWARDS HARPOON WITH BARB DOWNWARDS
    new NameId(ds("rharu"), 0x021C0),  // RIGHTWARDS HARPOON WITH BARB UPWARDS
    new NameId(ds("rharul"), 0x0296C),  // RIGHTWARDS HARPOON WITH BARB UP ABOVE LONG DASH
    new NameId(ds("Rho"), 0x003A1),  // GREEK CAPITAL LETTER RHO
    new NameId(ds("rho"), 0x003C1),  // GREEK SMALL LETTER RHO
    new NameId(ds("rhov"), 0x003F1),  // GREEK RHO SYMBOL
    new NameId(ds("RightAngleBracket"), 0x027E9),  // MATHEMATICAL RIGHT ANGLE BRACKET
    new NameId(ds("rightarrow"), 0x02192),  // RIGHTWARDS ARROW
    new NameId(ds("RightArrow"), 0x02192),  // RIGHTWARDS ARROW
    new NameId(ds("Rightarrow"), 0x021D2),  // RIGHTWARDS DOUBLE ARROW
    new NameId(ds("RightArrowBar"), 0x021E5),  // RIGHTWARDS ARROW TO BAR
    new NameId(ds("RightArrowLeftArrow"), 0x021C4),  // RIGHTWARDS ARROW OVER LEFTWARDS ARROW
    new NameId(ds("rightarrowtail"), 0x021A3),  // RIGHTWARDS ARROW WITH TAIL
    new NameId(ds("RightCeiling"), 0x02309),  // RIGHT CEILING
    new NameId(ds("RightDoubleBracket"), 0x027E7),  // MATHEMATICAL RIGHT WHITE SQUARE BRACKET
    new NameId(ds("RightDownTeeVector"), 0x0295D),  // DOWNWARDS HARPOON WITH BARB RIGHT FROM BAR
    new NameId(ds("RightDownVector"), 0x021C2),  // DOWNWARDS HARPOON WITH BARB RIGHTWARDS
    new NameId(ds("RightDownVectorBar"), 0x02955),  // DOWNWARDS HARPOON WITH BARB RIGHT TO BAR
    new NameId(ds("RightFloor"), 0x0230B),  // RIGHT FLOOR
    new NameId(ds("rightharpoondown"), 0x021C1),  // RIGHTWARDS HARPOON WITH BARB DOWNWARDS
    new NameId(ds("rightharpoonup"), 0x021C0),  // RIGHTWARDS HARPOON WITH BARB UPWARDS
    new NameId(ds("rightleftarrows"), 0x021C4),  // RIGHTWARDS ARROW OVER LEFTWARDS ARROW
    new NameId(ds("rightleftharpoons"), 0x021CC),  // RIGHTWARDS HARPOON OVER LEFTWARDS HARPOON
    new NameId(ds("rightrightarrows"), 0x021C9),  // RIGHTWARDS PAIRED ARROWS
    new NameId(ds("rightsquigarrow"), 0x0219D),  // RIGHTWARDS WAVE ARROW
    new NameId(ds("RightTee"), 0x022A2),  // RIGHT TACK
    new NameId(ds("RightTeeArrow"), 0x021A6),  // RIGHTWARDS ARROW FROM BAR
    new NameId(ds("RightTeeVector"), 0x0295B),  // RIGHTWARDS HARPOON WITH BARB UP FROM BAR
    new NameId(ds("rightthreetimes"), 0x022CC),  // RIGHT SEMIDIRECT PRODUCT
    new NameId(ds("RightTriangle"), 0x022B3),  // CONTAINS AS NORMAL SUBGROUP
    new NameId(ds("RightTriangleBar"), 0x029D0),  // VERTICAL BAR BESIDE RIGHT TRIANGLE
    new NameId(ds("RightTriangleEqual"), 0x022B5),  // CONTAINS AS NORMAL SUBGROUP OR EQUAL TO
    new NameId(ds("RightUpDownVector"), 0x0294F),  // UP BARB RIGHT DOWN BARB RIGHT HARPOON
    new NameId(ds("RightUpTeeVector"), 0x0295C),  // UPWARDS HARPOON WITH BARB RIGHT FROM BAR
    new NameId(ds("RightUpVector"), 0x021BE),  // UPWARDS HARPOON WITH BARB RIGHTWARDS
    new NameId(ds("RightUpVectorBar"), 0x02954),  // UPWARDS HARPOON WITH BARB RIGHT TO BAR
    new NameId(ds("RightVector"), 0x021C0),  // RIGHTWARDS HARPOON WITH BARB UPWARDS
    new NameId(ds("RightVectorBar"), 0x02953),  // RIGHTWARDS HARPOON WITH BARB UP TO BAR
    new NameId(ds("ring"), 0x002DA),  // RING ABOVE
    new NameId(ds("risingdotseq"), 0x02253),  // IMAGE OF OR APPROXIMATELY EQUAL TO
    new NameId(ds("rlarr"), 0x021C4),  // RIGHTWARDS ARROW OVER LEFTWARDS ARROW
    new NameId(ds("rlhar"), 0x021CC),  // RIGHTWARDS HARPOON OVER LEFTWARDS HARPOON
    new NameId(ds("rlm"), 0x0200F),  // RIGHT-TO-LEFT MARK
    new NameId(ds("rmoust"), 0x023B1),  // UPPER RIGHT OR LOWER LEFT CURLY BRACKET SECTION
    new NameId(ds("rmoustache"), 0x023B1),  // UPPER RIGHT OR LOWER LEFT CURLY BRACKET SECTION
    new NameId(ds("rnmid"), 0x02AEE),  // DOES NOT DIVIDE WITH REVERSED NEGATION SLASH
    new NameId(ds("roang"), 0x027ED),  // MATHEMATICAL RIGHT WHITE TORTOISE SHELL BRACKET
    new NameId(ds("roarr"), 0x021FE),  // RIGHTWARDS OPEN-HEADED ARROW
    new NameId(ds("robrk"), 0x027E7),  // MATHEMATICAL RIGHT WHITE SQUARE BRACKET
    new NameId(ds("ropar"), 0x02986),  // RIGHT WHITE PARENTHESIS
    new NameId(ds("Ropf"), 0x0211D),  // DOUBLE-STRUCK CAPITAL R
    new NameId(ds("ropf"), 0x1D563),  // MATHEMATICAL DOUBLE-STRUCK SMALL R
    new NameId(ds("roplus"), 0x02A2E),  // PLUS SIGN IN RIGHT HALF CIRCLE
    new NameId(ds("rotimes"), 0x02A35),  // MULTIPLICATION SIGN IN RIGHT HALF CIRCLE
    new NameId(ds("RoundImplies"), 0x02970),  // RIGHT DOUBLE ARROW WITH ROUNDED HEAD
    new NameId(ds("rpar"), 0x00029),  // RIGHT PARENTHESIS
    new NameId(ds("rpargt"), 0x02994),  // RIGHT ARC GREATER-THAN BRACKET
    new NameId(ds("rppolint"), 0x02A12),  // LINE INTEGRATION WITH RECTANGULAR PATH AROUND POLE
    new NameId(ds("rrarr"), 0x021C9),  // RIGHTWARDS PAIRED ARROWS
    new NameId(ds("Rrightarrow"), 0x021DB),  // RIGHTWARDS TRIPLE ARROW
    new NameId(ds("rsaquo"), 0x0203A),  // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
    new NameId(ds("Rscr"), 0x0211B),  // SCRIPT CAPITAL R
    new NameId(ds("rscr"), 0x1D4C7),  // MATHEMATICAL SCRIPT SMALL R
    new NameId(ds("rsh"), 0x021B1),  // UPWARDS ARROW WITH TIP RIGHTWARDS
    new NameId(ds("Rsh"), 0x021B1),  // UPWARDS ARROW WITH TIP RIGHTWARDS
    new NameId(ds("rsqb"), 0x0005D),  // RIGHT SQUARE BRACKET
    new NameId(ds("rsquo"), 0x02019),  // RIGHT SINGLE QUOTATION MARK
    new NameId(ds("rsquor"), 0x02019),  // RIGHT SINGLE QUOTATION MARK
    new NameId(ds("rthree"), 0x022CC),  // RIGHT SEMIDIRECT PRODUCT
    new NameId(ds("rtimes"), 0x022CA),  // RIGHT NORMAL FACTOR SEMIDIRECT PRODUCT
    new NameId(ds("rtri"), 0x025B9),  // WHITE RIGHT-POINTING SMALL TRIANGLE
    new NameId(ds("rtrie"), 0x022B5),  // CONTAINS AS NORMAL SUBGROUP OR EQUAL TO
    new NameId(ds("rtrif"), 0x025B8),  // BLACK RIGHT-POINTING SMALL TRIANGLE
    new NameId(ds("rtriltri"), 0x029CE),  // RIGHT TRIANGLE ABOVE LEFT TRIANGLE
    new NameId(ds("RuleDelayed"), 0x029F4),  // RULE-DELAYED
    new NameId(ds("ruluhar"), 0x02968),  // RIGHTWARDS HARPOON WITH BARB UP ABOVE LEFTWARDS HARPOON WITH BARB UP
    new NameId(ds("rx"), 0x0211E),  // PRESCRIPTION TAKE
];

const namesS: readonly NameId[] = [
    new NameId(ds("Sacute"), 0x0015A),  // LATIN CAPITAL LETTER S WITH ACUTE
    new NameId(ds("sacute"), 0x0015B),  // LATIN SMALL LETTER S WITH ACUTE
    new NameId(ds("sbquo"), 0x0201A),  // SINGLE LOW-9 QUOTATION MARK
    new NameId(ds("sc"), 0x0227B),  // SUCCEEDS
    new NameId(ds("Sc"), 0x02ABC),  // DOUBLE SUCCEEDS
    new NameId(ds("scap"), 0x02AB8),  // SUCCEEDS ABOVE ALMOST EQUAL TO
    new NameId(ds("Scaron"), 0x00160),  // LATIN CAPITAL LETTER S WITH CARON
    new NameId(ds("scaron"), 0x00161),  // LATIN SMALL LETTER S WITH CARON
    new NameId(ds("sccue"), 0x0227D),  // SUCCEEDS OR EQUAL TO
    new NameId(ds("sce"), 0x02AB0),  // SUCCEEDS ABOVE SINGLE-LINE EQUALS SIGN
    new NameId(ds("scE"), 0x02AB4),  // SUCCEEDS ABOVE EQUALS SIGN
    new NameId(ds("Scedil"), 0x0015E),  // LATIN CAPITAL LETTER S WITH CEDILLA
    new NameId(ds("scedil"), 0x0015F),  // LATIN SMALL LETTER S WITH CEDILLA
    new NameId(ds("Scirc"), 0x0015C),  // LATIN CAPITAL LETTER S WITH CIRCUMFLEX
    new NameId(ds("scirc"), 0x0015D),  // LATIN SMALL LETTER S WITH CIRCUMFLEX
    new NameId(ds("scnap"), 0x02ABA),  // SUCCEEDS ABOVE NOT ALMOST EQUAL TO
    new NameId(ds("scnE"), 0x02AB6),  // SUCCEEDS ABOVE NOT EQUAL TO
    new NameId(ds("scnsim"), 0x022E9),  // SUCCEEDS BUT NOT EQUIVALENT TO
    new NameId(ds("scpolint"), 0x02A13),  // LINE INTEGRATION WITH SEMICIRCULAR PATH AROUND POLE
    new NameId(ds("scsim"), 0x0227F),  // SUCCEEDS OR EQUIVALENT TO
    new NameId(ds("Scy"), 0x00421),  // CYRILLIC CAPITAL LETTER ES
    new NameId(ds("scy"), 0x00441),  // CYRILLIC SMALL LETTER ES
    new NameId(ds("sdot"), 0x022C5),  // DOT OPERATOR
    new NameId(ds("sdotb"), 0x022A1),  // SQUARED DOT OPERATOR
    new NameId(ds("sdote"), 0x02A66),  // EQUALS SIGN WITH DOT BELOW
    new NameId(ds("searhk"), 0x02925),  // SOUTH EAST ARROW WITH HOOK
    new NameId(ds("searr"), 0x02198),  // SOUTH EAST ARROW
    new NameId(ds("seArr"), 0x021D8),  // SOUTH EAST DOUBLE ARROW
    new NameId(ds("searrow"), 0x02198),  // SOUTH EAST ARROW
    new NameId(ds("sect"), 0x000A7),  // SECTION SIGN
    new NameId(ds("semi"), 0x0003B),  // SEMICOLON
    new NameId(ds("seswar"), 0x02929),  // SOUTH EAST ARROW AND SOUTH WEST ARROW
    new NameId(ds("setminus"), 0x02216),  // SET MINUS
    new NameId(ds("setmn"), 0x02216),  // SET MINUS
    new NameId(ds("sext"), 0x02736),  // SIX POINTED BLACK STAR
    new NameId(ds("sfgr"), 0x003C2),  // GREEK SMALL LETTER FINAL SIGMA
    new NameId(ds("Sfr"), 0x1D516),  // MATHEMATICAL FRAKTUR CAPITAL S
    new NameId(ds("sfr"), 0x1D530),  // MATHEMATICAL FRAKTUR SMALL S
    new NameId(ds("sfrown"), 0x02322),  // FROWN
    new NameId(ds("Sgr"), 0x003A3),  // GREEK CAPITAL LETTER SIGMA
    new NameId(ds("sgr"), 0x003C3),  // GREEK SMALL LETTER SIGMA
    new NameId(ds("sharp"), 0x0266F),  // MUSIC SHARP SIGN
    new NameId(ds("SHCHcy"), 0x00429),  // CYRILLIC CAPITAL LETTER SHCHA
    new NameId(ds("shchcy"), 0x00449),  // CYRILLIC SMALL LETTER SHCHA
    new NameId(ds("SHcy"), 0x00428),  // CYRILLIC CAPITAL LETTER SHA
    new NameId(ds("shcy"), 0x00448),  // CYRILLIC SMALL LETTER SHA
    new NameId(ds("ShortDownArrow"), 0x02193),  // DOWNWARDS ARROW
    new NameId(ds("ShortLeftArrow"), 0x02190),  // LEFTWARDS ARROW
    new NameId(ds("shortmid"), 0x02223),  // DIVIDES
    new NameId(ds("shortparallel"), 0x02225),  // PARALLEL TO
    new NameId(ds("ShortRightArrow"), 0x02192),  // RIGHTWARDS ARROW
    new NameId(ds("ShortUpArrow"), 0x02191),  // UPWARDS ARROW
    new NameId(ds("shy"), 0x000AD),  // SOFT HYPHEN
    new NameId(ds("Sigma"), 0x003A3),  // GREEK CAPITAL LETTER SIGMA
    new NameId(ds("sigma"), 0x003C3),  // GREEK SMALL LETTER SIGMA
    new NameId(ds("sigmaf"), 0x003C2),  // GREEK SMALL LETTER FINAL SIGMA
    new NameId(ds("sigmav"), 0x003C2),  // GREEK SMALL LETTER FINAL SIGMA
    new NameId(ds("sim"), 0x0223C),  // TILDE OPERATOR
    new NameId(ds("simdot"), 0x02A6A),  // TILDE OPERATOR WITH DOT ABOVE
    new NameId(ds("sime"), 0x02243),  // ASYMPTOTICALLY EQUAL TO
    new NameId(ds("simeq"), 0x02243),  // ASYMPTOTICALLY EQUAL TO
    new NameId(ds("simg"), 0x02A9E),  // SIMILAR OR GREATER-THAN
    new NameId(ds("simgE"), 0x02AA0),  // SIMILAR ABOVE GREATER-THAN ABOVE EQUALS SIGN
    new NameId(ds("siml"), 0x02A9D),  // SIMILAR OR LESS-THAN
    new NameId(ds("simlE"), 0x02A9F),  // SIMILAR ABOVE LESS-THAN ABOVE EQUALS SIGN
    new NameId(ds("simne"), 0x02246),  // APPROXIMATELY BUT NOT ACTUALLY EQUAL TO
    new NameId(ds("simplus"), 0x02A24),  // PLUS SIGN WITH TILDE ABOVE
    new NameId(ds("simrarr"), 0x02972),  // TILDE OPERATOR ABOVE RIGHTWARDS ARROW
    new NameId(ds("slarr"), 0x02190),  // LEFTWARDS ARROW
    new NameId(ds("SmallCircle"), 0x02218),  // RING OPERATOR
    new NameId(ds("smallsetminus"), 0x02216),  // SET MINUS
    new NameId(ds("smashp"), 0x02A33),  // SMASH PRODUCT
    new NameId(ds("smeparsl"), 0x029E4),  // EQUALS SIGN AND SLANTED PARALLEL WITH TILDE ABOVE
    new NameId(ds("smid"), 0x02223),  // DIVIDES
    new NameId(ds("smile"), 0x02323),  // SMILE
    new NameId(ds("smt"), 0x02AAA),  // SMALLER THAN
    new NameId(ds("smte"), 0x02AAC),  // SMALLER THAN OR EQUAL TO
    new NameId(ds("smtes"), 0x02AAC, 0x0FE00),  // SMALLER THAN OR slanted EQUAL
    new NameId(ds("SOFTcy"), 0x0042C),  // CYRILLIC CAPITAL LETTER SOFT SIGN
    new NameId(ds("softcy"), 0x0044C),  // CYRILLIC SMALL LETTER SOFT SIGN
    new NameId(ds("sol"), 0x0002F),  // SOLIDUS
    new NameId(ds("solb"), 0x029C4),  // SQUARED RISING DIAGONAL SLASH
    new NameId(ds("solbar"), 0x0233F),  // APL FUNCTIONAL SYMBOL SLASH BAR
    new NameId(ds("Sopf"), 0x1D54A),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL S
    new NameId(ds("sopf"), 0x1D564),  // MATHEMATICAL DOUBLE-STRUCK SMALL S
    new NameId(ds("spades"), 0x02660),  // BLACK SPADE SUIT
    new NameId(ds("spadesuit"), 0x02660),  // BLACK SPADE SUIT
    new NameId(ds("spar"), 0x02225),  // PARALLEL TO
    new NameId(ds("sqcap"), 0x02293),  // SQUARE CAP
    new NameId(ds("sqcaps"), 0x02293, 0x0FE00),  // SQUARE CAP with serifs
    new NameId(ds("sqcup"), 0x02294),  // SQUARE CUP
    new NameId(ds("sqcups"), 0x02294, 0x0FE00),  // SQUARE CUP with serifs
    new NameId(ds("Sqrt"), 0x0221A),  // SQUARE ROOT
    new NameId(ds("sqsub"), 0x0228F),  // SQUARE IMAGE OF
    new NameId(ds("sqsube"), 0x02291),  // SQUARE IMAGE OF OR EQUAL TO
    new NameId(ds("sqsubset"), 0x0228F),  // SQUARE IMAGE OF
    new NameId(ds("sqsubseteq"), 0x02291),  // SQUARE IMAGE OF OR EQUAL TO
    new NameId(ds("sqsup"), 0x02290),  // SQUARE ORIGINAL OF
    new NameId(ds("sqsupe"), 0x02292),  // SQUARE ORIGINAL OF OR EQUAL TO
    new NameId(ds("sqsupset"), 0x02290),  // SQUARE ORIGINAL OF
    new NameId(ds("sqsupseteq"), 0x02292),  // SQUARE ORIGINAL OF OR EQUAL TO
    new NameId(ds("squ"), 0x025A1),  // WHITE SQUARE
    new NameId(ds("square"), 0x025A1),  // WHITE SQUARE
    new NameId(ds("Square"), 0x025A1),  // WHITE SQUARE
    new NameId(ds("SquareIntersection"), 0x02293),  // SQUARE CAP
    new NameId(ds("SquareSubset"), 0x0228F),  // SQUARE IMAGE OF
    new NameId(ds("SquareSubsetEqual"), 0x02291),  // SQUARE IMAGE OF OR EQUAL TO
    new NameId(ds("SquareSuperset"), 0x02290),  // SQUARE ORIGINAL OF
    new NameId(ds("SquareSupersetEqual"), 0x02292),  // SQUARE ORIGINAL OF OR EQUAL TO
    new NameId(ds("SquareUnion"), 0x02294),  // SQUARE CUP
    new NameId(ds("squarf"), 0x025AA),  // BLACK SMALL SQUARE
    new NameId(ds("squf"), 0x025AA),  // BLACK SMALL SQUARE
    new NameId(ds("srarr"), 0x02192),  // RIGHTWARDS ARROW
    new NameId(ds("Sscr"), 0x1D4AE),  // MATHEMATICAL SCRIPT CAPITAL S
    new NameId(ds("sscr"), 0x1D4C8),  // MATHEMATICAL SCRIPT SMALL S
    new NameId(ds("ssetmn"), 0x02216),  // SET MINUS
    new NameId(ds("ssmile"), 0x02323),  // SMILE
    new NameId(ds("sstarf"), 0x022C6),  // STAR OPERATOR
    new NameId(ds("Star"), 0x022C6),  // STAR OPERATOR
    new NameId(ds("star"), 0x02606),  // WHITE STAR
    new NameId(ds("starf"), 0x02605),  // BLACK STAR
    new NameId(ds("straightepsilon"), 0x003F5),  // GREEK LUNATE EPSILON SYMBOL
    new NameId(ds("straightphi"), 0x003D5),  // GREEK PHI SYMBOL
    new NameId(ds("strns"), 0x000AF),  // MACRON
    new NameId(ds("sub"), 0x02282),  // SUBSET OF
    new NameId(ds("Sub"), 0x022D0),  // DOUBLE SUBSET
    new NameId(ds("subdot"), 0x02ABD),  // SUBSET WITH DOT
    new NameId(ds("sube"), 0x02286),  // SUBSET OF OR EQUAL TO
    new NameId(ds("subE"), 0x02AC5),  // SUBSET OF ABOVE EQUALS SIGN
    new NameId(ds("subedot"), 0x02AC3),  // SUBSET OF OR EQUAL TO WITH DOT ABOVE
    new NameId(ds("submult"), 0x02AC1),  // SUBSET WITH MULTIPLICATION SIGN BELOW
    new NameId(ds("subne"), 0x0228A),  // SUBSET OF WITH NOT EQUAL TO
    new NameId(ds("subnE"), 0x02ACB),  // SUBSET OF ABOVE NOT EQUAL TO
    new NameId(ds("subplus"), 0x02ABF),  // SUBSET WITH PLUS SIGN BELOW
    new NameId(ds("subrarr"), 0x02979),  // SUBSET ABOVE RIGHTWARDS ARROW
    new NameId(ds("subset"), 0x02282),  // SUBSET OF
    new NameId(ds("Subset"), 0x022D0),  // DOUBLE SUBSET
    new NameId(ds("subseteq"), 0x02286),  // SUBSET OF OR EQUAL TO
    new NameId(ds("subseteqq"), 0x02AC5),  // SUBSET OF ABOVE EQUALS SIGN
    new NameId(ds("SubsetEqual"), 0x02286),  // SUBSET OF OR EQUAL TO
    new NameId(ds("subsetneq"), 0x0228A),  // SUBSET OF WITH NOT EQUAL TO
    new NameId(ds("subsetneqq"), 0x02ACB),  // SUBSET OF ABOVE NOT EQUAL TO
    new NameId(ds("subsim"), 0x02AC7),  // SUBSET OF ABOVE TILDE OPERATOR
    new NameId(ds("subsub"), 0x02AD5),  // SUBSET ABOVE SUBSET
    new NameId(ds("subsup"), 0x02AD3),  // SUBSET ABOVE SUPERSET
    new NameId(ds("succ"), 0x0227B),  // SUCCEEDS
    new NameId(ds("succapprox"), 0x02AB8),  // SUCCEEDS ABOVE ALMOST EQUAL TO
    new NameId(ds("succcurlyeq"), 0x0227D),  // SUCCEEDS OR EQUAL TO
    new NameId(ds("Succeeds"), 0x0227B),  // SUCCEEDS
    new NameId(ds("SucceedsEqual"), 0x02AB0),  // SUCCEEDS ABOVE SINGLE-LINE EQUALS SIGN
    new NameId(ds("SucceedsSlantEqual"), 0x0227D),  // SUCCEEDS OR EQUAL TO
    new NameId(ds("SucceedsTilde"), 0x0227F),  // SUCCEEDS OR EQUIVALENT TO
    new NameId(ds("succeq"), 0x02AB0),  // SUCCEEDS ABOVE SINGLE-LINE EQUALS SIGN
    new NameId(ds("succnapprox"), 0x02ABA),  // SUCCEEDS ABOVE NOT ALMOST EQUAL TO
    new NameId(ds("succneqq"), 0x02AB6),  // SUCCEEDS ABOVE NOT EQUAL TO
    new NameId(ds("succnsim"), 0x022E9),  // SUCCEEDS BUT NOT EQUIVALENT TO
    new NameId(ds("succsim"), 0x0227F),  // SUCCEEDS OR EQUIVALENT TO
    new NameId(ds("SuchThat"), 0x0220B),  // CONTAINS AS MEMBER
    new NameId(ds("sum"), 0x02211),  // N-ARY SUMMATION
    new NameId(ds("Sum"), 0x02211),  // N-ARY SUMMATION
    new NameId(ds("sung"), 0x0266A),  // EIGHTH NOTE
    new NameId(ds("sup"), 0x02283),  // SUPERSET OF
    new NameId(ds("Sup"), 0x022D1),  // DOUBLE SUPERSET
    new NameId(ds("sup1"), 0x000B9),  // SUPERSCRIPT ONE
    new NameId(ds("sup2"), 0x000B2),  // SUPERSCRIPT TWO
    new NameId(ds("sup3"), 0x000B3),  // SUPERSCRIPT THREE
    new NameId(ds("supdot"), 0x02ABE),  // SUPERSET WITH DOT
    new NameId(ds("supdsub"), 0x02AD8),  // SUPERSET BESIDE AND JOINED BY DASH WITH SUBSET
    new NameId(ds("supe"), 0x02287),  // SUPERSET OF OR EQUAL TO
    new NameId(ds("supE"), 0x02AC6),  // SUPERSET OF ABOVE EQUALS SIGN
    new NameId(ds("supedot"), 0x02AC4),  // SUPERSET OF OR EQUAL TO WITH DOT ABOVE
    new NameId(ds("Superset"), 0x02283),  // SUPERSET OF
    new NameId(ds("SupersetEqual"), 0x02287),  // SUPERSET OF OR EQUAL TO
    new NameId(ds("suphsol"), 0x027C9),  // SUPERSET PRECEDING SOLIDUS
    new NameId(ds("suphsub"), 0x02AD7),  // SUPERSET BESIDE SUBSET
    new NameId(ds("suplarr"), 0x0297B),  // SUPERSET ABOVE LEFTWARDS ARROW
    new NameId(ds("supmult"), 0x02AC2),  // SUPERSET WITH MULTIPLICATION SIGN BELOW
    new NameId(ds("supne"), 0x0228B),  // SUPERSET OF WITH NOT EQUAL TO
    new NameId(ds("supnE"), 0x02ACC),  // SUPERSET OF ABOVE NOT EQUAL TO
    new NameId(ds("supplus"), 0x02AC0),  // SUPERSET WITH PLUS SIGN BELOW
    new NameId(ds("supset"), 0x02283),  // SUPERSET OF
    new NameId(ds("Supset"), 0x022D1),  // DOUBLE SUPERSET
    new NameId(ds("supseteq"), 0x02287),  // SUPERSET OF OR EQUAL TO
    new NameId(ds("supseteqq"), 0x02AC6),  // SUPERSET OF ABOVE EQUALS SIGN
    new NameId(ds("supsetneq"), 0x0228B),  // SUPERSET OF WITH NOT EQUAL TO
    new NameId(ds("supsetneqq"), 0x02ACC),  // SUPERSET OF ABOVE NOT EQUAL TO
    new NameId(ds("supsim"), 0x02AC8),  // SUPERSET OF ABOVE TILDE OPERATOR
    new NameId(ds("supsub"), 0x02AD4),  // SUPERSET ABOVE SUBSET
    new NameId(ds("supsup"), 0x02AD6),  // SUPERSET ABOVE SUPERSET
    new NameId(ds("swarhk"), 0x02926),  // SOUTH WEST ARROW WITH HOOK
    new NameId(ds("swarr"), 0x02199),  // SOUTH WEST ARROW
    new NameId(ds("swArr"), 0x021D9),  // SOUTH WEST DOUBLE ARROW
    new NameId(ds("swarrow"), 0x02199),  // SOUTH WEST ARROW
    new NameId(ds("swnwar"), 0x0292A),  // SOUTH WEST ARROW AND NORTH WEST ARROW
    new NameId(ds("szlig"), 0x000DF),  // LATIN SMALL LETTER SHARP S
];

const namesT: readonly NameId[] = [
    new NameId(ds("Tab"), 0x00009),  // CHARACTER TABULATION
    new NameId(ds("target"), 0x02316),  // POSITION INDICATOR
    new NameId(ds("Tau"), 0x003A4),  // GREEK CAPITAL LETTER TAU
    new NameId(ds("tau"), 0x003C4),  // GREEK SMALL LETTER TAU
    new NameId(ds("tbrk"), 0x023B4),  // TOP SQUARE BRACKET
    new NameId(ds("Tcaron"), 0x00164),  // LATIN CAPITAL LETTER T WITH CARON
    new NameId(ds("tcaron"), 0x00165),  // LATIN SMALL LETTER T WITH CARON
    new NameId(ds("Tcedil"), 0x00162),  // LATIN CAPITAL LETTER T WITH CEDILLA
    new NameId(ds("tcedil"), 0x00163),  // LATIN SMALL LETTER T WITH CEDILLA
    new NameId(ds("Tcy"), 0x00422),  // CYRILLIC CAPITAL LETTER TE
    new NameId(ds("tcy"), 0x00442),  // CYRILLIC SMALL LETTER TE
    new NameId(ds("tdot"), 0x020DB),  // COMBINING THREE DOTS ABOVE
    new NameId(ds("telrec"), 0x02315),  // TELEPHONE RECORDER
    new NameId(ds("Tfr"), 0x1D517),  // MATHEMATICAL FRAKTUR CAPITAL T
    new NameId(ds("tfr"), 0x1D531),  // MATHEMATICAL FRAKTUR SMALL T
    new NameId(ds("Tgr"), 0x003A4),  // GREEK CAPITAL LETTER TAU
    new NameId(ds("tgr"), 0x003C4),  // GREEK SMALL LETTER TAU
    new NameId(ds("there4"), 0x02234),  // THEREFORE
    new NameId(ds("therefore"), 0x02234),  // THEREFORE
    new NameId(ds("Therefore"), 0x02234),  // THEREFORE
    new NameId(ds("Theta"), 0x00398),  // GREEK CAPITAL LETTER THETA
    new NameId(ds("theta"), 0x003B8),  // GREEK SMALL LETTER THETA
    new NameId(ds("thetasym"), 0x003D1),  // GREEK THETA SYMBOL
    new NameId(ds("thetav"), 0x003D1),  // GREEK THETA SYMBOL
    new NameId(ds("THgr"), 0x00398),  // GREEK CAPITAL LETTER THETA
    new NameId(ds("thgr"), 0x003B8),  // GREEK SMALL LETTER THETA
    new NameId(ds("thickapprox"), 0x02248),  // ALMOST EQUAL TO
    new NameId(ds("thicksim"), 0x0223C),  // TILDE OPERATOR
    new NameId(ds("ThickSpace"), 0x0205F, 0x0200A),  // space of width 5/18 em
    new NameId(ds("thinsp"), 0x02009),  // THIN SPACE
    new NameId(ds("ThinSpace"), 0x02009),  // THIN SPACE
    new NameId(ds("thkap"), 0x02248),  // ALMOST EQUAL TO
    new NameId(ds("thksim"), 0x0223C),  // TILDE OPERATOR
    new NameId(ds("THORN"), 0x000DE),  // LATIN CAPITAL LETTER THORN
    new NameId(ds("thorn"), 0x000FE),  // LATIN SMALL LETTER THORN
    new NameId(ds("tilde"), 0x002DC),  // SMALL TILDE
    new NameId(ds("Tilde"), 0x0223C),  // TILDE OPERATOR
    new NameId(ds("TildeEqual"), 0x02243),  // ASYMPTOTICALLY EQUAL TO
    new NameId(ds("TildeFullEqual"), 0x02245),  // APPROXIMATELY EQUAL TO
    new NameId(ds("TildeTilde"), 0x02248),  // ALMOST EQUAL TO
    new NameId(ds("times"), 0x000D7),  // MULTIPLICATION SIGN
    new NameId(ds("timesb"), 0x022A0),  // SQUARED TIMES
    new NameId(ds("timesbar"), 0x02A31),  // MULTIPLICATION SIGN WITH UNDERBAR
    new NameId(ds("timesd"), 0x02A30),  // MULTIPLICATION SIGN WITH DOT ABOVE
    new NameId(ds("tint"), 0x0222D),  // TRIPLE INTEGRAL
    new NameId(ds("toea"), 0x02928),  // NORTH EAST ARROW AND SOUTH EAST ARROW
    new NameId(ds("top"), 0x022A4),  // DOWN TACK
    new NameId(ds("topbot"), 0x02336),  // APL FUNCTIONAL SYMBOL I-BEAM
    new NameId(ds("topcir"), 0x02AF1),  // DOWN TACK WITH CIRCLE BELOW
    new NameId(ds("Topf"), 0x1D54B),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL T
    new NameId(ds("topf"), 0x1D565),  // MATHEMATICAL DOUBLE-STRUCK SMALL T
    new NameId(ds("topfork"), 0x02ADA),  // PITCHFORK WITH TEE TOP
    new NameId(ds("tosa"), 0x02929),  // SOUTH EAST ARROW AND SOUTH WEST ARROW
    new NameId(ds("tprime"), 0x02034),  // TRIPLE PRIME
    new NameId(ds("trade"), 0x02122),  // TRADE MARK SIGN
    new NameId(ds("TRADE"), 0x02122),  // TRADE MARK SIGN
    new NameId(ds("triangle"), 0x025B5),  // WHITE UP-POINTING SMALL TRIANGLE
    new NameId(ds("triangledown"), 0x025BF),  // WHITE DOWN-POINTING SMALL TRIANGLE
    new NameId(ds("triangleleft"), 0x025C3),  // WHITE LEFT-POINTING SMALL TRIANGLE
    new NameId(ds("trianglelefteq"), 0x022B4),  // NORMAL SUBGROUP OF OR EQUAL TO
    new NameId(ds("triangleq"), 0x0225C),  // DELTA EQUAL TO
    new NameId(ds("triangleright"), 0x025B9),  // WHITE RIGHT-POINTING SMALL TRIANGLE
    new NameId(ds("trianglerighteq"), 0x022B5),  // CONTAINS AS NORMAL SUBGROUP OR EQUAL TO
    new NameId(ds("tridot"), 0x025EC),  // WHITE UP-POINTING TRIANGLE WITH DOT
    new NameId(ds("trie"), 0x0225C),  // DELTA EQUAL TO
    new NameId(ds("triminus"), 0x02A3A),  // MINUS SIGN IN TRIANGLE
    new NameId(ds("TripleDot"), 0x020DB),  // COMBINING THREE DOTS ABOVE
    new NameId(ds("triplus"), 0x02A39),  // PLUS SIGN IN TRIANGLE
    new NameId(ds("trisb"), 0x029CD),  // TRIANGLE WITH SERIFS AT BOTTOM
    new NameId(ds("tritime"), 0x02A3B),  // MULTIPLICATION SIGN IN TRIANGLE
    new NameId(ds("trpezium"), 0x023E2),  // WHITE TRAPEZIUM
    new NameId(ds("Tscr"), 0x1D4AF),  // MATHEMATICAL SCRIPT CAPITAL T
    new NameId(ds("tscr"), 0x1D4C9),  // MATHEMATICAL SCRIPT SMALL T
    new NameId(ds("TScy"), 0x00426),  // CYRILLIC CAPITAL LETTER TSE
    new NameId(ds("tscy"), 0x00446),  // CYRILLIC SMALL LETTER TSE
    new NameId(ds("TSHcy"), 0x0040B),  // CYRILLIC CAPITAL LETTER TSHE
    new NameId(ds("tshcy"), 0x0045B),  // CYRILLIC SMALL LETTER TSHE
    new NameId(ds("Tstrok"), 0x00166),  // LATIN CAPITAL LETTER T WITH STROKE
    new NameId(ds("tstrok"), 0x00167),  // LATIN SMALL LETTER T WITH STROKE
    new NameId(ds("twixt"), 0x0226C),  // BETWEEN
    new NameId(ds("twoheadleftarrow"), 0x0219E),  // LEFTWARDS TWO HEADED ARROW
    new NameId(ds("twoheadrightarrow"), 0x021A0),  // RIGHTWARDS TWO HEADED ARROW
];

const namesU: readonly NameId[] = [
    new NameId(ds("Uacgr"), 0x0038E),  // GREEK CAPITAL LETTER UPSILON WITH TONOS
    new NameId(ds("uacgr"), 0x003CD),  // GREEK SMALL LETTER UPSILON WITH TONOS
    new NameId(ds("Uacute"), 0x000DA),  // LATIN CAPITAL LETTER U WITH ACUTE
    new NameId(ds("uacute"), 0x000FA),  // LATIN SMALL LETTER U WITH ACUTE
    new NameId(ds("uarr"), 0x02191),  // UPWARDS ARROW
    new NameId(ds("Uarr"), 0x0219F),  // UPWARDS TWO HEADED ARROW
    new NameId(ds("uArr"), 0x021D1),  // UPWARDS DOUBLE ARROW
    new NameId(ds("Uarrocir"), 0x02949),  // UPWARDS TWO-HEADED ARROW FROM SMALL CIRCLE
    new NameId(ds("Ubrcy"), 0x0040E),  // CYRILLIC CAPITAL LETTER SHORT U
    new NameId(ds("ubrcy"), 0x0045E),  // CYRILLIC SMALL LETTER SHORT U
    new NameId(ds("Ubreve"), 0x0016C),  // LATIN CAPITAL LETTER U WITH BREVE
    new NameId(ds("ubreve"), 0x0016D),  // LATIN SMALL LETTER U WITH BREVE
    new NameId(ds("Ucirc"), 0x000DB),  // LATIN CAPITAL LETTER U WITH CIRCUMFLEX
    new NameId(ds("ucirc"), 0x000FB),  // LATIN SMALL LETTER U WITH CIRCUMFLEX
    new NameId(ds("Ucy"), 0x00423),  // CYRILLIC CAPITAL LETTER U
    new NameId(ds("ucy"), 0x00443),  // CYRILLIC SMALL LETTER U
    new NameId(ds("udarr"), 0x021C5),  // UPWARDS ARROW LEFTWARDS OF DOWNWARDS ARROW
    new NameId(ds("Udblac"), 0x00170),  // LATIN CAPITAL LETTER U WITH DOUBLE ACUTE
    new NameId(ds("udblac"), 0x00171),  // LATIN SMALL LETTER U WITH DOUBLE ACUTE
    new NameId(ds("udhar"), 0x0296E),  // UPWARDS HARPOON WITH BARB LEFT BESIDE DOWNWARDS HARPOON WITH BARB RIGHT
    new NameId(ds("udiagr"), 0x003B0),  // GREEK SMALL LETTER UPSILON WITH DIALYTIKA AND TONOS
    new NameId(ds("Udigr"), 0x003AB),  // GREEK CAPITAL LETTER UPSILON WITH DIALYTIKA
    new NameId(ds("udigr"), 0x003CB),  // GREEK SMALL LETTER UPSILON WITH DIALYTIKA
    new NameId(ds("ufisht"), 0x0297E),  // UP FISH TAIL
    new NameId(ds("Ufr"), 0x1D518),  // MATHEMATICAL FRAKTUR CAPITAL U
    new NameId(ds("ufr"), 0x1D532),  // MATHEMATICAL FRAKTUR SMALL U
    new NameId(ds("Ugr"), 0x003A5),  // GREEK CAPITAL LETTER UPSILON
    new NameId(ds("ugr"), 0x003C5),  // GREEK SMALL LETTER UPSILON
    new NameId(ds("Ugrave"), 0x000D9),  // LATIN CAPITAL LETTER U WITH GRAVE
    new NameId(ds("ugrave"), 0x000F9),  // LATIN SMALL LETTER U WITH GRAVE
    new NameId(ds("uHar"), 0x02963),  // UPWARDS HARPOON WITH BARB LEFT BESIDE UPWARDS HARPOON WITH BARB RIGHT
    new NameId(ds("uharl"), 0x021BF),  // UPWARDS HARPOON WITH BARB LEFTWARDS
    new NameId(ds("uharr"), 0x021BE),  // UPWARDS HARPOON WITH BARB RIGHTWARDS
    new NameId(ds("uhblk"), 0x02580),  // UPPER HALF BLOCK
    new NameId(ds("ulcorn"), 0x0231C),  // TOP LEFT CORNER
    new NameId(ds("ulcorner"), 0x0231C),  // TOP LEFT CORNER
    new NameId(ds("ulcrop"), 0x0230F),  // TOP LEFT CROP
    new NameId(ds("ultri"), 0x025F8),  // UPPER LEFT TRIANGLE
    new NameId(ds("Umacr"), 0x0016A),  // LATIN CAPITAL LETTER U WITH MACRON
    new NameId(ds("umacr"), 0x0016B),  // LATIN SMALL LETTER U WITH MACRON
    new NameId(ds("uml"), 0x000A8),  // DIAERESIS
    new NameId(ds("UnderBar"), 0x0005F),  // LOW LINE
    new NameId(ds("UnderBrace"), 0x023DF),  // BOTTOM CURLY BRACKET
    new NameId(ds("UnderBracket"), 0x023B5),  // BOTTOM SQUARE BRACKET
    new NameId(ds("UnderParenthesis"), 0x023DD),  // BOTTOM PARENTHESIS
    new NameId(ds("Union"), 0x022C3),  // N-ARY UNION
    new NameId(ds("UnionPlus"), 0x0228E),  // MULTISET UNION
    new NameId(ds("Uogon"), 0x00172),  // LATIN CAPITAL LETTER U WITH OGONEK
    new NameId(ds("uogon"), 0x00173),  // LATIN SMALL LETTER U WITH OGONEK
    new NameId(ds("Uopf"), 0x1D54C),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL U
    new NameId(ds("uopf"), 0x1D566),  // MATHEMATICAL DOUBLE-STRUCK SMALL U
    new NameId(ds("uparrow"), 0x02191),  // UPWARDS ARROW
    new NameId(ds("UpArrow"), 0x02191),  // UPWARDS ARROW
    new NameId(ds("Uparrow"), 0x021D1),  // UPWARDS DOUBLE ARROW
    new NameId(ds("UpArrowBar"), 0x02912),  // UPWARDS ARROW TO BAR
    new NameId(ds("UpArrowDownArrow"), 0x021C5),  // UPWARDS ARROW LEFTWARDS OF DOWNWARDS ARROW
    new NameId(ds("updownarrow"), 0x02195),  // UP DOWN ARROW
    new NameId(ds("UpDownArrow"), 0x02195),  // UP DOWN ARROW
    new NameId(ds("Updownarrow"), 0x021D5),  // UP DOWN DOUBLE ARROW
    new NameId(ds("UpEquilibrium"), 0x0296E),  // UPWARDS HARPOON WITH BARB LEFT BESIDE DOWNWARDS HARPOON WITH BARB RIGHT
    new NameId(ds("upharpoonleft"), 0x021BF),  // UPWARDS HARPOON WITH BARB LEFTWARDS
    new NameId(ds("upharpoonright"), 0x021BE),  // UPWARDS HARPOON WITH BARB RIGHTWARDS
    new NameId(ds("uplus"), 0x0228E),  // MULTISET UNION
    new NameId(ds("UpperLeftArrow"), 0x02196),  // NORTH WEST ARROW
    new NameId(ds("UpperRightArrow"), 0x02197),  // NORTH EAST ARROW
    new NameId(ds("upsi"), 0x003C5),  // GREEK SMALL LETTER UPSILON
    new NameId(ds("Upsi"), 0x003D2),  // GREEK UPSILON WITH HOOK SYMBOL
    new NameId(ds("upsih"), 0x003D2),  // GREEK UPSILON WITH HOOK SYMBOL
    new NameId(ds("Upsilon"), 0x003A5),  // GREEK CAPITAL LETTER UPSILON
    new NameId(ds("upsilon"), 0x003C5),  // GREEK SMALL LETTER UPSILON
    new NameId(ds("UpTee"), 0x022A5),  // UP TACK
    new NameId(ds("UpTeeArrow"), 0x021A5),  // UPWARDS ARROW FROM BAR
    new NameId(ds("upuparrows"), 0x021C8),  // UPWARDS PAIRED ARROWS
    new NameId(ds("urcorn"), 0x0231D),  // TOP RIGHT CORNER
    new NameId(ds("urcorner"), 0x0231D),  // TOP RIGHT CORNER
    new NameId(ds("urcrop"), 0x0230E),  // TOP RIGHT CROP
    new NameId(ds("Uring"), 0x0016E),  // LATIN CAPITAL LETTER U WITH RING ABOVE
    new NameId(ds("uring"), 0x0016F),  // LATIN SMALL LETTER U WITH RING ABOVE
    new NameId(ds("urtri"), 0x025F9),  // UPPER RIGHT TRIANGLE
    new NameId(ds("Uscr"), 0x1D4B0),  // MATHEMATICAL SCRIPT CAPITAL U
    new NameId(ds("uscr"), 0x1D4CA),  // MATHEMATICAL SCRIPT SMALL U
    new NameId(ds("utdot"), 0x022F0),  // UP RIGHT DIAGONAL ELLIPSIS
    new NameId(ds("Utilde"), 0x00168),  // LATIN CAPITAL LETTER U WITH TILDE
    new NameId(ds("utilde"), 0x00169),  // LATIN SMALL LETTER U WITH TILDE
    new NameId(ds("utri"), 0x025B5),  // WHITE UP-POINTING SMALL TRIANGLE
    new NameId(ds("utrif"), 0x025B4),  // BLACK UP-POINTING SMALL TRIANGLE
    new NameId(ds("uuarr"), 0x021C8),  // UPWARDS PAIRED ARROWS
    new NameId(ds("Uuml"), 0x000DC),  // LATIN CAPITAL LETTER U WITH DIAERESIS
    new NameId(ds("uuml"), 0x000FC),  // LATIN SMALL LETTER U WITH DIAERESIS
    new NameId(ds("uwangle"), 0x029A7),  // OBLIQUE ANGLE OPENING DOWN
];

const namesV: readonly NameId[] = [
    new NameId(ds("vangrt"), 0x0299C),  // RIGHT ANGLE VARIANT WITH SQUARE
    new NameId(ds("varepsilon"), 0x003F5),  // GREEK LUNATE EPSILON SYMBOL
    new NameId(ds("varkappa"), 0x003F0),  // GREEK KAPPA SYMBOL
    new NameId(ds("varnothing"), 0x02205),  // EMPTY SET
    new NameId(ds("varphi"), 0x003D5),  // GREEK PHI SYMBOL
    new NameId(ds("varpi"), 0x003D6),  // GREEK PI SYMBOL
    new NameId(ds("varpropto"), 0x0221D),  // PROPORTIONAL TO
    new NameId(ds("varr"), 0x02195),  // UP DOWN ARROW
    new NameId(ds("vArr"), 0x021D5),  // UP DOWN DOUBLE ARROW
    new NameId(ds("varrho"), 0x003F1),  // GREEK RHO SYMBOL
    new NameId(ds("varsigma"), 0x003C2),  // GREEK SMALL LETTER FINAL SIGMA
    new NameId(ds("varsubsetneq"), 0x0228A, 0x0FE00),  // SUBSET OF WITH NOT EQUAL TO - variant with stroke through bottom members
    new NameId(ds("varsubsetneqq"), 0x02ACB, 0x0FE00),  // SUBSET OF ABOVE NOT EQUAL TO - variant with stroke through bottom members
    new NameId(ds("varsupsetneq"), 0x0228B, 0x0FE00),  // SUPERSET OF WITH NOT EQUAL TO - variant with stroke through bottom members
    new NameId(ds("varsupsetneqq"), 0x02ACC, 0x0FE00),  // SUPERSET OF ABOVE NOT EQUAL TO - variant with stroke through bottom members
    new NameId(ds("vartheta"), 0x003D1),  // GREEK THETA SYMBOL
    new NameId(ds("vartriangleleft"), 0x022B2),  // NORMAL SUBGROUP OF
    new NameId(ds("vartriangleright"), 0x022B3),  // CONTAINS AS NORMAL SUBGROUP
    new NameId(ds("vBar"), 0x02AE8),  // SHORT UP TACK WITH UNDERBAR
    new NameId(ds("Vbar"), 0x02AEB),  // DOUBLE UP TACK
    new NameId(ds("vBarv"), 0x02AE9),  // SHORT UP TACK ABOVE SHORT DOWN TACK
    new NameId(ds("Vcy"), 0x00412),  // CYRILLIC CAPITAL LETTER VE
    new NameId(ds("vcy"), 0x00432),  // CYRILLIC SMALL LETTER VE
    new NameId(ds("vdash"), 0x022A2),  // RIGHT TACK
    new NameId(ds("vDash"), 0x022A8),  // TRUE
    new NameId(ds("Vdash"), 0x022A9),  // FORCES
    new NameId(ds("VDash"), 0x022AB),  // DOUBLE VERTICAL BAR DOUBLE RIGHT TURNSTILE
    new NameId(ds("Vdashl"), 0x02AE6),  // LONG DASH FROM LEFT MEMBER OF DOUBLE VERTICAL
    new NameId(ds("vee"), 0x02228),  // LOGICAL OR
    new NameId(ds("Vee"), 0x022C1),  // N-ARY LOGICAL OR
    new NameId(ds("veebar"), 0x022BB),  // XOR
    new NameId(ds("veeeq"), 0x0225A),  // EQUIANGULAR TO
    new NameId(ds("vellip"), 0x022EE),  // VERTICAL ELLIPSIS
    new NameId(ds("verbar"), 0x0007C),  // VERTICAL LINE
    new NameId(ds("Verbar"), 0x02017),  // DOUBLE VERTICAL LINE
    new NameId(ds("vert"), 0x0007C),  // VERTICAL LINE
    new NameId(ds("Vert"), 0x02017),  // DOUBLE VERTICAL LINE
    new NameId(ds("VerticalBar"), 0x02223),  // DIVIDES
    new NameId(ds("VerticalLine"), 0x0007C),  // VERTICAL LINE
    new NameId(ds("VerticalSeparator"), 0x02758),  // LIGHT VERTICAL BAR
    new NameId(ds("VerticalTilde"), 0x02240),  // WREATH PRODUCT
    new NameId(ds("VeryThinSpace"), 0x0200A),  // HAIR SPACE
    new NameId(ds("Vfr"), 0x1D519),  // MATHEMATICAL FRAKTUR CAPITAL V
    new NameId(ds("vfr"), 0x1D533),  // MATHEMATICAL FRAKTUR SMALL V
    new NameId(ds("vltri"), 0x022B2),  // NORMAL SUBGROUP OF
    new NameId(ds("vnsub"), 0x02282, 0x020D2),  // SUBSET OF with vertical line
    new NameId(ds("vnsup"), 0x02283, 0x020D2),  // SUPERSET OF with vertical line
    new NameId(ds("Vopf"), 0x1D54D),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL V
    new NameId(ds("vopf"), 0x1D567),  // MATHEMATICAL DOUBLE-STRUCK SMALL V
    new NameId(ds("vprop"), 0x0221D),  // PROPORTIONAL TO
    new NameId(ds("vrtri"), 0x022B3),  // CONTAINS AS NORMAL SUBGROUP
    new NameId(ds("Vscr"), 0x1D4B1),  // MATHEMATICAL SCRIPT CAPITAL V
    new NameId(ds("vscr"), 0x1D4CB),  // MATHEMATICAL SCRIPT SMALL V
    new NameId(ds("vsubne"), 0x0228A, 0x0FE00),  // SUBSET OF WITH NOT EQUAL TO - variant with stroke through bottom members
    new NameId(ds("vsubnE"), 0x02ACB, 0x0FE00),  // SUBSET OF ABOVE NOT EQUAL TO - variant with stroke through bottom members
    new NameId(ds("vsupne"), 0x0228B, 0x0FE00),  // SUPERSET OF WITH NOT EQUAL TO - variant with stroke through bottom members
    new NameId(ds("vsupnE"), 0x02ACC, 0x0FE00),  // SUPERSET OF ABOVE NOT EQUAL TO - variant with stroke through bottom members
    new NameId(ds("Vvdash"), 0x022AA),  // TRIPLE VERTICAL BAR RIGHT TURNSTILE
    new NameId(ds("vzigzag"), 0x0299A),  // VERTICAL ZIGZAG LINE
];

const namesW: readonly NameId[] = [
    new NameId(ds("Wcirc"), 0x00174),  // LATIN CAPITAL LETTER W WITH CIRCUMFLEX
    new NameId(ds("wcirc"), 0x00175),  // LATIN SMALL LETTER W WITH CIRCUMFLEX
    new NameId(ds("wedbar"), 0x02A5F),  // LOGICAL AND WITH UNDERBAR
    new NameId(ds("wedge"), 0x02227),  // LOGICAL AND
    new NameId(ds("Wedge"), 0x022C0),  // N-ARY LOGICAL AND
    new NameId(ds("wedgeq"), 0x02259),  // ESTIMATES
    new NameId(ds("weierp"), 0x02118),  // SCRIPT CAPITAL P
    new NameId(ds("Wfr"), 0x1D51A),  // MATHEMATICAL FRAKTUR CAPITAL W
    new NameId(ds("wfr"), 0x1D534),  // MATHEMATICAL FRAKTUR SMALL W
    new NameId(ds("Wopf"), 0x1D54E),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL W
    new NameId(ds("wopf"), 0x1D568),  // MATHEMATICAL DOUBLE-STRUCK SMALL W
    new NameId(ds("wp"), 0x02118),  // SCRIPT CAPITAL P
    new NameId(ds("wr"), 0x02240),  // WREATH PRODUCT
    new NameId(ds("wreath"), 0x02240),  // WREATH PRODUCT
    new NameId(ds("Wscr"), 0x1D4B2),  // MATHEMATICAL SCRIPT CAPITAL W
    new NameId(ds("wscr"), 0x1D4CC),  // MATHEMATICAL SCRIPT SMALL W
];

const namesX: readonly NameId[] = [
    new NameId(ds("xcap"), 0x022C2),  // N-ARY INTERSECTION
    new NameId(ds("xcirc"), 0x025EF),  // LARGE CIRCLE
    new NameId(ds("xcup"), 0x022C3),  // N-ARY UNION
    new NameId(ds("xdtri"), 0x025BD),  // WHITE DOWN-POINTING TRIANGLE
    new NameId(ds("Xfr"), 0x1D51B),  // MATHEMATICAL FRAKTUR CAPITAL X
    new NameId(ds("xfr"), 0x1D535),  // MATHEMATICAL FRAKTUR SMALL X
    new NameId(ds("Xgr"), 0x0039E),  // GREEK CAPITAL LETTER XI
    new NameId(ds("xgr"), 0x003BE),  // GREEK SMALL LETTER XI
    new NameId(ds("xharr"), 0x027F7),  // LONG LEFT RIGHT ARROW
    new NameId(ds("xhArr"), 0x027FA),  // LONG LEFT RIGHT DOUBLE ARROW
    new NameId(ds("Xi"), 0x0039E),  // GREEK CAPITAL LETTER XI
    new NameId(ds("xi"), 0x003BE),  // GREEK SMALL LETTER XI
    new NameId(ds("xlarr"), 0x027F5),  // LONG LEFTWARDS ARROW
    new NameId(ds("xlArr"), 0x027F8),  // LONG LEFTWARDS DOUBLE ARROW
    new NameId(ds("xmap"), 0x027FC),  // LONG RIGHTWARDS ARROW FROM BAR
    new NameId(ds("xnis"), 0x022FB),  // CONTAINS WITH VERTICAL BAR AT END OF HORIZONTAL STROKE
    new NameId(ds("xodot"), 0x02A00),  // N-ARY CIRCLED DOT OPERATOR
    new NameId(ds("Xopf"), 0x1D54F),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL X
    new NameId(ds("xopf"), 0x1D569),  // MATHEMATICAL DOUBLE-STRUCK SMALL X
    new NameId(ds("xoplus"), 0x02A01),  // N-ARY CIRCLED PLUS OPERATOR
    new NameId(ds("xotime"), 0x02A02),  // N-ARY CIRCLED TIMES OPERATOR
    new NameId(ds("xrarr"), 0x027F6),  // LONG RIGHTWARDS ARROW
    new NameId(ds("xrArr"), 0x027F9),  // LONG RIGHTWARDS DOUBLE ARROW
    new NameId(ds("Xscr"), 0x1D4B3),  // MATHEMATICAL SCRIPT CAPITAL X
    new NameId(ds("xscr"), 0x1D4CD),  // MATHEMATICAL SCRIPT SMALL X
    new NameId(ds("xsqcup"), 0x02A06),  // N-ARY SQUARE UNION OPERATOR
    new NameId(ds("xuplus"), 0x02A04),  // N-ARY UNION OPERATOR WITH PLUS
    new NameId(ds("xutri"), 0x025B3),  // WHITE UP-POINTING TRIANGLE
    new NameId(ds("xvee"), 0x022C1),  // N-ARY LOGICAL OR
    new NameId(ds("xwedge"), 0x022C0),  // N-ARY LOGICAL AND
];

const namesY: readonly NameId[] = [
    new NameId(ds("Yacute"), 0x000DD),  // LATIN CAPITAL LETTER Y WITH ACUTE
    new NameId(ds("yacute"), 0x000FD),  // LATIN SMALL LETTER Y WITH ACUTE
    new NameId(ds("YAcy"), 0x0042F),  // CYRILLIC CAPITAL LETTER YA
    new NameId(ds("yacy"), 0x0044F),  // CYRILLIC SMALL LETTER YA
    new NameId(ds("Ycirc"), 0x00176),  // LATIN CAPITAL LETTER Y WITH CIRCUMFLEX
    new NameId(ds("ycirc"), 0x00177),  // LATIN SMALL LETTER Y WITH CIRCUMFLEX
    new NameId(ds("Ycy"), 0x0042B),  // CYRILLIC CAPITAL LETTER YERU
    new NameId(ds("ycy"), 0x0044B),  // CYRILLIC SMALL LETTER YERU
    new NameId(ds("yen"), 0x000A5),  // YEN SIGN
    new NameId(ds("Yfr"), 0x1D51C),  // MATHEMATICAL FRAKTUR CAPITAL Y
    new NameId(ds("yfr"), 0x1D536),  // MATHEMATICAL FRAKTUR SMALL Y
    new NameId(ds("YIcy"), 0x00407),  // CYRILLIC CAPITAL LETTER YI
    new NameId(ds("yicy"), 0x00457),  // CYRILLIC SMALL LETTER YI
    new NameId(ds("Yopf"), 0x1D550),  // MATHEMATICAL DOUBLE-STRUCK CAPITAL Y
    new NameId(ds("yopf"), 0x1D56A),  // MATHEMATICAL DOUBLE-STRUCK SMALL Y
    new NameId(ds("Yscr"), 0x1D4B4),  // MATHEMATICAL SCRIPT CAPITAL Y
    new NameId(ds("yscr"), 0x1D4CE),  // MATHEMATICAL SCRIPT SMALL Y
    new NameId(ds("YUcy"), 0x0042E),  // CYRILLIC CAPITAL LETTER YU
    new NameId(ds("yucy"), 0x0044E),  // CYRILLIC SMALL LETTER YU
    new NameId(ds("yuml"), 0x000FF),  // LATIN SMALL LETTER Y WITH DIAERESIS
    new NameId(ds("Yuml"), 0x00178),  // LATIN CAPITAL LETTER Y WITH DIAERESIS
];

const namesZ: readonly NameId[] = [
    new NameId(ds("Zacute"), 0x00179),  // LATIN CAPITAL LETTER Z WITH ACUTE
    new NameId(ds("zacute"), 0x0017A),  // LATIN SMALL LETTER Z WITH ACUTE
    new NameId(ds("Zcaron"), 0x0017D),  // LATIN CAPITAL LETTER Z WITH CARON
    new NameId(ds("zcaron"), 0x0017E),  // LATIN SMALL LETTER Z WITH CARON
    new NameId(ds("Zcy"), 0x00417),  // CYRILLIC CAPITAL LETTER ZE
    new NameId(ds("zcy"), 0x00437),  // CYRILLIC SMALL LETTER ZE
    new NameId(ds("Zdot"), 0x0017B),  // LATIN CAPITAL LETTER Z WITH DOT ABOVE
    new NameId(ds("zdot"), 0x0017C),  // LATIN SMALL LETTER Z WITH DOT ABOVE
    new NameId(ds("zeetrf"), 0x02128),  // BLACK-LETTER CAPITAL Z
    new NameId(ds("ZeroWidthSpace"), 0x0200B),  // ZERO WIDTH SPACE
    new NameId(ds("Zeta"), 0x00396),  // GREEK CAPITAL LETTER ZETA
    new NameId(ds("zeta"), 0x003B6),  // GREEK SMALL LETTER ZETA
    new NameId(ds("Zfr"), 0x02128),  // BLACK-LETTER CAPITAL Z
    new NameId(ds("zfr"), 0x1D537),  // MATHEMATICAL FRAKTUR SMALL Z
    new NameId(ds("Zgr"), 0x00396),  // GREEK CAPITAL LETTER ZETA
    new NameId(ds("zgr"), 0x003B6),  // GREEK SMALL LETTER ZETA
    new NameId(ds("ZHcy"), 0x00416),  // CYRILLIC CAPITAL LETTER ZHE
    new NameId(ds("zhcy"), 0x00436),  // CYRILLIC SMALL LETTER ZHE
    new NameId(ds("zigrarr"), 0x021DD),  // RIGHTWARDS SQUIGGLE ARROW
    new NameId(ds("Zopf"), 0x02124),  // DOUBLE-STRUCK CAPITAL Z
    new NameId(ds("zopf"), 0x1D56B),  // MATHEMATICAL DOUBLE-STRUCK SMALL Z
    new NameId(ds("Zscr"), 0x1D4B5),  // MATHEMATICAL SCRIPT CAPITAL Z
    new NameId(ds("zscr"), 0x1D4CF),  // MATHEMATICAL SCRIPT SMALL Z
    new NameId(ds("zwj"), 0x0200D),  // ZERO WIDTH JOINER
    new NameId(ds("zwnj"), 0x0200C),  // ZERO WIDTH NON-JOINER
];
// @todo@ order namesTable and names? by frequency
const namesTable: readonly (readonly NameId[])[] = [
    namesA, namesB, namesC, namesD, namesE, namesF, namesG, namesH, namesI,
    namesJ, namesK, namesL, namesM, namesN, namesO, namesP, namesQ, namesR,
    namesS, namesT, namesU, namesV, namesW, namesX, namesY, namesZ,
];
