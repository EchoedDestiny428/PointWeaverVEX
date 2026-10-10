import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ProjectFile {
  path: string;
  content: string;
}

export interface ProjectSnapshot {
  root: string;
  name: string;
  files: ProjectFile[];
}

const SOURCE = /\.(cpp|cc|cxx)$/i;
const SKIP = new Set(["node_modules", ".git", ".vscode", ".cache", "bin", "build", "dist", "firmware", "static", "out"]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 600;
const DEBOUNCE_MS = 180;

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function sourceRoot(root: string): Promise<string> {
  const src = path.join(root, "src");
  return (await exists(src)) ? src : root;
}

async function walk(dir: string, found: string[]): Promise<void> {
  if (found.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (found.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) await walk(full, found);
    } else if (entry.isFile() && SOURCE.test(entry.name)) {
      found.push(full);
    }
  }
}

export async function scanProject(root: string): Promise<ProjectSnapshot> {
  const found: string[] = [];
  await walk(await sourceRoot(root), found);
  const files: ProjectFile[] = [];
  for (const full of found) {
    try {
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      files.push({ path: path.relative(root, full).split(path.sep).join("/"), content: await readFile(full, "utf8") });
    } catch {
      continue;
    }
  }
  return { root, name: path.basename(root), files };
}

export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onChange: (snapshot: ProjectSnapshot) => void) {}

  async start(root: string): Promise<void> {
    this.stop();
    const dir = await sourceRoot(root);
    try {
      this.watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && !SOURCE.test(filename.toString())) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          scanProject(root).then(this.onChange, () => undefined);
        }, DEBOUNCE_MS);
      });
      this.watcher.on("error", () => this.stop());
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
