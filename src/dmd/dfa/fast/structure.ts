// Ported from dmd/dfa/fast/structure.d (module dmd.dfa.fast.structure).
//
// TRANSLATION DECISIONS (the DFA wave records every struct, allocator and pointer mapping here).
//
// STRUCTS -> CLASSES (03 §0, 02 §10), decided by how the dfa/ modules use each struct:
//   - DFAVar, DFAScopeVar, DFAScope, DFALattice, DFAConsequence, DFAObject, DFALabelState, DFACaseState are
//     allocated from DFAAllocator and handled ONLY through pointers (`DFAVar*`, `DFAScope*`, ...) in every dfa/
//     module: TS class references, aliased wherever D passes the pointer. DFAVar, DFAObject and DFAConsequence
//     export a field-wise copy() (03 §6.3), though no D site copies one by value. DFAScopeVar, DFALabelState,
//     DFACaseState and DFAScope are non-copyable in D: their DFAScopeRef/DFALatticeRef field has a copy
//     constructor taking a mutable ref, so the generated copy constructor is disabled (probed with
//     `__traits(isCopyable)`), and they get no value copy() (03 §6.2). DFAScope and DFALattice keep their D
//     `copy()` as the domain copy (a new scope / lattice), the same name collision as the two handles below.
//   - DFACommon is a stack local of dfaEntry (entry.d:114) reached through `DFACommon*`: class reference.
//     DFAAllocator lives inline in DFACommon and is never copied: class with copy().
//   - DFAScopeVarMergable and DFAPAValue are plain value structs: class + copy() at every D copy point (03 §1);
//     a D whole-value overwrite of `this` or of a `ref` parameter copies the fields INTO the object (03 §1.1).
//   - DFAScopeRef and DFALatticeRef are owning handles: see OWNERSHIP PROTOCOL below.
//
// ALLOCATOR (DFAAllocator, structure.d:933) — KEPT, the ratified dfa exception of 03 §8.1, because its lifetime
// is observable: `free` pushes a node on a per-type free list and the next `make*` of that type hands the
// SAME node out again (a stale pointer then sees the re-initialized node), and only a free-list miss advances
// the region bump pointer, whose value is the node's address. Those addresses are what the DFAVar-keyed hash
// buckets hash and order by (below). So:
//   - free lists hold the JS objects themselves; `resetToInit()` is D's `memcpy(ret, &valInit, T.sizeof)`.
//   - the region bump pointer runs on simulated addresses (`addr`): `T.sizeof` as probed with ldc2 1.43.0
//     (`pragma(msg, T.sizeof)`), the static region at its link address in the ldc2 1.43.0 oracle binary (nm),
//     every later (malloc'd) region above it, in allocation order.
//
// POINTER IDIOMS:
//   - buckets keyed by a DFAVar pointer (DFAScope.buckets, DFALattice.buckets, DFACommon.varPairs) are ported
//     literally over the simulated address (`dfaVarAddress`): a DFAScope's bucket order IS the order its
//     opApply, copy and consumeNext visit the scope variables.
//   - buckets keyed by a GC-allocated AST node (DFACommon.vars / DFAVar.childVars by VarDeclaration,
//     DFACommon.forwardLabels by Identifier, DFACommon.caseEntries by Statement) are a `Map` keyed by the node:
//     a JS object has no address, and these tables are only probed, never iterated, so their order is
//     unobservable. The chain links they used (`DFALabelState.next`, `DFACaseState.next`, and `DFAVar.next`
//     for these two tables) are not linked.
//   - `T**` slot walks that write through the slot: the 03 §7.3 accessor pair (`Slot`); read-only walks: a
//     plain node cursor. `out` parameters: `Ref<T>` boxes reset on entry (03 §3.3).
//   - Unions: none. Region/alignment: `Region` is `align(1)`, 24 bytes (3 x 8), only its size is observable.
//
// OWNERSHIP PROTOCOL for DFAScopeRef / DFALatticeRef, the ratified dfa exception of 03 §6.6. `DFACleanup` is
// `__VERSION__ >= 2102`, true for the oracle (its binary carries `DFALatticeRef.__ctor(ref)`, `__dtor` and the
// generated `opAssign`), so both handles have a copy constructor that MOVES (it steals `other`'s pointer and nulls
// `other`) and a destructor that frees the scope / lattice into the allocator's free lists. Semantics probed with ldc2
// (lvalue copy steals; `a = b` copy-constructs the parameter from `b`, swaps, destroys the old value; by-value
// parameters are destroyed by the callee at its exit; `return param;` copy-constructs). The TS spelling:
//   - `new X()`         D `X.init` or a default-initialized handle.
//   - `new X(src)`      every D copy FROM AN LVALUE (initialization from a variable or field, by-value argument,
//                       `return variable;`): steals `src`'s pointer, `src` becomes null.
//   - `x.opAssign(v)`   D `x = v`; `v` is `new X(lvalue)` for an lvalue right-hand side, the rvalue itself
//                       otherwise. The old value is destroyed.
//   - `x.__dtor()`      D's destructor at the end of the owner's lifetime: a local at its scope exit (try/finally
//                       when the scope has several exits), a by-value parameter BY THE CALLEE at its exit
//                       (extern(D) is callee-destroyed, target.isCalleeDestroyingArgs), an rvalue temporary no
//                       one took over at the end of its full expression.
//   A dtor on a null handle does nothing (D's own early-out). DFALatticeRef.__dtor also nulls its pointer after
//   freeing (DFAScopeRef's D dtor already does), so a second dtor on a handle D had already destroyed is inert.
//   D's own `copy()` on both handles is a DOMAIN copy (a new scope / lattice holding copies of the contents),
//   so it keeps its D name; the value-copy protocol of 03 §2 is spelled `new X(src)` (03 §2 name collision).
//
// OVERLOAD SETS (04 §1, 05 §9b): `DFACommon.makeObject(DFAObject*, DFAObject*)` keeps the bare name (ten cross-module
// callers in analysis.d/expression.d, most zero-argument) and `makeObject(DFAVar*)` is `makeObjectFromDFAVar`;
// `DFAAllocator.free(DFAScopeVar*)` keeps `free`, the others are `freeFromDFAScope` / `freeFromDFALattice` /
// `freeFromDFAConsequence`; `DFALatticeRef.setContext(DFAConsequence*)` keeps `setContext`, the DFAVar form is
// `setContextFromDFAVar`; `getContext()`/`getContext(out var)` collapse by arity to one method (Form A);
// DFALatticeRef's `acquireConstantAsContext()` keeps the bare name and its (Truthiness, Nullable, DFAObject*) form,
// whose body differs, is `acquireConstantAsContextTruthiness` (rule 3); the three `opApply` of DFAScopeRef / DFAScope
// are `opApply` (the first declared) plus `opApply_DFAVar_DFALattice` / `opApply_DFAVar_DFALattice_DFAScopeVar`;
// DFAPAValue's `this(Kind)` / `this(long)` are the factories `DFAPAValue.fromKind` / `DFAPAValue.fromLong`.
//
// DEBUG MACHINERY: the `debugIt` / `debugStructure` / `debugVerify` `static if` bodies and the
// `version (DebugJoinMeetOp)` blocks are resolved OFF and dropped (_config.md `DebugJoinMeetOp`, LOG-class).
// The debug dumpers `PrintPipeText`, `printPrefix`, `DFACommon.print`, the `printActual` methods and
// `DFAConsequence.print` are dropped: their only callers are those resolved-off blocks and `version (none)`
// code, and their output is raw `%p` memory addresses.

import { assert, SwitchError } from "../../../assert.js";
import { toUint32, toInt64, toUint64, maskSignedN, maskUnsignedN } from "../../../numeric.js";
import { ds } from "../../../dstring.js";
import type { DString } from "../../../dstring.js";
import { STC, STMT, TFlags, TY, Tbool } from "../../astenums.js";
import { Loc, SourceLoc, writeSourceLoc } from "../../location.js";
import { Id } from "../../id.js";
import type { OutBuffer } from "../../common/outbuffer.js";
import type { VarDeclaration } from "../../declaration.js";
import type { Expression } from "../../expression.js";
import type { FuncDeclaration, ParameterDFAInfo } from "../../func.js";
import type { Identifier } from "../../identifier.js";
import type { Type } from "../../mtype.js";
import type {
    CaseStatement, CompoundStatement, LabelStatement, Statement, SwitchStatement, TryFinallyStatement,
} from "../../statement.js";
import type { dinteger_t } from "../../globals.js";
import { isTypeNullable, isTypeTruthy } from "../utils.js";
// last: typesem enters the core SCC; every leaf import above loads first (01 §4.8).
import { isUnsigned } from "../../typesem.js";

/** The 03 §7.2 box: a D `out`/`ref` cell. */
export interface Ref<T> { value: T; }

/** The 03 §7.3 accessor pair: a D `T**` slot (a bucket head or a node's link field) that a walk writes through. */
interface Slot<T> { get(): T; set(v: T): void; }

/** The slot `&arr[i]`. */
function arraySlot<T>(arr: T[], i: number): Slot<T> {
    return { get: () => arr[i], set: (v: T) => { arr[i] = v; } };
}

/** The slot `&o.k` over a public field. */
function fieldSlot<O, K extends keyof O>(o: O, k: K): Slot<O[K]> {
    return { get: () => o[k], set: (v: O[K]) => { o[k] = v; } };
}

/**
 * D `cast(size_t) var` for a DFAVar pointer: its simulated region address (see the file header), 0 for null.
 * Used exactly where D hashes or orders DFAVar pointers.
 */
function dfaVarAddress(v: DFAVar | null): number {
    return v === null ? 0 : v.addr;
}

/// dmd/dfa/fast/structure.d:28 — `package static immutable PrintPipeText` — dropped with the debug dumpers
/// (file header): its only reader is `printPrefix`.

/**
 * dmd/dfa/fast/structure.d:30 — `void appendLoc(ref OutBuffer ob, ref const(Loc) loc)`: appends `loc` in the
 * current message style, with columns.
 */
export function appendLoc(ob: OutBuffer, loc: Loc): void {
    writeSourceLoc(ob, SourceLoc.fromLoc(loc), true, Loc.messageStyle);
}

/// dmd/dfa/fast/structure.d:35 — `alias PrintPrefixType = void delegate(const(char)*);`
export type PrintPrefixType = (pre: DString) => void;

// Old compiler versions have bugs with their copy constructors.
// Don't try to save memory by using moving to cleanup.
// Only relevant for bootstrapping purposes.
// We also require that GC.inFinalizer to exist.
// dmd/dfa/fast/structure.d:41 — `enum DFACleanup = __VERSION__ >= 2102;` resolved: the host compiler that
// built the oracle is >= 2.102 (its binary carries the ref handles' copy ctors and dtors) -> true (07 §3.2).
export const DFACleanup = true;

// dmd/dfa/fast/structure.d:43 — `//version = DebugJoinMeetOp;` stays unset (_config.md `DebugJoinMeetOp`).

// D DFACommon-scoped manifest enums (structure.d:66-72), hoisted and exported (02 §4.1): other dfa/ modules
// read them as `dfaCommon.debugUnknownAST`, which becomes the bare name.
// Making these enum's instead of fields allows for significant performance gains
export const debugIt = false;
export const debugStructure = false;
export const debugUnknownAST = false;
export const debugVerify = false; // Disable to improve performance

/***********************************************************
 * The central context for a DFA run.
 *
 * This structure manages the memory allocator, holds references to global
 * variables (like return values), and tracks the current scope being analyzed.
 *
 * Performance Note:
 * It uses a custom `DFAAllocator` (bump-pointer allocator) to avoid the overhead
 * of the GC or standard `malloc` for the thousands of tiny nodes created during analysis.
 *
 * dmd/dfa/fast/structure.d:55 — `struct DFACommon`. One per analysed function; the entry point sets
 * `allocator.dfaCommon` to it before the first allocation.
 */
export class DFACommon {
    allocator: DFAAllocator = new DFAAllocator();
    currentDFAScope: DFAScope | null = null;
    lastLoopyLabel: DFAScope | null = null;
    lastCatch: DFAScope | null = null;

    sdepth = 0;
    edepth = 0;
    currentFunction: FuncDeclaration | null = null;

    // D `private` block (structure.d:74-86).
    /// D `DFAVar*[16] vars`, hashed and ordered by the VarDeclaration's address: a Map (file header).
    private vars: Map<VarDeclaration, DFAVar> = new Map();
    // do not change, 16 is hardcoded in usage
    private varPairs: (DFAVar | null)[] = new Array<DFAVar | null>(16).fill(null);
    // D private and never touched in D either; TS `private` would trip noUnusedLocals.
    objects: (DFAObject | null)[] = new Array<DFAObject | null>(16).fill(null);
    objectPairs: (DFAObject | null)[] = new Array<DFAObject | null>(16).fill(null);
    private returnVar: DFAVar | null = null;
    private infiniteLifetimeVar: DFAVar | null = null;
    private unknownVar: DFAVar | null = null;

    /// D `DFALabelState*[16] forwardLabels`, keyed by the Identifier's address: a Map (file header).
    private forwardLabels: Map<Identifier | null, DFALabelState> = new Map();
    /// D `DFACaseState*[16] caseEntries`, keyed by the Statement's address: a Map (file header).
    private caseEntries: Map<Statement | null, DFACaseState> = new Map();

    /**
     * dmd/dfa/fast/structure.d:88 — `void printIfStructure(`. Debug dump, resolved away:
     * `static if (debugStructure)` -> false, so `del` is never called.
     */
    printIfStructure(_del: (ob: OutBuffer, prefix: (pre: DString) => void) => void): void {
        // resolved: static if (debugStructure) -> false (structure.d:91), block dropped
    }

    /** dmd/dfa/fast/structure.d:109 — `void printStructureln(const(char)[] text)`: debug dump (no output). */
    printStructureln(text: DString): void {
        this.printStructure((ob: OutBuffer, _prefix: PrintPrefixType) => {
            ob.writestring(text);
            ob.writestring(ds("\n"));
        });
    }

    /**
     * dmd/dfa/fast/structure.d:117 — `void printStructure(scope void delegate(ref OutBuffer ob,`. Debug dump,
     * resolved away: `static if (debugStructure)` -> false, so `del` is never called.
     */
    printStructure(_del: (ob: OutBuffer, prefix: (pre: DString) => void) => void): void {
        // resolved: static if (debugStructure) -> false (structure.d:120), block dropped
    }

    /** dmd/dfa/fast/structure.d:139 — `void printStateln(const(char)[] text)`: debug dump (no output). */
    printStateln(text: DString): void {
        this.printState((ob: OutBuffer, _prefix: PrintPrefixType) => {
            ob.writestring(text);
            ob.writestring(ds("\n"));
        });
    }

    /**
     * dmd/dfa/fast/structure.d:147 — `void printState(scope void delegate(ref OutBuffer ob, scope PrintPrefixType`.
     * Debug dump, resolved away: `static if (debugIt)` -> false, so `del` is never called.
     */
    printState(_del: (ob: OutBuffer, prefix: PrintPrefixType) => void): void {
        // resolved: static if (debugIt) -> false (structure.d:149), block dropped
    }

    /**
     * dmd/dfa/fast/structure.d:168 — `void pushScope()`: allocates a child of the current scope and makes it
     * current. Depth is the parent's + 1 (1 for the root); `inConditional` is inherited.
     */
    pushScope(): void {
        const oldScope = this.currentDFAScope;
        this.currentDFAScope = this.allocator.makeScope(this, oldScope);

        assert(this.currentDFAScope.parent !== this.currentDFAScope);
        assert(this.currentDFAScope.parent === oldScope);

        if (oldScope !== null) {
            oldScope.child = this.currentDFAScope;
            this.currentDFAScope.depth = oldScope.depth + 1;
            this.currentDFAScope.inConditional = oldScope.inConditional;
        }
        else {
            this.currentDFAScope.depth = 1;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:188 — `DFAScopeRef popScope()`: detaches the current scope and returns it as
     * an owning handle (freed when the handle is destroyed). Unwinds `lastLoopyLabel` / `lastCatch` when they
     * name the popped scope. Precondition: a current scope exists.
     */
    popScope(): DFAScopeRef {
        const ret = new DFAScopeRef();
        ret.sc = this.currentDFAScope;

        if (this.lastLoopyLabel === this.currentDFAScope)
            this.lastLoopyLabel = this.lastLoopyLabel!.previousLoopyLabel;
        if (this.lastCatch === this.currentDFAScope)
            this.lastCatch = this.lastCatch!.previousCatch;

        this.currentDFAScope = this.currentDFAScope!.parent;
        ret.sc!.parent = null;

        if (this.currentDFAScope !== null)
            this.currentDFAScope.child = null;
        return ret;
    }

    /** dmd/dfa/fast/structure.d:206 — `void setScopeAsLoopyLabel()`: pushes the current scope on the loopy chain. */
    setScopeAsLoopyLabel(): void {
        this.currentDFAScope!.isLoopyLabel = true;
        this.currentDFAScope!.previousLoopyLabel = this.lastLoopyLabel;
        this.lastLoopyLabel = this.currentDFAScope;
    }

    /** dmd/dfa/fast/structure.d:213 — `void setScopeAsCatch()`: pushes the current scope on the catch chain. */
    setScopeAsCatch(): void {
        this.currentDFAScope!.previousCatch = this.lastCatch;
        this.lastCatch = this.currentDFAScope;
    }

    /**
     * dmd/dfa/fast/structure.d:219 — `DFAVar* findVariable(VarDeclaration vd, DFAVar* childOf = null)`.
     * The unique DFAVar of `vd` (a root variable when `childOf` is null, else the field `vd` of `childOf`),
     * created on first use. `__dollar` is always unmodellable. Null `vd` answers null.
     */
    findVariable(vd: VarDeclaration | null, childOf: DFAVar | null = null): DFAVar | null {
        if (vd === null)
            return null;

        let ret: DFAVar;

        if (childOf === null) {
            // D walks the bucket `vars[vd % 16]`, ordered by the declaration's address: a Map lookup.
            const found = this.vars.get(vd);
            if (found !== undefined)
                return found;

            ret = this.allocator.makeVar(vd);
            this.vars.set(vd, ret); // `ret.next = *bucket; *bucket = ret;`
        }
        else
            ret = this.allocator.makeVar(vd, childOf);

        if (vd.ident === Id.dollar) {
            // __dollar creates problems because it isn't a real variable
            // https://issues.dlang.org/show_bug.cgi?id=3326

            ret.unmodellable = true;
        }

        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:256 — `DFAVar* findVariablePair(DFAVar* a, DFAVar* b)`. Null or equal inputs
     * answer the other / the same variable. Otherwise the bucket search compares `base1`, which a pair
     * variable never sets, so every call ends past the chain and appends a FRESH variable whose infinite
     * lifetime is `a`'s and `b`'s together.
     */
    findVariablePair(a: DFAVar | null, b: DFAVar | null): DFAVar | null {
        if (a === null)
            return b;
        else if (b === null)
            return a;
        else if (a === b)
            return a;

        if (dfaVarAddress(a) > dfaVarAddress(b)) {
            const temp = a;
            a = b;
            b = temp;
        }

        const a1 = dfaVarAddress(a) % 0xF, b1 = dfaVarAddress(b) % 0xF;
        const ab1 = (b1 << 4) | a1;
        const ab2 = ab1 % 16;

        let bucket: Slot<DFAVar | null> = arraySlot(this.varPairs, ab2);

        while (bucket.get() !== null && dfaVarAddress(bucket.get()!.base1) < dfaVarAddress(a)) {
            bucket = fieldSlot(bucket.get()!, "next");
        }

        if (bucket.get() === a) {
            while (bucket.get()!.base1 === a && dfaVarAddress(bucket.get()!.base2) < dfaVarAddress(b)) {
                bucket = fieldSlot(bucket.get()!, "next");
            }
        }

        if (bucket.get() === null || bucket.get()!.base1 !== a || bucket.get()!.base2 !== b) {
            const next = bucket.get();
            bucket.set(this.allocator.makeVar(null, null));
            bucket.get()!.haveInfiniteLifetime = a.haveInfiniteLifetime && b.haveInfiniteLifetime;
            bucket.get()!.next = next;
        }

        return bucket.get();
    }

    /** dmd/dfa/fast/structure.d:302 — `DFAVar* findDereferenceVar(DFAVar* childOf)`: the unique `*childOf`. */
    findDereferenceVar(childOf: DFAVar | null): DFAVar | null {
        if (childOf === null)
            return null;

        if (childOf.dereferenceVar === null) {
            childOf.dereferenceVar = this.allocator.makeVar(null);
            childOf.dereferenceVar.base1 = childOf;
            childOf.dereferenceVar.haveInfiniteLifetime = childOf.haveInfiniteLifetime;
        }

        return childOf.dereferenceVar;
    }

    /** dmd/dfa/fast/structure.d:317 — `DFAVar* findIndexVar(DFAVar* childOf)`: the unique `childOf[index]`. */
    findIndexVar(childOf: DFAVar | null): DFAVar | null {
        if (childOf === null)
            return null;

        if (childOf.indexVar === null) {
            childOf.indexVar = this.allocator.makeVar(null);
            childOf.indexVar.base1 = childOf;
            childOf.indexVar.isAnIndex = true;
            childOf.indexVar.haveInfiniteLifetime = childOf.haveInfiniteLifetime;
        }

        return childOf.indexVar;
    }

    /** dmd/dfa/fast/structure.d:333 — `DFAVar* findAsSliceVar(DFAVar* childOf)`: the unique `childOf[]`. */
    findAsSliceVar(childOf: DFAVar | null): DFAVar | null {
        if (childOf === null)
            return null;

        if (childOf.asSliceVar === null) {
            childOf.asSliceVar = this.allocator.makeVar(null);
            childOf.asSliceVar.base1 = childOf;
            childOf.asSliceVar.haveInfiniteLifetime = childOf.haveInfiniteLifetime;
        }

        return childOf.asSliceVar;
    }

    /** dmd/dfa/fast/structure.d:348 — `DFAVar* findSliceLengthVar(DFAVar* childOf)`: the unique `childOf.length`. */
    findSliceLengthVar(childOf: DFAVar | null): DFAVar | null {
        if (childOf === null)
            return null;

        if (childOf.lengthVar === null) {
            childOf.lengthVar = this.allocator.makeVar(null);
            childOf.lengthVar.base1 = childOf;
            childOf.lengthVar.isLength = true;
            childOf.lengthVar.haveInfiniteLifetime = childOf.haveInfiniteLifetime;
        }

        return childOf.lengthVar;
    }

    /**
     * dmd/dfa/fast/structure.d:364 — `DFAVar* findOffsetVar(dinteger_t offset, DFAVar* childOf)`: the unique
     * variable at byte `offset` from `childOf`, kept in a chain sorted by offset (unsigned).
     */
    findOffsetVar(offset: dinteger_t, childOf: DFAVar | null): DFAVar | null {
        if (childOf === null)
            return null;

        let bucket: Slot<DFAVar | null> = fieldSlot(childOf, "childOffsetVars");

        while (bucket.get() !== null && bucket.get()!.offsetFromBase < offset) {
            bucket = fieldSlot(bucket.get()!, "next");
        }

        if (bucket.get() !== null && bucket.get()!.offsetFromBase === offset)
            return bucket.get();

        const ret = this.allocator.makeVar(null);
        ret.base1 = childOf;
        ret.offsetFromBase = offset;
        ret.haveInfiniteLifetime = childOf.haveInfiniteLifetime;

        ret.next = bucket.get();
        bucket.set(ret);
        return ret;
    }

    /** dmd/dfa/fast/structure.d:389 — `DFAScope* findScopeForControlStatement(Statement st)`: innermost match. */
    findScopeForControlStatement(st: Statement | null): DFAScope | null {
        let current = this.currentDFAScope;

        while (current !== null && current.controlStatement !== st) {
            current = current.parent;
        }

        return current;
    }

    /**
     * dmd/dfa/fast/structure.d:401 — `DFAScope* findScopeHeadOfLabelStatement(Identifier label)`: the innermost
     * scope whose compound statement, from the statement in progress on, contains `label` or a variable
     * declaration a jump to it could skip. A CompoundDeclaration statement reached here faults exactly as D does:
     * D reads it through `isCompoundStatement`, which is null for it.
     */
    findScopeHeadOfLabelStatement(label: Identifier | null): DFAScope | null {
        const walkExpression = (e: Expression): boolean => {
            const de = e.isDeclarationExp();
            if (de !== null) {
                const ad = de.declaration!.isAttribDeclaration();
                if (ad !== null) {
                    // ImportC wraps their declarations

                    if (ad.decl !== null) {
                        for (const symbol of ad.decl) {
                            if (symbol!.isVarDeclaration() !== null)
                                return true;
                        }
                    }

                    return false;
                }
                else
                    return de.declaration!.isVarDeclaration() !== null;
            }
            else {
                const be = e.isBinExp();
                if (be !== null)
                    return walkExpression(be.e1!) || walkExpression(be.e2!);
                else {
                    const ue = e.isUnaExp();
                    if (ue !== null)
                        return walkExpression(ue.e1!);
                    else
                        return false;
                }
            }
        };

        const walkStatement = (s: Statement | null): boolean => {
            if (s === null)
                return false;

            // D `with (STMT) final switch (s.stmt)` — case labels re-qualified (06 §3.3).
            switch (s.stmt) {
                // could prevent it
            case STMT.Exp: {
                const s2 = s.isExpStatement()!;
                return walkExpression(s2.exp!);
            }

                // could be this
            case STMT.Label: {
                const s2 = s.isLabelStatement()!;
                if (s2.ident === label)
                    return true;
                else
                    return walkStatement(s2.statement);
            }

                // can be in this
            case STMT.Debug: {
                const s2 = s.isDebugStatement()!;
                return walkStatement(s2.statement);
            }
            case STMT.Default: {
                const s2 = s.isDefaultStatement()!;
                return walkStatement(s2.statement);
            }
            case STMT.CaseRange: {
                const s2 = s.isCaseRangeStatement()!;
                return walkStatement(s2.statement);
            }
            case STMT.Case: {
                const s2 = s.isCaseStatement()!;
                return walkStatement(s2.statement);
            }
            case STMT.Peel: {
                const s2 = s.isPeelStatement()!;
                return walkStatement(s2.s);
            }
            case STMT.Forwarding: {
                const s2 = s.isForwardingStatement()!;
                return walkStatement(s2.statement);
            }
            case STMT.If: {
                const s2 = s.isIfStatement()!;
                return walkStatement(s2.ifbody) || walkStatement(s2.elsebody);
            }
            case STMT.Do: {
                const s2 = s.isDoStatement()!;
                return walkStatement(s2._body);
            }
            case STMT.For: {
                const s2 = s.isForStatement()!;
                return walkStatement(s2._body);
            }
            case STMT.Switch: {
                const s2 = s.isSwitchStatement()!;
                if (s2.cases !== null) {
                    for (const c of s2.cases) {
                        if (walkStatement(c))
                            return true;
                    }
                }
                return false;
            }
            case STMT.UnrolledLoop: {
                const s2 = s.isUnrolledLoopStatement()!;
                if (s2.statements !== null) {
                    for (const s3 of s2.statements) {
                        if (walkStatement(s3))
                            return true;
                    }
                }
                return false;
            }
            case STMT.Scope: {
                const s2 = s.isScopeStatement()!;
                return walkStatement(s2.statement);
            }
            case STMT.Compound:
            case STMT.CompoundDeclaration: {
                // D reads a CompoundDeclaration through isCompoundStatement (null for it) and dereferences
                // the null: the `!` keeps that fault.
                const s2 = s.isCompoundStatement()!;
                if (s2.statements !== null) {
                    for (const s3 of s2.statements) {
                        if (walkStatement(s3))
                            return true;
                    }
                }
                return false;
            }

                // can't be in this
            case STMT.Error:
            case STMT.DtorExp:
            case STMT.Mixin:
            case STMT.CompoundAsm:
            case STMT.Synchronized:
            case STMT.With:
            case STMT.TryCatch:
            case STMT.TryFinally:
            case STMT.ScopeGuard:
            case STMT.While:
            case STMT.Conditional:
            case STMT.ForeachRange:
            case STMT.Foreach:
            case STMT.StaticForeach:
            case STMT.Pragma:
            case STMT.StaticAssert:
            case STMT.GotoDefault:
            case STMT.GotoCase:
            case STMT.SwitchError:
            case STMT.Return:
            case STMT.Break:
            case STMT.Continue:
            case STMT.Throw:
            case STMT.Goto:
            case STMT.Asm:
            case STMT.InlineAsm:
            case STMT.GccAsm:
            case STMT.Import:
                return false;

            default: {
                // final switch: D throws SwitchError on an unhandled value
                const _exhaustive: never = s.stmt; void _exhaustive;
                throw new SwitchError();
            }
            }
        };

        let current = this.currentDFAScope;

        while (current !== null) {
            if (current.compoundStatement !== null) {
                const statements = current.compoundStatement.statements!;
                for (const s of statements.opSlice(current.inProgressCompoundStatement, statements.length)) {
                    if (walkStatement(s))
                        return current;
                }
            }

            current = current.parent;
        }

        return null;
    }

    /**
     * dmd/dfa/fast/structure.d:575 — `SwitchStatement findSwitchGivenCase(CaseStatement cs, out DFAScope* target)`:
     * the innermost enclosing switch that owns `cs`, with its scope in `target` (null / null when none).
     */
    findSwitchGivenCase(cs: CaseStatement | null, target: Ref<DFAScope | null>): SwitchStatement | null {
        target.value = null; // `out` parameter reset on entry (03 §3.3)
        let current = this.currentDFAScope;

        while (current !== null) {
            if (current.controlStatement !== null) {
                const sw = current.controlStatement.isSwitchStatement();

                if (sw !== null && sw.cases !== null) {
                    for (const cs2 of sw.cases) {
                        if (cs2 === cs) {
                            target.value = current;
                            return sw;
                        }
                    }
                }
            }

            current = current.parent;
        }

        return null;
    }

    /** dmd/dfa/fast/structure.d:604 — `DFAVar* getReturnVariable()`: the function's return-value variable. */
    getReturnVariable(): DFAVar {
        if (this.returnVar === null)
            this.returnVar = this.allocator.makeVar(null);
        return this.returnVar;
    }

    /**
     * dmd/dfa/fast/structure.d:611 — `DFAVar* getInfiniteLifetimeVariable()`: the shared variable standing for
     * storage with infinite lifetime (truthy, nullable).
     */
    getInfiniteLifetimeVariable(): DFAVar {
        if (this.infiniteLifetimeVar === null) {
            this.infiniteLifetimeVar = this.allocator.makeVar(null);
            this.infiniteLifetimeVar.haveInfiniteLifetime = true;
            this.infiniteLifetimeVar.isTruthy = true;
            this.infiniteLifetimeVar.isNullable = true;
        }

        return this.infiniteLifetimeVar;
    }

    /** dmd/dfa/fast/structure.d:624 — `DFAVar* getUnknownVar()`: the shared unmodellable variable. */
    getUnknownVar(): DFAVar {
        if (this.unknownVar === null) {
            this.unknownVar = this.allocator.makeVar(null);
            this.unknownVar.unmodellable = true;
        }

        return this.unknownVar;
    }

    /**
     * dmd/dfa/fast/structure.d:635 — `DFAScope* getSideEffectScope()`: the innermost scope that may hold side
     * effects. Precondition: some enclosing scope is not side-effect free (D dereferences past the root).
     */
    getSideEffectScope(): DFAScope {
        let current = this.currentDFAScope!;

        while (current.sideEffectFree) {
            current = current.parent!;
        }

        return current;
    }

    /**
     * dmd/dfa/fast/structure.d:647 — `DFAObject* makeObject(DFAVar* storageForVar)` (renamed, 04 §1 Form B
     * rule 3). The object stored in `storageForVar`, created once.
     */
    makeObjectFromDFAVar(storageForVar: DFAVar | null): DFAObject | null {
        if (storageForVar === null)
            return null;
        else if (storageForVar.storageFor !== null)
            return storageForVar.storageFor;

        const ret = this.allocator.makeObject();
        ret.storageFor = storageForVar;

        storageForVar.storageFor = ret;
        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:661 — `DFAObject* makeObject(DFAObject* base1 = null, DFAObject* base2 = null)`
     * (bare name: 04 §1 rule 1, ten cross-module callers in analysis.d/expression.d against four for the DFAVar
     * form). A fresh object derived from up to two bases; a lone `base2` moves to `base1`.
     */
    makeObject(base1: DFAObject | null = null, base2: DFAObject | null = null): DFAObject {
        if (base2 !== null && base1 === null) {
            base1 = base2;
            base2 = null;
        }

        const ret = this.allocator.makeObject();
        ret.base1 = base1;
        ret.base2 = base2;
        return ret;
    }

    /** dmd/dfa/fast/structure.d:675 — `DFALatticeRef makeLatticeRef()`: a handle owning a fresh empty lattice. */
    makeLatticeRef(): DFALatticeRef {
        const ret = new DFALatticeRef();
        ret.lattice = this.allocator.makeLattice(this);
        ret.check();
        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:683 — `DFAScopeVar* swapLattice(DFAVar* contextVar, scope DFALatticeRef delegate(`.
     * Replaces the lattice of `contextVar` in the current scope by `dg(old)`. D passes `scv.lr` to `dg` BY VALUE:
     * the copy constructor moves it into the delegate's parameter (`scv.lr` is null while `dg` runs) and the
     * delegate destroys that parameter at its exit (callee-destroyed). A null result leaves `scv.lr` null.
     * Answers null when `contextVar` is null or declared deeper than the current scope.
     */
    swapLattice(contextVar: DFAVar | null, dg: (lr: DFALatticeRef) => DFALatticeRef): DFAScopeVar | null {
        if (contextVar === null || this.currentDFAScope!.depth < contextVar.declaredAtDepth)
            return null;

        const scv = this.acquireScopeVar(contextVar)!;

        if (scv.lr.isNull()) {
            scv.lr.opAssign(this.makeLatticeRef());
            scv.lr.setContextFromDFAVar(contextVar);
        }

        const got = dg(new DFALatticeRef(scv.lr));
        try {
            if (!got.isNull()) {
                if (got.getContextVar() !== contextVar)
                    scv.lr.setContextFromDFAVar(contextVar);

                scv.lr.opAssign(new DFALatticeRef(got));
            }

            scv.lr.check();
            return scv;
        } finally {
            got.__dtor(); // D destroys the local `got` at scope exit
        }
    }

    /** dmd/dfa/fast/structure.d:710 — `bool haveForwardLabelState(Identifier ident)`: a forward jump targets it. */
    haveForwardLabelState(ident: Identifier | null): boolean {
        // D walks `forwardLabels[ident % 16]`, ordered by the identifier's address: a Map lookup.
        return this.forwardLabels.has(ident);
    }

    /**
     * dmd/dfa/fast/structure.d:723 — `void swapForwardLabelScope(Identifier ident, scope DFAScopeRef delegate(`.
     * Replaces the scope recorded for forward jumps to `ident` (created empty on first use) by `del(old)`; the
     * old handle is moved into `del`'s by-value parameter, which `del` destroys at its exit.
     */
    swapForwardLabelScope(ident: Identifier | null, del: (scr: DFAScopeRef) => DFAScopeRef): void {
        // D walks `forwardLabels[ident % 16]`, ordered by the identifier's address: a Map lookup.
        let st = this.forwardLabels.get(ident);

        if (st === undefined) {
            const temp = this.allocator.makeLabelState(ident);
            this.forwardLabels.set(ident, temp); // `temp.next = *bucket; *bucket = temp;`
            st = temp;
        }

        st.scr.opAssign(del(new DFAScopeRef(st.scr)));
    }

    /** dmd/dfa/fast/structure.d:743 — `DFACaseState* acquireCaseState(Statement caseStatement)`: created once. */
    acquireCaseState(caseStatement: Statement | null): DFACaseState {
        // D walks `caseEntries[caseStatement % 16]`, ordered by the statement's address: a Map lookup.
        let st = this.caseEntries.get(caseStatement);

        if (st === undefined) {
            const temp = this.allocator.makeCaseState(caseStatement);
            this.caseEntries.set(caseStatement, temp); // `temp.next = *bucket; *bucket = temp;`
            st = temp;
        }

        return st;
    }

    /**
     * dmd/dfa/fast/structure.d:763 — `DFALatticeRef acquireLattice(DFAVar* var)`: a COPY of `var`'s lattice as
     * seen from the current scope (null handle when `var` is not visible there).
     */
    acquireLattice(var_: DFAVar | null): DFALatticeRef {
        const scv = this.acquireScopeVar(var_);
        if (scv === null)
            return new DFALatticeRef();

        return scv.lr.copy();
    }

    /**
     * dmd/dfa/fast/structure.d:772 — `DFAScopeVar* acquireScopeVar(DFAVar* var)`: the scope variable of `var` in
     * the CURRENT scope. When an enclosing scope (down to the declaring depth) already tracks `var`, its lattice
     * and mergable counts are copied into every scope between it and the current one; otherwise a fresh entry is
     * created in the current scope. Null when `var` is null or declared deeper than the current scope.
     */
    acquireScopeVar(var_: DFAVar | null): DFAScopeVar | null {
        if (var_ === null || this.currentDFAScope!.depth < var_.declaredAtDepth)
            return null;

        let sc: DFAScope | null;
        sc = this.currentDFAScope;
        let scv: DFAScopeVar | null = null, ret: DFAScopeVar | null;

        while (sc !== null && sc.depth >= var_.declaredAtDepth) {
            if ((scv = sc.findScopeVar(var_)) !== null)
                break;

            sc = sc.parent;
        }

        assert(scv === null || scv.var === var_);
        let c: DFAConsequence | null;

        if (scv === null) {
            // init new state
            sc = this.currentDFAScope!;
            ret = sc.getScopeVar(var_)!;

            c = ret.lr.getContext();
            assert(ret.var === var_);
            assert(c !== null);
            assert(c.var === var_);

            return ret;
        }
        else {
            assert(!scv.lr.isNull());
            c = scv.lr.getContext();
            assert(c !== null);
            assert(c.var === var_);
        }

        sc = sc!.child;
        ret = scv;

        while (sc !== null) {
            ret = sc.getScopeVar(var_)!;
            assert(ret.var === var_);
            // if we had state that we wanted copied, we'd do it here

            ret.lr.opAssign(scv.lr.copy());
            ret.mergable = scv.mergable.copy();

            c = ret.lr.getContext();
            assert(c !== null);
            assert(c.var === var_);

            sc = sc.child;
        }

        assert(ret !== null);
        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:836 — `DFAScope* findScopeGivenLabel(Identifier ident)`: the scope a
     * `break`/`continue` targets — the innermost labelled `ident`, or for a null `ident` the innermost control
     * statement. Null when the walk ends at the root without a match. Precondition: a current scope exists.
     */
    findScopeGivenLabel(ident: Identifier | null): DFAScope | null {
        let current = this.currentDFAScope!;

        if (ident === null) {
            while (current.parent !== null && current.controlStatement === null) {
                current = current.parent;
            }
        }
        else {
            while (current.parent !== null && (current.label === null || current.label.ident !== ident)) {
                current = current.parent;
            }
        }

        return (current !== null && ((current.label !== null && current.label.ident === ident)
                || current.controlStatement !== null)) ? current : null;
    }

    /**
     * dmd/dfa/fast/structure.d:861 — `void allocatedVariablesAllUnmodellable()`: marks every variable allocated
     * so far unmodellable.
     */
    allocatedVariablesAllUnmodellable(): void {
        // If we're calling this, that means we have literally no idea what state these variables are in.
        // Its anything after this point in the AST walk.

        let current = this.allocator.allocatedlistvar;

        while (current !== null) {
            current.unmodellable = true;
            current = current.listnext;
        }
    }

    /// dmd/dfa/fast/structure.d:875 — `void print()` — dropped with the debug dumpers (file header).

    /** dmd/dfa/fast/structure.d:903 — `void check()`: the debugVerify self-check, resolved OFF (no-op). */
    check(): void {
        // resolved: static if (DFACommon.debugVerify) -> false (structure.d:905), block dropped
    }

    /**
     * 03 §6.3: D's implicit field-wise copy. `allocator` is copied as a value; the scope and variable pointers
     * are shared; the Map-backed tables are copied as new Maps over the same nodes (D copies the bucket heads).
     */
    copy(): DFACommon {
        const c = new DFACommon();
        c.allocator = this.allocator.copy();
        c.currentDFAScope = this.currentDFAScope;
        c.lastLoopyLabel = this.lastLoopyLabel;
        c.lastCatch = this.lastCatch;
        c.sdepth = this.sdepth;
        c.edepth = this.edepth;
        c.currentFunction = this.currentFunction;
        c.vars = new Map(this.vars);
        c.varPairs = this.varPairs.slice();
        c.objects = this.objects.slice();
        c.objectPairs = this.objectPairs.slice();
        c.returnVar = this.returnVar;
        c.infiniteLifetimeVar = this.infiniteLifetimeVar;
        c.unknownVar = this.unknownVar;
        c.forwardLabels = new Map(this.forwardLabels);
        c.caseEntries = new Map(this.caseEntries);
        return c;
    }
}

/**
 * The nodes DFAAllocator hands out: a free-list link, the simulated address of the node's region slot, and
 * D's `memcpy(ret, &valInit, T.sizeof)` re-initialization.
 */
interface Pooled<T> {
    listnext: T | null;
    addr: number;
    resetToInit(): void;
}

// D DFAAllocator-scoped manifest enum (structure.d:953), hoisted (02 §4.1). 128kb for regions of memory; the
// 8 KiB, 256 KiB and 1 MiB alternatives are commented out in D (structure.d:950-957) and not carried.
const RegionAllocationStep = 131_072;

/**
 * dmd/dfa/fast/structure.d:942 — `static struct Region` (`align(1)`), the header at the start of each block the
 * allocator carves nodes from. `base` is the block's simulated address (file header); D has no such field.
 */
class Region {
    previous: Region | null = null;
    next: Region | null = null;
    length = 0;
    readonly base: number;

    /// resolved: Region.sizeof -> 24 (`align(1)`: two pointers and a size_t, no padding).
    static readonly sizeof = 24;

    constructor(base: number) {
        this.base = base;
    }
}

/// The link address of `DFAAllocator.staticRegion` in the ldc2 1.43.0 oracle binary (nm: 0x1076c73c8). The
/// process slide is a page multiple, so the address modulo 16 (8) and its place below the heap hold at run time.
const STATIC_REGION_ADDRESS = 0x1_076c_73c8;
/// Simulated addresses of the malloc'd regions: 16-byte aligned (macOS malloc), above the static region, one
/// 128 KiB block after the other in allocation order.
const MALLOC_REGION_BASE = 0x2_0000_0000;

// D DFAAllocator `__gshared` statics (structure.d:975-979): process-wide module state (01 §5.5).
let lastRegion: Region | null = null;
/// D `void[RegionAllocationStep] staticRegion = void;` — only its header and its address are observable.
const staticRegion = new Region(STATIC_REGION_ADDRESS);
let mallocRegionCount = 0;

/**
 * dmd/dfa/fast/structure.d:933 — `struct DFAAllocator`: the bump-and-free-list allocator of every DFA node.
 * Kept (file header): each `make*` pops the type's free list, else carves the next `T.sizeof` bytes from the
 * current region (moving to the next region, or malloc'ing one, when it is full); either way the node is reset
 * to its `.init`. Nodes live until freed; nothing is freed at the end of a run, and the regions are reused by
 * the next run (a new DFAAllocator starts again at the static region).
 */
export class DFAAllocator {
    // package(dmd.dfa)
    dfaCommon: DFACommon | null = null;

    // D `private` block (structure.d:940-980).
    allocatedlistvar: DFAVar | null = null; // D module-private (read by DFACommon.allocatedVariablesAllUnmodellable)
    private allocatedlistlastvar: DFAVar | null = null;
    private allocatedlistobject: DFAObject | null = null;

    // We use free lists to reuse memory, during our operation.
    private freelistlabel: DFALabelState | null = null;
    private freelistcase: DFACaseState | null = null;
    private freelistvar: DFAVar | null = null;
    private freelistscopevar: DFAScopeVar | null = null;
    private freelistobject: DFAObject | null = null;
    private freelistscope: DFAScope | null = null;
    private freelistlattice: DFALattice | null = null;
    private freelistconsequence: DFAConsequence | null = null;

    private currentRegion: Region | null = null;
    private regionUsed = 0;

    /**
     * dmd/dfa/fast/structure.d:982 — `static void deinitialize()`: releases every malloc'd region and forgets
     * them, so the next run starts from a re-initialized static region.
     */
    static deinitialize(): void {
        // erased: `import dmd.root.rmem;` (structure.d:984) -> JS GC

        while (lastRegion !== null) {
            let toFree: Region | null = null;
            if (lastRegion.previous !== null)
                toFree = lastRegion;
            lastRegion = lastRegion.previous;

            assert(toFree !== staticRegion);
            // erased: `if (toFree !is null) Mem.xfree(toFree);` (structure.d:994) -> JS GC
        }
        // port-only, no D line: the simulated malloc addresses (file header) restart, as in a fresh process
        mallocRegionCount = 0;
    }

    /** dmd/dfa/fast/structure.d:999 — `static void checkfreelist()`: its body is `version (none)`, dropped. */
    static checkfreelist(): void {
        // dropped: version(none) block (structure.d:1001), disabled in upstream
    }

    /**
     * dmd/dfa/fast/structure.d:1036 — `DFAVar* makeVar(VarDeclaration vd, DFAVar* childOf = null)`. A new
     * variable (typed from `vd` when given), or, when `childOf` is given, the field `vd` of `childOf`, created
     * once. Every new variable joins the allocated list (newest first).
     */
    makeVar(vd: VarDeclaration | null, childOf: DFAVar | null = null): DFAVar {
        if (childOf !== null) {
            // D walks `childOf.childVars[vd % 16]`, ordered by the declaration's address: a Map lookup.
            const found = childOf.childVars.get(vd);
            if (found !== undefined)
                return found;
        }

        const ret = this.allocInternal<DFAVar>(
            { get: () => this.freelistvar, set: (v: DFAVar | null) => { this.freelistvar = v; } },
            DFAVar.sizeof, () => new DFAVar());
        ret.var = vd;
        ret.base1 = childOf;
        ret.offsetFromBase = toUint64(-1n);

        if (vd !== null)
            applyType(ret, vd);

        if (childOf !== null) {
            ret.haveInfiniteLifetime = childOf.haveInfiniteLifetime;
            ret.offsetFromBase = BigInt(vd!.offset);

            childOf.childVars.set(vd, ret); // `ret.next = *bucket; *bucket = ret;`
        }

        if (this.allocatedlistlastvar === null) {
            this.allocatedlistlastvar = ret;
            this.allocatedlistvar = ret;
        }
        else {
            ret.listnext = this.allocatedlistvar;
            this.allocatedlistvar = ret;
        }

        return ret;
    }

    /** dmd/dfa/fast/structure.d:1084 — `DFAScopeVar* makeScopeVar(DFACommon* dfaCommon, DFAVar* var)`. */
    makeScopeVar(_dfaCommon: DFACommon | null, var_: DFAVar | null): DFAScopeVar {
        const ret = this.allocInternal<DFAScopeVar>(
            { get: () => this.freelistscopevar, set: (v: DFAScopeVar | null) => { this.freelistscopevar = v; } },
            DFAScopeVar.sizeof, () => new DFAScopeVar());
        ret.var = var_;
        return ret;
    }

    /** dmd/dfa/fast/structure.d:1091 — `DFAScope* makeScope(DFACommon* dfaCommon, DFAScope* parent)`. */
    makeScope(dfaCommon: DFACommon, parent: DFAScope | null): DFAScope {
        const ret = this.allocInternal<DFAScope>(
            { get: () => this.freelistscope, set: (v: DFAScope | null) => { this.freelistscope = v; } },
            DFAScope.sizeof, () => new DFAScope());
        ret.dfaCommon = dfaCommon;
        ret.parent = parent;
        return ret;
    }

    /** dmd/dfa/fast/structure.d:1099 — `DFAObject* makeObject()`: joins the allocated-object list (newest first). */
    makeObject(): DFAObject {
        const ret = this.allocInternal<DFAObject>(
            { get: () => this.freelistobject, set: (v: DFAObject | null) => { this.freelistobject = v; } },
            DFAObject.sizeof, () => new DFAObject());

        ret.listnext = this.allocatedlistobject;
        this.allocatedlistobject = ret;
        return ret;
    }

    /** dmd/dfa/fast/structure.d:1108 — `DFALattice* makeLattice(DFACommon* dfaCommon)`. */
    makeLattice(dfaCommon: DFACommon): DFALattice {
        const ret = this.allocInternal<DFALattice>(
            { get: () => this.freelistlattice, set: (v: DFALattice | null) => { this.freelistlattice = v; } },
            DFALattice.sizeof, () => new DFALattice());
        ret.dfaCommon = dfaCommon;
        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:1115 — `DFAConsequence* makeConsequence(DFAVar* var, DFAConsequence* copyFrom`.
     * A consequence on `var`, copying `copyFrom`'s facts when given; truthiness / nullability the variable
     * cannot have are reset to Unknown.
     */
    makeConsequence(var_: DFAVar | null, copyFrom: DFAConsequence | null = null): DFAConsequence {
        const ret = this.allocInternal<DFAConsequence>(
            {
                get: () => this.freelistconsequence,
                set: (v: DFAConsequence | null) => { this.freelistconsequence = v; },
            },
            DFAConsequence.sizeof, () => new DFAConsequence());
        ret.dfaCommon = this.dfaCommon;
        ret.var = var_;

        if (copyFrom !== null) {
            ret.copyFrom(copyFrom);

            if (var_ !== null) {
                if (!var_.isTruthy)
                    ret.truthiness = Truthiness.Unknown;
                if (!var_.isNullable)
                    ret.nullable = Nullable.Unknown;
            }
        }

        ret.var = var_;
        return ret;
    }

    /** dmd/dfa/fast/structure.d:1138 — `DFALabelState* makeLabelState(Identifier ident)`. */
    makeLabelState(ident: Identifier | null): DFALabelState {
        const ret = this.allocInternal<DFALabelState>(
            { get: () => this.freelistlabel, set: (v: DFALabelState | null) => { this.freelistlabel = v; } },
            DFALabelState.sizeof, () => new DFALabelState());
        ret.ident = ident;
        return ret;
    }

    /** dmd/dfa/fast/structure.d:1145 — `DFACaseState* makeCaseState(Statement caseStatement)`. */
    makeCaseState(caseStatement: Statement | null): DFACaseState {
        const ret = this.allocInternal<DFACaseState>(
            { get: () => this.freelistcase, set: (v: DFACaseState | null) => { this.freelistcase = v; } },
            DFACaseState.sizeof, () => new DFACaseState());
        ret.caseStatement = caseStatement;
        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:1152 — `void free(DFAScopeVar* s)`: destroys the three lattices (freeing them) and
     * pushes `s` on its free list.
     */
    free(s: DFAScopeVar): void {
        s.lr.opAssign(new DFALatticeRef());
        s.lrGatePredicate.opAssign(new DFALatticeRef());
        s.lrGateNegatedPredicate.opAssign(new DFALatticeRef());
        s.var = null;
        s.next = null;

        s.listnext = this.freelistscopevar;
        this.freelistscopevar = s;
    }

    /**
     * dmd/dfa/fast/structure.d:1164 — `void free(DFAScope* s)` (renamed, 04 §1 Form B). Destroys the before/after
     * states, frees every scope variable, and pushes `s` on its free list. `label`, `depth` and the flags are
     * left as they are (the next `makeScope` re-initializes them).
     */
    freeFromDFAScope(s: DFAScope): void {
        // resolved: static if (DFACommon.debugVerify) -> false (structure.d:1166), block dropped

        s.parent = null;
        s.child = null;
        s.previousLoopyLabel = null;
        s.previousCatch = null;

        s.controlStatement = null;
        s.compoundStatement = null;
        s.tryFinallyStatement = null;

        s.beforeScopeState.opAssign(new DFAScopeRef());
        s.afterScopeState.opAssign(new DFAScopeRef());

        for (let i = 0; i < s.buckets.length; i++) {
            let next: DFAScopeVar | null;

            while (s.buckets[i] !== null) {
                next = s.buckets[i]!.next;
                this.free(s.buckets[i]!);
                s.buckets[i] = next;
            }
        }

        s.listnext = this.freelistscope;
        this.freelistscope = s;
    }

    /**
     * dmd/dfa/fast/structure.d:1205 — `void free(DFALattice* l)` (renamed, 04 §1 Form B): unlinks the lattice's
     * consequences (freed by the caller) and pushes `l` on its free list.
     */
    freeFromDFALattice(l: DFALattice): void {

        l.firstInSequence = null;
        l.lastInSequence = null;
        l.constant = null;
        l.context = null;

        l.listnext = this.freelistlattice;
        this.freelistlattice = l;
    }

    /** dmd/dfa/fast/structure.d:1217 — `void free(DFAConsequence* c)` (renamed, 04 §1 Form B). */
    freeFromDFAConsequence(c: DFAConsequence): void {
        c.listnext = this.freelistconsequence;
        this.freelistconsequence = c;
    }

    /** dmd/dfa/fast/structure.d:1223 — `void allObjects(scope void delegate(DFAObject* obj) del)`: newest first. */
    allObjects(del: (obj: DFAObject) => void): void {
        let current = this.allocatedlistobject;

        while (current !== null) {
            del(current);
            current = current.listnext;
        }
    }

    /** dmd/dfa/fast/structure.d:1234 — `void allVariables(scope void delegate(DFAVar* obj) del)`: newest first. */
    allVariables(del: (obj: DFAVar) => void): void {
        let current = this.allocatedlistvar;

        while (current !== null) {
            del(current);
            current = current.listnext;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:1246 — `T* allocInternal(T)(ref T* freelist)`: pops `freelist`, else carves
     * `sizeofT` bytes (D `T.sizeof`) at the bump pointer; the node is then reset to `T.init`.
     */
    private allocInternal<T extends Pooled<T>>(freelist: Slot<T | null>, sizeofT: number, create: () => T): T {
        // erased: `import core.stdc.string; import dmd.root.rmem;` (structure.d:1248-1249)

        let ret = freelist.get();

        if (ret !== null) {
            freelist.set(ret.listnext);
            // Initialize it to the right type: D's `memcpy(ret, cast(void*)&valInit, T.sizeof)` (structure.d:1303)
            // over the reused node.
            ret.resetToInit();
        }
        else {
            if (this.currentRegion === null) {
                const got = staticRegion;

                if (lastRegion === null) {
                    // `*got = Region(null, null, RegionAllocationStep);`
                    got.previous = null;
                    got.next = null;
                    got.length = RegionAllocationStep;
                }

                this.currentRegion = got;
                this.regionUsed = Region.sizeof;
            }
            else if (this.regionUsed + sizeofT >= this.currentRegion.length) {
                if (this.currentRegion.next !== null) {
                    this.currentRegion = this.currentRegion.next;
                    this.regionUsed = Region.sizeof;
                }
                else {
                    // Acquire the next block of memory to allocate from
                    // erased: `Mem.xmalloc(RegionAllocationStep)` -> a Region at the next simulated block address
                    const got = new Region(MALLOC_REGION_BASE + mallocRegionCount++ * RegionAllocationStep);
                    assert(got !== null);

                    // `*got = Region(currentRegion, null, RegionAllocationStep);`
                    got.previous = this.currentRegion;
                    got.next = null;
                    got.length = RegionAllocationStep;
                    this.currentRegion.next = got;
                    this.currentRegion = got;

                    lastRegion = got;
                    this.regionUsed = Region.sizeof;
                }
            }

            assert(this.currentRegion !== null);
            assert(this.regionUsed + sizeofT <= this.currentRegion.length);

            const pos = this.currentRegion.base + this.regionUsed;
            // Initialize it to the right type: a fresh node already holds `T.init` (the D memcpy).
            ret = create();
            ret.addr = pos;
            this.regionUsed += sizeofT;
        }

        assert(ret !== null);
        return ret;
    }

    /** 03 §6.3: D's implicit field-wise copy (every field is a pointer or a size, all shared/copied as values). */
    copy(): DFAAllocator {
        const c = new DFAAllocator();
        c.dfaCommon = this.dfaCommon;
        c.allocatedlistvar = this.allocatedlistvar;
        c.allocatedlistlastvar = this.allocatedlistlastvar;
        c.allocatedlistobject = this.allocatedlistobject;
        c.freelistlabel = this.freelistlabel;
        c.freelistcase = this.freelistcase;
        c.freelistvar = this.freelistvar;
        c.freelistscopevar = this.freelistscopevar;
        c.freelistobject = this.freelistobject;
        c.freelistscope = this.freelistscope;
        c.freelistlattice = this.freelistlattice;
        c.freelistconsequence = this.freelistconsequence;
        c.currentRegion = this.currentRegion;
        c.regionUsed = this.regionUsed;
        return c;
    }
}

/**
 * dmd/dfa/fast/structure.d:1310 — `struct DFALabelState`: the scope state recorded for forward jumps to a label.
 * Allocated from DFAAllocator, handled by pointer.
 */
export class DFALabelState implements Pooled<DFALabelState> {
    // D `private` block (structure.d:1312-1316).
    listnext: DFALabelState | null = null; // D module-private (DFAAllocator's free list)
    // dropped: `DFALabelState* next` (structure.d:1315), the bucket chain of DFACommon.forwardLabels, now a Map.

    ident: Identifier | null = null;
    readonly scr: DFAScopeRef = new DFAScopeRef();

    /// Simulated address of this node's region slot (file header); not a D field.
    addr = 0;

    /// resolved: DFALabelState.sizeof -> 32 (ldc2 1.43.0 probe).
    static readonly sizeof = 32;

    /** D `memcpy(this, &DFALabelState.init)`: every field back to `.init`, in place (03 §1.1). */
    resetToInit(): void {
        this.listnext = null;
        this.ident = null;
        this.scr.sc = null;
    }
}

/**
 * dmd/dfa/fast/structure.d:1322 — `struct DFACaseState`: the scope states of one `case`/`default` of a switch.
 * Allocated from DFAAllocator, handled by pointer.
 */
export class DFACaseState implements Pooled<DFACaseState> {
    // D `private` block (structure.d:1324-1328).
    listnext: DFACaseState | null = null; // D module-private (DFAAllocator's free list)
    // dropped: `DFACaseState* next` (structure.d:1327), the bucket chain of DFACommon.caseEntries, now a Map.

    caseStatement: Statement | null = null; // default case or case
    readonly containing: DFAScopeRef = new DFAScopeRef();
    readonly jumpedTo: DFAScopeRef = new DFAScopeRef(); // When its jumped to this case, this is the meet'd state

    /// Simulated address of this node's region slot (file header); not a D field.
    addr = 0;

    /// resolved: DFACaseState.sizeof -> 40 (ldc2 1.43.0 probe).
    static readonly sizeof = 40;

    /** D `memcpy(this, &DFACaseState.init)`: every field back to `.init`, in place (03 §1.1). */
    resetToInit(): void {
        this.listnext = null;
        this.caseStatement = null;
        this.containing.sc = null;
        this.jumpedTo.sc = null;
    }
}

/***********************************************************
 * Represents the identity of a variable being tracked.
 *
 * This does NOT store the current value of the variable (that changes depending on
 * where you are in the code). Instead, it stores immutable properties like:
 * - Is it a boolean? (`isBoolean`)
 * - Can it be null? (`isNullable`)
 * - Is it a reference to another variable? (`base1`, `indexVar`)
 *
 * Think of this as the "Key" in a map, where the "Value" is the DFALattice.
 *
 * dmd/dfa/fast/structure.d:1346 — `struct DFAVar`. Allocated from DFAAllocator, never freed, handled by pointer.
 */
export class DFAVar implements Pooled<DFAVar> {
    // D `private` block (structure.d:1348-1354).
    listnext: DFAVar | null = null; // D module-private (DFAAllocator's allocated list)
    next: DFAVar | null = null; // D module-private (DFACommon's pair / offset chains)
    /// D `DFAVar*[16] childVars`, keyed by the field's VarDeclaration address: a Map (file header).
    childVars: Map<VarDeclaration | null, DFAVar> = new Map(); // D module-private (DFAAllocator.makeVar)
    childOffsetVars: DFAVar | null = null; // D module-private (DFACommon.findOffsetVar)

    base1: DFAVar | null = null;
    base2: DFAVar | null = null;

    indexVar: DFAVar | null = null;
    lengthVar: DFAVar | null = null;
    asSliceVar: DFAVar | null = null;

    var: VarDeclaration | null = null;
    offsetFromBase: dinteger_t = 0n; // -1 if its not an offset

    isAnIndex = false; // base1[index] = this
    isLength = false; // T[].length

    isTruthy = false;
    isNullable = false;

    isBoolean = false;
    isStaticArray = false;
    isFloatingPoint = false;
    isByRef = false;

    haveInfiniteLifetime = false;
    wasDefaultInitialized = false; // may not be accurate for all variables

    declaredAtDepth = 0;
    writeCount = 0;

    dereferenceVar: DFAVar | null = null; // child var

    unmodellable = false; // DO NOT REPORT!!!!
    doNotInferNonNull = false; // i.e. was the rhs of >
    assertedCount = 0;

    param: ParameterDFAInfo | null = null;

    storageFor: DFAObject | null = null;

    /// Simulated address of this node's region slot (file header); not a D field. The bucket key of every
    /// DFAVar-keyed hash table.
    addr = 0;

    /// resolved: DFAVar.sizeof -> 264 (ldc2 1.43.0 probe).
    static readonly sizeof = 264;

    /** D `memcpy(this, &DFAVar.init)`: every field back to `.init`, in place (03 §1.1). */
    resetToInit(): void {
        this.listnext = null;
        this.next = null;
        this.childVars.clear();
        this.childOffsetVars = null;
        this.base1 = null;
        this.base2 = null;
        this.indexVar = null;
        this.lengthVar = null;
        this.asSliceVar = null;
        this.var = null;
        this.offsetFromBase = 0n;
        this.isAnIndex = false;
        this.isLength = false;
        this.isTruthy = false;
        this.isNullable = false;
        this.isBoolean = false;
        this.isStaticArray = false;
        this.isFloatingPoint = false;
        this.isByRef = false;
        this.haveInfiniteLifetime = false;
        this.wasDefaultInitialized = false;
        this.declaredAtDepth = 0;
        this.writeCount = 0;
        this.dereferenceVar = null;
        this.unmodellable = false;
        this.doNotInferNonNull = false;
        this.assertedCount = 0;
        this.param = null;
        this.storageFor = null;
    }

    /** dmd/dfa/fast/structure.d:1393 — `bool haveBase()`: this variable is derived from another. */
    haveBase(): boolean {
        return this.base1 !== null;
    }

    /// Finds the root variables for this one, where base1 is null
    /// dmd/dfa/fast/structure.d:1399 — `void walkRoots(scope void delegate(DFAVar* var) del)`: calls `del` on
    /// each root (both sides of a pair).
    walkRoots(del: (var_: DFAVar) => void): void {
        const handle = (temp: DFAVar): void => {
            while (temp.base1 !== null && temp.base2 === null) {
                temp = temp.base1;
            }

            if (temp.base2 !== null) {
                handle(temp.base1!);
                handle(temp.base2);
            }
            else
                del(temp);
        };

        handle(this);
    }

    /// Walk all variables that end up at a root
    /// dmd/dfa/fast/structure.d:1421 — `void walkToRoot(scope void delegate(DFAVar* var) del)`: calls `del` on
    /// this variable and every one between it and its roots, roots included.
    walkToRoot(del: (var_: DFAVar) => void): void {
        const handle = (temp: DFAVar): void => {
            while (temp.base1 !== null && temp.base2 === null) {
                del(temp);
                temp = temp.base1;
            }

            if (temp.base2 !== null) {
                handle(temp.base1!);
                handle(temp.base2);
            }
            else
                del(temp);
        };

        handle(this);
    }

    /// Visit the base1 and base2 if present
    /// dmd/dfa/fast/structure.d:1444 — `void visitFirstBase(scope void delegate(DFAVar* var) del)`.
    visitFirstBase(del: (var_: DFAVar) => void): void {
        if (this.base1 === null)
            return;

        del(this.base1);

        if (this.base2 !== null)
            del(this.base2);
    }

    /**
     * dmd/dfa/fast/structure.d:1455 — `void visitDereferenceBases(scope void delegate(DFAVar* var) del)`: walks
     * down through dereferences and unnamed offsets, calling `del` on the variable each chain stops at.
     */
    visitDereferenceBases(del: (var_: DFAVar) => void): void {
        const handle = (var_: DFAVar): void => {
            while (var_.base2 === null && var_.base1 !== null && (var_.base1.dereferenceVar === var_
                    || (var_.offsetFromBase !== toUint64(-1n) && var_.var === null))) {
                var_ = var_.base1;
            }

            if (var_.base2 !== null) {
                handle(var_.base1!);
                handle(var_.base2);
            }
            else
                del(var_);
        };

        handle(this);
    }

    /// If this variable is a reference to another variable, visit the base variable.
    /// dmd/dfa/fast/structure.d:1479 — `void visitIfReferenceToAnotherVar(scope void delegate(DFAVar* var) del)`:
    /// `del` sees each base reached through at least one offset, dereference or index step.
    visitIfReferenceToAnotherVar(del: (var_: DFAVar) => void): void {
        const handle = (var_: DFAVar, refed: number): void => {
            while (var_.base2 === null && var_.base1 !== null) {
                if (var_.offsetFromBase !== toUint64(-1n))
                    refed++;
                else if (var_.base1.dereferenceVar === var_)
                    refed++;
                else if (var_.base1.indexVar === var_)
                    refed++;
                else
                    break;

                var_ = var_.base1;
            }

            if (var_.base2 !== null) {
                handle(var_.base1!, refed);
                handle(var_.base2, refed);
            }
            else if (refed !== 0)
                del(var_);
        };

        handle(this, 0);
    }

    /// If this variable is a reference to another, takes into account dereferencing.
    /// dmd/dfa/fast/structure.d:1510 — `void visitReferenceToAnotherVar(scope void delegate(DFAVar* var)`:
    /// a base reached with net positive indirection goes to `hasIndirection`, otherwise to `noIndirection`.
    visitReferenceToAnotherVar(hasIndirection: ((var_: DFAVar) => void) | null,
            noIndirection: ((var_: DFAVar) => void) | null = null): void {
        const handle = (var_: DFAVar, refed: number): void => {
            while (var_.base2 === null && var_.base1 !== null) {
                if (var_.offsetFromBase !== toUint64(-1n) && var_.var === null)
                    refed++;
                else if (var_.base1.dereferenceVar === var_)
                    refed--;
                else if (var_.base1.indexVar === var_)
                    refed++;
                else
                    break;

                var_ = var_.base1;
            }

            if (var_.base2 !== null) {
                handle(var_.base1!, refed);
                handle(var_.base2, refed);
            }
            else if (refed > 0) {
                if (hasIndirection !== null)
                    hasIndirection(var_);
            }
            else if (noIndirection !== null)
                noIndirection(var_);
        };

        handle(this, 0);
    }

    /// If this variable is a reference to another, takes into account dereferencing.
    /// dmd/dfa/fast/structure.d:1547 — `void visitIfReadOfReferenceToAnotherVar(scope void delegate(DFAVar* var)`:
    /// `resolvedIndirection` sees each base whose read goes through net dereferencing.
    visitIfReadOfReferenceToAnotherVar(resolvedIndirection: (var_: DFAVar) => void): void {
        const handle = (var_: DFAVar, refed: number): void => {
            if (!(var_.base1 !== null || var_.base2 !== null || refed !== 0))
                return;

            while (var_.base2 === null && var_.base1 !== null) {
                if (var_.offsetFromBase !== toUint64(-1n) && var_.var === null)
                    refed++;
                else if (var_.base1.dereferenceVar === var_)
                    refed--;
                else if (var_.base1.indexVar === var_)
                    refed++;
                else if (var_.base1.lengthVar === var_ && var_.base1.isStaticArray && !var_.base1.haveBase())
                    return; // Statically known length, base doesn't matter as it won't be read
                else if (var_.base1.asSliceVar === var_ && !var_.base1.haveBase() && refed === 0)
                    return; // base1[] is a slice this does not inherently make it a read
                else
                    break;

                var_ = var_.base1;
            }

            if (var_.base2 !== null) {
                handle(var_.base1!, refed);
                handle(var_.base2, refed);
            }
            else if (refed < 0)
                resolvedIndirection(var_);
        };

        handle(this, 0);
    }

    /** dmd/dfa/fast/structure.d:1585 — `bool isModellable()`: no root this variable derives from is unmodellable. */
    isModellable(): boolean {
        let ret = true;

        const handle = (var_: DFAVar): void => {
            if (var_.base1 === null) {
                if (var_.unmodellable)
                    ret = false;
            }
            else {
                handle(var_.base1);
                if (ret && var_.base2 !== null)
                    handle(var_.base2);
            }
        };

        handle(this);
        return ret;
    }

    /** 03 §6.3: D's implicit field-wise copy (pointers shared; the child-variable table copied over the nodes). */
    copy(): DFAVar {
        const c = new DFAVar();
        c.listnext = this.listnext;
        c.next = this.next;
        c.childVars = new Map(this.childVars);
        c.childOffsetVars = this.childOffsetVars;
        c.base1 = this.base1;
        c.base2 = this.base2;
        c.indexVar = this.indexVar;
        c.lengthVar = this.lengthVar;
        c.asSliceVar = this.asSliceVar;
        c.var = this.var;
        c.offsetFromBase = this.offsetFromBase;
        c.isAnIndex = this.isAnIndex;
        c.isLength = this.isLength;
        c.isTruthy = this.isTruthy;
        c.isNullable = this.isNullable;
        c.isBoolean = this.isBoolean;
        c.isStaticArray = this.isStaticArray;
        c.isFloatingPoint = this.isFloatingPoint;
        c.isByRef = this.isByRef;
        c.haveInfiniteLifetime = this.haveInfiniteLifetime;
        c.wasDefaultInitialized = this.wasDefaultInitialized;
        c.declaredAtDepth = this.declaredAtDepth;
        c.writeCount = this.writeCount;
        c.dereferenceVar = this.dereferenceVar;
        c.unmodellable = this.unmodellable;
        c.doNotInferNonNull = this.doNotInferNonNull;
        c.assertedCount = this.assertedCount;
        c.param = this.param;
        c.storageFor = this.storageFor;
        return c;
    }
}

/**
 * dmd/dfa/fast/structure.d:1610 — `struct DFAScopeVar`: the per-scope state of one variable (its lattice, the
 * loop-gate predicates, depth bookkeeping). Allocated from DFAAllocator, handled by pointer.
 */
export class DFAScopeVar implements Pooled<DFAScopeVar> {
    // D `private` block (structure.d:1612-1616).
    listnext: DFAScopeVar | null = null; // D module-private (DFAAllocator's free list)
    next: DFAScopeVar | null = null; // D module-private (DFAScope's bucket chains)

    var: DFAVar | null = null;
    readonly lr: DFALatticeRef = new DFALatticeRef();

    gatePredicateWriteCount = 0;
    readonly lrGatePredicate: DFALatticeRef = new DFALatticeRef();
    readonly lrGateNegatedPredicate: DFALatticeRef = new DFALatticeRef();

    derefDepth = 0;
    derefAssertedDepth = 0;

    assignDepth = 0;
    assertDepth = 0;
    assertTrueDepth = 0;
    assertFalseDepth = 0;

    mergable: DFAScopeVarMergable = new DFAScopeVarMergable();

    /// Simulated address of this node's region slot (file header); not a D field.
    addr = 0;

    /// resolved: DFAScopeVar.sizeof -> 88 (ldc2 1.43.0 probe).
    static readonly sizeof = 88;

    /** D `memcpy(this, &DFAScopeVar.init)`: every field back to `.init`, in place (03 §1.1). */
    resetToInit(): void {
        this.listnext = null;
        this.next = null;
        this.var = null;
        this.lr.lattice = null;
        this.gatePredicateWriteCount = 0;
        this.lrGatePredicate.lattice = null;
        this.lrGateNegatedPredicate.lattice = null;
        this.derefDepth = 0;
        this.derefAssertedDepth = 0;
        this.assignDepth = 0;
        this.assertDepth = 0;
        this.assertTrueDepth = 0;
        this.assertFalseDepth = 0;
        this.mergable.nullAssignWriteCount = 0;
        this.mergable.nullAssignAssertedCount = 0;
    }
}

/** dmd/dfa/fast/structure.d:1634 — `struct DFAScopeVarMergable`: counts merged by maximum. A value struct. */
export class DFAScopeVarMergable {
    nullAssignWriteCount = 0;
    nullAssignAssertedCount = 0;

    /**
     * dmd/dfa/fast/structure.d:1639 — `void merge(DFAScopeVarMergable other)`: each count becomes the larger of
     * the two. `other` is by value (the caller copies, 03 §3.1); it is only read.
     */
    merge(other: DFAScopeVarMergable): void {
        if (other.nullAssignWriteCount > this.nullAssignWriteCount)
            this.nullAssignWriteCount = other.nullAssignWriteCount;
        if (other.nullAssignAssertedCount > this.nullAssignAssertedCount)
            this.nullAssignAssertedCount = other.nullAssignAssertedCount;
    }

    /** 03 §2: field-wise value copy. */
    copy(): DFAScopeVarMergable {
        const c = new DFAScopeVarMergable();
        c.nullAssignWriteCount = this.nullAssignWriteCount;
        c.nullAssignAssertedCount = this.nullAssignAssertedCount;
        return c;
    }
}

/**
 * dmd/dfa/fast/structure.d:1648 — `struct DFAObject`: an abstract object a non-null pointer points to, possibly
 * derived from one or two others. Allocated from DFAAllocator, handled by pointer.
 */
export class DFAObject implements Pooled<DFAObject> {
    // D `private` block (structure.d:1650-1653).
    listnext: DFAObject | null = null; // D module-private (DFAAllocator's allocated list)

    storageFor: DFAVar | null = null;

    base1: DFAObject | null = null;
    base2: DFAObject | null = null;

    // Pointer arithmetic may mean this object isn't 1:1 with the object start.
    mayNotBeExactPointer = false;

    /// Simulated address of this node's region slot (file header); not a D field.
    addr = 0;

    /// resolved: DFAObject.sizeof -> 40 (ldc2 1.43.0 probe).
    static readonly sizeof = 40;

    /** D `memcpy(this, &DFAObject.init)`: every field back to `.init`, in place (03 §1.1). */
    resetToInit(): void {
        this.listnext = null;
        this.storageFor = null;
        this.base1 = null;
        this.base2 = null;
        this.mayNotBeExactPointer = false;
    }

    /**
     * dmd/dfa/fast/structure.d:1663 — `void walkRoots(scope void delegate(DFAObject* root) del)`: calls `del` on
     * every root object (base-less), `base2` sides first, the `base1` spine's root last.
     */
    walkRoots(del: (root: DFAObject) => void): void {
        let obj: DFAObject = this;

        while (obj.base1 !== null) {
            if (obj.base2 !== null)
                obj.base2.walkRoots(del);

            obj = obj.base1;
        }

        del(obj);
    }

    /** 03 §6.3: D's implicit field-wise copy (pointers shared). */
    copy(): DFAObject {
        const c = new DFAObject();
        c.listnext = this.listnext;
        c.storageFor = this.storageFor;
        c.base1 = this.base1;
        c.base2 = this.base2;
        c.mayNotBeExactPointer = this.mayNotBeExactPointer;
        return c;
    }
}

/**
 * dmd/dfa/fast/structure.d:1679 — `struct DFAScopeRef`: an OWNING handle on a detached DFAScope (file header,
 * OWNERSHIP PROTOCOL). Copying moves the scope; destroying frees it into the allocator.
 */
export class DFAScopeRef {
    // package
    sc: DFAScope | null = null;

    /**
     * `new DFAScopeRef()` is D's `DFAScopeRef.init`. `new DFAScopeRef(other)` is the copy constructor
     * dmd/dfa/fast/structure.d:1685 — `this(ref DFAScopeRef other)` (`static if (DFACleanup)`, resolved true):
     * it takes `other`'s scope and leaves `other` null.
     */
    constructor(other?: DFAScopeRef) {
        if (other !== undefined) {
            this.sc = other.sc;
            other.sc = null;
        }
    }

    /** dmd/dfa/fast/structure.d:1691 — `~this()`: frees the owned scope, if any, and nulls the handle. */
    __dtor(): void {
        if (this.sc === null)
            return;

        this.sc.dfaCommon!.allocator.freeFromDFAScope(this.sc);
        this.sc = null;
    }

    /**
     * D's compiler-generated `opAssign` (copy ctor + dtor present): `rhs` is the already-constructed by-value
     * parameter (`new DFAScopeRef(lvalue)` or an rvalue); the handles swap and the old value is destroyed.
     */
    opAssign(rhs: DFAScopeRef): void {
        const old = this.sc;
        this.sc = rhs.sc;
        rhs.sc = old;
        rhs.__dtor();
    }

    /** dmd/dfa/fast/structure.d:1701 — `bool isNull()`. */
    isNull(): boolean {
        return this.sc === null;
    }

    /** dmd/dfa/fast/structure.d:1706 — `DFAScopeVar* findScopeVar(DFAVar* contextVar)`: null on a null handle. */
    findScopeVar(contextVar: DFAVar | null): DFAScopeVar | null {
        if (this.sc === null)
            return null;

        return this.sc.findScopeVar(contextVar);
    }

    /** dmd/dfa/fast/structure.d:1714 — `DFAScopeVar* getScopeVar(DFAVar* contextVar)`: null on a null handle. */
    getScopeVar(contextVar: DFAVar | null): DFAScopeVar | null {
        if (this.sc === null)
            return null;

        return this.sc.getScopeVar(contextVar);
    }

    /**
     * dmd/dfa/fast/structure.d:1722 — `DFALatticeRef consumeNext(out DFAVar* contextVar, out DFAScopeVarMergable`.
     * Removes the first scope variable in bucket order, frees it, and returns its lattice (moved out) with its
     * variable and counts in the out parameters; a null handle and null `contextVar` once the scope is empty.
     */
    consumeNext(contextVar: Ref<DFAVar | null>, mergable: Ref<DFAScopeVarMergable>): DFALatticeRef {
        contextVar.value = null; // `out` parameters reset on entry (03 §3.3)
        mergable.value = new DFAScopeVarMergable();

        if (this.sc === null)
            return new DFALatticeRef();

        for (let i = 0; i < this.sc.buckets.length; i++) {
            if (this.sc.buckets[i] === null)
                continue;

            const scv = this.sc.buckets[i]!;
            contextVar.value = scv.var;
            mergable.value = scv.mergable.copy();
            this.sc.buckets[i] = scv.next;

            const lr = new DFALatticeRef(scv.lr); // copy ctor: the lattice moves out of `scv.lr`
            this.sc.dfaCommon!.allocator.free(scv);
            return lr;
        }

        return new DFALatticeRef();
    }

    /**
     * dmd/dfa/fast/structure.d:1745 — `DFALatticeRef consumeVar(DFAVar* contextVar, out DFAScopeVarMergable`.
     * Removes `contextVar`'s scope variable, frees it, and returns its lattice (moved out); a null handle when
     * the scope does not track `contextVar`.
     */
    consumeVar(contextVar: DFAVar | null, mergable: Ref<DFAScopeVarMergable>): DFALatticeRef {
        mergable.value = new DFAScopeVarMergable(); // `out` parameter reset on entry (03 §3.3)

        if (this.sc === null)
            return new DFALatticeRef();

        let bucket: Slot<DFAScopeVar | null> =
            arraySlot(this.sc.buckets, dfaVarAddress(contextVar) % this.sc.buckets.length);

        while (bucket.get() !== null && dfaVarAddress(bucket.get()!.var) < dfaVarAddress(contextVar))
            bucket = fieldSlot(bucket.get()!, "next");

        if (bucket.get() === null || bucket.get()!.var !== contextVar)
            return new DFALatticeRef();

        const scv = bucket.get()!;
        mergable.value = scv.mergable.copy();
        const lr = new DFALatticeRef(scv.lr); // copy ctor: the lattice moves out of `scv.lr`

        bucket.set(scv.next);
        this.sc.dfaCommon!.allocator.free(scv);
        return lr;
    }

    /**
     * dmd/dfa/fast/structure.d:1767 — `DFAScopeVar* assignLattice(DFAVar* contextVar, DFALatticeRef lr)`: stores
     * `lr` (moved) as `contextVar`'s lattice in the owned scope. `lr` is a by-value parameter: this callee destroys
     * it at exit, which frees the lattice when the handle is null and nothing took it over.
     */
    assignLattice(contextVar: DFAVar | null, lr: DFALatticeRef): DFAScopeVar | null {
        try {
            if (this.isNull())
                return null;
            this.check();

            const ret = this.sc!.assignLattice(contextVar, new DFALatticeRef(lr));

            this.check();
            return ret;
        } finally {
            lr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/structure.d:1779 — `void printStructure(const(char)* prefix = "", int sdepth = 0,`: debug dump
     * (the scope's own printStructure is resolved to a no-op).
     */
    printStructure(prefix: DString = ds(""), sdepth = 0, currentFunction: FuncDeclaration | null = null,
            depth = 0): void {
        if (this.isNull())
            return;

        this.sc!.printStructure(prefix, sdepth, currentFunction, depth);
    }

    /**
     * dmd/dfa/fast/structure.d:1788 — `void printState(const(char)* prefix = "", int sdepth = 0,`: debug dump
     * (the scope's own printState is resolved to a no-op).
     */
    printState(prefix: DString = ds(""), sdepth = 0, currentFunction: FuncDeclaration | null = null,
            depth = 0): void {
        if (this.isNull())
            return;

        this.sc!.printState(prefix, sdepth, currentFunction, depth);
    }

    /// dmd/dfa/fast/structure.d:1797 — `void printActual(` — dropped with the debug dumpers (file header).

    /**
     * dmd/dfa/fast/structure.d:1806 — `int opApply(scope int delegate(DFALattice*) dg)`: 05 §11 protocol over
     * the owned scope's lattices (0 on a null handle).
     */
    opApply(dg: (l: DFALattice) => number): number {
        if (this.sc === null)
            return 0;

        return this.sc.opApply(dg);
    }

    /**
     * dmd/dfa/fast/structure.d:1814 — `int opApply(scope int delegate(DFAVar*, DFALattice*) dg)` (renamed,
     * 05 §9b).
     */
    opApply_DFAVar_DFALattice(dg: (var_: DFAVar | null, l: DFALattice) => number): number {
        if (this.sc === null)
            return 0;

        return this.sc.opApply_DFAVar_DFALattice(dg);
    }

    /**
     * dmd/dfa/fast/structure.d:1822 — `int opApply(scope int delegate(DFAVar*, DFALattice*, DFAScopeVar*) dg)`
     * (renamed, 05 §9b).
     */
    opApply_DFAVar_DFALattice_DFAScopeVar(
            dg: (var_: DFAVar | null, l: DFALattice, scv: DFAScopeVar) => number): number {
        if (this.sc === null)
            return 0;

        return this.sc.opApply_DFAVar_DFALattice_DFAScopeVar(dg);
    }

    /**
     * dmd/dfa/fast/structure.d:1830 — `DFAScopeRef copy()`: a DOMAIN copy — a new scope (same parent and depth)
     * holding a copy of every variable's lattice. Not the 03 value copy (file header).
     */
    copy(): DFAScopeRef {
        if (this.isNull())
            return new DFAScopeRef();

        return this.sc!.copy();
    }

    /** dmd/dfa/fast/structure.d:1838 — `void check()`: the owned scope's self-check (a no-op, debugVerify OFF). */
    check(): void {
        if (!this.isNull())
            this.sc!.check();
    }
}

/***********************************************************
 * Represents a specific region of code execution (a scope).
 *
 * As the DFA walks through the code, it pushes and pops scopes.
 * Each scope holds a table (`buckets`) of the current state of variables
 * within that block.
 *
 * When the analysis branches (e.g., inside an `if`), a new child scope is
 * created to track the state changes specific to that branch.
 *
 * dmd/dfa/fast/structure.d:1855 — `struct DFAScope`. Allocated from DFAAllocator, handled by pointer. The 16
 * buckets hash a variable by `address % 16` and keep each chain ascending by address; that is also the order
 * `opApply`, `copy` and `consumeNext` visit the variables in.
 */
export class DFAScope implements Pooled<DFAScope> {
    // D `private` block (structure.d:1857-1863).
    dfaCommon: DFACommon | null = null; // D module-private (DFAAllocator, DFAScopeRef)
    listnext: DFAScope | null = null; // D module-private (DFAAllocator's free list)
    previousLoopyLabel: DFAScope | null = null; // D module-private (DFACommon, DFAAllocator)
    previousCatch: DFAScope | null = null; // D module-private (DFACommon, DFAAllocator)

    parent: DFAScope | null = null;
    child: DFAScope | null = null;
    readonly buckets: (DFAScopeVar | null)[] = new Array<DFAScopeVar | null>(16).fill(null);
    depth = 0;

    haveJumped = false; // thrown, goto, break, continue, return
    haveReturned = false;
    isLoopyLabel = false; // Is a loop or label
    isLoopyLabelKnownToHaveRun = false; // was the loopy label guaranteed to have at least one iteration?
    inConditional = false;
    sideEffectFree = false; // No side effects should be stored in this scope use a parent instead.

    // needed to apply on iteration for continue, loops switch statements ext.
    controlStatement: Statement | null = null;
    label: LabelStatement | null = null;

    compoundStatement: CompoundStatement | null = null;
    inProgressCompoundStatement = 0;

    tryFinallyStatement: TryFinallyStatement | null = null;

    readonly beforeScopeState: DFAScopeRef = new DFAScopeRef();
    readonly afterScopeState: DFAScopeRef = new DFAScopeRef();

    /// Simulated address of this node's region slot (file header); not a D field.
    addr = 0;

    /// resolved: DFAScope.sizeof -> 248 (ldc2 1.43.0 probe).
    static readonly sizeof = 248;

    /** D `memcpy(this, &DFAScope.init)`: every field back to `.init`, in place (03 §1.1). */
    resetToInit(): void {
        this.dfaCommon = null;
        this.listnext = null;
        this.previousLoopyLabel = null;
        this.previousCatch = null;
        this.parent = null;
        this.child = null;
        this.buckets.fill(null);
        this.depth = 0;
        this.haveJumped = false;
        this.haveReturned = false;
        this.isLoopyLabel = false;
        this.isLoopyLabelKnownToHaveRun = false;
        this.inConditional = false;
        this.sideEffectFree = false;
        this.controlStatement = null;
        this.label = null;
        this.compoundStatement = null;
        this.inProgressCompoundStatement = 0;
        this.tryFinallyStatement = null;
        this.beforeScopeState.sc = null;
        this.afterScopeState.sc = null;
    }

    /**
     * dmd/dfa/fast/structure.d:1886 — `DFALattice* findLattice(DFAVar* contextVar)`: the lattice this scope holds
     * for `contextVar`, or null. Precondition: `contextVar` is non-null.
     */
    findLattice(contextVar: DFAVar | null): DFALattice | null {
        assert(contextVar !== null); // if this is null idk what is going on!

        let bucket = this.buckets[dfaVarAddress(contextVar) % this.buckets.length];

        while (bucket !== null && dfaVarAddress(bucket.var) < dfaVarAddress(contextVar)) {
            bucket = bucket.next;
        }

        if (bucket === null || bucket.var !== contextVar)
            return null;

        const cctx = bucket.lr.getContext();
        if (cctx !== null) {
            assert(cctx.var === contextVar);
        }

        return bucket.lr.lattice;
    }

    /**
     * dmd/dfa/fast/structure.d:1909 — `DFAScopeVar* findScopeVar(DFAVar* contextVar)`: this scope's entry for
     * `contextVar`, or null. Precondition: `contextVar` is non-null.
     */
    findScopeVar(contextVar: DFAVar | null): DFAScopeVar | null {
        assert(contextVar !== null); // if this is null idk what is going on!

        let bucket = this.buckets[dfaVarAddress(contextVar) % this.buckets.length];

        let lastVar: DFAVar | null = null;

        while (bucket !== null && dfaVarAddress(bucket.var) < dfaVarAddress(contextVar)
                && dfaVarAddress(lastVar) < dfaVarAddress(bucket.var)) {
            lastVar = bucket.var;
            bucket = bucket.next;
        }

        if (bucket === null || bucket.var !== contextVar)
            return null;
        return bucket;
    }

    /**
     * dmd/dfa/fast/structure.d:1928 — `DFAScopeVar* getScopeVar(DFAVar* contextVar)`: this scope's entry for
     * `contextVar`, created with a fresh lattice whose context is `contextVar` when missing. Null `contextVar`
     * answers null.
     */
    getScopeVar(contextVar: DFAVar | null): DFAScopeVar | null {
        if (contextVar === null)
            return null;

        this.check();
        let bucket: Slot<DFAScopeVar | null> = arraySlot(this.buckets, dfaVarAddress(contextVar) % this.buckets.length);

        while (bucket.get() !== null && dfaVarAddress(bucket.get()!.var) < dfaVarAddress(contextVar))
            bucket = fieldSlot(bucket.get()!, "next");

        let scv = bucket.get();

        if (scv === null || scv.var !== contextVar) {
            scv = this.dfaCommon!.allocator.makeScopeVar(this.dfaCommon, contextVar);

            const temp = this.dfaCommon!.makeLatticeRef();
            temp.setContextFromDFAVar(contextVar);
            scv.lr.opAssign(new DFALatticeRef(temp));

            scv.next = bucket.get();
            bucket.set(scv);
            temp.__dtor(); // D destroys the block-local `temp` (already moved, so a no-op)
        }

        this.check();
        return scv;
    }

    /**
     * dmd/dfa/fast/structure.d:1957 — `DFAScopeVar* createAndInheritLattice(DFAVar* contextVar, DFALattice*`:
     * this scope's entry for `contextVar` (created when missing); an entry without a lattice gets a copy of
     * `copyFrom` (or a fresh lattice) with `contextVar` as context. Precondition: `contextVar` is non-null.
     */
    createAndInheritLattice(contextVar: DFAVar | null, copyFrom: DFALattice | null): DFAScopeVar {
        assert(contextVar !== null); // if this is null idk what is going on!

        let bucket: Slot<DFAScopeVar | null> = arraySlot(this.buckets, dfaVarAddress(contextVar) % this.buckets.length);

        while (bucket.get() !== null && dfaVarAddress(bucket.get()!.var) < dfaVarAddress(contextVar))
            bucket = fieldSlot(bucket.get()!, "next");

        let scv = bucket.get();

        if (scv === null || scv.var !== contextVar) {
            scv = this.dfaCommon!.allocator.makeScopeVar(this.dfaCommon, contextVar);
            scv.next = bucket.get();
            bucket.set(scv);
        }

        if (scv.lr.isNull()) {
            scv.lr.opAssign(copyFrom !== null ? copyFrom.copy() : this.dfaCommon!.makeLatticeRef());
            scv.lr.setContextFromDFAVar(contextVar);
        }

        return scv;
    }

    /**
     * dmd/dfa/fast/structure.d:1984 — `DFAScopeVar* assignLattice(DFAVar* contextVar, DFALatticeRef lr)`: stores
     * `lr` (moved, context set to `contextVar`) as the entry's lattice, creating the entry when missing; the old
     * lattice is destroyed. A null `lr` answers null. `lr` is by value: this callee destroys it at exit.
     */
    assignLattice(contextVar: DFAVar | null, lr: DFALatticeRef): DFAScopeVar | null {
        try {
            if (lr.isNull())
                return null;

            let bucket: Slot<DFAScopeVar | null> =
                arraySlot(this.buckets, dfaVarAddress(contextVar) % this.buckets.length);

            while (bucket.get() !== null && dfaVarAddress(bucket.get()!.var) < dfaVarAddress(contextVar))
                bucket = fieldSlot(bucket.get()!, "next");

            let scv = bucket.get();

            if (scv === null || scv.var !== contextVar) {
                scv = this.dfaCommon!.allocator.makeScopeVar(this.dfaCommon, contextVar);
                scv.next = bucket.get();
                bucket.set(scv);
            }

            lr.setContextFromDFAVar(contextVar);
            scv.lr.opAssign(new DFALatticeRef(lr));
            scv.lr.check();

            return scv;
        } finally {
            lr.__dtor();
        }
    }

    /**
     * dmd/dfa/fast/structure.d:2010 — `void printStructure(const(char)* prefix = "", int sdepth = 0,`. Debug dump,
     * resolved away: `static if (!this.dfaCommon.debugStructure)` -> true, so it returns at once.
     */
    printStructure(_prefix: DString = ds(""), _sdepth = 0, _currentFunction: FuncDeclaration | null = null,
            _depth = 0): void {
        // resolved: static if (!debugStructure) -> true (structure.d:2013): `return;`, the printActual arm dropped
    }

    /**
     * dmd/dfa/fast/structure.d:2019 — `void printState(const(char)* prefix = "", int sdepth = 0,`. Debug dump,
     * resolved away: `static if (!this.dfaCommon.debugIt)` -> true, so it returns at once.
     */
    printState(_prefix: DString = ds(""), _sdepth = 0, _currentFunction: FuncDeclaration | null = null,
            _depth = 0): void {
        // resolved: static if (!debugIt) -> true (structure.d:2022): `return;`, the printActual arm dropped
    }

    /// dmd/dfa/fast/structure.d:2028 — `void printActual(` — dropped with the debug dumpers (file header).

    /**
     * dmd/dfa/fast/structure.d:2090 — `DFAScopeRef copy()`: a DOMAIN copy — a new scope with the same parent and
     * depth and, in bucket order, a copy of every variable's lattice. Flags, statements and the before/after
     * states are not copied.
     */
    copy(): DFAScopeRef {
        const ret = new DFAScopeRef();
        ret.sc = this.dfaCommon!.allocator.makeScope(this.dfaCommon!, this.parent);
        ret.sc.depth = this.depth;

        // not everything is copied over as it isn't important

        this.opApply_DFAVar_DFALattice_DFAScopeVar((var_: DFAVar | null, lr: DFALattice, _scv: DFAScopeVar) => {
            ret.sc!.createAndInheritLattice(var_, lr);
            return 0;
        });

        ret.check();
        return ret;
    }

    /** dmd/dfa/fast/structure.d:2107 — `void check()`: the debugVerify self-check, resolved OFF (no-op). */
    check(): void {
        // resolved: static if (DFACommon.debugVerify) -> false (structure.d:2109), block dropped
    }

    /**
     * dmd/dfa/fast/structure.d:2127 — `int opApply(scope int delegate(DFALattice*) dg)`: 05 §11 protocol over the
     * scope variables in bucket order (every entry holds a lattice).
     */
    opApply(dg: (l: DFALattice) => number): number {
        let ret = 0;

        for (let i = 0; i < this.buckets.length; i++) {
            let scv = this.buckets[i];
            while (scv !== null) {
                ret = dg(scv.lr.lattice!);
                if (ret !== 0)
                    return ret;

                scv = scv.next;
            }
        }

        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:2146 — `int opApply(scope int delegate(DFAVar*, DFALattice*) dg)` (renamed, 05 §9b).
     */
    opApply_DFAVar_DFALattice(dg: (var_: DFAVar | null, l: DFALattice) => number): number {
        let ret = 0;

        for (let i = 0; i < this.buckets.length; i++) {
            let scv = this.buckets[i];
            while (scv !== null) {
                ret = dg(scv.var, scv.lr.lattice!);
                if (ret !== 0)
                    return ret;

                scv = scv.next;
            }
        }

        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:2165 — `int opApply(scope int delegate(DFAVar*, DFALattice*, DFAScopeVar*) dg)`
     * (renamed, 05 §9b).
     */
    opApply_DFAVar_DFALattice_DFAScopeVar(
            dg: (var_: DFAVar | null, l: DFALattice, scv: DFAScopeVar) => number): number {
        let ret = 0;

        for (let i = 0; i < this.buckets.length; i++) {
            let scv = this.buckets[i];
            while (scv !== null) {
                ret = dg(scv.var, scv.lr.lattice!, scv);
                if (ret !== 0)
                    return ret;

                scv = scv.next;
            }
        }

        return ret;
    }
}

/**
 * dmd/dfa/fast/structure.d:2185 — `struct DFALatticeRef`: an OWNING handle on a DFALattice (file header,
 * OWNERSHIP PROTOCOL). Copying moves the lattice; destroying frees the lattice and its consequences.
 */
export class DFALatticeRef {
    // package
    lattice: DFALattice | null = null;

    /**
     * `new DFALatticeRef()` is D's `DFALatticeRef.init`. `new DFALatticeRef(other)` is the copy constructor
     * dmd/dfa/fast/structure.d:2191 — `this(ref DFALatticeRef other)` (`static if (DFACleanup)`, resolved true):
     * it takes `other`'s lattice and leaves `other` null.
     */
    constructor(other?: DFALatticeRef) {
        if (other !== undefined) {
            this.lattice = other.lattice;
            other.lattice = null;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:2197 — `~this()`: frees every consequence of the owned lattice, its constant and
     * the lattice itself. The final `this.lattice = null` is not in D (a destroyed D value is never read again):
     * it makes a repeated dtor inert (file header).
     */
    __dtor(): void {
        if (this.isNull())
            return;

        const lattice = this.lattice!;
        let c = lattice.lastInSequence;

        while (c !== null) {
            const next = c.next;
            assert(next !== c);

            lattice.dfaCommon!.allocator.freeFromDFAConsequence(c);
            c = next;
        }

        lattice.lastInSequence = null;

        if (lattice.constant !== null) {
            lattice.dfaCommon!.allocator.freeFromDFAConsequence(lattice.constant);
            lattice.constant = null;
        }

        lattice.dfaCommon!.allocator.freeFromDFALattice(lattice);
        this.lattice = null;
    }

    /**
     * D's compiler-generated `opAssign` (copy ctor + dtor present): `rhs` is the already-constructed by-value
     * parameter (`new DFALatticeRef(lvalue)` or an rvalue); the handles swap and the old value is destroyed.
     */
    opAssign(rhs: DFALatticeRef): void {
        const old = this.lattice;
        this.lattice = rhs.lattice;
        rhs.lattice = old;
        rhs.__dtor();
    }

    /** dmd/dfa/fast/structure.d:2225 — `bool isNull()`. */
    isNull(): boolean {
        return this.lattice === null;
    }

    /** dmd/dfa/fast/structure.d:2230 — `bool haveNonContext()`: a consequence other than the context exists. */
    haveNonContext(): boolean {
        if (this.isNull())
            return false;

        const cctx = this.getContext();

        const code = this.opApply((c: DFAConsequence): number => {
            if (c !== cctx)
                return 2; // `return true;` from the enclosing function (05 §11)
            return 0;
        });
        if (code === 2)
            return true;

        return false;
    }

    /**
     * dmd/dfa/fast/structure.d:2246 — `bool isModellable()`: every variable reached through the maybe-tops is
     * modellable (see `walkMaybeTops`).
     */
    isModellable(): boolean {
        let ret = true;

        const walker = (c: DFAConsequence): boolean => {
            if (c.var !== null && !c.var.isModellable()) {
                ret = false;
                return false;
            }

            return true;
        };

        this.walkMaybeTops(walker);
        return ret;
    }

    /** dmd/dfa/fast/structure.d:2265 — `DFAConsequence* findConsequence(DFAVar* var)`: null on a null handle. */
    findConsequence(var_: DFAVar | null): DFAConsequence | null {
        if (this.isNull())
            return null;

        return this.lattice!.findConsequence(var_);
    }

    /**
     * dmd/dfa/fast/structure.d:2273 — `DFAConsequence* addConsequence(DFAVar* var, DFAConsequence* copyFrom = null)`:
     * null on a null handle.
     */
    addConsequence(var_: DFAVar | null, copyFrom: DFAConsequence | null = null): DFAConsequence | null {
        if (this.isNull())
            return null;

        return this.lattice!.addConsequence(var_, copyFrom);
    }

    /**
     * The overload pair dmd/dfa/fast/structure.d:2281 — `DFAConsequence* getContext()` and
     * dmd/dfa/fast/structure.d:2289 — `DFAConsequence* getContext(out DFAVar* var)`, collapsed by arity (04 §1
     * Form A). The context consequence, null on a null handle; with `var_`, also its variable (reset to null on
     * entry, left null when there is no context).
     */
    getContext(var_?: Ref<DFAVar | null>): DFAConsequence | null {
        if (var_ === undefined) {
            if (this.isNull())
                return null;

            return this.lattice!.context;
        }

        var_.value = null; // `out` parameter reset on entry (03 §3.3)
        if (this.isNull() || this.lattice!.context === null)
            return null;

        var_.value = this.lattice!.context.var;
        return this.lattice!.context;
    }

    /** dmd/dfa/fast/structure.d:2298 — `DFAVar* getContextVar()`: the context's variable, or null. */
    getContextVar(): DFAVar | null {
        if (this.isNull() || this.lattice!.context === null)
            return null;
        return this.lattice!.context.var;
    }

    /**
     * dmd/dfa/fast/structure.d:2305 — `DFAConsequence* setContext(DFAConsequence* c)`: makes `c` the context. A
     * null `c` changes nothing; a null handle faults (D dereferences it).
     */
    setContext(c: DFAConsequence | null): DFAConsequence | null {
        if (c === null)
            return null;

        this.lattice!.context = c;
        return c;
    }

    /**
     * dmd/dfa/fast/structure.d:2314 — `DFAConsequence* setContext(DFAVar* var)` (renamed, 04 §1 Form B): the
     * consequence on `var` (added when missing) becomes the context. Null on a null handle.
     */
    setContextFromDFAVar(var_: DFAVar | null): DFAConsequence | null {
        if (this.isNull())
            return null;

        const ret = this.addConsequence(var_);
        this.lattice!.context = ret;
        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:2324 — `DFAConsequence* getGateConsequence()`: the consequence that gates a branch —
     * the context when it is a plain variable, or the variable its `maybe` names when that one is plain.
     */
    getGateConsequence(): DFAConsequence | null {
        if (this.isNull() || this.lattice!.context === null)
            return null;
        else if (this.lattice!.context.var !== null && this.lattice!.context.maybe === null)
            return this.lattice!.context;
        else if (this.lattice!.context.var === null && this.lattice!.context.maybe !== null) {
            const c = this.findConsequence(this.lattice!.context.maybe);
            if (c !== null)
                return c.maybe === null ? c : null;
        }

        return null;
    }

    /** dmd/dfa/fast/structure.d:2339 — `DFAVar* getGateConsequenceVariable()`: the variable of getGateConsequence. */
    getGateConsequenceVariable(): DFAVar | null {
        if (this.isNull() || this.lattice!.context === null)
            return null;
        else if (this.lattice!.context.var !== null && this.lattice!.context.maybe === null)
            return this.lattice!.context.var;
        else if (this.lattice!.context.var === null && this.lattice!.context.maybe !== null) {
            const c = this.findConsequence(this.lattice!.context.maybe);
            if (c !== null)
                return c.maybe === null ? c.var : null;
        }

        return null;
    }

    /**
     * dmd/dfa/fast/structure.d:2354 — `DFAConsequence* acquireConstantAsContext()`: makes the lattice's constant
     * consequence (created when missing) the context, its truthiness and nullability reset to Unknown and its
     * object untouched (DFALattice.acquireConstantAsContext). Precondition: the handle is non-null.
     */
    acquireConstantAsContext(): DFAConsequence {
        assert(!this.isNull());
        return this.lattice!.acquireConstantAsContext();
    }

    /**
     * dmd/dfa/fast/structure.d:2360 — `DFAConsequence* acquireConstantAsContext(Truthiness truthiness,` (renamed,
     * 04 §1 rule 3, inserted parameters). Makes the constant consequence (created when missing) the context and
     * sets its truthiness, nullability and object. Precondition: the handle is non-null.
     */
    acquireConstantAsContextTruthiness(truthiness: Truthiness, nullable: Nullable,
            obj: DFAObject | null): DFAConsequence {
        assert(!this.isNull());

        const ret = this.addConsequence(null)!;
        this.setContext(ret);

        ret.truthiness = truthiness;
        ret.nullable = nullable;
        ret.obj = obj;
        return ret;
    }

    /// DFAConsequence.maybeTopSeen will be set on the DFAConsequence if it was visited
    /// dmd/dfa/fast/structure.d:2375 — `void walkMaybeTops(scope bool delegate(DFAConsequence*) del)`: no-op on a
    /// null handle or a null `del`.
    walkMaybeTops(del: ((c: DFAConsequence) => boolean) | null): void {
        if (this.isNull() || del === null)
            return;

        this.lattice!.walkMaybeTops(del);
    }

    /** dmd/dfa/fast/structure.d:2383 — `void cleanupConstant(DFAVar* contextVar)`: see DFALattice.cleanupConstant. */
    cleanupConstant(contextVar: DFAVar | null): void {
        if (!this.isNull())
            this.lattice!.cleanupConstant(contextVar);
    }

    /**
     * dmd/dfa/fast/structure.d:2389 — `int opApply(scope int delegate(DFAConsequence* consequence) dg)`: 05 §11
     * protocol over the consequences (0 on a null handle).
     */
    opApply(dg: (consequence: DFAConsequence) => number): number {
        if (this.isNull())
            return 0;

        return this.lattice!.opApply(dg);
    }

    /**
     * dmd/dfa/fast/structure.d:2397 — `void printStructure(const(char)* prefix = "", int sdepth = 0,`: debug dump
     * (the lattice's own printStructure is resolved to a no-op).
     */
    printStructure(prefix: DString = ds(""), sdepth = 0, currentFunction: FuncDeclaration | null = null,
            depth = 0): void {
        if (this.isNull())
            return;
        this.lattice!.printStructure(prefix, sdepth, currentFunction, depth);
    }

    /**
     * dmd/dfa/fast/structure.d:2405 — `void printState(const(char)* prefix = "", int sdepth = 0,`: debug dump
     * (the lattice's own printState is resolved to a no-op).
     */
    printState(prefix: DString = ds(""), sdepth = 0, currentFunction: FuncDeclaration | null = null,
            depth = 0): void {
        if (this.isNull())
            return;
        this.lattice!.printState(prefix, sdepth, currentFunction, depth);
    }

    /// dmd/dfa/fast/structure.d:2413 — `void printActual(` — dropped with the debug dumpers (file header).

    /**
     * dmd/dfa/fast/structure.d:2421 — `DFALatticeRef copy()`: a DOMAIN copy — a new lattice holding copies of
     * every consequence, same context. Not the 03 value copy (file header). Null handle for a null handle.
     */
    copy(): DFALatticeRef {
        if (this.lattice === null)
            return new DFALatticeRef();
        return this.lattice.copy();
    }

    /** dmd/dfa/fast/structure.d:2428 — `DFALatticeRef copyWithoutInfiniteLifetime()`: see DFALattice. */
    copyWithoutInfiniteLifetime(): DFALatticeRef {
        if (this.lattice === null)
            return new DFALatticeRef();
        return this.lattice.copyWithoutInfiniteLifetime();
    }

    /** dmd/dfa/fast/structure.d:2435 — `void check()`: the lattice's self-check (a no-op, debugVerify OFF). */
    check(): void {
        if (!this.isNull())
            this.lattice!.check();
    }
}

/***********************************************************
 * The collection of values and facts known about a variable.
 *
 * A DFALattice contains one or more `DFAConsequence` nodes.
 * Each `DFAConsequence` represents the state of a variable at the current
 * point in time.
 *
 * dmd/dfa/fast/structure.d:2449 — `struct DFALattice`. Allocated from DFAAllocator, handled by pointer (owned by
 * a DFALatticeRef). The consequences on variables form a sequence (`firstInSequence` .. `lastInSequence`,
 * iterated newest first) indexed by 16 address-hashed buckets; the one consequence with no variable is
 * `constant`.
 */
export class DFALattice implements Pooled<DFALattice> {
    // D `private` block (structure.d:2451-2460).
    listnext: DFALattice | null = null; // D module-private (DFAAllocator's free list)

    dfaCommon: DFACommon | null = null; // D module-private (DFAAllocator, DFALatticeRef)
    firstInSequence: DFAConsequence | null = null; // D module-private (DFAAllocator.freeFromDFALattice)
    lastInSequence: DFAConsequence | null = null; // D module-private (DFALatticeRef.__dtor)
    private readonly buckets: (DFAConsequence | null)[] = new Array<DFAConsequence | null>(16).fill(null);

    constant: DFAConsequence | null = null; // D module-private (DFALatticeRef.__dtor)

    context: DFAConsequence | null = null;

    /// Simulated address of this node's region slot (file header); not a D field.
    addr = 0;

    /// resolved: DFALattice.sizeof -> 176 (ldc2 1.43.0 probe).
    static readonly sizeof = 176;

    /** D `memcpy(this, &DFALattice.init)`: every field back to `.init`, in place (03 §1.1). */
    resetToInit(): void {
        this.listnext = null;
        this.dfaCommon = null;
        this.firstInSequence = null;
        this.lastInSequence = null;
        this.buckets.fill(null);
        this.constant = null;
        this.context = null;
    }

    /**
     * dmd/dfa/fast/structure.d:2464 — `DFAConsequence* findConsequence(DFAVar* var)`: the consequence on `var`,
     * or null; a null `var` answers the constant.
     */
    findConsequence(var_: DFAVar | null): DFAConsequence | null {
        if (var_ === null)
            return this.constant;

        const bucket = this.findBucketForVar(var_);
        if (bucket.get() !== null && bucket.get()!.var === var_)
            return bucket.get();
        else
            return null;
    }

    /**
     * dmd/dfa/fast/structure.d:2476 — `DFAConsequence* addConsequence(DFAVar* var, DFAConsequence* copyFrom = null)`:
     * the consequence on `var` (the constant for a null `var`), created from `copyFrom` when missing. A new
     * variable consequence becomes the newest of the sequence and, when not copied, records the variable's
     * current write count.
     */
    addConsequence(var_: DFAVar | null, copyFrom: DFAConsequence | null = null): DFAConsequence {
        let ret: DFAConsequence;

        if (var_ === null) {
            if (this.constant === null) {
                ret = this.dfaCommon!.allocator.makeConsequence(var_, copyFrom);
            }
            else
                ret = this.constant;

            this.constant = ret;
        }
        else {
            const bucket = this.findBucketForVar(var_);
            if (bucket.get() !== null && bucket.get()!.var === var_)
                return bucket.get()!;

            ret = this.dfaCommon!.allocator.makeConsequence(var_, copyFrom);

            if (this.lastInSequence !== null)
                this.lastInSequence.previous = ret;
            if (this.firstInSequence === null)
                this.firstInSequence = ret;

            ret.next = this.lastInSequence;
            this.lastInSequence = ret;

            if (copyFrom === null) {
                ret.writeOnVarAtThisPoint = toUint32(var_.writeCount); // int -> uint (09 §2)
            }

            ret.bucketNext = bucket.get();
            bucket.set(ret);
        }

        assert(ret !== ret.next);
        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:2520 — `DFAConsequence** findBucketForVar(DFAVar* var)`: the slot where `var`'s
     * consequence is or would be inserted (its bucket chain is ascending by variable address).
     */
    findBucketForVar(var_: DFAVar): Slot<DFAConsequence | null> {
        let bucket: Slot<DFAConsequence | null> = arraySlot(this.buckets, dfaVarAddress(var_) % this.buckets.length);

        while (bucket.get() !== null && dfaVarAddress(bucket.get()!.var) < dfaVarAddress(var_)) {
            bucket = fieldSlot(bucket.get()!, "bucketNext");
        }

        return bucket;
    }

    /**
     * dmd/dfa/fast/structure.d:2532 — `DFAConsequence* acquireConstantAsContext()`: the constant (created when
     * missing) becomes the context, its truthiness and nullability Unknown.
     */
    acquireConstantAsContext(): DFAConsequence {
        const ret = this.addConsequence(null);
        this.context = ret;

        ret.truthiness = Truthiness.Unknown;
        ret.nullable = Nullable.Unknown;
        return ret;
    }

    /// DFAConsequence.maybeTopSeen will be set on the DFAConsequence if it was visited
    /// dmd/dfa/fast/structure.d:2543 — `void walkMaybeTops(scope bool delegate(DFAConsequence*) del)`: calls `del`
    /// once per consequence reached from a "top" (the plain-variable context first, then every consequence with a
    /// `maybe`), following `maybe` links; `del` returning false stops that chain (and, from a later top, the walk).
    walkMaybeTops(del: (c: DFAConsequence) => boolean): void {
        const handle = (c: DFAConsequence | null): boolean => {
            if (c === null || c.maybeTopSeen)
                return true;

            c.maybeTopSeen = true;
            if (!del(c))
                return false;

            if (handle(this.findConsequence(c.maybe)))
                return true;
            return false;
        };

        this.opApply((c: DFAConsequence): number => {
            c.maybeTopSeen = false;
            return 0;
        });

        {
            const c = this.context;
            if (c !== null) {
                if (c.var !== null && c.maybe === null)
                    handle(c);
            }
        }

        this.opApply((c: DFAConsequence): number => {
            if (c.maybeTopSeen)
                return 0; // continue

            if (c.maybe !== null) {
                if (!handle(c))
                    return 1; // break
            }
            return 0;
        });
    }

    /**
     * dmd/dfa/fast/structure.d:2583 — `void printStructure(const(char)* prefix = "", int sdepth = 0,`. Debug dump,
     * resolved away: `static if (!dfaCommon.debugStructure)` -> true, so it returns at once.
     */
    printStructure(_prefix: DString = ds(""), _sdepth = 0, _currentFunction: FuncDeclaration | null = null,
            _depth = 0): void {
        // resolved: static if (!debugStructure) -> true (structure.d:2586): `return;`, the printActual arm dropped
    }

    /**
     * dmd/dfa/fast/structure.d:2592 — `void printState(const(char)* prefix = "", int sdepth = 0,`. Debug dump,
     * resolved away: `static if (!dfaCommon.debugIt)` -> true, so it returns at once.
     */
    printState(_prefix: DString = ds(""), _sdepth = 0, _currentFunction: FuncDeclaration | null = null,
            _depth = 0): void {
        // resolved: static if (!debugIt) -> true (structure.d:2595): `return;`, the printActual arm dropped
    }

    /// dmd/dfa/fast/structure.d:2601 — `private void printActual(` — dropped with the debug dumpers (file header).

    /**
     * dmd/dfa/fast/structure.d:2612 — `int opApply(scope int delegate(DFAConsequence* consequence) dg)`: 05 §11
     * protocol over the variable consequences, newest first, then the constant.
     */
    opApply(dg: (consequence: DFAConsequence) => number): number {
        let c = this.lastInSequence;
        let i: number;

        while (c !== null) {
            i = dg(c);
            if (i !== 0)
                return i;

            assert(c !== c.next);
            c = c.next;
        }

        if (this.constant !== null)
            return dg(this.constant);
        else
            return 0;
    }

    /**
     * dmd/dfa/fast/structure.d:2633 — `DFALatticeRef copy()`: a new lattice with a copy of the constant and of
     * every variable consequence, oldest first, and the matching context.
     */
    copy(): DFALatticeRef {
        const ret = this.dfaCommon!.makeLatticeRef();

        if (this.constant !== null) {
            const newC = ret.addConsequence(null, this.constant);

            if (this.context === this.constant)
                ret.setContext(newC);
        }

        let oldC = this.firstInSequence;

        while (oldC !== null) {
            const newC = ret.addConsequence(oldC.var, oldC);

            if (this.context === oldC)
                ret.setContext(newC);

            oldC = oldC.previous;
        }

        ret.check();
        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:2661 — `DFALatticeRef copyWithoutInfiniteLifetime()`: `copy` without the
     * consequences on infinite-lifetime variables; when the context was one of them, the constant becomes the
     * context.
     */
    copyWithoutInfiniteLifetime(): DFALatticeRef {
        const ret = this.dfaCommon!.makeLatticeRef();

        if (this.constant !== null) {
            const newC = ret.addConsequence(null, this.constant);

            if (this.context === this.constant)
                ret.setContext(newC);
        }

        let oldC = this.firstInSequence;

        while (oldC !== null) {
            if (!oldC.var!.haveInfiniteLifetime) {
                const newC = ret.addConsequence(oldC.var, oldC);

                if (this.context === oldC)
                    ret.setContext(newC);

            }
            oldC = oldC.previous;
        }

        if (ret.getContext() === null)
            ret.acquireConstantAsContext();

        ret.check();
        return ret;
    }

    /// Remove constant if not context
    /// dmd/dfa/fast/structure.d:2696 — `void cleanupConstant(DFAVar* contextVar)`: frees the constant; when it was
    /// the context, the consequence on `contextVar` (added now, possibly reusing the freed node) replaces it.
    cleanupConstant(contextVar: DFAVar | null): void {
        if (contextVar === null)
            return;

        if (this.constant !== null) {
            this.dfaCommon!.allocator.freeFromDFAConsequence(this.constant);

            if (this.context === this.constant)
                this.context = this.addConsequence(contextVar);

            this.constant = null;
        }
    }

    /** dmd/dfa/fast/structure.d:2712 — `void check()`: the debugVerify self-check, resolved OFF (no-op). */
    check(): void {
        // resolved: static if (DFACommon.debugVerify) -> false (structure.d:2714), block dropped
    }
}

/// dmd/dfa/fast/structure.d:2764 — `enum Truthiness : ubyte` (<= 32 bits -> TS numeric enum, 02 §4.2).
export enum Truthiness {
    Unknown, // unmodelled
    Maybe, // if assert'd non-constant consequences apply in true branch
    False, // if false branch of if statement will be taken
    True, // if true branch of if statement will be taken
}

/// dmd/dfa/fast/structure.d:2772 — `enum Nullable : ubyte`.
export enum Nullable {
    Unknown,
    Null,
    NonNull,
}

/// dmd/dfa/fast/structure.d:2779 — `enum PAMathOp : ubyte`.
export enum PAMathOp {
    add,
    sub,
    mul,
    div,
    mod,
    and,
    or,
    xor,
    pow,
    leftShift,
    rightShiftSigned,
    rightShiftUnsigned,

    postInc,
    postDec,
}

/// D `long.max` / `long.min` in the bigint carrier (09 §1).
const LONG_MAX = 0x7FFF_FFFF_FFFF_FFFFn;
const LONG_MIN = -0x8000_0000_0000_0000n;

// Point analysis, tracking of integral values such as a slice length or an integer typed variable/constant.
// Note that the math op functions here may not be correct.
// They'll just have to be fixed once a test case appears.
/**
 * dmd/dfa/fast/structure.d:2801 — `struct DFAPAValue`: a point-analysis value, a `long` plus how much is known
 * about it. A value struct (03): copied at every D copy point.
 *
 * The integer arithmetic reproduces D's promotions exactly: 8- and 16-bit operands compute in `int`, 32-bit in
 * `int`/`uint` (wrapping), 64/128-bit in `long`/`ulong` (wrapping); the result is stored sign- or zero-extended
 * as D's conversion to `long` does. Shift counts are taken modulo the operation width, and a remainder by a
 * divisor that truncates to zero yields the dividend, as ldc2 compiles them on arm64 (probed).
 */
export class DFAPAValue {
    kind: DFAPAValue.Kind = DFAPAValue.Kind.Unknown;

    // We use long to represent the VRP value, however this cuts off long.max .. ulong.max,
    // represent this with UnknownUpperPositive.
    // By doing long we can ignore signedness and lower negative long.min .. int.min, making things simpler.
    value = 0n;

    /** dmd/dfa/fast/structure.d:2820 — `this(Kind kind)` (04 §1 ctor Form B -> factory): value 0. */
    static fromKind(kind: DFAPAValue.Kind): DFAPAValue {
        const r = new DFAPAValue();
        r.kind = kind;
        return r;
    }

    /** dmd/dfa/fast/structure.d:2825 — `this(long value)` (04 §1 ctor Form B -> factory): a Concrete value. */
    static fromLong(value: bigint): DFAPAValue {
        const r = new DFAPAValue();
        r.kind = DFAPAValue.Kind.Concrete;
        r.value = value;
        return r;
    }

    /**
     * dmd/dfa/fast/structure.d:2831 — `int opCmp(const ref DFAPAValue other) const`: orders by `kind`, then by
     * `value` when both are Concrete; values of any other equal kind compare equal. D `a < b` is
     * `a.opCmp(b) < 0` (05 §3); D `==` on DFAPAValue is NOT this (no opEquals: member-wise, probed).
     */
    opCmp(other: DFAPAValue): number {
        if (this.kind !== other.kind) {
            const difference = this.kind - other.kind;
            return difference < 0 ? -1 : 1;
        }
        else if (this.kind === DFAPAValue.Kind.Concrete && other.kind === DFAPAValue.Kind.Concrete)
            return this.value < other.value ? -1 : (this.value === other.value ? 0 : 1);
        else
            return 0;
    }

    /**
     * dmd/dfa/fast/structure.d:2844 — `DFAPAValue meet(DFAPAValue other)`: this value when both are the same
     * Concrete value, else Unknown. `other` is by value (the caller copies).
     */
    meet(other: DFAPAValue): DFAPAValue {
        if (this.kind !== other.kind || this.kind !== DFAPAValue.Kind.Concrete || this.value !== other.value)
            return Unknown.copy();
        else
            return this.copy();
    }

    /**
     * dmd/dfa/fast/structure.d:2852 — `DFAPAValue join(DFAPAValue other)`: the greater by opCmp (`other` on a
     * tie). `other` is by value (the caller copies).
     */
    join(other: DFAPAValue): DFAPAValue {
        if (this.opCmp(other) > 0)
            return this.copy();
        else
            return other.copy();
    }

    /**
     * dmd/dfa/fast/structure.d:2860 — `bool canFitIn(Type type)`: a Lower/Upper/Concrete value lies in the range
     * of the integral `type` (every value for (u)long/128, non-negative for ulong/ucent). Other kinds and
     * non-integral types answer false.
     */
    canFitIn(type: Type): boolean {
        if (this.kind < DFAPAValue.Kind.Lower)
            return false;

        switch (type.ty) {
        case TY.Tint8:
            return -128n <= this.value && this.value <= 127n;

        case TY.Tuns8:
            return 0n <= this.value && this.value <= 255n;

        case TY.Tint16:
            return -32768n <= this.value && this.value <= 32767n;

        case TY.Tuns16:
            return 0n <= this.value && this.value <= 65535n;

        case TY.Tint32:
            return -2147483648n <= this.value && this.value <= 2147483647n;

        case TY.Tuns32:
            return 0n <= this.value && this.value <= 4294967295n;

        case TY.Tuns64:
        case TY.Tuns128:
            return 0n <= this.value;

        case TY.Tint64:
        case TY.Tint128:
            return true;

        default:
            return false;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:2898 — `Truthiness compareEqual(ref DFAPAValue other)`: `this == other` as far as
     * known. Neither side is modified.
     */
    compareEqual(other: DFAPAValue): Truthiness {
        if (this.kind === DFAPAValue.Kind.Unknown || other.kind === DFAPAValue.Kind.Unknown)
            return Truthiness.Unknown;

        const lhsConcrete = this.kind === DFAPAValue.Kind.Concrete;
        const rhsConcrete = other.kind === DFAPAValue.Kind.Concrete;

        if (lhsConcrete && rhsConcrete)
            return this.value === other.value ? Truthiness.True : Truthiness.False;
        else if ((lhsConcrete || rhsConcrete) && (this.kind === DFAPAValue.Kind.UnknownUpperPositive
                || other.kind === DFAPAValue.Kind.UnknownUpperPositive))
            return Truthiness.False;

        return Truthiness.Maybe;
    }

    /**
     * dmd/dfa/fast/structure.d:2915 — `Truthiness compareNotEqual(ref DFAPAValue other)`: `this != other` as far
     * as known. Neither side is modified.
     */
    compareNotEqual(other: DFAPAValue): Truthiness {
        if (this.kind === DFAPAValue.Kind.Unknown || other.kind === DFAPAValue.Kind.Unknown)
            return Truthiness.Unknown;
        else if (this.kind < DFAPAValue.Kind.Concrete || other.kind < DFAPAValue.Kind.Concrete)
            return Truthiness.Maybe; // we can't know the value at this time of development but it could be equal

        if (this.kind === DFAPAValue.Kind.Concrete && other.kind === DFAPAValue.Kind.Concrete)
            return (this.value === other.value) ? Truthiness.False : Truthiness.True;

        return Truthiness.Maybe;
    }

    /**
     * dmd/dfa/fast/structure.d:2928 — `Truthiness greaterThan(ref DFAPAValue other)`: `this > other` as far as
     * known, and narrows both sides for the branch where it holds: on False both become Unknown; otherwise
     * `other` becomes (at most) an Upper bound and `this` a Lower bound above it. `other` is modified in place.
     */
    greaterThan(other: DFAPAValue): Truthiness {
        let ret = Truthiness.Maybe;

        if (this.kind === DFAPAValue.Kind.Concrete && other.kind === DFAPAValue.Kind.Concrete)
            ret = this.value > other.value ? Truthiness.True : Truthiness.False;
        else if (this.kind === DFAPAValue.Kind.Concrete && other.kind === DFAPAValue.Kind.UnknownUpperPositive)
            ret = Truthiness.False;

        if (ret === Truthiness.False) {
            Object.assign(this, Unknown); // `this = Unknown;` (03 §1.1)
            Object.assign(other, Unknown); // `other = Unknown;`
        }
        else {
            const temp = other.copy();

            if (temp.kind === DFAPAValue.Kind.Concrete) {
                if (temp.value < LONG_MAX)
                    temp.value++;
                else
                    temp.kind = DFAPAValue.Kind.UnknownUpperPositive;
            }

            Object.assign(other, other.meet(this.copy())); // `other = other.meet(this);`
            Object.assign(this, this.join(temp.copy())); // `this = this.join(temp);`

            if (other.kind > DFAPAValue.Kind.Lower)
                other.kind = DFAPAValue.Kind.Upper;
            if (this.kind >= DFAPAValue.Kind.Lower)
                this.kind = DFAPAValue.Kind.Lower;
        }

        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:2967 — `Truthiness greaterThanOrEqual(ref DFAPAValue other)`: as `greaterThan`
     * for `this >= other`. `other` is modified in place.
     */
    greaterThanOrEqual(other: DFAPAValue): Truthiness {
        let ret = Truthiness.Maybe;

        if (this.kind === DFAPAValue.Kind.Concrete && other.kind === DFAPAValue.Kind.Concrete)
            ret = this.value >= other.value ? Truthiness.True : Truthiness.False;
        else if (this.kind === DFAPAValue.Kind.Concrete && other.kind === DFAPAValue.Kind.UnknownUpperPositive)
            ret = Truthiness.False;

        if (ret === Truthiness.False) {
            Object.assign(this, Unknown); // `this = Unknown;` (03 §1.1)
            Object.assign(other, Unknown); // `other = Unknown;`
        }
        else {
            Object.assign(other, other.meet(this.copy())); // `other = other.meet(this);`
            Object.assign(this, this.join(other.copy())); // `this = this.join(other);`

            if (other.kind > DFAPAValue.Kind.Lower)
                other.kind = DFAPAValue.Kind.Upper;
            if (this.kind >= DFAPAValue.Kind.Lower)
                this.kind = DFAPAValue.Kind.Lower;
        }

        return ret;
    }

    /**
     * dmd/dfa/fast/structure.d:2996 — `void negate(Type type)`: `-this` in the arithmetic of the integral
     * `type`; any other kind, a null type or a non-integral type makes the value Unknown.
     */
    negate(type: Type | null): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || type === null) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = -maskSignedN(8, this.value); // -cast(int)(cast(byte) v): fits in int
            break;
        case TY.Tint16:
            this.value = -maskSignedN(16, this.value);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, -maskSignedN(32, this.value)); // int negation wraps
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = toInt64(-this.value);
            break;

        case TY.Tuns8:
            this.value = -maskUnsignedN(8, this.value); // -cast(int)(cast(ubyte) v)
            break;
        case TY.Tuns16:
            this.value = -maskUnsignedN(16, this.value);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, -maskUnsignedN(32, this.value)); // uint negation, zero-extended
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(-this.value);
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:3040 — `void addFrom(DFAPAValue other, Type type)`: `this += other` in `type`'s
     * arithmetic; a non-Concrete operand makes it Unknown, an unsigned sum past `long.max` UnknownUpperPositive.
     * `other` is by value (the caller copies); `type` is dereferenced.
     */
    addFrom(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        if (isUnsigned(type)) {
            if (this.value > 0n && other.value > 0n && this.value > (LONG_MAX - other.value)) {
                // long.max .. ulong.max
                this.kind = DFAPAValue.Kind.UnknownUpperPositive;
                return;
            }
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(8, this.value) + maskSignedN(8, other.value);
            break;
        case TY.Tint16:
            this.value = maskSignedN(16, this.value) + maskSignedN(16, other.value);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, maskSignedN(32, this.value) + maskSignedN(32, other.value));
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = toInt64(this.value + other.value);
            break;

        case TY.Tuns8:
            this.value = maskUnsignedN(8, this.value) + maskUnsignedN(8, other.value);
            break;
        case TY.Tuns16:
            this.value = maskUnsignedN(16, this.value) + maskUnsignedN(16, other.value);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, maskUnsignedN(32, this.value) + maskUnsignedN(32, other.value));
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(this.value + other.value);
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:3094 — `void subtractFrom(DFAPAValue other, Type type)`: `this -= other` in
     * `type`'s arithmetic; an unsigned result below zero (signed comparison of the two values) makes it Unknown.
     */
    subtractFrom(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        if (isUnsigned(type)) {
            if (other.value > this.value) {
                this.kind = DFAPAValue.Kind.Unknown;
                return;
            }
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(8, this.value) - maskSignedN(8, other.value);
            break;
        case TY.Tint16:
            this.value = maskSignedN(16, this.value) - maskSignedN(16, other.value);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, maskSignedN(32, this.value) - maskSignedN(32, other.value));
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = toInt64(this.value - other.value);
            break;

        case TY.Tuns8:
            this.value = maskUnsignedN(8, this.value) - maskUnsignedN(8, other.value);
            break;
        case TY.Tuns16:
            this.value = maskUnsignedN(16, this.value) - maskUnsignedN(16, other.value);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, maskUnsignedN(32, this.value) - maskUnsignedN(32, other.value));
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(this.value - other.value);
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:3147 — `void multiplyFrom(DFAPAValue other, Type type)`: `this *= other` in
     * `type`'s arithmetic; an unsigned product past `long.max` becomes UnknownUpperPositive. (`ushort * ushort`
     * computes in `int` and can wrap negative, as in D.)
     */
    multiplyFrom(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        if (isUnsigned(type)) {
            if (this.value > 1n && other.value > 1n && this.value > (LONG_MAX / other.value)) {
                this.kind = DFAPAValue.Kind.UnknownUpperPositive;
                return;
            }
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(8, this.value) * maskSignedN(8, other.value);
            break;
        case TY.Tint16:
            this.value = maskSignedN(16, this.value) * maskSignedN(16, other.value);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, maskSignedN(32, this.value) * maskSignedN(32, other.value));
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = toInt64(this.value * other.value);
            break;

        case TY.Tuns8:
            this.value = maskUnsignedN(8, this.value) * maskUnsignedN(8, other.value);
            break;
        case TY.Tuns16:
            this.value = maskSignedN(32, maskUnsignedN(16, this.value) * maskUnsignedN(16, other.value)); // int
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, maskUnsignedN(32, this.value) * maskUnsignedN(32, other.value));
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(this.value * other.value);
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:3200 — `void divideFrom(DFAPAValue other, Type type)`: `this /= other` in `type`'s
     * arithmetic (truncating); a zero divisor (after truncation to the type), signed `long.min / -1` or a
     * non-integral type leave the value Unknown. `int.min / -1` wraps to `int.min`, as arm64's `sdiv` does.
     */
    divideFrom(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        this.kind = DFAPAValue.Kind.Unknown;

        if (!isUnsigned(type) && this.value === LONG_MIN && other.value === -1n) {
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            if (maskSignedN(8, other.value) === 0n)
                return;
            this.value = maskSignedN(8, this.value) / maskSignedN(8, other.value);
            break;
        case TY.Tint16:
            if (maskSignedN(16, other.value) === 0n)
                return;
            this.value = maskSignedN(16, this.value) / maskSignedN(16, other.value);
            break;
        case TY.Tint32:
            if (maskSignedN(32, other.value) === 0n)
                return;
            this.value = maskSignedN(32, maskSignedN(32, this.value) / maskSignedN(32, other.value));
            break;
        case TY.Tint64:
        case TY.Tint128:
            if (other.value === 0n)
                return;
            this.value = toInt64(this.value / other.value);
            break;

        case TY.Tuns8:
            if (maskUnsignedN(8, other.value) === 0n)
                return;
            this.value = maskUnsignedN(8, this.value) / maskUnsignedN(8, other.value);
            break;
        case TY.Tuns16:
            if (maskUnsignedN(16, other.value) === 0n)
                return;
            this.value = maskUnsignedN(16, this.value) / maskUnsignedN(16, other.value);
            break;
        case TY.Tuns32:
            if (maskUnsignedN(32, other.value) === 0n)
                return;
            this.value = maskUnsignedN(32, this.value) / maskUnsignedN(32, other.value);
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            if (toUint64(other.value) === 0n)
                return;
            // Must cast to ulong to perform correct unsigned 64-bit division before final assignment.
            this.value = toInt64(toUint64(this.value) / toUint64(other.value));
            break;

        default:
            return;
        }

        this.kind = DFAPAValue.Kind.Concrete;
    }

    /**
     * dmd/dfa/fast/structure.d:3269 — `void modulasFrom(DFAPAValue other, Type type)`: `this %= other` in `type`'s
     * arithmetic (sign of the dividend); a zero divisor or signed `long.min % -1` make it Unknown. A divisor that
     * truncates to zero in a narrower type yields the dividend, as arm64's `sdiv`/`udiv` + `msub` do.
     */
    modulasFrom(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete || other.value === 0n) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        if (!isUnsigned(type)) {
            if (this.value === LONG_MIN && other.value === -1n) {
                this.kind = DFAPAValue.Kind.Unknown;
                return;
            }
        }

        // arm64 remainder: `a - (b == 0 ? 0 : a / b) * b` (the divide by zero answers 0, no trap).
        const rem = (a: bigint, b: bigint): bigint => (b === 0n ? a : a % b);

        switch (type.ty) {
        case TY.Tint8:
            this.value = rem(maskSignedN(8, this.value), maskSignedN(8, other.value));
            break;
        case TY.Tint16:
            this.value = rem(maskSignedN(16, this.value), maskSignedN(16, other.value));
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, rem(maskSignedN(32, this.value), maskSignedN(32, other.value)));
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = this.value % other.value;
            break;

        case TY.Tuns8:
            this.value = rem(maskUnsignedN(8, this.value), maskUnsignedN(8, other.value));
            break;
        case TY.Tuns16:
            this.value = rem(maskUnsignedN(16, this.value), maskUnsignedN(16, other.value));
            break;
        case TY.Tuns32:
            this.value = rem(maskUnsignedN(32, this.value), maskUnsignedN(32, other.value));
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(toUint64(this.value) % toUint64(other.value));
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:3322 — `void leftShiftBy(DFAPAValue other, Type type)`: `this <<= other` in `type`'s
     * arithmetic (32-bit `int`/`uint` below 64 bits); a negative count makes it Unknown. D does not bound the
     * count after its narrowing cast (a count of the width or more, or a negative narrowed one, is LLVM poison);
     * the port takes it modulo 32 / 64 as ldc2's arm64 `lsl`/`asr`/`lsr` do (probed), the declared exception of
     * 09 §4.3.
     */
    leftShiftBy(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete || other.value < 0n) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(32, maskSignedN(8, this.value) << (maskSignedN(8, other.value) & 31n));
            break;
        case TY.Tint16:
            this.value = maskSignedN(32, maskSignedN(16, this.value) << (maskSignedN(16, other.value) & 31n));
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, maskSignedN(32, this.value) << (maskSignedN(32, other.value) & 31n));
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = toInt64(this.value << (other.value & 63n));
            break;

        case TY.Tuns8:
            this.value = maskSignedN(32, maskUnsignedN(8, this.value) << (maskUnsignedN(8, other.value) & 31n));
            break;
        case TY.Tuns16:
            this.value = maskSignedN(32, maskUnsignedN(16, this.value) << (maskUnsignedN(16, other.value) & 31n));
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, maskUnsignedN(32, this.value) << (maskUnsignedN(32, other.value) & 31n));
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(toUint64(this.value) << (toUint64(other.value) & 63n));
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:3366 — `void rightShiftSignedBy(DFAPAValue other, Type type)`: `this >>= other`
     * (arithmetic for signed types, logical for unsigned ones); count modulo 32 / 64 as `leftShiftBy`.
     */
    rightShiftSignedBy(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete || other.value < 0n) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(8, this.value) >> (maskSignedN(8, other.value) & 31n);
            break;
        case TY.Tint16:
            this.value = maskSignedN(16, this.value) >> (maskSignedN(16, other.value) & 31n);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, this.value) >> (maskSignedN(32, other.value) & 31n);
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = this.value >> (other.value & 63n);
            break;

        case TY.Tuns8:
            this.value = maskUnsignedN(8, this.value) >> (maskUnsignedN(8, other.value) & 31n);
            break;
        case TY.Tuns16:
            this.value = maskUnsignedN(16, this.value) >> (maskUnsignedN(16, other.value) & 31n);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, this.value) >> (maskUnsignedN(32, other.value) & 31n);
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(toUint64(this.value) >> (toUint64(other.value) & 63n));
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:3410 — `void rightShiftUnsignedBy(DFAPAValue other, Type type)`: `this >>>= other`,
     * the value first truncated to the unsigned type of `type`'s width; count modulo 32 / 64 as `leftShiftBy`.
     */
    rightShiftUnsignedBy(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete || other.value < 0n) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        switch (type.ty) {
            // We cast to the unsigned equivalent of the target size (ubyte, ushort, uint)
            // to force the logical shift behavior (zero-filling).
        case TY.Tint8:
        case TY.Tuns8:
            this.value = maskUnsignedN(8, this.value) >> (maskUnsignedN(8, other.value) & 31n);
            break;
        case TY.Tint16:
        case TY.Tuns16:
            this.value = maskUnsignedN(16, this.value) >> (maskUnsignedN(16, other.value) & 31n);
            break;
        case TY.Tint32:
        case TY.Tuns32:
            this.value = maskUnsignedN(32, this.value) >> (maskUnsignedN(32, other.value) & 31n);
            break;
        case TY.Tint64:
        case TY.Tuns64:
        case TY.Tint128:
        case TY.Tuns128:
            // For 64-bit, we use ulong to perform the logical shift before casting back to long.
            this.value = toInt64(toUint64(this.value) >> (toUint64(other.value) & 63n));
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /**
     * dmd/dfa/fast/structure.d:3448 — `void powerBy(DFAPAValue other, Type type)`: `this ^^= other`, computed as
     * `ulong ^^ ulong` (wrapping modulo 2^64) and then truncated to `type`; a result past `long.max` becomes
     * UnknownUpperPositive, a negative exponent Unknown. `x ^^ 0` is 1, `0 ^^ n` 0, `x ^^ 1` unchanged.
     */
    powerBy(other: DFAPAValue, type: Type): void {
        const exponent = other.value;
        const base = this.value;

        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete || exponent < 0n) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }
        else if (exponent === 0n) {
            // base ^^ 0
            this.value = 1n;
            return;
        }
        else if (base === 0n) {
            // 0 ^^ exponent
            this.value = 0n;
            return;
        }
        else if (exponent === 1n) {
            // base ^^ 1
            return;
        }

        // `cast(ulong) base ^^ cast(ulong) exponent`: druntime's integral pow, square-and-multiply in ulong
        // (every product wraps modulo 2^64, so the result is base^exponent mod 2^64).
        let temp = 1n;
        {
            let b = toUint64(base);
            let e = toUint64(exponent);
            while (e !== 0n) {
                if ((e & 1n) !== 0n)
                    temp = toUint64(temp * b);
                b = toUint64(b * b);
                e >>= 1n;
            }
        }

        if (temp > LONG_MAX) {
            this.kind = DFAPAValue.Kind.UnknownUpperPositive;
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(8, temp);
            break;
        case TY.Tint16:
            this.value = maskSignedN(16, temp);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, temp);
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = toInt64(temp);
            break;

        case TY.Tuns8:
            this.value = maskUnsignedN(8, temp);
            break;
        case TY.Tuns16:
            this.value = maskUnsignedN(16, temp);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, temp);
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(temp);
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /** dmd/dfa/fast/structure.d:3520 — `void bitwiseAndBy(DFAPAValue other, Type type)`: `this &= other`. */
    bitwiseAndBy(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(8, this.value) & maskSignedN(8, other.value);
            break;
        case TY.Tint16:
            this.value = maskSignedN(16, this.value) & maskSignedN(16, other.value);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, this.value) & maskSignedN(32, other.value);
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = this.value & other.value;
            break;

        case TY.Tuns8:
            this.value = maskUnsignedN(8, this.value) & maskUnsignedN(8, other.value);
            break;
        case TY.Tuns16:
            this.value = maskUnsignedN(16, this.value) & maskUnsignedN(16, other.value);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, this.value) & maskUnsignedN(32, other.value);
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(toUint64(this.value) & toUint64(other.value));
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /** dmd/dfa/fast/structure.d:3564 — `void bitwiseOrBy(DFAPAValue other, Type type)`: `this |= other`. */
    bitwiseOrBy(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(8, this.value) | maskSignedN(8, other.value);
            break;
        case TY.Tint16:
            this.value = maskSignedN(16, this.value) | maskSignedN(16, other.value);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, this.value) | maskSignedN(32, other.value);
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = this.value | other.value;
            break;

        case TY.Tuns8:
            this.value = maskUnsignedN(8, this.value) | maskUnsignedN(8, other.value);
            break;
        case TY.Tuns16:
            this.value = maskUnsignedN(16, this.value) | maskUnsignedN(16, other.value);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, this.value) | maskUnsignedN(32, other.value);
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(toUint64(this.value) | toUint64(other.value));
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /** dmd/dfa/fast/structure.d:3608 — `void bitwiseXorBy(DFAPAValue other, Type type)`: `this ^= other`. */
    bitwiseXorBy(other: DFAPAValue, type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete || other.kind !== DFAPAValue.Kind.Concrete) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = maskSignedN(8, this.value) ^ maskSignedN(8, other.value);
            break;
        case TY.Tint16:
            this.value = maskSignedN(16, this.value) ^ maskSignedN(16, other.value);
            break;
        case TY.Tint32:
            this.value = maskSignedN(32, this.value) ^ maskSignedN(32, other.value);
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = this.value ^ other.value;
            break;

        case TY.Tuns8:
            this.value = maskUnsignedN(8, this.value) ^ maskUnsignedN(8, other.value);
            break;
        case TY.Tuns16:
            this.value = maskUnsignedN(16, this.value) ^ maskUnsignedN(16, other.value);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, this.value) ^ maskUnsignedN(32, other.value);
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = toInt64(toUint64(this.value) ^ toUint64(other.value));
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /** dmd/dfa/fast/structure.d:3652 — `void bitwiseInvert(Type type)`: `this = ~this` in `type`'s arithmetic. */
    bitwiseInvert(type: Type): void {
        if (this.kind !== DFAPAValue.Kind.Concrete) {
            this.kind = DFAPAValue.Kind.Unknown;
            return;
        }

        switch (type.ty) {
        case TY.Tint8:
            this.value = ~maskSignedN(8, this.value); // ~cast(int)(cast(byte) v)
            break;
        case TY.Tint16:
            this.value = ~maskSignedN(16, this.value);
            break;
        case TY.Tint32:
            this.value = ~maskSignedN(32, this.value);
            break;
        case TY.Tint64:
        case TY.Tint128:
            this.value = ~this.value;
            break;

        case TY.Tuns8:
            this.value = ~maskUnsignedN(8, this.value); // ~cast(int)(cast(ubyte) v): negative int
            break;
        case TY.Tuns16:
            this.value = ~maskUnsignedN(16, this.value);
            break;
        case TY.Tuns32:
            this.value = maskUnsignedN(32, ~maskUnsignedN(32, this.value)); // uint complement, zero-extended
            break;
        case TY.Tuns64:
        case TY.Tuns128:
            this.value = ~this.value;
            break;

        default:
            this.kind = DFAPAValue.Kind.Unknown;
            break;
        }
    }

    /** 03 §2: field-wise value copy. */
    copy(): DFAPAValue {
        const c = new DFAPAValue();
        c.kind = this.kind;
        c.value = this.value;
        return c;
    }
}

/// dmd/dfa/fast/structure.d:2811 — `enum Kind : ubyte` declared INSIDE `struct DFAPAValue`: TS has no enum in a
/// class body, so it lives in the namespace merged with the class, keeping D's `DFAPAValue.Kind.Concrete`
/// spelling (the `Visibility.Kind` shape, dsymbol.ts).
export namespace DFAPAValue {
    export enum Kind {
        Unknown,
        UnknownUpperPositive,
        Lower, // VRP lower inclusive
        Upper, // VRP upper inclusive
        Concrete,
    }
}

/**
 * dmd/dfa/fast/structure.d:2803 — `enum Unknown = DFAPAValue(DFAPAValue.Kind.Unknown);`, a DFAPAValue-scoped
 * manifest constant hoisted and exported (02 §4.1): other dfa/ modules spell `DFAPAValue.Unknown` as the bare
 * name. D materializes a fresh value at every use, so every use site copies it (`Unknown.copy()`) or copies its
 * fields in; it is frozen so that a use that forgets fails loudly (01 §5.6).
 */
export const Unknown: DFAPAValue = Object.freeze(DFAPAValue.fromKind(DFAPAValue.Kind.Unknown));

/***********************************************************
 * A specific fact known about a variable at the current point in time.
 *
 * Examples of consequences:
 * - "This variable is definitely not null" (`nullable == NonNull`)
 * - "This variable is True" (`truthiness == True`)
 * - "This variable has the integer value 5" (`pa` - Point Analysis)
 *
 * dmd/dfa/fast/structure.d:3705 — `struct DFAConsequence`. Allocated from DFAAllocator, handled by pointer (a
 * node of one DFALattice).
 */
export class DFAConsequence implements Pooled<DFAConsequence> {
    // D `private` block (structure.d:3707-3712).
    dfaCommon: DFACommon | null = null; // D module-private (DFAAllocator.makeConsequence)
    listnext: DFAConsequence | null = null; // D module-private (DFAAllocator's free list)
    previous: DFAConsequence | null = null; // D module-private (DFALattice's sequence)
    next: DFAConsequence | null = null; // D module-private (DFALattice's sequence, DFALatticeRef.__dtor)
    bucketNext: DFAConsequence | null = null; // D module-private (DFALattice's bucket chains)

    // This will be null if it is a constant or effect
    var: DFAVar | null = null;
    // only valid when var.writeCount == writeOnVarAtThisPoint
    writeOnVarAtThisPoint = 0; // uint

    // Must be asserted to be true, at which point a join takes place
    truthiness: Truthiness = Truthiness.Unknown;
    // Ditto
    nullable: Nullable = Nullable.Unknown;
    // Boolean logic can be inverted once,
    //  thanks to or and equality expressions we won't be tracking it beyond that one invert.
    invertedOnce = false;
    // Protect else bodies assertion of the condition from introducing unknowable things
    protectElseNegate = false;
    // When the context is maybe, look at this instead
    maybe: DFAVar | null = null;
    maybeTopSeen = false;
    // Point analysis value, tracking of integral/length values
    pa: DFAPAValue = new DFAPAValue();
    // The object that this is if its non-null
    obj: DFAObject | null = null;

    /// Simulated address of this node's region slot (file header); not a D field.
    addr = 0;

    /// resolved: DFAConsequence.sizeof -> 96 (ldc2 1.43.0 probe).
    static readonly sizeof = 96;

    /** D `memcpy(this, &DFAConsequence.init)`: every field back to `.init`, in place (03 §1.1). */
    resetToInit(): void {
        this.dfaCommon = null;
        this.listnext = null;
        this.previous = null;
        this.next = null;
        this.bucketNext = null;
        this.var = null;
        this.writeOnVarAtThisPoint = 0;
        this.truthiness = Truthiness.Unknown;
        this.nullable = Nullable.Unknown;
        this.invertedOnce = false;
        this.protectElseNegate = false;
        this.maybe = null;
        this.maybeTopSeen = false;
        this.pa.kind = DFAPAValue.Kind.Unknown;
        this.pa.value = 0n;
        this.obj = null;
    }

    /**
     * dmd/dfa/fast/structure.d:3736 — `void copyFrom(DFAConsequence* other)`: copies `other`'s facts (not its
     * variable or links); the write count only when both are on the same variable. Null `other` is a no-op.
     */
    copyFrom(other: DFAConsequence | null): void {
        if (other === null)
            return;

        if (this.var === other.var)
            this.writeOnVarAtThisPoint = other.writeOnVarAtThisPoint;

        this.truthiness = other.truthiness;
        this.nullable = other.nullable;
        this.invertedOnce = other.invertedOnce;
        this.maybe = other.maybe;
        this.protectElseNegate = other.protectElseNegate;
        this.pa = other.pa.copy();
        this.obj = other.obj;
    }

    /**
     * dmd/dfa/fast/structure.d:3753 — `void meetConsequence(DFAConsequence* c1, DFAConsequence* c2, bool`.
     * The MEET (control-flow merge) of `c1` and `c2` into this consequence. When `c2` is missing or stale (written
     * before the variable's current write count) only `c1` counts; otherwise truthiness and nullability take the
     * lower of the two (Maybe truthiness degrades to Unknown), the point value their meet, objects a merged
     * object. `couldScopeNotHaveRan` makes differing facts Unknown. Preconditions: `this.var` and `c1` non-null.
     */
    meetConsequence(c1: DFAConsequence | null, c2: DFAConsequence | null, couldScopeNotHaveRan = false): void {
        const doOne = (c: DFAConsequence): void => {
            // dropped: version (DebugJoinMeetOp) trace (structure.d:3757), OFF (_config.md)

            this.invertedOnce = c.invertedOnce;
            this.writeOnVarAtThisPoint = c.writeOnVarAtThisPoint;
            this.pa = couldScopeNotHaveRan ? Unknown.copy() : c.pa.copy();
            this.obj = couldScopeNotHaveRan ? this.dfaCommon!.makeObject(c.obj) : c.obj;

            if (this.var === null || this.var.isTruthy)
                this.truthiness = couldScopeNotHaveRan ? Truthiness.Unknown : c.truthiness;
            if (this.var === null || this.var.isNullable)
                this.nullable = couldScopeNotHaveRan ? Nullable.Unknown : c.nullable;
        };

        const doMulti = (): void => {
            // dropped: version (DebugJoinMeetOp) trace (structure.d:3777), OFF (_config.md)

            this.writeOnVarAtThisPoint = c1!.writeOnVarAtThisPoint > c2!.writeOnVarAtThisPoint
                ? c1!.writeOnVarAtThisPoint : c2!.writeOnVarAtThisPoint;

            this.invertedOnce = this.truthiness === Truthiness.Unknown ? false : (c1!.invertedOnce || c2!.invertedOnce);

            this.pa = couldScopeNotHaveRan ? Unknown.copy() : c1!.pa.meet(c2!.pa.copy());

            if (this.var === null || this.var.isTruthy) {
                this.truthiness = (couldScopeNotHaveRan && c1!.truthiness !== c2!.truthiness)
                    ? Truthiness.Unknown : (c1!.truthiness < c2!.truthiness ? c1!.truthiness : c2!.truthiness);
                if (this.truthiness === Truthiness.Maybe)
                    this.truthiness = Truthiness.Unknown;
            }

            if (this.var === null || this.var.isNullable) {
                this.nullable = (couldScopeNotHaveRan && c1!.nullable !== c2!.nullable)
                    ? Nullable.Unknown : (c1!.nullable < c2!.nullable ? c1!.nullable : c2!.nullable);

                if (c1!.obj !== null || c2!.obj !== null) {
                    if (c1!.obj !== c2!.obj)
                        this.obj = this.dfaCommon!.makeObject(c1!.obj, c2!.obj);
                    else
                        this.obj = c1!.obj !== null ? c1!.obj : c2!.obj;
                }
            }
        };

        const writeCount = this.var!.writeCount;

        // dropped: version (DebugJoinMeetOp) trace (structure.d:3820), OFF (_config.md)

        // uint vs int: D compares in uint (09 §3.1)
        if (c2 === null || c2.writeOnVarAtThisPoint < toUint32(writeCount))
            doOne(c1!);
        else
            doMulti();
    }

    // c1 may be the same consequence as this
    /**
     * dmd/dfa/fast/structure.d:3838 — `void joinConsequence(DFAConsequence* c1, DFAConsequence* c2,`.
     * The JOIN (both facts hold) of `c1` and `c2` into this consequence: truthiness and nullability take the
     * higher of the two (Unknown when `c2`'s is, or `c1`'s under `unknownAware`), the point value their join,
     * objects a merged object, `maybe` from `c2`. Which inputs count depends on the write counts (see the
     * branches) unless `ignoreWriteCount`. Preconditions: `this.var` and `c1` non-null.
     */
    joinConsequence(c1: DFAConsequence | null, c2: DFAConsequence | null, rhsCtx: DFAConsequence | null,
            isC1Context: boolean, ignoreWriteCount = false, unknownAware = false): void {
        const doOne = (c: DFAConsequence): void => {
            // dropped: version (DebugJoinMeetOp) trace (structure.d:3843), OFF (_config.md)

            this.invertedOnce = c.invertedOnce;
            this.writeOnVarAtThisPoint = c.writeOnVarAtThisPoint;
            this.maybe = c.maybe;
            this.pa = c.pa.copy();
            this.obj = c.obj;

            if (this.var === null || this.var.isTruthy)
                this.truthiness = c.truthiness;
            if (this.var === null || this.var.isNullable)
                this.nullable = c.nullable;
        };

        const doMulti = (c2: DFAConsequence): void => {
            // dropped: version (DebugJoinMeetOp) trace (structure.d:3864), OFF (_config.md)

            this.invertedOnce = c1!.invertedOnce || c2.invertedOnce;
            this.writeOnVarAtThisPoint = c1!.writeOnVarAtThisPoint < c2.writeOnVarAtThisPoint
                ? c2.writeOnVarAtThisPoint : c1!.writeOnVarAtThisPoint;
            this.pa = c1!.pa.join(c2.pa.copy());

            if (this.var === null || this.var.isTruthy) {
                if (unknownAware && c1!.truthiness === Truthiness.Unknown || c2.truthiness === Truthiness.Unknown)
                    this.truthiness = Truthiness.Unknown;
                else
                    this.truthiness = c1!.truthiness < c2.truthiness ? c2.truthiness : c1!.truthiness;
            }

            if (this.var === null || this.var.isNullable) {
                if (unknownAware && c1!.nullable === Nullable.Unknown || c2.nullable === Nullable.Unknown)
                    this.nullable = Nullable.Unknown;
                else
                    this.nullable = c1!.nullable < c2.nullable ? c2.nullable : c1!.nullable;

                if (c1!.obj !== null || c2.obj !== null) {
                    if (c1!.obj !== c2.obj)
                        this.obj = this.dfaCommon!.makeObject(c1!.obj, c2.obj);
                    else
                        this.obj = c1!.obj !== null ? c1!.obj : c2.obj;
                }
            }

            this.maybe = c2.maybe;

            // dropped: version (DebugJoinMeetOp) trace (structure.d:3906), OFF (_config.md)
        };

        const writeCount = this.var!.writeCount;

        // dropped: version (DebugJoinMeetOp) trace (structure.d:3915), OFF (_config.md)

        // uint vs int: D compares in uint (09 §3.1)
        if (ignoreWriteCount) {
            if (c2 !== null)
                doMulti(c2);
            else
                doOne(c1!);
        }
        else if (c2 !== null && c2.writeOnVarAtThisPoint >= toUint32(writeCount)) {
            if (c2.writeOnVarAtThisPoint < c1!.writeOnVarAtThisPoint)
                doMulti(c2);
            else
                doOne(c2);
        }
        else {
            if (isC1Context && rhsCtx !== null && rhsCtx.writeOnVarAtThisPoint === toUint32(writeCount)
                    && (rhsCtx.var === null || rhsCtx.var === c1!.var)) {
                if (rhsCtx.writeOnVarAtThisPoint < c1!.writeOnVarAtThisPoint)
                    doMulti(rhsCtx);
            }
            else
                doOne(c1!);
        }
    }

    /// dmd/dfa/fast/structure.d:3955 — `void print(` — dropped with the debug dumpers (file header).

    /** 03 §6.3: D's implicit field-wise copy (pointers shared, `pa` copied). */
    copy(): DFAConsequence {
        const c = new DFAConsequence();
        c.dfaCommon = this.dfaCommon;
        c.listnext = this.listnext;
        c.previous = this.previous;
        c.next = this.next;
        c.bucketNext = this.bucketNext;
        c.var = this.var;
        c.writeOnVarAtThisPoint = this.writeOnVarAtThisPoint;
        c.truthiness = this.truthiness;
        c.nullable = this.nullable;
        c.invertedOnce = this.invertedOnce;
        c.protectElseNegate = this.protectElseNegate;
        c.maybe = this.maybe;
        c.maybeTopSeen = this.maybeTopSeen;
        c.pa = this.pa.copy();
        c.obj = this.obj;
        return c;
    }
}

// D `private:` (structure.d:3987) — module-private free functions.

/**
 * dmd/dfa/fast/structure.d:3988 — `void applyType(DFAVar* var, VarDeclaration vd)`: fills the variable's
 * type-derived flags from `vd`. A variable not owned by a function, or one that is static / extern / __gshared
 * or cannot have its address taken, is unmodellable. `vd.type` is dereferenced.
 */
function applyType(var_: DFAVar, vd: VarDeclaration): void {
    var_.isNullable = vd.isRef() || isTypeNullable(vd.type);
    var_.isTruthy = isTypeTruthy(vd.type);

    var_.isStaticArray = vd.type!.isTypeSArray() !== null;
    var_.isBoolean = vd.type!.ty === Tbool;
    var_.isFloatingPoint = vd.type!.isTypeBasic() !== null && (vd.type!.isTypeBasic()!.flags & TFlags.floating) !== 0;

    // Unfortunately isDataseg can have very undesirable side effects that kill compilation,
    //  even if it shouldn't when this is ran.
    if (vd.parent !== null && vd.parent.isFuncDeclaration() !== null) {
        // make sure the parent of this variable is a function, if it isn't then we can't model it.
        if (!(vd.canTakeAddressOf() && (vd.storage_class & (STC.static_ | STC.extern_ | STC.gshared)) === 0n))
            var_.unmodellable = true;
    }
    else
        var_.unmodellable = true;
}

/// dmd/dfa/fast/structure.d:4011 — `void printPrefix(Args...)(ref OutBuffer ob, const(char)* prefix, int sdepth,`
/// and dmd/dfa/fast/structure.d:4024 — `void printPrefix(Args...)(const(char)* prefix, int sdepth,` — dropped
/// with the debug dumpers (file header).
