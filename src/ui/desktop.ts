import { isSourceFile } from "../project/types";
import type { ProjectFile, ProjectSnapshot } from "../project/types";
import type { ThemeChoice } from "./storage";

export interface DesktopBridge {
  openFolder(): Promise<ProjectSnapshot | null>;
  restore(): Promise<ProjectSnapshot | null>;
  reveal(relative: string): Promise<boolean>;
  setTheme(source: ThemeChoice): Promise<void>;
  onChange(callback: (snapshot: ProjectSnapshot) => void): () => void;
}

declare global {
  interface Window {
    pointweaver?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | null = typeof window !== "undefined" ? (window.pointweaver ?? null) : null;

const SKIP = new Set(["node_modules", ".git", ".vscode", ".cache", "bin", "build", "dist", "firmware", "static", "out"]);
const MAX_FILE_BYTES = 512 * 1024;

export async function readPicked(list: FileList | null): Promise<ProjectSnapshot | null> {
  const picked = list ? [...list] : [];
  if (picked.length === 0) return null;
  const relative = (file: File): string => {
    const parts = (file.webkitRelativePath || file.name).split("/");
    return parts.length > 1 ? parts.slice(1).join("/") : parts[0];
  };
  const rootName = picked[0].webkitRelativePath ? picked[0].webkitRelativePath.split("/")[0] : picked[0].name;
  const candidates = picked.filter((file) => {
    const path = relative(file);
    return isSourceFile(path) && file.size <= MAX_FILE_BYTES && !path.split("/").some((part) => SKIP.has(part));
  });
  const underSrc = candidates.filter((file) => relative(file).startsWith("src/"));
  const chosen = underSrc.length > 0 ? underSrc : candidates;
  const files: ProjectFile[] = await Promise.all(chosen.map(async (file) => ({ path: relative(file), content: await file.text() })));
  return { root: rootName, name: rootName, files };
}
