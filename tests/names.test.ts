import { describe, expect, it } from "vitest";
import { allFolders, buildTree, folderOf, inFolder, leafOf, NAME_RE, normalizeName } from "../src/editor/names";
import { cppName } from "../src/editor/codegen";

describe("path names with folders", () => {
  it("accepts folders and tidies what was typed", () => {
    expect(normalizeName("  skills  148 /  start  ")).toBe("skills 148/start");
    expect(normalizeName("a/b/c")).toBe("a/b/c");
    expect(normalizeName("plain-name_2")).toBe("plain-name_2");
    for (const bad of ["", "/a", "a/", "a//b", "a/../b", "a.b", "a\\b", "x/ /y"]) expect(normalizeName(bad)).toBeNull();
    expect(NAME_RE.test("a/b")).toBe(true);
    expect(NAME_RE.test("../a")).toBe(false);
  });

  it("splits and moves names", () => {
    expect(folderOf("a/b/c")).toBe("a/b");
    expect(folderOf("c")).toBe("");
    expect(leafOf("a/b/c")).toBe("c");
    expect(inFolder("x", "a/b/c")).toBe("x/c");
    expect(inFolder("", "a/c")).toBe("c");
  });

  it("builds the folder tree: folders first, numbers sorted as numbers", () => {
    const t = buildTree(["start", "skills 148/start", "skills 148/loop 10", "skills 148/loop 9", "skills 138/start", "a/b/c"]);
    expect(t.count).toBe(6);
    expect(t.folders.map(f => f.name)).toEqual(["a", "skills 138", "skills 148"]);
    expect(t.items).toEqual(["start"]);
    const s148 = t.folders[2];
    expect(s148.count).toBe(3);
    expect(s148.items).toEqual(["skills 148/loop 9", "skills 148/loop 10", "skills 148/start"]);
    expect(t.folders[0].folders[0]).toMatchObject({ path: "a/b", name: "b", items: ["a/b/c"], count: 1 });
    expect(allFolders(["a/b/c", "x/y", "z"])).toEqual(["a", "a/b", "x"]);
  });

  it("makes a C++ name from a path in a folder", () => {
    expect(cppName("skills 148/start")).toBe("skills_148_start");
    expect(cppName("148/start")).toBe("path_148_start");
  });
});
