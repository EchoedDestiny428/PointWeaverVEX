import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteDoc, fileFor, readAll, renameDoc, writeJson } from "../electron/docs";

let base = "";
const fresh = () => (base = mkdtempSync(path.join(tmpdir(), "pw-docs-")));
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("documents on disk, with folders", () => {
  it("saves a path in a folder as a subfolder and reads it back by its whole name", () => {
    fresh();
    writeJson(fileFor(base, "path", "skills 148/start"), { points: [] });
    writeJson(fileFor(base, "path", "loose"), { points: [1] });
    expect(existsSync(path.join(base, "paths", "skills 148", "start.json"))).toBe(true);
    const skipped: string[] = [];
    expect(readAll(base, "path", skipped)).toEqual({ "skills 148/start": { points: [] }, loose: { points: [1] } });
    expect(skipped).toEqual([]);
  });

  it("moves a file between folders on rename and removes the folder it left empty", () => {
    fresh();
    writeJson(fileFor(base, "path", "a/b/one"), {});
    renameDoc(base, "path", "a/b/one", "c/one");
    expect(existsSync(path.join(base, "paths", "c", "one.json"))).toBe(true);
    expect(existsSync(path.join(base, "paths", "a"))).toBe(false);
    expect(existsSync(path.join(base, "paths"))).toBe(true);
    writeJson(fileFor(base, "path", "c/two"), {});
    expect(() => renameDoc(base, "path", "c/two", "c/one")).toThrow(/taken/);
  });

  it("deletes a file and the folders it leaves empty, not the folder others are in", () => {
    fresh();
    writeJson(fileFor(base, "path", "x/a"), {});
    writeJson(fileFor(base, "path", "x/b"), {});
    deleteDoc(base, "path", "x/a");
    expect(existsSync(path.join(base, "paths", "x"))).toBe(true);
    deleteDoc(base, "path", "x/b");
    expect(existsSync(path.join(base, "paths", "x"))).toBe(false);
  });

  it("refuses names that could leave the folder, and skips unreadable files", () => {
    fresh();
    for (const bad of ["../evil", "a/../../b", "a\\b", "C:/x", "/abs", "a//b"]) expect(() => fileFor(base, "path", bad)).toThrow(/Invalid/);
    mkdirSync(path.join(base, "paths", "f"), { recursive: true });
    writeFileSync(path.join(base, "paths", "f", "broken.json"), "{ nope");
    const skipped: string[] = [];
    expect(readAll(base, "path", skipped)).toEqual({});
    expect(skipped[0]).toMatch(/paths\/f\/broken\.json/);
  });
});
