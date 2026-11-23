import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/*
 * Autons and paths on disk, one JSON file each, under a base folder (Documents/PointWeaver):
 *   paths/<name>.json    a path (a name like "a/b" is the file paths/a/b.json)
 *   autons/<name>.json   an auton
 */

export type Kind = "path" | "auton";

// letters, numbers, spaces, - and _, with / between folders (keep in step with src/editor/names.ts); no dots, so a
// name can't climb out of its folder
export const NAME_RE = /^[A-Za-z0-9_\- ]+(?:\/[A-Za-z0-9_\- ]+)*$/;
export const FOLDERS: Record<Kind, string> = { path: "paths", auton: "autons" };

export const kindFolder = (base: string, kind: Kind): string => path.join(base, FOLDERS[kind]);

export function fileFor(base: string, kind: unknown, name: unknown): string {
  if (kind !== "path" && kind !== "auton") throw new Error(`Unknown kind: ${String(kind)}`);
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`Invalid name: ${String(name)}`);
  const parts = name.split("/");
  return path.join(kindFolder(base, kind), ...parts.slice(0, -1), `${parts[parts.length - 1]}.json`);
}

export const writeJson = (file: string, data: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

/** Removes folders left empty above a file, up to (not including) the kind's own folder. */
export function pruneEmpty(base: string, kind: Kind, file: string): void {
  const top = kindFolder(base, kind);
  for (let dir = path.dirname(file); dir.startsWith(top) && dir !== top; dir = path.dirname(dir)) {
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/** Every document of a kind, folders included: paths/a/b.json is "a/b". Unreadable files go in skipped. */
export function readAll(base: string, kind: Kind, skipped: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (dir: string, prefix: string, depth: number) => {
    if (!existsSync(dir) || depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (NAME_RE.test(entry.name)) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".json")) continue;
      const name = `${prefix}${entry.name.slice(0, -5)}`;
      if (!NAME_RE.test(name)) continue;
      try {
        out[name] = JSON.parse(readFileSync(path.join(dir, entry.name), "utf8"));
      } catch (e) {
        skipped.push(`${FOLDERS[kind]}/${prefix}${entry.name}: ${(e as Error).message}`);
      }
    }
  };
  walk(kindFolder(base, kind), "", 0);
  return out;
}

export function deleteDoc(base: string, kind: unknown, name: unknown): void {
  const file = fileFor(base, kind, name);
  if (existsSync(file)) unlinkSync(file);
  pruneEmpty(base, kind as Kind, file);
}

export function renameDoc(base: string, kind: unknown, from: unknown, to: unknown): void {
  const src = fileFor(base, kind, from);
  const dst = fileFor(base, kind, to);
  // a case-only rename is the same file on Windows
  if (existsSync(dst) && src.toLowerCase() !== dst.toLowerCase()) throw new Error("That name is already taken.");
  if (!existsSync(src)) return;
  mkdirSync(path.dirname(dst), { recursive: true });
  renameSync(src, dst);
  pruneEmpty(base, kind as Kind, src);
}
