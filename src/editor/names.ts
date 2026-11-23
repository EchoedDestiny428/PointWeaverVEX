/**
 * Names of paths and autons. A path can live in folders: "skills 148/start" is the path "start" in the folder
 * "skills 148", saved as paths/skills 148/start.json. Autons refer to it by the whole name.
 */

const SEGMENT = '[A-Za-z0-9_\\- ]+';
/** letters, numbers, spaces, - and _, with / between folders (keep in step with electron/main.ts) */
export const NAME_RE = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`);

/** Tidies what someone typed: spaces squeezed and trimmed around each /. null when it isn't a usable name. */
export function normalizeName(raw: string): string | null {
  const parts = raw.split('/').map(s => s.trim().replace(/\s+/g, ' '));
  if (parts.some(p => !p)) return null;
  const name = parts.join('/');
  return NAME_RE.test(name) ? name : null;
}

/** "a/b/c" -> "a/b"; "" for a name with no folder */
export const folderOf = (name: string) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');
/** "a/b/c" -> "c" */
export const leafOf = (name: string) => name.slice(name.lastIndexOf('/') + 1);
/** the name moved into folder ('' = no folder) */
export const inFolder = (folder: string, name: string) => (folder ? `${folder}/${leafOf(name)}` : leafOf(name));

export interface FolderNode {
  /** the folder's whole name ("a/b"), '' for the top */
  path: string;
  /** its own name ("b") */
  name: string;
  folders: FolderNode[];
  /** whole names of the paths directly in it */
  items: string[];
  /** paths in it and all its folders */
  count: number;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then paths, each sorted; numbers in names sort as numbers. */
export function buildTree(names: string[]): FolderNode {
  const root: FolderNode = { path: '', name: '', folders: [], items: [], count: 0 };
  for (const full of names) {
    let node = root;
    node.count++;
    const parts = full.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let next = node.folders.find(f => f.path === path);
      if (!next) {
        next = { path, name: parts[i], folders: [], items: [], count: 0 };
        node.folders.push(next);
      }
      next.count++;
      node = next;
    }
    node.items.push(full);
  }
  const sort = (n: FolderNode) => {
    n.folders.sort((a, b) => byName(a.name, b.name));
    n.items.sort((a, b) => byName(leafOf(a), leafOf(b)));
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Every folder that has at least one path in it, sorted ("a", "a/b", ...). */
export function allFolders(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
  }
  return [...out].sort(byName);
}
