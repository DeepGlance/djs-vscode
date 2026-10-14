// Ported from dmd/ob.d (module dmd.ob).
//
// "Flow analysis for Ownership/Borrowing" — the `@live` checker of DIP1021.
//
// Every top-level D declaration, in source order, translated whole — no wall, no escalation:
//   - `oblive` (ob.d:56), the one public entry; everything after `private:` (ob.d:81) is module-private
//     and therefore NOT exported (01 §2.5): `ObNodes`/`StmtState` aliases (:83, :85), `ObState` (:90),
//     `ObNode` (:109), `ObType` (:141) with its `toString` (:153), `PtrState` (:198), `PtrStateToChars`
//     (:205), the `PtrState` `toString` (:210), `PtrVarState` (:218), `setLabelStatementExtraFields`
//     (:332), `toObNodes` (:348), `insertFinallyBlockCalls` (:893), `insertFinallyBlockGotos` (:991),
//     `numberNodes` (:1025), `removeUnreachable` (:1049), `computePreds` (:1098), `isTrackableVar`
//     (:1112), `isTrackableVarExp` (:1144), `collectVars` (:1163), `allocDeps` (:1203), `allocStates`
//     (:1216), `isBorrowedPtr` (:1242), `isReadonlyPtr` (:1253), `genKill` (:1261), `toPtrState`
//     (:1772), `hasPointersToMutableFields` (:1798), `hasMutableFields` (:1828), `doDataFlowAnalysis`
//     (:1855), `escapeLive` (:1996), `checkObErrors` (:2012), `readVar` (:2628), `makeChildrenUndefined`
//     (:2674), `makeUndefined` (:2698), `isMutableRef` (:2709).
// ob.d carries no unittest block (verified: `grep -c unittest ob.d` -> 0).
//
// OVERLOAD RENAMES (04 §1): D's two module-private `toString` overloads differ only in the enum
// parameter type, which TS cannot dispatch on (both are numbers): `toString(ObType)` (:153) is
// `obTypeToString`, `toString(PtrState)` (:210) is `ptrStateToString`.
//
// VISITOR CENSUS (13-visitor.md §0(a), code-free header line): two `extern (C++) final class`
// declarations extending `Visitor`, each named `ExpWalker` and each nested inside the `foreachExp`
// closure of its driver (genKill, ob.d:1351; checkObErrors, ob.d:2105). They stay nested (sideeffect.ts
// precedent), so `extends Visitor` is read at CALL time and this module opens no class-extends-value
// edge (01 §4.1). 13 §1's named-method rename applies; both `alias visit = typeof(super).visit;` lines
// are dropped. `visitAssign(AssignExp, bool)` (:1375) is an ordinary helper method, not an override.
// Base-chain dispatch the overrides rely on: `ConstructExp`/`BlitExp` reach `visitAssignExp`, every
// other `BinExp`/`UnaExp` subclass not named here reaches `visitBinExp`/`visitUnaExp`, and the other
// expression kinds reach the empty `visitExpression`.
//
// RESOLVED CONSTRUCTS:
//   - `struct ObNode` is only ever reached through `ObNode*` (`new ObNode`), so it is a TS class held
//     by reference (02 §10); `Array!(ObNode*)` is `DArray<ObNode>`.
//   - `struct PtrVarState` is a VALUE type whose user-defined `opAssign` copies `state` and the bits of
//     `deps` into the destination's own BitArray (03 §1). Every D `a = b` on it is `a.opAssign(b)`,
//     and every `a == b`/`a != b` is `a.opEquals(b)` (05 §1). `PtrVarState[]` slices over the
//     `xcalloc` pool (ob.d:1220) are JS arrays that share the pool's element objects, exactly the D
//     aliasing: `&ob.gen[vi]` is the element object itself. A zeroed `PtrVarState` (xcalloc) is
//     `new PtrVarState()`: state `Initial` (0), empty `deps`.
//   - `mem.xfree` of the pools (ob.d:102, :1624, :1660, :2369, :2403) and the ObState
//     destructor are GC cleanup: dropped (01 §5.3).
//   - `void* extra` on `CaseStatement`/`LabelStatement` (statement.ts `extra: unknown`) holds an ObNode;
//     the one cast back lives in `extraNode` (02 §11.5c shape 6).
//   - `ObType`/`PtrState` are `ubyte` enums -> TS numeric enums; `PtrState.max + 1` (ob.d:239) is 5.
//   - `const int j = tf.isDstyleVariadic();` (bool -> int) is `? 1 : 0`. The `i - j < length && i >= j`
//     guards (size_t arithmetic, wrapping when i < j) give the same verdict with signed numbers, because
//     `i >= j` is false exactly when the D subtraction would wrap.
//   - `bool` flag compares on `STC` are `!== 0n` (09 §1).
//
// FAITHFUL QUIRKS, kept verbatim:
//   - checkObErrors's `obstate.mutableStack[vi]` (ob.d:2306) indexes the parallel stack by the variable
//     index `vi`, not the stack position `i`, and D's unchecked `opIndex` reads the slot even past the
//     stack's end. `BoolStack` keeps D's slot storage so the read sees what D sees (probes m1, m5, m6).
//   - genKill's `LogicalExp`/`CondExp` scratch states are merged with `combine`, whose default arm makes
//     the variable Undefined in `ob.gen` (ob.d:277).
//
// DROPPED (non-debug build, `_config.md` §3; 07 audit convention): the bare `debug` block of
// numberNodes (ob.d:1035-1039), the `debug printf` before `assert(0)` in toObNodes (ob.d:859), the
// `static if (0)` dump in toObNodes (ob.d:868-875), and every `enum log = false;` gate with its
// `if (log)`/`static if (log)` traces (ob.d:898, :1165, :1263, :1857, :2014). Commented-out D code
// lines (printf traces, the `needsScopeDtor` test at :1126-1127, the `kill`/`comb` lines at
// :1225-1226, the Undefined check at :1567-1568 and :2294-2295) are not carried over.
//
// dropped: `import dmd.printast;` (ob.d:40) — ob.d references no printast symbol (grep `printAST ob.d`
// finds only the import), so the module is not ported for this file.
// dropped: `import core.stdc.stdlib; import core.stdc.string;` (ob.d:16-17) — only `mem`/pool use.
// dropped: `import dmd.root.rmem;` (ob.d:21): `mem.xcalloc`/`xfree` map to JS allocation and GC.

import type { DString } from "../dstring.js";
import { ds, dsConcat, dsToJs } from "../dstring.js";
import { assert, assertUnreachable, SwitchError } from "../assert.js";
import { SIZE_MAX } from "../numeric.js";
import type { Expression, AssignExp, DeclarationExp, VarExp, CallExp, SymOffExp, LogicalExp, CondExp,
    AddrExp, UnaExp, BinExp, ArrayLiteralExp, StructLiteralExp, AssocArrayLiteralExp, NewExp,
    SliceExp } from "./expression.js";
import type { VarDeclaration } from "./declaration.js";
import type { Dsymbol, DsymbolTable } from "./dsymbol.js";
import type { FuncDeclaration } from "./func.js";
import type { LabelDsymbol } from "./statement.js";
import type {
    Statement, ExpStatement, DtorExpStatement, CompoundStatement, CompoundDeclarationStatement,
    UnrolledLoopStatement, ScopeStatement, DoStatement, ForStatement, IfStatement, SwitchStatement,
    CaseStatement, DefaultStatement, GotoDefaultStatement, GotoCaseStatement, SwitchErrorStatement,
    ReturnStatement, BreakStatement, ContinueStatement, WithStatement, TryCatchStatement,
    TryFinallyStatement, ThrowStatement, GotoStatement, LabelStatement,
} from "./statement.js";
import type { Type, TypeFunction, Parameter } from "./mtype.js";
import type { VarDeclarations } from "./arraytypes.js";
import { Array as DArray } from "./root/array.js";
import { BitArray } from "./root/bitarray.js";
import { OutBuffer } from "./common/outbuffer.js";
import { dmdformat } from "./root/dmdformat.js";
import { STC, STMT, TY } from "./astenums.js";
import { EXP } from "./tokens.js";
import type { Loc } from "./location.js";
import { error } from "./errors.js";
import { StmtState } from "./stmtstate.js";
import { Visitor } from "./visitor/index.js";
import { foreachVar, foreachExpAndVar } from "./visitor/foreachvar.js";
// last: escape, typesem and dsymbolsem are core-SCC semantic modules; naming them first would make this
// module an entry into the SCC (01 §4.8)
import { EscapeByResults, escapeByValue } from "./escape.js";
import { hasPointers, nextOf, toBasetype } from "./typesem.js";
import { toAlias } from "./dsymbolsem.js";

/**********************************
 * dmd/ob.d:56 — `void oblive(FuncDeclaration funcdecl)`.
 * Perform ownership/borrowing checks for funcdecl.
 * Does not modify the AST, just checks for errors.
 *
 * Precondition: `funcdecl.fbody` is the semantic3-lowered body (no `while`/`foreach`/`scope(...)`
 * left; asserted in toObNodes) and `funcdecl.type` is not `Terror` — the caller's gate at
 * semantic3.d:1470. Diagnostics go through `error()`; the only AST write is `VarDeclaration.isowner`
 * (ob.d:1324) and the `extra` slots of the body's case and label statements, which it owns for the
 * duration of the call. Cost: builds a flow graph and iterates a data-flow fixpoint over
 * nodes × tracked variables (asserted to converge within 1000 rounds).
 */
export function oblive(funcdecl: FuncDeclaration): void {
    const obstate = new ObState();

    /* Build the flow graph
     */
    setLabelStatementExtraFields(funcdecl.labtab);
    toObNodes(obstate.nodes, funcdecl.fbody);
    insertFinallyBlockCalls(obstate.nodes);
    insertFinallyBlockGotos(obstate.nodes);
    removeUnreachable(obstate.nodes);
    computePreds(obstate.nodes);

    numberNodes(obstate.nodes);

    collectVars(funcdecl, obstate.vars);
    allocStates(obstate);
    doDataFlowAnalysis(obstate);

    checkObErrors(obstate);
}

/// ob.d:83 — `alias ObNodes = Array!(ObNode*);`
type ObNodes = DArray<ObNode>;

/*******************************************
 * ob.d:90 — `struct ObState`.
 * Collect the state information.
 * Only ever used through `ref`, so a class (03 §1); the destructor's `mem.xfree(varPool.ptr)` is GC
 * cleanup and dropped. Non-copyable: its `Array` fields disable the postblit (root/array.d:50), so it
 * carries no `copy()` (03 §6.2).
 */
class ObState {
    nodes: ObNodes = new DArray<ObNode>();
    vars: VarDeclarations = new DArray<VarDeclaration>();

    varStack: DArray<number> = new DArray<number>();       /// temporary storage
    mutableStack: BoolStack = new BoolStack();              /// parallel to varStack[], is type mutable?

    varPool: PtrVarState[] = [];      /// memory pool
}

/*******************************************
 * ob.d:96 — the `Array!bool` of `ObState.mutableStack`, with D's storage kept where ob.d observes it.
 *
 * checkObErrors reads `obstate.mutableStack[vi]` (ob.d:2306) by the VARIABLE index, which may lie at or
 * past `length`. D's non-debug `opIndex` is the unchecked `data.ptr[i]` (root/array.d:315-321) and
 * `setDim` only lowers `length` (root/array.d:293), so such a read sees the value an earlier call left
 * in that slot: ldc2 reports m5.d (`three(x, y, p); two(p, p);`, scope parameters) as "passed as Owner
 * more than once" from the `true` that three() left at slot 2, and m6.d (the same, three() taking
 * const) clean. TS `DArray.setDim` truncates its backing array, which would lose those values, so the
 * slots live here. A slot never written is uninitialized heap in D (undefined behaviour); it reads as
 * `false`, ldc2's observed verdict on m1.d (the §2 record of the port's report).
 * Invariant: `setDim` only ever lowers `length` (ob.d pops back to a saved height).
 */
class BoolStack {
    length = 0;
    private slots: boolean[] = [];

    /// D `push` (root/array.d:144).
    push(v: boolean): void {
        this.slots[this.length++] = v;
    }

    /// D `setDim` (root/array.d:293), lowering only: the slots past the new length keep their values.
    setDim(n: number): void {
        assert(n <= this.length);
        this.length = n;
    }

    /// D `opIndex` (root/array.d:315) at any slot index, in or past `length`: see the class comment.
    opIndex(i: number): boolean {
        return this.slots[i] === true;
    }
}

/***********************************************
 * ob.d:109 — `struct ObNode`.
 * A node in the function's expression graph, and its edges to predecessors and successors.
 * Non-copyable: its `Array` fields disable the postblit (root/array.d:50), so it carries no `copy()`
 * (03 §6.2); D reaches it only as `ObNode*`.
 */
class ObNode {
    exp: Expression | null = null;      /// expression for the node
    preds: ObNodes = new DArray<ObNode>();      /// predecessors
    succs: ObNodes = new DArray<ObNode>();      /// successors
    tryBlock: ObNode | null;    /// try-finally block we're inside
    obtype: ObType = ObType.goto_;
    index = 0;         /// index of this in obnodes

    gen: PtrVarState[] = [];    /// new states generated for this node
    input: PtrVarState[] = [];  /// variable states on entry to exp
    output: PtrVarState[] = []; /// variable states on exit to exp

    /// ob.d:122 — `this(ObNode* tryBlock) scope`. D's argument-less `new ObNode()` (ob.d:920, :931) is
    /// the default construction, `tryBlock` null.
    constructor(tryBlock: ObNode | null = null) {
        this.tryBlock = tryBlock;
    }

    /// ob.d:127 — `void print()`: a developer dump to stdout, reached only from dropped log blocks.
    print(): void {
        let s = dmdformat("%d: %s %s\n", [this.index, ds(obTypeToString(this.obtype)),
            this.exp !== null ? this.exp.toChars() : ds("-")]);
        s = dsConcat(s, ds("  preds: "));
        for (const ob of this.preds.opSlice())
            s = dsConcat(s, dmdformat(" %d", [ob.index]));
        s = dsConcat(s, ds("\n  succs: "));
        for (const ob of this.succs.opSlice())
            s = dsConcat(s, dmdformat(" %d", [ob.index]));
        s = dsConcat(s, ds("\n\n"));
        process.stdout.write(dsToJs(s));
    }
}

/// ob.d:141 — `enum ObType : ubyte`.
enum ObType {
    goto_,              /// goto one of the succs[]
    return_,            /// returns from function
    retexp,             /// returns expression from function
    throw_,             /// exits with throw
    exit,               /// exits program
    try_,
    finally_,
    fend,
}

/// ob.d:153 — `string toString(ObType obtype) @safe` (renamed, see the file header).
function obTypeToString(obtype: ObType): string {
    return obtype === ObType.goto_     ? "goto  "  :
           obtype === ObType.return_   ? "ret   "  :
           obtype === ObType.retexp    ? "retexp"  :
           obtype === ObType.throw_    ? "throw"   :
           obtype === ObType.exit      ? "exit"    :
           obtype === ObType.try_      ? "try"     :
           obtype === ObType.finally_  ? "finally" :
           obtype === ObType.fend      ? "fend"    :
           "---";
}

/***********
 ob.d:166-196 — Pointer variable states:

    Initial     state is not known; ignore for now

    Undefined   not in a usable state

                T* p = void;

    Owner       mutable pointer

                T* p = initializer;

    Borrowed    scope mutable pointer, borrowed from [p]

                T* p = initializer;
                scope T* b = p;

    Readonly    scope const pointer, copied from [p]

                T* p = initializer;
                scope const(T)* cp = p;

 Examples:

    T* p = initializer; // p is owner
    T** pp = &p;        // pp borrows from p

    T* p = initialize;  // p is owner
    T* q = p;           // transfer: q is owner, p is undefined
 */

/// ob.d:198 — `enum PtrState : ubyte`.
enum PtrState {
    Initial, Undefined, Owner, Borrowed, Readonly
}

/// ob.d:205 — `const(char)* PtrStateToChars(PtrState state)`.
function PtrStateToChars(state: PtrState): DString {
    return ds(ptrStateToString(state));
}

/// ob.d:210 — `string toString(PtrState state) @safe` (renamed, see the file header).
function ptrStateToString(state: PtrState): string {
    return ["Initial", "Undefined", "Owner", "Borrowed", "Readonly"][state];
}

/******
 * ob.d:218 — `struct PtrVarState`.
 * Carries the state of a pointer variable.
 * A value type: see the file header for how its `opAssign`/`opEquals` map.
 */
class PtrVarState {
    deps: BitArray = new BitArray();           /// dependencies
    state: PtrState = PtrState.Initial;        /// state the pointer variable is in

    /// ob.d:223 — `void opAssign(const ref PtrVarState pvs)`: copies the state and the dependency bits
    /// (BitArray's own opAssign: an empty destination adopts the source length first).
    opAssign(pvs: PtrVarState): void {
        this.state = pvs.state;
        this.deps.opAssign(pvs.deps);
    }

    /// 03 §6.3 — the value-struct copy, routed through the user `opAssign` (ob.d:223). ob.d never copies
    /// a PtrVarState outside `opAssign` (its states live in the pool and are reached by reference), so
    /// nothing calls this; it is the copy contract of a copyable struct (03 §2).
    copy(): PtrVarState {
        const c = new PtrVarState();
        c.opAssign(this);
        return c;
    }

    /* Combine `this` and `pvs` into `this`,
     * on the idea that the `this` and the `pvs` paths
     * are being merged
     * Params:
     *  pvs = path to be merged with `this`
     *  vi = variable's index into gen[]
     *  gen = array of variable states
     */
    /// ob.d:237 — `void combine(ref PtrVarState pvs, size_t vi, PtrVarState[] gen)`.
    combine(pvs: PtrVarState, vi: number, gen: PtrVarState[]): void {
        // ob.d:239 — `static uint X(PtrState x1, PtrState x2)`; `PtrState.max + 1` is 5.
        function X(x1: PtrState, x2: PtrState): number { return x1 * (PtrState.Readonly + 1) + x2; }

        switch (X(this.state, pvs.state)) {
            case X(PtrState.Initial, PtrState.Initial):
                break;

            case X(PtrState.Initial, PtrState.Owner    ):
            case X(PtrState.Initial, PtrState.Borrowed ):
            case X(PtrState.Initial, PtrState.Readonly ):
                // Transfer state to `this`
                this.state = pvs.state;
                this.deps.opAssign(pvs.deps);
                break;

            case X(PtrState.Owner,    PtrState.Initial):
            case X(PtrState.Borrowed, PtrState.Initial):
            case X(PtrState.Readonly, PtrState.Initial):
                break;

            case X(PtrState.Undefined, PtrState.Initial):
            case X(PtrState.Undefined, PtrState.Undefined):
            case X(PtrState.Undefined, PtrState.Owner    ):
            case X(PtrState.Undefined, PtrState.Borrowed ):
            case X(PtrState.Undefined, PtrState.Readonly ):
                break;

            case X(PtrState.Owner    , PtrState.Owner   ):
                break;

            case X(PtrState.Borrowed , PtrState.Borrowed):
            case X(PtrState.Readonly , PtrState.Readonly):
                this.deps.or(pvs.deps);
                break;

            default:
                makeUndefined(vi, gen);
                break;
        }
    }

    /// ob.d:283 — `bool opEquals(const ref PtrVarState pvs) const`.
    opEquals(pvs: PtrVarState): boolean {
        return this.state === pvs.state &&
                this.deps.opEquals(pvs.deps);
    }

    /***********************
     * ob.d:294 — `void print(VarDeclaration[] vars)`.
     * Print a bracketed list of all the variables that depend on 'this'
     * Params:
     *  vars = variables that depend on 'this'
     * A developer dump to stdout, reached only from dropped log blocks.
     */
    print(vars: VarDeclaration[]): void {
        const s = ptrStateToString(this.state);
        process.stdout.write(s + " [");
        assert(vars.length === this.deps.length);
        const buf = new OutBuffer();
        this.depsToBuf(buf, vars);
        const t = buf.opSliceAll();
        process.stdout.write(dsToJs(t) + "]\n");
    }

    /*****************************
     * ob.d:312 — `void depsToBuf(ref OutBuffer buf, const VarDeclaration[] vars)`.
     * Produce a user-readable comma separated string of the
     * dependencies.
     * Params:
     *  buf = write resulting string here
     *  vars = array from which to get the variable names
     */
    depsToBuf(buf: OutBuffer, vars: readonly VarDeclaration[]): void {
        let any = false;
        for (let i = 0; i < this.deps.length; i++) {
            if (this.deps.opIndex(i)) {
                if (any)
                    buf.writestring(ds(", "));
                buf.writestring(vars[i].toString());
                any = true;
            }
        }
    }
}

/// The `void* extra` slot of a case or label statement holds the ObNode this module put there
/// (ob.d:340, :585). statement.ts declares the slot `extra: unknown` (statement.ts:1232 CaseStatement,
/// statement.ts:1751 LabelStatement, 02 §10 opaque) because only this module and the glue type it; D's
/// `cast(ObNode*)s.extra` is this one re-typing cast (02 §11.5c shape 6).
function extraNode(extra: unknown): ObNode {
    return extra as ObNode;
}

/*****************************************
 * ob.d:332 — `void setLabelStatementExtraFields(DsymbolTable labtab)`.
 * Set the `.extra` field for LabelStatements in labtab[].
 */
function setLabelStatementExtraFields(labtab: DsymbolTable | null): void {
    if (labtab !== null) {
        for (const keyValue of labtab.tab.asRange()) {
            // D `cast(LabelDsymbol)keyValue.value` is an unchecked extern(C++) reinterpret; labtab holds
            // only LabelDsymbols (func.d searchLabel inserts nothing else), so `isLabel()` is the
            // tag-proved equivalent.
            const label: LabelDsymbol | null = keyValue[1].isLabel();
            if (label!.statement !== null)
                label!.statement.extra = new ObNode(null);
        }
    }
}

/*****************************************
 * ob.d:348 — `void toObNodes(ref ObNodes obnodes, Statement s)`.
 * Convert statement into ObNodes.
 */
function toObNodes(obnodes: ObNodes, s: Statement | null): void {
    let curblock = new ObNode(null);
    obnodes.push(curblock);

    function visit(s: Statement | null, stmtstate: StmtState<ObNode>): void {
        if (s === null)
            return;

        function newNode(): ObNode {
            return new ObNode(stmtstate.tryBlock);
        }

        function nextNodeIs(ob: ObNode): ObNode {
            obnodes.push(ob);
            curblock = ob;
            return ob;
        }

        function nextNode(): ObNode {
            return nextNodeIs(newNode());
        }

        function gotoNextNodeIs(ob: ObNode): ObNode {
            obnodes.push(ob);
            curblock.succs.push(ob);
            curblock = ob;
            return ob;
        }

        // block_goto(blx, BC.goto_, null)
        function gotoNextNode(): ObNode {
            return gotoNextNodeIs(newNode());
        }

        /***
         * Doing a goto to dest
         */
        function gotoDest(dest: ObNode): ObNode {
            curblock.succs.push(dest);
            return nextNode();
        }

        function visitExp(s: ExpStatement): void {
            curblock.obtype = ObType.goto_;
            curblock.exp = s.exp;
            gotoNextNode();
        }

        function visitDtorExp(s: DtorExpStatement): void {
            visitExp(s);
        }

        function visitCompound(s: CompoundStatement): void {
            if (s.statements !== null) {
                for (const s2 of s.statements.opSlice()) {
                    visit(s2, stmtstate);
                }
            }
        }

        function visitCompoundDeclaration(s: CompoundDeclarationStatement): void {
            visitCompound(s);
        }

        function visitUnrolledLoop(s: UnrolledLoopStatement): void {
            const mystate = new StmtState<ObNode>(stmtstate, s);
            mystate.breakBlock = newNode();

            gotoNextNode();

            for (const s2 of s.statements!.opSlice()) {
                if (s2 !== null) {
                    mystate.contBlock = newNode();

                    visit(s2, mystate);

                    gotoNextNodeIs(mystate.contBlock);
                }
            }

            gotoNextNodeIs(mystate.breakBlock);
        }

        function visitScope(s: ScopeStatement): void {
            if (s.statement !== null) {
                const mystate = new StmtState<ObNode>(stmtstate, s);

                if (mystate.prev!.ident !== null)
                    mystate.ident = mystate.prev!.ident;

                visit(s.statement, mystate);

                if (mystate.breakBlock !== null)
                    gotoNextNodeIs(mystate.breakBlock);
            }
        }

        function visitDo(s: DoStatement): void {
            const mystate = new StmtState<ObNode>(stmtstate, s);
            mystate.breakBlock = newNode();
            mystate.contBlock = newNode();

            const bpre = curblock;

            const ob = newNode();
            obnodes.push(ob);
            curblock.succs.push(ob);
            curblock = ob;
            bpre.succs.push(curblock);

            mystate.contBlock.succs.push(curblock);
            mystate.contBlock.succs.push(mystate.breakBlock);

            visit(s._body, mystate);

            gotoNextNodeIs(mystate.contBlock);
            mystate.contBlock.exp = s.condition;
            nextNodeIs(mystate.breakBlock);
        }

        function visitFor(s: ForStatement): void {
            const mystate = new StmtState<ObNode>(stmtstate, s);
            mystate.breakBlock = newNode();
            mystate.contBlock = newNode();

            visit(s._init, mystate);

            const bcond = gotoNextNode();
            mystate.contBlock.succs.push(bcond);

            if (s.condition !== null) {
                bcond.exp = s.condition;
                const ob = newNode();
                obnodes.push(ob);
                bcond.succs.push(ob);
                bcond.succs.push(mystate.breakBlock);
                curblock = ob;
            } else {
                /* No conditional, it's a straight goto
                 */
                bcond.exp = s.condition;
                bcond.succs.push(nextNode());
            }

            visit(s._body, mystate);
            /* End of the body goes to the continue block
             */
            curblock.succs.push(mystate.contBlock);
            nextNodeIs(mystate.contBlock);

            if (s.increment !== null)
                curblock.exp = s.increment;

            /* The 'break' block follows the for statement.
             */
            nextNodeIs(mystate.breakBlock);
        }

        function visitIf(s: IfStatement): void {
            const mystate = new StmtState<ObNode>(stmtstate, s);

            // bexit is the block that gets control after this IfStatement is done
            const bexit = mystate.breakBlock !== null ? mystate.breakBlock : newNode();

            curblock.exp = s.condition;

            const bcond = curblock;
            gotoNextNode();

            visit(s.ifbody, mystate);
            curblock.succs.push(bexit);

            if (s.elsebody !== null) {
                bcond.succs.push(nextNode());

                visit(s.elsebody, mystate);

                gotoNextNodeIs(bexit);
            } else {
                bcond.succs.push(bexit);
                nextNodeIs(bexit);
            }
        }

        function visitSwitch(s: SwitchStatement): void {
            const mystate = new StmtState<ObNode>(stmtstate, s);

            mystate.switchBlock = curblock;

            /* Block for where "break" goes to
             */
            mystate.breakBlock = newNode();

            /* Block for where "default" goes to.
             * If there is a default statement, then that is where default goes.
             * If not, then do:
             *   default: break;
             * by making the default block the same as the break block.
             */
            mystate.defaultBlock = s.sdefault !== null ? newNode() : mystate.breakBlock;

            const numcases = s.cases !== null ? s.cases.length : 0;

            /* allocate a block for each case
             */
            if (numcases)
                for (const cs of s.cases!.opSlice()) {
                    cs!.extra = newNode();
                }

            curblock.exp = s.condition;

            if (s.hasVars) {
                /* Generate a sequence of if-then-else blocks for the cases.
                 */
                if (numcases)
                    for (const cs of s.cases!.opSlice()) {
                        const ecase = newNode();
                        obnodes.push(ecase);
                        ecase.exp = cs!.exp;
                        curblock.succs.push(ecase);

                        const cn = extraNode(cs!.extra);
                        ecase.succs.push(cn);
                        ecase.succs.push(nextNode());
                    }

                /* The final 'else' clause goes to the default
                 */
                curblock.succs.push(mystate.defaultBlock);
                nextNode();

                visit(s._body, mystate);

                /* Have the end of the switch body fall through to the block
                 * following the switch statement.
                 */
                gotoNextNodeIs(mystate.breakBlock);
                return;
            }

            const ob = newNode();
            obnodes.push(ob);
            curblock = ob;

            mystate.switchBlock.succs.push(mystate.defaultBlock);

            visit(s._body, mystate);

            /* Have the end of the switch body fall through to the block
             * following the switch statement.
             */
            gotoNextNodeIs(mystate.breakBlock);
        }

        function visitCase(s: CaseStatement): void {
            const cb = extraNode(s.extra);
            cb.tryBlock = stmtstate.tryBlock;
            const bsw = stmtstate.getSwitchBlock();
            bsw!.succs.push(cb);
            gotoNextNodeIs(cb);

            visit(s.statement, stmtstate);
        }

        function visitDefault(s: DefaultStatement): void {
            const bdefault = stmtstate.getDefaultBlock()!;
            bdefault.tryBlock = stmtstate.tryBlock;
            gotoNextNodeIs(bdefault);
            visit(s.statement, stmtstate);
        }

        function visitGotoDefault(_s: GotoDefaultStatement): void {
            gotoDest(stmtstate.getDefaultBlock()!);
        }

        function visitGotoCase(s: GotoCaseStatement): void {
            gotoDest(extraNode(s.cs!.extra));
        }

        function visitSwitchError(s: SwitchErrorStatement): void {
            curblock.obtype = ObType.throw_;
            curblock.exp = s.exp;

            nextNode();
        }

        function visitReturn(s: ReturnStatement): void {
            curblock.obtype = s.exp !== null && toBasetype(s.exp.type!).ty !== TY.Tvoid
                        ? ObType.retexp
                        : ObType.return_;
            curblock.exp = s.exp;

            nextNode();
        }

        function visitBreak(s: BreakStatement): void {
            gotoDest(stmtstate.getBreakBlock(s.ident)!);
        }

        function visitContinue(s: ContinueStatement): void {
            gotoDest(stmtstate.getContBlock(s.ident)!);
        }

        function visitWith(s: WithStatement): void {
            visit(s._body, stmtstate);
        }

        function visitTryCatch(s: TryCatchStatement): void {
            /* tryblock
             * body
             * breakBlock
             * catches
             * breakBlock2
             */

            const mystate = new StmtState<ObNode>(stmtstate, s);
            mystate.breakBlock = newNode();

            const tryblock = gotoNextNode();

            visit(s._body, mystate);

            gotoNextNodeIs(mystate.breakBlock);

            // create new break block that follows all the catches
            const breakBlock2 = newNode();

            gotoDest(breakBlock2);

            for (const cs of s.catches!.opSlice()) {
                /* Each catch block is a successor to tryblock
                 * and the last block of try body
                 */
                const catchState = new StmtState<ObNode>(stmtstate, s);

                const bcatch = curblock;
                tryblock.succs.push(bcatch);
                mystate.breakBlock.succs.push(bcatch);

                nextNode();

                visit(cs!.handler, catchState);

                gotoDest(breakBlock2);
            }

            curblock.succs.push(breakBlock2);
            obnodes.push(breakBlock2);
            curblock = breakBlock2;
        }

        function visitTryFinally(s: TryFinallyStatement): void {
            /* Build this:
             *  1  goto     [2]
             *  2  try_     [3] [5] [7]
             *  3  body
             *  4  goto     [8]
             *  5  finally_ [6]
             *  6  finalbody
             *  7  fend     [8]
             *  8  lastblock
             */

            const bodyState = new StmtState<ObNode>(stmtstate, s);

            const b2 = gotoNextNode();
            b2.obtype = ObType.try_;
            bodyState.tryBlock = b2;

            gotoNextNode();

            visit(s._body, bodyState);

            const b4 = gotoNextNode();

            const b5 = newNode();
            b5.obtype = ObType.finally_;
            nextNodeIs(b5);
            gotoNextNode();

            const finallyState = new StmtState<ObNode>(stmtstate, s);
            visit(s.finalbody, finallyState);

            const b7 = gotoNextNode();
            b7.obtype = ObType.fend;

            const b8 = gotoNextNode();

            b2.succs.push(b5);
            b2.succs.push(b7);

            b4.succs.push(b8);
        }

        function visitThrow(s: ThrowStatement): void {
            curblock.obtype = ObType.throw_;
            curblock.exp = s.exp;
            nextNode();
        }

        function visitGoto(s: GotoStatement): void {
            gotoDest(extraNode(s.label!.statement!.extra));
        }

        function visitLabel(s: LabelStatement): void {
            const mystate = new StmtState<ObNode>(stmtstate, s);
            mystate.ident = s.ident;

            const ob = extraNode(s.extra);
            ob.tryBlock = mystate.tryBlock;
            visit(s.statement, mystate);
        }

        switch (s.stmt) {
            case STMT.Exp:                 visitExp(s.isExpStatement()!); break;
            case STMT.DtorExp:             visitDtorExp(s.isDtorExpStatement()!); break;
            case STMT.Compound:            visitCompound(s.isCompoundStatement()!); break;
            case STMT.CompoundDeclaration: visitCompoundDeclaration(s.isCompoundDeclarationStatement()!); break;
            case STMT.UnrolledLoop:        visitUnrolledLoop(s.isUnrolledLoopStatement()!); break;
            case STMT.Scope:               visitScope(s.isScopeStatement()!); break;
            case STMT.Do:                  visitDo(s.isDoStatement()!); break;
            case STMT.For:                 visitFor(s.isForStatement()!); break;
            case STMT.If:                  visitIf(s.isIfStatement()!); break;
            case STMT.Switch:              visitSwitch(s.isSwitchStatement()!); break;
            case STMT.Case:                visitCase(s.isCaseStatement()!); break;
            case STMT.Default:             visitDefault(s.isDefaultStatement()!); break;
            case STMT.GotoDefault:         visitGotoDefault(s.isGotoDefaultStatement()!); break;
            case STMT.GotoCase:            visitGotoCase(s.isGotoCaseStatement()!); break;
            case STMT.SwitchError:         visitSwitchError(s.isSwitchErrorStatement()!); break;
            case STMT.Return:              visitReturn(s.isReturnStatement()!); break;
            case STMT.Break:               visitBreak(s.isBreakStatement()!); break;
            case STMT.Continue:            visitContinue(s.isContinueStatement()!); break;
            case STMT.With:                visitWith(s.isWithStatement()!); break;
            case STMT.TryCatch:            visitTryCatch(s.isTryCatchStatement()!); break;
            case STMT.TryFinally:          visitTryFinally(s.isTryFinallyStatement()!); break;
            case STMT.Throw:               visitThrow(s.isThrowStatement()!); break;
            case STMT.Goto:                visitGoto(s.isGotoStatement()!); break;
            case STMT.Label:               visitLabel(s.isLabelStatement()!); break;

            case STMT.CompoundAsm:
            case STMT.Asm:
            case STMT.InlineAsm:
            case STMT.GccAsm:

            case STMT.Pragma:
            case STMT.Import:
            case STMT.ScopeGuard:
            case STMT.Error:
                break;          // ignore these

            case STMT.Foreach:
            case STMT.ForeachRange:
            case STMT.Debug:
            case STMT.CaseRange:
            case STMT.StaticForeach:
            case STMT.StaticAssert:
            case STMT.Conditional:
            case STMT.While:
            case STMT.Forwarding:
            case STMT.Mixin:
            case STMT.Peel:
            case STMT.Synchronized:
                // dropped: `debug printf("s: %s\n", toChars(s));` (ob.d:859, non-debug build)
                assertUnreachable();    // should have been rewritten

            default: {
                // final switch: D throws SwitchError on an unhandled value
                const _exhaustive: never = s.stmt; void _exhaustive;
                throw new SwitchError();
            }
        }
    }

    // ob.d:864 — `StmtState stmtstate;`, the default-initialized state (every field null).
    const stmtstate = new StmtState<ObNode>(null, null);
    visit(s, stmtstate);
    curblock.obtype = ObType.return_;

    // dropped: `static if (0)` dump block (ob.d:868-875)

    assert(stmtstate.breakBlock === null);
    assert(stmtstate.contBlock === null);
    assert(stmtstate.switchBlock === null);
    assert(stmtstate.defaultBlock === null);
    assert(stmtstate.tryBlock === null);
}

/***************************************************
 * ob.d:893 — `void insertFinallyBlockCalls(ref ObNodes obnodes)`.
 * Insert finally block calls when doing a goto from
 * inside a try block to outside.
 * Done after blocks are generated because then we know all
 * the edges of the graph, but before the pred's are computed.
 * Params:
 *      obnodes = graph of the function
 */
function insertFinallyBlockCalls(obnodes: ObNodes): void {
    let bcret: ObNode | null = null;
    let bcretexp: ObNode | null = null;

    // dropped: enum log = false (gate constant; both static-if(log) blocks dropped — dmd/ob.d:898)

    for (const ob of obnodes.opSlice()) {
        if (ob.tryBlock === null)
            continue;

        // SHARED-ARM (06 §4): the `case_goto:` block (ob.d:942) is entered by fall-through from the
        // `goto_` arm and by a jump from the `return_` and `retexp` arms; each ends with the switch's
        // `break`, so the block is a closure the three arms call last.
        const case_goto = (): void => {
            const target = ob.succs.opIndex(0);              // destination of goto
            ob.succs.setDim(0);
            const lasttry = target.tryBlock;
            let blast = ob;
            for (let bt = ob.tryBlock; bt !== lasttry; bt = bt!.tryBlock) {
                assert(bt!.obtype === ObType.try_);
                const bf = bt!.succs.opIndex(1);
                assert(bf.obtype === ObType.finally_);
                const bfend = bt!.succs.opIndex(2);
                assert(bfend.obtype === ObType.fend);

                if (!blast.succs.contains(bf.succs.opIndex(0)))
                    blast.succs.push(bf.succs.opIndex(0));

                blast = bfend;
            }
            if (!blast.succs.contains(target))
                blast.succs.push(target);
        };

        switch (ob.obtype) {
            case ObType.return_:
                // Rewrite into a ObType.goto_ => ObType.return_
                if (bcret === null) {
                    bcret = new ObNode();
                    bcret.obtype = ob.obtype;
                }
                ob.obtype = ObType.goto_;
                ob.succs.push(bcret);
                case_goto();
                break;

            case ObType.retexp:
                // Rewrite into a ObType.goto_ => ObType.retexp
                if (bcretexp === null) {
                    bcretexp = new ObNode();
                    bcretexp.obtype = ob.obtype;
                }
                ob.obtype = ObType.goto_;
                ob.succs.push(bcretexp);
                case_goto();
                break;

            case ObType.goto_:
                if (ob.succs.length !== 1)
                    break;
                case_goto();
                break;

            default:
                break;
        }
    }
    if (bcret !== null)
        obnodes.push(bcret);
    if (bcretexp !== null)
        obnodes.push(bcretexp);
}

/***************************************************
 * ob.d:991 — `void insertFinallyBlockGotos(ref ObNodes obnodes)`.
 * Remove try-finally scaffolding.
 * Params:
 *      obnodes = nodes for the function
 */
function insertFinallyBlockGotos(obnodes: ObNodes): void {
    /* Remove all the try_, finally_, lpad and ret nodes.
     * Actually, just make them into no-ops.
     */
    for (const ob of obnodes.opSlice()) {
        ob.tryBlock = null;
        switch (ob.obtype) {
            case ObType.try_:
                ob.obtype = ObType.goto_;
                ob.succs.remove(2);     // remove fend
                ob.succs.remove(1);     // remove finally_
                break;

            case ObType.finally_:
                ob.obtype = ObType.goto_;
                break;

            case ObType.fend:
                ob.obtype = ObType.goto_;
                break;

            default:
                break;
        }
    }
}

/*********************************
 * ob.d:1025 — `void numberNodes(ref ObNodes obnodes) @safe`.
 * Set the `index` field of each ObNode
 * to its index in the `obnodes[]` array.
 */
function numberNodes(obnodes: ObNodes): void {
    const nodes = obnodes.opSlice();
    for (let i = 0; i < nodes.length; i++) {
        nodes[i].index = i;
    }

    // Verify that nodes do not appear more than once in obnodes[]
    // dropped: bare `debug` verification loop (ob.d:1035-1039, non-debug build)
}

/*********************************
 * ob.d:1049 — `void removeUnreachable(ref ObNodes obnodes)`.
 * Remove unreachable nodes and compress
 * them out of obnodes[].
 * Params:
 *      obnodes = array of nodes
 */
function removeUnreachable(obnodes: ObNodes): void {
    if (!obnodes.length)
        return;

    /* Mark all nodes as unreachable,
     * temporarilly reusing ObNode.index
     */
    for (const ob of obnodes.opSlice())
        ob.index = 0;

    /* Recursively mark ob and all its successors as reachable
     */
    function mark(ob: ObNode): void {
        ob.index = 1;
        for (const succ of ob.succs.opSlice()) {
            if (!succ.index)
                mark(succ);
        }
    }

    mark(obnodes.opIndex(0));   // first node is entry point

    /* Remove unreachable nodes by shifting the remainder left
     */
    let j = 1;
    for (let i = 1; i < obnodes.length; i++) {
        if (obnodes.opIndex(i).index) {
            if (i !== j)
                obnodes.opIndexAssign(obnodes.opIndex(i), j);
            ++j;
        } else {
            // dropped: `obnodes[i].destroy();` (ob.d:1087) — nulls slot i, which is always either
            // overwritten by a later shift (j reaches i only after it) or cut by `setDim(j)` below; the
            // write is unobservable and `ObNodes` holds no null.
        }
    }
    obnodes.setDim(j);
}

/*************************************
 * ob.d:1098 — `void computePreds(ref ObNodes obnodes)`.
 * Compute predecessors.
 */
function computePreds(obnodes: ObNodes): void {
    for (const ob of obnodes.opSlice()) {
        for (const succ of ob.succs.opSlice()) {
            succ.preds.push(ob);
        }
    }
}

/*******************************
 * ob.d:1112 — `bool isTrackableVar(VarDeclaration v)`.
 * Are we interested in tracking variable `v`?
 */
function isTrackableVar(v: VarDeclaration): boolean {
    const tb = toBasetype(v.type!);

    /* Assume class references are managed by the GC,
     * don't need to track them
     */
    if (tb.ty === TY.Tclass)
        return false;

    /* Assume types with a destructor are doing their own tracking,
     * such as being a ref counted type
     */

    /* Not tracking function parameters that are not mutable
     */
    if ((v.storage_class & STC.parameter) !== 0n && !hasPointersToMutableFields(tb))
        return false;

    /* Not tracking global variables
     */
    return !v.isDataseg();
}

/*******************************
 * ob.d:1144 — `VarDeclaration isTrackableVarExp(Expression e)`.
 * Are we interested in tracking this expression?
 * Returns:
 *      variable if so, null if not
 */
function isTrackableVarExp(e: Expression): VarDeclaration | null {
    const ve = e.isVarExp();
    if (ve !== null) {
        const v = ve.var_.isVarDeclaration();
        if (v !== null)
            if (isTrackableVar(v))
                return v;
    }
    return null;
}

/**************
 * ob.d:1163 — `void collectVars(FuncDeclaration funcdecl, out VarDeclarations vars)`.
 * Find the pointer variable declarations in this function,
 * and fill `vars` with them.
 * Params:
 *      funcdecl = function we are in
 *      vars = array to fill in
 */
function collectVars(funcdecl: FuncDeclaration, vars: VarDeclarations): void {
    vars.setDim(0);     // `out` parameter: reset to `VarDeclarations.init` on entry
    // dropped: enum log = false (gate constant; its if(log)/static-if(log) blocks dropped — dmd/ob.d:1165)

    if (funcdecl.parameters !== null)
        for (const v of funcdecl.parameters.opSlice()) {
            if (isTrackableVar(v!))
                vars.push(v!);
        }

    function dgVar(v: VarDeclaration): void {
        if (isTrackableVar(v))
            vars.push(v);
    }

    function dgExp(e: Expression): void {
        foreachVar(e, dgVar);
    }

    foreachExpAndVar(funcdecl.fbody, dgExp, dgVar);
}

/***********************************
 * ob.d:1203 — `void allocDeps(PtrVarState[] pvss)`.
 * Allocate BitArrays in PtrVarState.
 * Can be allocated much more efficiently by subdividing a single
 * large array of bits
 */
function allocDeps(pvss: PtrVarState[]): void {
    for (const pvs of pvss) {
        pvs.deps.length = pvss.length;
    }
}

/**************************************
 * ob.d:1216 — `void allocStates(ref ObState obstate)`.
 * Allocate state variables foreach node.
 */
function allocStates(obstate: ObState): void {
    const vlen = obstate.vars.length;
    const n = obstate.nodes.length * 3 * vlen;
    const pool: PtrVarState[] = [];
    for (let k = 0; k < n; k++)
        pool.push(new PtrVarState());   // `mem.xcalloc`: zeroed, i.e. Initial with empty deps
    obstate.varPool = pool;
    let p = 0;
    for (const ob of obstate.nodes.opSlice()) {
        ob.gen         = pool.slice(p, p + vlen); p += vlen;
        ob.input       = pool.slice(p, p + vlen); p += vlen;
        ob.output      = pool.slice(p, p + vlen); p += vlen;

        allocDeps(ob.gen);
        allocDeps(ob.input);
        allocDeps(ob.output);
    }
}

/******************************
 * ob.d:1242 — `bool isBorrowedPtr(VarDeclaration v)`.
 * Does v meet the definiton of a `Borrowed` pointer?
 * Returns:
 *      true if it does
 */
function isBorrowedPtr(v: VarDeclaration): boolean {
    return v.isScope() && !v.isowner &&
        hasPointersToMutableFields(v.type!);
}

/******************************
 * ob.d:1253 — `bool isReadonlyPtr(VarDeclaration v)`.
 * Does v meet the definiton of a `Readonly` pointer?
 * Returns:
 *      true if it does
 */
function isReadonlyPtr(v: VarDeclaration): boolean {
    return v.isScope() && !hasPointersToMutableFields(v.type!);
}

/***************************************
 * ob.d:1261 — `void genKill(ref ObState obstate, ObNode* ob)`.
 * Compute the gen vector for ob.
 */
function genKill(obstate: ObState, ob: ObNode): void {
    // dropped: enum log = false (gate constant; its if(log) traces dropped — dmd/ob.d:1263)

    /***************
     * Assigning result of expression `e` to variable `v`.
     */
    function dgWriteVar(ob: ObNode, v: VarDeclaration, e: Expression | null, initializer: boolean): void {
        const vi = obstate.vars.find(v);
        assert(vi !== SIZE_MAX);
        const pvs = ob.gen[vi];
        readVar(ob, vi, true, ob.gen);
        if (e !== null) {
            if (isBorrowedPtr(v))
                pvs.state = PtrState.Borrowed;
            else if (isReadonlyPtr(v))
                pvs.state = PtrState.Readonly;
            else
                pvs.state = PtrState.Owner;
            pvs.deps.zero();

            let any = false;           // if any variables are assigned to v

            function by(r: VarDeclaration): void {
                const ri = obstate.vars.find(r);
                if (ri !== SIZE_MAX && ri !== vi) {
                    pvs.deps.opIndexAssign(true, ri);         // v took from r
                    const pvsr = ob.gen[ri];
                    any = true;

                    if (isBorrowedPtr(v)) {
                        // v is borrowing from r
                        pvs.state = PtrState.Borrowed;
                    } else if (isReadonlyPtr(v)) {
                        pvs.state = PtrState.Readonly;
                    } else {
                        // move r to v, which "consumes" r
                        pvsr.state = PtrState.Undefined;
                        pvsr.deps.zero();
                    }
                }
            }

            escapeLive(e, by);

            /* Make v an Owner for initializations like:
             *    scope v = malloc();
             */
            if (initializer && !any && isBorrowedPtr(v)) {
                v.isowner = true;
                pvs.state = PtrState.Owner;
            }
        } else {
            if (isBorrowedPtr(v))
                pvs.state = PtrState.Borrowed;
            else if (isReadonlyPtr(v))
                pvs.state = PtrState.Readonly;
            else
                pvs.state = PtrState.Owner;
            pvs.deps.zero();
        }
    }

    function dgReadVar(_loc: Loc, ob: ObNode, v: VarDeclaration, mutable: boolean): void {
        const vi = obstate.vars.find(v);
        assert(vi !== SIZE_MAX);
        readVar(ob, vi, mutable, ob.gen);
    }

    function foreachExp(ob: ObNode, e: Expression | null): void {
        // ob.d:1351 — `extern (C++) final class ExpWalker : Visitor`, nested as in D.
        class ExpWalker extends Visitor {
            dgWriteVar: (ob: ObNode, v: VarDeclaration, e: Expression | null, initializer: boolean) => void;
            dgReadVar: (loc: Loc, ob: ObNode, v: VarDeclaration, mutable: boolean) => void;
            ob: ObNode;
            obstate: ObState;

            // ob.d:1359
            constructor(dgWriteVar: (ob: ObNode, v: VarDeclaration, e: Expression | null, initializer: boolean) => void,
                        dgReadVar: (loc: Loc, ob: ObNode, v: VarDeclaration, mutable: boolean) => void,
                        ob: ObNode, obstate: ObState) {
                super();
                this.dgWriteVar = dgWriteVar;
                this.dgReadVar  = dgReadVar;
                this.ob = ob;
                this.obstate = obstate;
            }

            // ob.d:1369
            override visitExpression(_e: Expression): void {
            }

            // ob.d:1375
            visitAssign(ae: AssignExp, initializer: boolean): void {
                ae.e2!.accept(this);
                const ve = ae.e1!.isVarExp();
                if (ve !== null) {
                    const v = ve.var_.isVarDeclaration();
                    if (v !== null)
                        if (isTrackableVar(v))
                            this.dgWriteVar(this.ob, v, ae.e2, initializer);
                } else
                    ae.e1!.accept(this);
            }

            // ob.d:1388
            override visitAssignExp(ae: AssignExp): void {
                this.visitAssign(ae, false);
            }

            // ob.d:1393
            override visitDeclarationExp(e: DeclarationExp): void {
                const Dsymbol_visit = (s: Dsymbol): void => {
                    const vd = s.isVarDeclaration();
                    if (vd !== null) {
                        s = toAlias(s);
                        if (s !== vd)
                            return Dsymbol_visit(s);
                        if (!isTrackableVar(vd))
                            return;

                        if (!(vd._init !== null && vd._init.isVoidInitializer() !== null)) {
                            const ei = vd._init !== null ? vd._init.isExpInitializer() : null;
                            if (ei !== null)
                                this.visitAssign(asAssignExp(ei.exp!), true);
                            else
                                this.dgWriteVar(this.ob, vd, null, false);
                        }
                    } else {
                        const td = s.isTupleDeclaration();
                        if (td !== null) {
                            td.foreachVar(Dsymbol_visit);
                        }
                    }
                };

                Dsymbol_visit(e.declaration!);
            }

            // ob.d:1423
            override visitVarExp(ve: VarExp): void {
                const v = ve.var_.isVarDeclaration();
                if (v !== null)
                    if (isTrackableVar(v)) {
                        this.dgReadVar(ve.loc, this.ob, v, isMutableRef(ve.type!));
                    }
            }

            // ob.d:1433
            override visitCallExp(ce: CallExp): void {
                ce.e1!.accept(this);
                const t = toBasetype(ce.e1!.type!);
                let tf: TypeFunction | null = t.isTypeFunction();
                if (tf === null) {
                    assert(t.ty === TY.Tdelegate);
                    tf = nextOf(t)!.isTypeFunction();
                    assert(tf !== null);
                }
                const tfn: TypeFunction = tf;

                const dve = ce.e1!.isDotVarExp();
                if (dve !== null) {
                    if (t.isTypeDelegate() === null && dve.e1!.isVarExp() !== null) {
                        const byf = (v: VarDeclaration): void => {
                            if (!isTrackableVar(v))
                                return;

                            const vi = this.obstate.vars.find(v);
                            if (vi === SIZE_MAX)
                                return;

                            const fd = dve.var_.isFuncDeclaration();
                            if (fd !== null && (fd.storage_class & STC.scope_) !== 0n) {
                                // borrow
                                this.obstate.varStack.push(vi);
                                this.obstate.mutableStack.push(isMutableRef(toBasetype(dve.e1!.type!)));
                            } else {
                                // move (i.e. consume arg)
                                makeUndefined(vi, this.ob.gen);
                            }
                        };

                        escapeLive(dve.e1!, byf);
                    }
                }

                // j=1 if _arguments[] is first argument
                const j = tfn.isDstyleVariadic() ? 1 : 0;
                let hasOut = false;
                const varStackSave = this.obstate.varStack.length;

                const args = ce.arguments_!.opSlice();
                for (let i = 0; i < args.length; i++) {
                    const arg = args[i]!;
                    if (i - j < tfn.parameterList.length() &&
                        i >= j) {
                        const p: Parameter = tfn.parameterList.opIndex(i - j)!;
                        const pt = toBasetype(p.type!);

                        if (!((p.storageClass & STC.out_) !== 0n && arg.isVarExp() !== null))
                            arg.accept(this);

                        const by = (v: VarDeclaration): void => {
                            if (!isTrackableVar(v))
                                return;

                            const vi = this.obstate.vars.find(v);
                            if (vi === SIZE_MAX)
                                return;

                            if ((p.storageClass & STC.out_) !== 0n) {
                                /// initialize
                                hasOut = true;
                                makeUndefined(vi, this.ob.gen);
                            } else if ((p.storageClass & STC.scope_) !== 0n) {
                                // borrow
                                this.obstate.varStack.push(vi);
                                this.obstate.mutableStack.push(isMutableRef(pt));
                            } else {
                                // move (i.e. consume arg)
                                makeUndefined(vi, this.ob.gen);
                            }
                        };

                        escapeLive(arg, by);
                    } else { // variadic args
                        arg.accept(this);

                        const byv = (v: VarDeclaration): void => {
                            if (!isTrackableVar(v))
                                return;

                            const vi = this.obstate.vars.find(v);
                            if (vi === SIZE_MAX)
                                return;

                            if ((tfn.parameterList.stc & STC.scope_) !== 0n) {
                                // borrow
                                this.obstate.varStack.push(vi);
                                this.obstate.mutableStack.push(isMutableRef(arg.type!) &&
                                        !((tfn.parameterList.stc & (STC.const_ | STC.immutable_)) !== 0n));
                            } else
                                // move (i.e. consume arg)
                                makeUndefined(vi, this.ob.gen);
                        };

                        escapeLive(arg, byv);
                    }
                }

                /* Do a dummy 'read' of each variable passed to the function,
                 * to detect O/B errors
                 */
                assert(this.obstate.varStack.length === this.obstate.mutableStack.length);
                for (let i = varStackSave; i < this.obstate.varStack.length; i++) {
                    const vi = this.obstate.varStack.opIndex(i);
                    const v = this.obstate.vars.opIndex(vi)!;

                    this.dgReadVar(ce.loc, this.ob, v, this.obstate.mutableStack.opIndex(i));
                }

                /* Pop off stack all variables for this function call
                 */
                this.obstate.varStack.setDim(varStackSave);
                this.obstate.mutableStack.setDim(varStackSave);

                if (hasOut)
                    // Initialization of out's only happens after the function call
                    for (let i = 0; i < args.length; i++) {
                        const arg = args[i]!;
                        if (i - j < tfn.parameterList.length() &&
                            i >= j) {
                            const p: Parameter = tfn.parameterList.opIndex(i - j)!;
                            if ((p.storageClass & STC.out_) !== 0n) {
                                const v = isTrackableVarExp(arg);
                                if (v !== null)
                                    this.dgWriteVar(this.ob, v, null, true);
                            }
                        }
                    }
            }

            // ob.d:1595
            override visitSymOffExp(e: SymOffExp): void {
                const v = e.var_.isVarDeclaration();
                if (v !== null)
                    if (isTrackableVar(v)) {
                        this.dgReadVar(e.loc, this.ob, v, isMutableRef(e.type!));
                    }
            }

            // ob.d:1604
            override visitLogicalExp(e: LogicalExp): void {
                e.e1!.accept(this);

                const vlen = this.obstate.vars.length;
                const gen1: PtrVarState[] = [];
                for (let i = 0; i < vlen; i++) {
                    const pvs = new PtrVarState();      // `mem.xcalloc`: zeroed
                    pvs.opAssign(this.ob.gen[i]);
                    gen1.push(pvs);
                }

                e.e2!.accept(this);

                // Merge gen1 into ob.gen
                for (let i = 0; i < vlen; i++) {
                    this.ob.gen[i].combine(gen1[i], i, this.ob.gen);
                }
            }

            // ob.d:1627
            override visitCondExp(e: CondExp): void {
                e.econd!.accept(this);

                const vlen = this.obstate.vars.length;
                const gen1: PtrVarState[] = [];
                for (let i = 0; i < vlen; i++) {
                    const pvs = new PtrVarState();      // `mem.xcalloc`: zeroed
                    pvs.opAssign(this.ob.gen[i]);
                    gen1.push(pvs);
                }

                e.e1!.accept(this);

                // Swap gen1 with ob.gen
                for (let i = 0; i < vlen; i++) {
                    gen1[i].deps.swap(this.ob.gen[i].deps);
                    const state = gen1[i].state;
                    gen1[i].state = this.ob.gen[i].state;
                    this.ob.gen[i].state = state;
                }

                e.e2!.accept(this);

                /* xxx1 is the state from expression e1, ob.xxx is the state from e2.
                 * Merge xxx1 into ob.xxx to get the state from `e`.
                 */
                for (let i = 0; i < vlen; i++) {
                    this.ob.gen[i].combine(gen1[i], i, this.ob.gen);
                }
            }

            // ob.d:1663
            override visitAddrExp(e: AddrExp): void {
                /* Taking the address of struct literal is normally not
                 * allowed, but CTFE can generate one out of a new expression,
                 * but it'll be placed in static data so no need to check it.
                 */
                if (e.e1!.op !== EXP.structLiteral)
                    e.e1!.accept(this);
            }

            // ob.d:1673
            override visitUnaExp(e: UnaExp): void {
                e.e1!.accept(this);
            }

            // ob.d:1678
            override visitBinExp(e: BinExp): void {
                e.e1!.accept(this);
                e.e2!.accept(this);
            }

            // ob.d:1684
            override visitArrayLiteralExp(e: ArrayLiteralExp): void {
                const tb = toBasetype(e.type!);
                if (tb.isStaticOrDynamicArray()) {
                    if (e.basis !== null)
                        e.basis.accept(this);
                    for (const el of e.elements!.opSlice()) {
                        if (el !== null)
                            el.accept(this);
                    }
                }
            }

            // ob.d:1699
            override visitStructLiteralExp(e: StructLiteralExp): void {
                if (e.elements !== null) {
                    for (const ex of e.elements.opSlice()) {
                        if (ex !== null)
                            ex.accept(this);
                    }
                }
            }

            // ob.d:1711
            override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
                if (e.keys !== null) {
                    const keys = e.keys.opSlice();
                    for (let i = 0; i < keys.length; i++) {
                        const key = keys[i];
                        if (key !== null)
                            key.accept(this);
                        const value = e.values!.opIndex(i);
                        if (value !== null)
                            value.accept(this);
                    }
                }
            }

            // ob.d:1725
            override visitNewExp(e: NewExp): void {
                if (e.placement !== null)
                    e.placement.accept(this);
                if (e.arguments_ !== null) {
                    for (const ex of e.arguments_.opSlice()) {
                        if (ex !== null)
                            ex.accept(this);
                    }
                }
            }

            // ob.d:1739
            override visitSliceExp(e: SliceExp): void {
                e.e1!.accept(this);
                if (e.lwr !== null)
                    e.lwr.accept(this);
                if (e.upr !== null)
                    e.upr.accept(this);
            }
        }

        if (e !== null) {
            const ew = new ExpWalker(dgWriteVar, dgReadVar, ob, obstate);
            e.accept(ew);
        }
    }

    foreachExp(ob, ob.exp);
}

/// D `cast(AssignExp)ei.exp` (ob.d:1409): D's cast between extern(C++) classes is an unchecked
/// reinterpret, never null (probe: an extern(C++) cross-cast `cast(B)` of a `C` instance is not null).
/// ldc2 feeds more than the AssignExp family here: a postblit or constructor initializer is lowered to
/// a CommaExp (`-vcg-ast`: `S t = (t = s).__postblit() , t;`). visitAssign reads only `e1`/`e2`, which
/// for any BinExp are BinExp's own fields, so the reinterpret reads the same slots D reads. The tag test
/// proves the SUPERCLASS BinExp (02 §11.5c shape 3); the assert stands in for D's undefined behaviour
/// on a non-BinExp initializer, which the frontend never produces.
function asAssignExp(e: Expression): AssignExp {
    assert(e.isBinExp() !== null);
    return e as unknown as AssignExp;
}

/***************************************
 * ob.d:1772 — `PtrState toPtrState(VarDeclaration v)`.
 * Determine the state of a variable based on
 * its type and storage class.
 */
function toPtrState(v: VarDeclaration): PtrState {
    /* pointer to mutable:        Owner
     * pointer to mutable, scope: Borrowed
     * pointer to const:          Owner
     * pointer to const, scope:   Readonly
     * ref:                       Borrowed
     * const ref:                 Readonly
     */

    const t = v.type!;
    if (v.isReference()) {
        return hasMutableFields(t) ? PtrState.Borrowed : PtrState.Readonly;
    }
    if (v.isScope()) {
        return hasPointersToMutableFields(t) ? PtrState.Borrowed : PtrState.Readonly;
    } else
        return PtrState.Owner;
}

/**********************************
 * ob.d:1798 — `bool hasPointersToMutableFields(Type t)`.
 * Does type `t` contain any pointers to mutable?
 */
function hasPointersToMutableFields(t: Type): boolean {
    const tb = toBasetype(t);
    if (!tb.isMutable())
        return false;
    const tsa = tb.isTypeSArray();
    if (tsa !== null) {
        return hasPointersToMutableFields(nextOf(tsa)!);
    }
    const ts = tb.isTypeStruct();
    if (ts !== null) {
        for (const v of ts.sym!.fields.opSlice()) {
            if (v!.isReference()) {
                if (hasMutableFields(v!.type!))
                    return true;
            } else if (hasPointersToMutableFields(v!.type!))
                return true;
        }
        return false;
    }
    const tbn = nextOf(tb);
    return tbn !== null && hasMutableFields(tbn);
}

/********************************
 * ob.d:1828 — `bool hasMutableFields(Type t)`.
 * Does type `t` have any mutable fields?
 */
function hasMutableFields(t: Type): boolean {
    const tb = toBasetype(t);
    if (!tb.isMutable())
        return false;
    const tsa = tb.isTypeSArray();
    if (tsa !== null) {
        return hasMutableFields(nextOf(tsa)!);
    }
    const ts = tb.isTypeStruct();
    if (ts !== null) {
        for (const v of ts.sym!.fields.opSlice()) {
            if (hasMutableFields(v!.type!))
                return true;
        }
        return false;
    }
    return true;
}

/***************************************
 * ob.d:1855 — `void doDataFlowAnalysis(ref ObState obstate)`.
 * Do the data flow analysis (i.e. compute the input[]
 * and output[] vectors for each ObNode).
 */
function doDataFlowAnalysis(obstate: ObState): void {
    // dropped: enum log = false (gate constant; its if(log)/static-if(log) blocks dropped — dmd/ob.d:1857)

    if (!obstate.nodes.length)
        return;

    const startnode = obstate.nodes.opIndex(0);
    assert(startnode.preds.length === 0);

    /* Set opening state `input[]` for first node
     */
    for (let i = 0; i < startnode.input.length; i++) {
        const ps = startnode.input[i];
        const v = obstate.vars.opIndex(i)!;
        let state = toPtrState(v);
        if (v.isParameter()) {
            if (v.isOut())
                state = PtrState.Undefined;
            else if (isBorrowedPtr(v))
                state = PtrState.Borrowed;
            else
                state = PtrState.Owner;
        } else
            state = PtrState.Undefined;
        ps.state = state;
        ps.deps.zero();
        startnode.gen[i].opAssign(ps);
    }

    /* Set all output[]s to Initial
     */
    for (const ob of obstate.nodes.opSlice()) {
        for (const ps of ob.output) {
            ps.state = PtrState.Initial;
            ps.deps.zero();
        }
    }

    const vlen = obstate.vars.length;
    const pvs = new PtrVarState();
    pvs.deps.length = vlen;
    let counter = 0;
    let changes: boolean;
    do {
        changes = false;
        assert(++counter <= 1000);      // should converge, but don't hang if it doesn't
        for (const ob of obstate.nodes.opSlice()) {
            /* Construct ob.gen[] by combining the .output[]s of each ob.preds[]
             * and set ob.input[] to the same state
             */
            if (ob !== startnode) {
                assert(ob.preds.length);

                for (let i = 0; i < vlen; i++) {
                    ob.gen[i].opAssign(ob.preds.opIndex(0).output[i]);
                }

                for (let j = 1; j < ob.preds.length; j++) {
                    for (let i = 0; i < vlen; i++) {
                        ob.gen[i].combine(ob.preds.opIndex(j).output[i], i, ob.gen);
                    }
                }

                /* Set ob.input[] to ob.gen[],
                 * if any changes were made we'll have to do another iteration
                 */
                for (let i = 0; i < vlen; i++) {
                    if (!ob.gen[i].opEquals(ob.input[i])) {
                        ob.input[i].opAssign(ob.gen[i]);
                        changes = true;
                    }
                }
            }

            /* Compute gen[] for node ob
             */
            genKill(obstate, ob);

            for (let i = 0; i < vlen; i++) {
                if (!ob.gen[i].opEquals(ob.output[i])) {
                    ob.output[i].opAssign(ob.gen[i]);
                    changes = true;
                }
            }
        }
    } while (changes);
}

/***************************************
 * ob.d:1996 — `void escapeLive(Expression e, scope void delegate(VarDeclaration) onVar)`.
 * Check for escaping variables using DIP1000's `escapeByValue`, with `live` set to `true`
 * Params:
 *   e = expression to check
 *   onVar = gets called for each variable escaped through `e`, either by value or by ref
 */
function escapeLive(e: Expression, onVar: (v: VarDeclaration) => void): void {
    // D's five-field positional struct literal: byRef, byValue, byFunc, byExp, live.
    const er = new EscapeByResults(
        (v: VarDeclaration, _b: boolean) => onVar(v),
        onVar,
        (_f: FuncDeclaration, _b: boolean) => {},
        (_e: Expression, _b: boolean) => {},
    );
    er.live = true;

    escapeByValue(e, er);
}

/***************************************
 * ob.d:2012 — `void checkObErrors(ref ObState obstate)`.
 * Check for Ownership/Borrowing errors.
 */
function checkObErrors(obstate: ObState): void {
    // dropped: enum log = false (gate constant; its if(log)/static-if(log) blocks dropped — dmd/ob.d:2014)

    function dgWriteVar(ob: ObNode, cpvs: PtrVarState[], v: VarDeclaration, e: Expression | null): void {
        const vi = obstate.vars.find(v);
        assert(vi !== SIZE_MAX);
        const pvs = cpvs[vi];
        readVar(ob, vi, true, cpvs);
        if (e !== null) {
            if (isBorrowedPtr(v))
                pvs.state = PtrState.Borrowed;
            else if (isReadonlyPtr(v))
                pvs.state = PtrState.Readonly;
            else {
                if (pvs.state === PtrState.Owner && hasPointersToMutableFields(v.type!))
                    error(e.loc, ds("%s `%s` assigning to Owner without disposing of owned value"), v.kind(),
                        v.toPrettyChars());

                pvs.state = PtrState.Owner;
            }
            pvs.deps.zero();

            function by(r: VarDeclaration): void {   // `v` = `r`
                const ri = obstate.vars.find(r);
                if (ri === SIZE_MAX)
                    return;

                pvs.deps.opIndexAssign(true, ri);         // v took from r
                const pvsr = cpvs[ri];

                if (pvsr.state === PtrState.Undefined) {
                    error(e!.loc, ds("%s `%s` is reading from `%s` which is Undefined"), v.kind(),
                        v.toPrettyChars(), r.toChars());
                } else if (isBorrowedPtr(v)) {  // v is going to borrow from r
                    if (pvsr.state === PtrState.Readonly)
                        error(e!.loc, ds("%s `%s` is borrowing from `%s` which is Readonly"), v.kind(),
                            v.toPrettyChars(), r.toChars());

                    pvs.state = PtrState.Borrowed;
                } else if (isReadonlyPtr(v)) {
                    pvs.state = PtrState.Readonly;
                } else {
                    // move from r to v
                    pvsr.state = PtrState.Undefined;
                    pvsr.deps.zero();
                }
            }

            escapeLive(e, by);
        } else {
            if (isBorrowedPtr(v))
                pvs.state = PtrState.Borrowed;
            else if (isReadonlyPtr(v))
                pvs.state = PtrState.Readonly;
            else
                pvs.state = PtrState.Owner;
            pvs.deps.zero();
        }
    }

    function dgReadVar(loc: Loc, ob: ObNode, v: VarDeclaration, mutable: boolean, gen: PtrVarState[]): void {
        const vi = obstate.vars.find(v);
        assert(vi !== SIZE_MAX);
        const pvs = gen[vi];
        if (pvs.state === PtrState.Undefined)
            error(loc, ds("%s `%s` has undefined state and cannot be read"), v.kind(), v.toPrettyChars());

        readVar(ob, vi, mutable, gen);
    }

    function foreachExp(ob: ObNode, e: Expression | null, cpvs: PtrVarState[]): void {
        // ob.d:2105 — `extern (C++) final class ExpWalker : Visitor`, nested as in D.
        class ExpWalker extends Visitor {
            dgWriteVar: (ob: ObNode, cpvs: PtrVarState[], v: VarDeclaration, e: Expression | null) => void;
            dgReadVar: (loc: Loc, ob: ObNode, v: VarDeclaration, mutable: boolean, gen: PtrVarState[]) => void;
            cpvs: PtrVarState[];
            ob: ObNode;
            obstate: ObState;

            // ob.d:2114
            constructor(dgReadVar: (loc: Loc, ob: ObNode, v: VarDeclaration, mutable: boolean,
                                    gen: PtrVarState[]) => void,
                        dgWriteVar: (ob: ObNode, cpvs: PtrVarState[], v: VarDeclaration, e: Expression | null) => void,
                        cpvs: PtrVarState[], ob: ObNode, obstate: ObState) {
                super();
                this.dgReadVar  = dgReadVar;
                this.dgWriteVar = dgWriteVar;
                this.cpvs = cpvs;
                this.ob = ob;
                this.obstate = obstate;
            }

            // ob.d:2125
            override visitExpression(_e: Expression): void {
            }

            // ob.d:2129
            override visitDeclarationExp(e: DeclarationExp): void {
                const Dsymbol_visit = (s: Dsymbol): void => {
                    const vd = s.isVarDeclaration();
                    if (vd !== null) {
                        s = toAlias(s);
                        if (s !== vd)
                            return Dsymbol_visit(s);
                        if (!isTrackableVar(vd))
                            return;

                        if (vd._init !== null && vd._init.isVoidInitializer() !== null)
                            return;

                        const ei = vd._init !== null ? vd._init.isExpInitializer() : null;
                        if (ei !== null) {
                            let e = ei.exp!;
                            const ae = e.isConstructExp();
                            if (ae !== null)
                                e = ae.e2!;
                            this.dgWriteVar(this.ob, this.cpvs, vd, e);
                        } else
                            this.dgWriteVar(this.ob, this.cpvs, vd, null);
                    } else {
                        const td = s.isTupleDeclaration();
                        if (td !== null) {
                            td.foreachVar(Dsymbol_visit);
                        }
                    }
                };

                Dsymbol_visit(e.declaration!);
            }

            // ob.d:2164
            override visitAssignExp(ae: AssignExp): void {
                ae.e2!.accept(this);
                const ve = ae.e1!.isVarExp();
                if (ve !== null) {
                    const v = ve.var_.isVarDeclaration();
                    if (v !== null)
                        if (isTrackableVar(v))
                            this.dgWriteVar(this.ob, this.cpvs, v, ae.e2);
                } else
                    ae.e1!.accept(this);
            }

            // ob.d:2177
            override visitVarExp(ve: VarExp): void {
                const v = ve.var_.isVarDeclaration();
                if (v !== null)
                    if (isTrackableVar(v)) {
                        this.dgReadVar(ve.loc, this.ob, v, isMutableRef(ve.type!), this.cpvs);
                    }
            }

            // ob.d:2187
            override visitCallExp(ce: CallExp): void {
                ce.e1!.accept(this);
                const t = toBasetype(ce.e1!.type!);
                let tf: TypeFunction | null = t.isTypeFunction();
                if (tf === null) {
                    assert(t.ty === TY.Tdelegate);
                    tf = nextOf(t)!.isTypeFunction();
                    assert(tf !== null);
                }
                const tfn: TypeFunction = tf;

                // j=1 if _arguments[] is first argument
                const j = tfn.isDstyleVariadic() ? 1 : 0;
                let hasOut = false;
                const varStackSave = this.obstate.varStack.length;

                const args = ce.arguments_!.opSlice();
                for (let i = 0; i < args.length; i++) {
                    const arg = args[i]!;
                    if (i - j < tfn.parameterList.length() &&
                        i >= j) {
                        const p: Parameter = tfn.parameterList.opIndex(i - j)!;
                        const pt = toBasetype(p.type!);

                        if (!((p.storageClass & STC.out_) !== 0n && arg.isVarExp() !== null))
                            arg.accept(this);

                        const by = (v: VarDeclaration): void => {
                            if (!isTrackableVar(v))
                                return;

                            const vi = this.obstate.vars.find(v);
                            if (vi === SIZE_MAX)
                                return;

                            const pvs = this.cpvs[vi];

                            if ((p.storageClass & STC.out_) !== 0n) {
                                /// initialize
                                hasOut = true;
                                makeUndefined(vi, this.cpvs);
                            } else if ((p.storageClass & STC.scope_) !== 0n) {
                                // borrow
                                this.obstate.varStack.push(vi);
                                this.obstate.mutableStack.push(isMutableRef(pt));
                            } else {
                                // move (i.e. consume arg)
                                if (pvs.state !== PtrState.Owner)
                                    error(arg.loc, ds("%s `%s` is not Owner, cannot consume its value"), v.kind(),
                                        v.toPrettyChars());
                                makeUndefined(vi, this.cpvs);
                            }
                        };

                        escapeLive(arg, by);
                    } else { // variadic args
                        arg.accept(this);
                        const byv = (v: VarDeclaration): void => {
                            if (!isTrackableVar(v))
                                return;

                            const vi = this.obstate.vars.find(v);
                            if (vi === SIZE_MAX)
                                return;

                            const pvs = this.cpvs[vi];

                            if ((tfn.parameterList.stc & STC.scope_) !== 0n) {
                                // borrow
                                this.obstate.varStack.push(vi);
                                this.obstate.mutableStack.push(isMutableRef(arg.type!) &&
                                        !((tfn.parameterList.stc & (STC.const_ | STC.immutable_)) !== 0n));
                            } else {
                                // move (i.e. consume arg)
                                if (pvs.state !== PtrState.Owner)
                                    error(arg.loc, ds("%s `%s` is not Owner, cannot consume its value"), v.kind(),
                                        v.toPrettyChars());
                                makeUndefined(vi, this.cpvs);
                            }
                        };

                        escapeLive(arg, byv);
                    }
                }

                /* Do a dummy 'read' of each variable passed to the function,
                 * to detect O/B errors
                 */
                assert(this.obstate.varStack.length === this.obstate.mutableStack.length);
                for (let i = varStackSave; i < this.obstate.varStack.length; i++) {
                    const vi = this.obstate.varStack.opIndex(i);
                    const pvs = this.cpvs[vi];
                    const v = this.obstate.vars.opIndex(vi)!;

                    this.dgReadVar(ce.loc, this.ob, v, this.obstate.mutableStack.opIndex(i), this.cpvs);

                    if (pvs.state === PtrState.Owner) {
                        for (let k = i + 1; k < this.obstate.varStack.length; ++k) {
                            const vk = this.obstate.varStack.opIndex(k);
                            if (vk === vi) {
                                // indexed by `vi`/`vk`, not by stack position, as D does (BoolStack)
                                if (this.obstate.mutableStack.opIndex(vi) || this.obstate.mutableStack.opIndex(vk)) {
                                    error(ce.loc, ds("%s `%s` is passed as Owner more than once"), v.kind(),
                                        v.toPrettyChars());
                                    break;  // no need to continue
                                }
                            }
                        }
                    }
                }

                /* Pop off stack all variables for this function call
                 */
                this.obstate.varStack.setDim(varStackSave);
                this.obstate.mutableStack.setDim(varStackSave);

                if (hasOut)
                    // Initialization of out's only happens after the function call
                    for (let i = 0; i < args.length; i++) {
                        const arg = args[i]!;
                        if (i - j < tfn.parameterList.length() &&
                            i >= j) {
                            const p: Parameter = tfn.parameterList.opIndex(i - j)!;
                            if ((p.storageClass & STC.out_) !== 0n) {
                                const v = isTrackableVarExp(arg);
                                if (v !== null) {
                                    this.dgWriteVar(this.ob, this.cpvs, v, null);
                                }
                            }
                        }
                    }
            }

            // ob.d:2340
            override visitSymOffExp(e: SymOffExp): void {
                const v = e.var_.isVarDeclaration();
                if (v !== null)
                    if (isTrackableVar(v)) {
                        this.dgReadVar(e.loc, this.ob, v, isMutableRef(e.type!), this.cpvs);
                    }
            }

            // ob.d:2349
            override visitLogicalExp(e: LogicalExp): void {
                e.e1!.accept(this);

                const vlen = this.obstate.vars.length;
                const out1: PtrVarState[] = [];
                for (let i = 0; i < vlen; i++) {
                    const pvs = new PtrVarState();      // `mem.xcalloc`: zeroed
                    pvs.opAssign(this.cpvs[i]);
                    out1.push(pvs);
                }

                e.e2!.accept(this);

                // Merge out1 into cpvs
                for (let i = 0; i < vlen; i++) {
                    this.cpvs[i].combine(out1[i], i, this.cpvs);
                }
            }

            // ob.d:2372
            override visitCondExp(e: CondExp): void {
                e.econd!.accept(this);

                const vlen = this.obstate.vars.length;
                const out1: PtrVarState[] = [];
                for (let i = 0; i < vlen; i++) {
                    const pvs = new PtrVarState();      // `mem.xcalloc`: zeroed
                    pvs.opAssign(this.cpvs[i]);
                    out1.push(pvs);
                }

                e.e1!.accept(this);

                // Swap out1 with cpvs
                for (let i = 0; i < vlen; i++) {
                    out1[i].deps.swap(this.cpvs[i].deps);
                    const state = out1[i].state;
                    out1[i].state = this.cpvs[i].state;
                    this.cpvs[i].state = state;
                }

                e.e2!.accept(this);

                // Merge out1 into cpvs
                for (let i = 0; i < vlen; i++) {
                    this.cpvs[i].combine(out1[i], i, this.cpvs);
                }
            }

            // ob.d:2406
            override visitAddrExp(e: AddrExp): void {
                /* Taking the address of struct literal is normally not
                 * allowed, but CTFE can generate one out of a new expression,
                 * but it'll be placed in static data so no need to check it.
                 */
                if (e.e1!.op !== EXP.structLiteral)
                    e.e1!.accept(this);
            }

            // ob.d:2416
            override visitUnaExp(e: UnaExp): void {
                e.e1!.accept(this);
            }

            // ob.d:2421
            override visitBinExp(e: BinExp): void {
                e.e1!.accept(this);
                e.e2!.accept(this);
            }

            // ob.d:2427
            override visitArrayLiteralExp(e: ArrayLiteralExp): void {
                const tb = toBasetype(e.type!);
                if (tb.isStaticOrDynamicArray()) {
                    if (e.basis !== null)
                        e.basis.accept(this);
                    for (const el of e.elements!.opSlice()) {
                        if (el !== null)
                            el.accept(this);
                    }
                }
            }

            // ob.d:2442
            override visitStructLiteralExp(e: StructLiteralExp): void {
                if (e.elements !== null) {
                    for (const ex of e.elements.opSlice()) {
                        if (ex !== null)
                            ex.accept(this);
                    }
                }
            }

            // ob.d:2454
            override visitAssocArrayLiteralExp(e: AssocArrayLiteralExp): void {
                if (e.keys !== null) {
                    const keys = e.keys.opSlice();
                    for (let i = 0; i < keys.length; i++) {
                        const key = keys[i];
                        if (key !== null)
                            key.accept(this);
                        const value = e.values!.opIndex(i);
                        if (value !== null)
                            value.accept(this);
                    }
                }
            }

            // ob.d:2468
            override visitNewExp(e: NewExp): void {
                if (e.placement !== null)
                    e.placement.accept(this);

                if (e.arguments_ !== null) {
                    for (const ex of e.arguments_.opSlice()) {
                        if (ex !== null)
                            ex.accept(this);
                    }
                }
            }

            // ob.d:2483
            override visitSliceExp(e: SliceExp): void {
                e.e1!.accept(this);
                if (e.lwr !== null)
                    e.lwr.accept(this);
                if (e.upr !== null)
                    e.upr.accept(this);
            }
        }

        if (e !== null) {
            const ew = new ExpWalker(dgReadVar, dgWriteVar, cpvs, ob, obstate);
            e.accept(ew);
        }
    }

    const vlen = obstate.vars.length;
    const cpvs: PtrVarState[] = [];
    for (let i = 0; i < vlen; i++)
        cpvs.push(new PtrVarState());   // `mem.xcalloc`: zeroed
    for (const pvs of cpvs)
        pvs.deps.length = vlen;

    const nodes = obstate.nodes.opSlice();
    for (let obi = 0; obi < nodes.length; obi++) {
        const ob = nodes[obi];

        /* Combine the .output[]s of each ob.preds[] looking for errors
         */
        if (obi) {   // skip startnode
            assert(ob.preds.length);

            for (let i = 0; i < vlen; i++) {
                ob.gen[i].opAssign(ob.preds.opIndex(0).output[i]);
            }

            for (let j = 1; j < ob.preds.length; j++) {
                for (let i = 0; i < vlen; i++) {
                    const pvs1 = ob.gen[i];
                    const pvs2 = ob.preds.opIndex(j).output[i];
                    const s1 = pvs1.state;
                    const s2 = pvs2.state;
                    if (s1 !== s2 && (s1 === PtrState.Owner || s2 === PtrState.Owner)) {
                        const v = obstate.vars.opIndex(i)!;
                        // Don't worry about non-pointers
                        if (hasPointers(v.type!))
                            error(ob.exp !== null ? ob.exp.loc : v.loc, ds("%s `%s` is both %s and %s"), v.kind(),
                                v.toPrettyChars(), PtrStateToChars(s1), PtrStateToChars(s2));
                    }
                    pvs1.combine(pvs2, i, ob.gen);
                }
            }
        }

        /* Prolly should use gen[] instead of cpvs[], or vice versa
         */
        for (let i = 0; i < ob.input.length; i++) {
            cpvs[i].opAssign(ob.input[i]);
        }

        foreachExp(ob, ob.exp, cpvs);

        if (ob.obtype === ObType.retexp) {
            const by = (r: VarDeclaration): void => {   // `r` is the rvalue
                const ri = obstate.vars.find(r);
                if (ri === SIZE_MAX)
                    return;
                const pvsr = ob.output[ri];
                switch (pvsr.state) {
                    case PtrState.Undefined:
                        error(ob.exp!.loc, ds("%s `%s` is returned but is Undefined"), r.kind(), r.toPrettyChars());
                        break;

                    case PtrState.Owner:
                        pvsr.state = PtrState.Undefined;     // returning a pointer "consumes" it
                        break;

                    case PtrState.Borrowed:
                    case PtrState.Readonly:
                        break;

                    default:
                        assertUnreachable();
                }
            };
            escapeLive(ob.exp!, by);
        }

        if (ob.obtype === ObType.return_ || ob.obtype === ObType.retexp) {
            for (let i = 0; i < ob.output.length; i++) {
                const pvs = ob.output[i];
                if (pvs.state === PtrState.Owner) {
                    // `import dmd.typesem : hasPointers;` (ob.d:2611) — hoisted to the top-level import.
                    const v = obstate.vars.opIndex(i)!;
                    if (hasPointers(v.type!))
                        error(v.loc, ds("%s `%s` is not disposed of before return"), v.kind(), v.toPrettyChars());
                }
            }
        }
    }
}

/***************************************************
 * ob.d:2628 — `void readVar(ObNode* ob, const size_t vi, bool mutable, PtrVarState[] gen)`.
 * Read from variable vi.
 * The beginning of the 'scope' of a variable is when it is first read.
 * Hence, when a read is done, instead of when assignment to the variable is done, the O/B rules are enforced.
 * (Also called "non-lexical scoping".)
 */
function readVar(_ob: ObNode, vi: number, mutable: boolean, gen: PtrVarState[]): void {
    const pvso = gen[vi];
    switch (pvso.state) {
        case PtrState.Owner:
            if (mutable) { // if mutable read
                makeChildrenUndefined(vi, gen);
            } else { // const read
                // If there's a Borrow child, set that to Undefined
                for (let di = 0; di < gen.length; di++) {
                    const pvsd = gen[di];
                    if (pvsd.deps.opIndex(vi) && pvsd.state === PtrState.Borrowed) { // if di borrowed vi
                        makeUndefined(di, gen);
                    }
                }
            }
            break;

        case PtrState.Borrowed:
            /* All children become Undefined
             */
            makeChildrenUndefined(vi, gen);
            break;

        case PtrState.Readonly:
            break;

        case PtrState.Undefined:
            break;

        default:
            break;
    }
}

/********************
 * ob.d:2674 — `void makeChildrenUndefined(size_t vi, PtrVarState[] gen)`.
 * Recursively make Undefined all who list vi as a dependency
 */
function makeChildrenUndefined(vi: number, gen: PtrVarState[]): void {
    for (let di = 0; di < gen.length; di++) {
        if (gen[di].deps.opIndex(vi)) {    // if di depends on vi
            if (gen[di].state !== PtrState.Undefined) {
                gen[di].state = PtrState.Undefined;  // set this first to avoid infinite recursion
                makeChildrenUndefined(di, gen);
                gen[di].deps.zero();
            }
        }
    }
}

/********************
 * ob.d:2698 — `void makeUndefined(size_t vi, PtrVarState[] gen)`.
 * Recursively make Undefined vi undefined and all who list vi as a dependency
 * Params:
 *    vi = variable's index
 *    gen = array of the states of variables
 */
function makeUndefined(vi: number, gen: PtrVarState[]): void {
    const pvs = gen[vi];
    pvs.state = PtrState.Undefined;  // set this first to avoid infinite recursion
    makeChildrenUndefined(vi, gen);
    pvs.deps.zero();
}

/*************************
 * ob.d:2709 — `bool isMutableRef(Type t)`.
 * Is type `t` a reference to a const or a reference to a mutable?
 */
function isMutableRef(t: Type): boolean {
    const tb = toBasetype(t);
    return (nextOf(tb) !== null ? nextOf(tb)! : tb).isMutable();
}
