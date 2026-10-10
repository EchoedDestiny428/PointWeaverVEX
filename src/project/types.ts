export interface ProjectFile {
  path: string;
  content: string;
}

export interface ProjectSnapshot {
  root: string;
  name: string;
  files: ProjectFile[];
}

export function isSourceFile(path: string): boolean {
  return /\.(cpp|cc|cxx)$/i.test(path);
}
