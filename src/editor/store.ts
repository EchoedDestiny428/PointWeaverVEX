import type { AutonDefinition, PathDefinition } from './types';

export type DocKind = 'path' | 'auton';

export interface Loaded {
  /** where the files are, for showing and opening; null in a plain browser */
  dir: string | null;
  paths: Record<string, PathDefinition>;
  autons: Record<string, AutonDefinition>;
  settings: Settings | null;
  skipped: string[];
}

export interface Settings {
  robot?: Record<string, number>;
  /** how this field was built: each loader's offset from the manual's 12 in, by id (src/editor/targets.ts) */
  field?: { loaderOffsets?: Record<string, number> };
}

export interface PendingWrite {
  kind: DocKind;
  name: string;
  data: unknown;
}

export interface Store {
  load(): Promise<Loaded>;
  write(kind: DocKind, name: string, data: unknown): Promise<void>;
  remove(kind: DocKind, name: string): Promise<void>;
  rename(kind: DocKind, from: string, to: string): Promise<void>;
  writeSettings(data: Settings): Promise<void>;
  /** opens the folder in Explorer (desktop app only) */
  reveal: (() => Promise<void>) | null;
  copy(text: string): Promise<void>;
  /** writes that must land before the window closes */
  flushSync(writes: PendingWrite[]): void;
  setTheme(theme: 'light' | 'dark'): void;
}

type Result = { error?: string } & Record<string, unknown>;

interface Bridge {
  load(): Promise<Result>;
  write(kind: DocKind, name: string, data: unknown): Promise<Result>;
  remove(kind: DocKind, name: string): Promise<Result>;
  rename(kind: DocKind, from: string, to: string): Promise<Result>;
  writeSettings(data: unknown): Promise<Result>;
  reveal(): Promise<Result>;
  copy(text: string): Promise<Result>;
  setTheme(source: string): Promise<Result>;
  flushSync(writes: PendingWrite[]): boolean;
}

declare global {
  interface Window {
    pointweaver?: Bridge;
  }
}

const check = async (p: Promise<Result>) => {
  const res = await p;
  if (res?.error !== undefined) throw new Error(res.error);
  return res;
};

/** Files in Documents/PointWeaver, through the desktop app. */
function desktopStore(api: Bridge): Store {
  return {
    load: async () => (await check(api.load())) as unknown as Loaded,
    write: async (kind, name, data) => void (await check(api.write(kind, name, data))),
    remove: async (kind, name) => void (await check(api.remove(kind, name))),
    rename: async (kind, from, to) => void (await check(api.rename(kind, from, to))),
    writeSettings: async data => void (await check(api.writeSettings(data))),
    reveal: async () => void (await check(api.reveal())),
    copy: async text => void (await check(api.copy(text))),
    flushSync: writes => void api.flushSync(writes),
    setTheme: theme => void api.setTheme(theme),
  };
}

const KEY = 'pw:library';

interface Saved {
  paths: Record<string, PathDefinition>;
  autons: Record<string, AutonDefinition>;
  settings: Settings | null;
}

/** A plain browser (npm run dev): everything in localStorage. */
function browserStore(): Store {
  const read = (): Saved => {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? '') as Saved;
      return { paths: s.paths ?? {}, autons: s.autons ?? {}, settings: s.settings ?? null };
    } catch {
      return { paths: {}, autons: {}, settings: null };
    }
  };
  const save = (s: Saved) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch { /* full or blocked: the session still works */ }
  };
  const bucket = (s: Saved, kind: DocKind) => (kind === 'path' ? s.paths : s.autons) as Record<string, unknown>;
  const write = (kind: DocKind, name: string, data: unknown) => {
    const s = read();
    bucket(s, kind)[name] = data;
    save(s);
  };
  return {
    load: async () => ({ dir: null, skipped: [], ...structuredClone(read()) }),
    write: async (kind, name, data) => write(kind, name, data),
    remove: async (kind, name) => {
      const s = read();
      delete bucket(s, kind)[name];
      save(s);
    },
    rename: async (kind, from, to) => {
      const s = read();
      const b = bucket(s, kind);
      if (to in b) throw new Error('That name is already taken.');
      if (from in b) {
        b[to] = b[from];
        delete b[from];
      }
      save(s);
    },
    writeSettings: async settings => save({ ...read(), settings }),
    reveal: null,
    copy: text => navigator.clipboard.writeText(text),
    flushSync: writes => writes.forEach(w => write(w.kind, w.name, w.data)),
    setTheme: () => {},
  };
}

export const store: Store = window.pointweaver ? desktopStore(window.pointweaver) : browserStore();
