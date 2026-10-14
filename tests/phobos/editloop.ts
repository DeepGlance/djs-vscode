// THE EDIT LIST of the VS Code readiness mandate (question 2): sixteen successive versions of the `--probe-program`
// PROGRAM (run.ts), each one edit away from the previous, as a person typing produces them. It covers the four edit
// shapes where reuse of state across in-process compiles went wrong (10 §4.6): an edit after a parse error (e11), a
// line removed then restored (e12, e13), an import added then removed (e14, e15), and a broken then repaired
// identifier (e07, e08). Fixture data for an in-process host's protocol test: compile EDITS in order in one process
// as `prog.d` (`--sequence prog.d=<file>,...`) and compare each call with a fresh process. Not read by run.ts.

/** The sixteen versions, in order; `EDITS[i]` is e<i+1>.d, its comment the edit from the previous version. */
export const EDITS: readonly string[] = [
    // e01: PROGRAM as committed
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    iota(1, 11).filter!(x => x % 2).map!(x => x * x).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array);\n"
        + "}\n",
    // e02: `x % 2` -> `x % 3`
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * x).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array);\n"
        + "}\n",
    // e03: adds the argument `, 42`
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * x).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e04: adds `auto total = iota(1, 11).sum;`
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto total = iota(1, 11).sum;\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * x).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e05: renames it to `acc`
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * x).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e06: adds `writeln(acc);`
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * x).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e07: `acx`: undefined identifier
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acx);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * x).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e08: repairs it
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * x).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e09: `x * x` -> `x * 2.5`
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * 2.5).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e10: drops a `;`: parse error
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc)\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * 2.5).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e11: repairs the parse error
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * 2.5).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e12: removes the `sort` line
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * 2.5).each!writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e13: puts it back
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * 2.5).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e14: adds `import std.json` and a `parseJSON` call
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "import std.json;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * 2.5).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    parseJSON(\"[1, 2]\").writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e15: drops the import, keeps `std.json.parseJSON`: error
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * 2.5).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    std.json.parseJSON(\"[1, 2]\").writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
    // e16: the clean text again
    "import std.stdio;\n"
        + "import std.algorithm;\n"
        + "import std.range;\n"
        + "\n"
        + "void main()\n"
        + "{\n"
        + "    auto acc = iota(1, 11).sum;\n"
        + "    writeln(acc);\n"
        + "    iota(1, 11).filter!(x => x % 3).map!(x => x * 2.5).each!writeln;\n"
        + "    [3, 1, 2].sort.writeln;\n"
        + "    writeln(zip(iota(3), \"abc\").array, 42);\n"
        + "}\n",
];
