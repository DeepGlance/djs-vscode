// Ported unittests from dmd/root/filename.d (10-tests-diagnostics.md §1).
//
// All 13 in-source `unittest{}` blocks are ported, in source order, as `unittest#N`. The
// `version (Windows)` asserts inside several blocks are DROPPED (resolved: version(Windows) ->
// false, _config.md) — only the common + POSIX assertions remain. D `==` on char-slices is a
// byte compare -> `dsEquals`; `== null` on a returned slice -> the function returns `null`.
//
// Path-manipulation semantics spot-checked against ldc2-1.42.0 (/tmp/probe_fn2.d): path("foo")="",
// path("/foo/bar")="/foo", ext("")=null, sansExt strips the extension, name("a:b")="a:b" on POSIX.

import { describe, test, expect } from "vitest";
import { FileName } from "./filename.js";
import { ds, dsEquals } from "../../dstring.js";
import type { DString } from "../../dstring.js";

// Compare a DString (or null) against a JS ASCII string. `null` only matches `null`.
function eq(actual: DString | null, expected: string | null): boolean {
    if (expected === null) return actual === null;
    if (actual === null) return false;
    return dsEquals(actual, ds(expected));
}

describe("filename.d", () => {
    // BEFORE: unittest { assert(absolute("/") == true); assert(absolute("") == false); ... }
    // (filename.d:150) — the version(Windows) drive-letter asserts are dropped.
    test("unittest#1", () => {
        expect(FileName.absolute(ds("/"))).toBe(true);
        expect(FileName.absolute(ds(""))).toBe(false);
    });

    // BEFORE: unittest { assert(ext("/foo/bar/dmd.conf") == "conf"); ... } (filename.d:221)
    test("unittest#2", () => {
        expect(eq(FileName.ext(ds("/foo/bar/dmd.conf")), "conf")).toBe(true);
        expect(eq(FileName.ext(ds("object.o")), "o")).toBe(true);
        expect(eq(FileName.ext(ds("/foo/bar/dmd")), null)).toBe(true);
        expect(eq(FileName.ext(ds(".objdir.o/object")), null)).toBe(true);
        expect(eq(FileName.ext(ds("")), null)).toBe(true);
    });

    // BEFORE: unittest { assert(removeExt("/foo/bar/object.d") == "/foo/bar/object"); ... }
    // (filename.d:268)
    test("unittest#3", () => {
        expect(eq(FileName.removeExt(ds("/foo/bar/object.d")), "/foo/bar/object")).toBe(true);
        expect(eq(FileName.removeExt(ds("/foo/bar/frontend.di")), "/foo/bar/frontend")).toBe(true);
    });

    // BEFORE: unittest { assert(name("/foo/bar/object.d") == "object.d"); ... } (filename.d:335)
    test("unittest#4", () => {
        expect(eq(FileName.name(ds("/foo/bar/object.d")), "object.d")).toBe(true);
        expect(eq(FileName.name(ds("/foo/bar/frontend.di")), "frontend.di")).toBe(true);
    });

    // BEFORE: unittest { assert(path("/foo/bar") == "/foo"); assert(path("foo") == ""); }
    // (filename.d:368)
    test("unittest#5", () => {
        expect(eq(FileName.path(ds("/foo/bar")), "/foo")).toBe(true);
        expect(eq(FileName.path(ds("foo")), "")).toBe(true);
    });

    // BEFORE: unittest { version(Windows) ... else assert(combine("foo","bar") == "foo/bar");
    //         assert(combine("foo/","bar") == "foo/bar"); } (filename.d:411)
    test("unittest#6", () => {
        expect(eq(FileName.combine(ds("foo"), ds("bar")), "foo/bar")).toBe(true);
        expect(eq(FileName.combine(ds("foo/"), ds("bar")), "foo/bar")).toBe(true);
    });

    // BEFORE: unittest { assert(buildPath() == ""); assert(buildPath("foo") == "foo"); ...
    //         version(Windows) ... else assert(buildPath("a/","bb","ccc") == "a/bb/ccc"); }
    // (filename.d:459) — null fragment maps to a null DString argument.
    test("unittest#7", () => {
        expect(eq(FileName.buildPath(), "")).toBe(true);
        expect(eq(FileName.buildPath(ds("foo")), "foo")).toBe(true);
        expect(eq(FileName.buildPath(ds("foo"), null), "foo")).toBe(true);
        expect(eq(FileName.buildPath(null, ds("foo")), "foo")).toBe(true);
        expect(eq(FileName.buildPath(ds("a/"), ds("bb"), ds("ccc")), "a/bb/ccc")).toBe(true);
    });

    // BEFORE: unittest { assert(defaultExt("/foo/object.d","d") == "/foo/object.d"); ... }
    // (filename.d:622)
    test("unittest#8", () => {
        expect(eq(FileName.defaultExt(ds("/foo/object.d"), ds("d")), "/foo/object.d")).toBe(true);
        expect(eq(FileName.defaultExt(ds("/foo/object"), ds("d")), "/foo/object.d")).toBe(true);
        expect(eq(FileName.defaultExt(ds("/foo/bar.d"), ds("o")), "/foo/bar.d")).toBe(true);
    });

    // BEFORE: unittest { assert(forceExt("/foo/object.d","d") == "/foo/object.d"); ... }
    // (filename.d:645)
    test("unittest#9", () => {
        expect(eq(FileName.forceExt(ds("/foo/object.d"), ds("d")), "/foo/object.d")).toBe(true);
        expect(eq(FileName.forceExt(ds("/foo/object"), ds("d")), "/foo/object.d")).toBe(true);
        expect(eq(FileName.forceExt(ds("/foo/bar.d"), ds("o")), "/foo/bar.o")).toBe(true);
    });

    // BEFORE: unittest { assert(!equalsExt("foo.bar","d")); assert(equalsExt("foo.bar","bar")); ... }
    // (filename.d:670)
    test("unittest#10", () => {
        expect(FileName.equalsExt(ds("foo.bar"), ds("d"))).toBe(false);
        expect(FileName.equalsExt(ds("foo.bar"), ds("bar"))).toBe(true);
        expect(FileName.equalsExt(ds("object.d"), ds("d"))).toBe(true);
        expect(FileName.equalsExt(ds("object"), ds("d"))).toBe(false);
    });

    // BEFORE: unittest { assert(findReservedChar("") == size_t.max); ... version(Windows) ...
    //         else assert(findReservedChar(`<>:"|?*`) == size_t.max); } (filename.d:786)
    // resolved: version(Windows) -> false, so POSIX has no reserved chars -> always SIZE_MAX.
    test("unittest#11", () => {
        expect(FileName.findReservedChar(ds(""))).toBe(-1); // SIZE_MAX
        expect(
            FileName.findReservedChar(
                ds(" abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,.-_=+()"),
            ),
        ).toBe(-1);
        expect(FileName.findReservedChar(ds('<>:"|?*'))).toBe(-1);
    });

    // BEFORE: unittest { assert(!refersToParentDir("")); ... assert(refersToParentDir("..")); ... }
    // (filename.d:831) — the version(Windows) backslash asserts are dropped.
    test("unittest#12", () => {
        expect(FileName.refersToParentDir(ds(""))).toBe(false);
        expect(FileName.refersToParentDir(ds("foo"))).toBe(false);
        expect(FileName.refersToParentDir(ds("foo.."))).toBe(false);
        expect(FileName.refersToParentDir(ds("foo..boo"))).toBe(false);
        expect(FileName.refersToParentDir(ds("foo/..boo"))).toBe(false);
        expect(FileName.refersToParentDir(ds("foo../boo"))).toBe(false);
        expect(FileName.refersToParentDir(ds(".."))).toBe(true);
        expect(FileName.refersToParentDir(ds("../"))).toBe(true);
        expect(FileName.refersToParentDir(ds("foo/.."))).toBe(true);
        expect(FileName.refersToParentDir(ds("foo/../"))).toBe(true);
        expect(FileName.refersToParentDir(ds("foo/../../boo"))).toBe(true);
    });

    // BEFORE: unittest { string filename = "foo.bar"; const path = canonicalName(filename);
    //         scope(exit) free(path.ptr); assert(path.length >= filename.length);
    //         assert(path[$ - filename.length .. $] == filename); } (filename.d:1088)
    // resolved: version(Posix) realpath -> fs.realpathSync; "foo.bar" does not exist, so the
    // fallback duplicates the name (which ends with the filename and is >= its length). free -> no-op.
    test("unittest#13", () => {
        const filename = ds("foo.bar");
        const path = FileName.canonicalName(filename);
        FileName.free(path); // scope(exit) free(path.ptr) — no-op under GC
        expect(path).not.toBeNull();
        expect(path!.length >= filename.length).toBe(true);
        expect(dsEquals(path!.subarray(path!.length - filename.length), filename)).toBe(true);
    });
});
