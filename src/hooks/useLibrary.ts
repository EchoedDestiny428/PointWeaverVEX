import { useEffect, useMemo, useRef, useState } from 'react';
import type { AutonDefinition, Library, PathDefinition } from '../editor/types';
import { NAME_RE } from '../editor/types';
import { rotate180 } from '../editor/pathOps';
import { targetById } from '../editor/targets';
import { store, type DocKind, type Settings } from '../editor/store';
import { CRIMSON_PROFILE } from '../profiles/crimson';
import type { RobotConfig } from '../robot/config';

/**
 * What the editor is looking at:
 * - an auton: all its paths on the field, its code, its ghost
 * - one step of an auton: that path, edited where the auton drives it (turned around if the step is)
 * - a path from the library on its own
 */
export type Focus =
  | { kind: 'auton'; auton: string }
  | { kind: 'step'; auton: string; step: number }
  | { kind: 'path'; path: string }
  | null;

/**
 * true  = save an undo step first
 * false = no undo step (live drag; call checkpoint() once before)
 * string = undo step, but merge with the previous one if it had the same key in the last second (typing, scrolling)
 */
export type HistoryMode = boolean | string;

interface History {
  past: string[];
  future: string[];
}

const MAX_HISTORY = 100;
const COALESCE_MS = 1000;
/** Changes are written this long after the last edit (Ctrl+S writes at once). */
const SAVE_DELAY = 400;
const FOCUS_KEY = 'pw:focus';
const EMPTY_PATH: PathDefinition = { points: [], params: null };

const docKey = (kind: DocKind, name: string) => `${kind}:${name}`;
const without = <T,>(obj: Record<string, T>, key: string) => {
  const next = { ...obj };
  delete next[key];
  return next;
};
const splitKey = (key: string) => {
  const i = key.indexOf(':');
  return { kind: key.slice(0, i) as DocKind, name: key.slice(i + 1) };
};

function cleanPath(raw: unknown): PathDefinition {
  const d = (raw ?? {}) as Partial<PathDefinition>;
  return {
    ...d,
    points: Array.isArray(d.points)
      ? d.points
        .filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
        // a snapped point sits on its spot, wherever the field model now puts it (an unknown spot is dropped)
        .map(p => {
          if (!p.target) return p;
          const t = targetById(p.target);
          return t ? { ...p, x: t.x, y: t.y } : { ...p, target: null };
        })
      : [],
    params: d.params ?? null,
  };
}

function cleanAuton(raw: unknown): AutonDefinition {
  const d = (raw ?? {}) as Partial<AutonDefinition>;
  return { ...d, steps: Array.isArray(d.steps) ? d.steps.filter(s => typeof s?.path === 'string') : [] };
}

const readFocus = (): Focus => {
  try {
    return JSON.parse(localStorage.getItem(FOCUS_KEY) ?? 'null') as Focus;
  } catch {
    return null;
  }
};

export function useLibrary() {
  const [ready, setReady] = useState(false);
  const [dir, setDir] = useState<string | null>(null);
  const [lib, setLibState] = useState<Library>({ paths: {}, autons: {} });
  const libRef = useRef(lib);
  const setLib = (next: Library) => {
    libRef.current = next;
    setLibState(next);
  };

  const [focus, setFocusState] = useState<Focus>(null);
  const focusRef = useRef<Focus>(null);
  // Selected points: none, one (the Inspector edits it), or a group from a box select (dragged together).
  const [selection, setSelection] = useState<number[]>([]);
  const selectedIndex = selection.length === 1 ? selection[0] : null;
  const setSelectedIndex = (i: number | null) => setSelection(i == null ? [] : [i]);

  const [robot, setRobotState] = useState<RobotConfig>(CRIMSON_PROFILE.robot);
  const robotTimer = useRef<number | undefined>(undefined);

  // unsaved documents ("path:name" / "auton:name"), each with its pending write
  const timers = useRef(new Map<string, number>());
  const [dirty, setDirtyState] = useState<Set<string>>(new Set());
  const dirtyRef = useRef<Set<string>>(new Set());
  const markDirty = (key: string, on: boolean) => {
    if (dirtyRef.current.has(key) === on) return;
    const next = new Set(dirtyRef.current);
    if (on) next.add(key);
    else next.delete(key);
    dirtyRef.current = next;
    setDirtyState(next);
  };

  const histories = useRef(new Map<string, History>());
  const lastAction = useRef<{ doc: string; key: string; time: number } | null>(null);

  // ---------- derived ----------

  const pathNameOf = (f: Focus, l: Library = libRef.current) =>
    f?.kind === 'path' ? f.path : f?.kind === 'step' ? (l.autons[f.auton]?.steps[f.step]?.path ?? null) : null;
  const rotatedOf = (f: Focus, l: Library = libRef.current) =>
    f?.kind === 'step' && !!l.autons[f.auton]?.steps[f.step]?.rotate;
  const autonOf = (f: Focus) => (f?.kind === 'auton' || f?.kind === 'step' ? f.auton : null);
  const docOf = (f: Focus): string | null => {
    if (f?.kind === 'auton') return docKey('auton', f.auton);
    const p = pathNameOf(f);
    return p ? docKey('path', p) : null;
  };

  const currentPathName = pathNameOf(focus, lib);
  const rotated = rotatedOf(focus, lib);
  const rawPath = currentPathName ? lib.paths[currentPathName] : undefined;
  /** the current path as shown and edited (turned around for a turned step) */
  const currentPath: PathDefinition = useMemo(
    () => (rawPath ? (rotated ? rotate180(rawPath) : rawPath) : EMPTY_PATH),
    [rawPath, rotated],
  );
  const currentAutonName = autonOf(focus);
  const currentAuton = currentAutonName ? lib.autons[currentAutonName] : undefined;

  const setFocus = (f: Focus) => {
    focusRef.current = f;
    setFocusState(f);
    setSelection([]);
    lastAction.current = null;
    try {
      localStorage.setItem(FOCUS_KEY, JSON.stringify(f));
    } catch { /* not important */ }
  };

  // ---------- loading ----------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await store.load();
        if (cancelled) return;
        const paths = Object.fromEntries(Object.entries(res.paths ?? {}).map(([k, v]) => [k, cleanPath(v)]));
        const autons = Object.fromEntries(Object.entries(res.autons ?? {}).map(([k, v]) => [k, cleanAuton(v)]));
        setLib({ paths, autons });
        setDir(res.dir);
        if (res.settings?.robot) setRobotState({ ...CRIMSON_PROFILE.robot, ...res.settings.robot });
        if (res.skipped?.length) alert(`Skipped unreadable files:\n${res.skipped.join('\n')}`);
        // reopen what was open last time, if it's still there
        const f = readFocus();
        const ok = f?.kind === 'path' ? f.path in paths
          : f?.kind === 'auton' ? f.auton in autons
            : f?.kind === 'step' ? !!autons[f.auton]?.steps[f.step]
              : false;
        const first = Object.keys(autons)[0];
        setFocus(ok ? f : first ? { kind: 'auton', auton: first } : null);
      } catch (e) {
        alert(`Couldn't load autons: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- saving ----------

  const dataOf = (kind: DocKind, name: string) => (kind === 'path' ? libRef.current.paths[name] : libRef.current.autons[name]);

  const flush = async (key: string) => {
    window.clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    const { kind, name } = splitKey(key);
    const data = dataOf(kind, name);
    if (!data) return markDirty(key, false);
    try {
      await store.write(kind, name, data);
    } catch (e) {
      alert(`Couldn't save ${name}: ${(e as Error).message}`);
      return;
    }
    if (!timers.current.has(key)) markDirty(key, false);
  };

  const schedule = (kind: DocKind, name: string) => {
    const key = docKey(kind, name);
    window.clearTimeout(timers.current.get(key));
    timers.current.set(key, window.setTimeout(() => void flush(key), SAVE_DELAY));
    markDirty(key, true);
  };

  /** Write everything that's waiting now. */
  const saveAll = async () => {
    for (const key of [...timers.current.keys()]) await flush(key);
  };

  // closing with writes still waiting: write them synchronously
  useEffect(() => {
    const onUnload = () => {
      const writes = [...timers.current.keys()].flatMap(key => {
        const { kind, name } = splitKey(key);
        const data = dataOf(kind, name);
        return data ? [{ kind, name, data }] : [];
      });
      timers.current.forEach(t => window.clearTimeout(t));
      timers.current.clear();
      if (writes.length) store.flushSync(writes);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const putPath = (name: string, def: PathDefinition) => {
    setLib({ ...libRef.current, paths: { ...libRef.current.paths, [name]: def } });
    schedule('path', name);
  };

  const putAuton = (name: string, def: AutonDefinition) => {
    setLib({ ...libRef.current, autons: { ...libRef.current.autons, [name]: def } });
    schedule('auton', name);
  };

  // ---------- undo ----------

  const history = (doc: string) => {
    let h = histories.current.get(doc);
    if (!h) histories.current.set(doc, (h = { past: [], future: [] }));
    return h;
  };

  const checkpointDoc = (doc: string, key?: string) => {
    const now = performance.now();
    const last = lastAction.current;
    if (key && last && last.doc === doc && last.key === key && now - last.time < COALESCE_MS) {
      last.time = now;
      return;
    }
    lastAction.current = key ? { doc, key, time: now } : null;
    const { kind, name } = splitKey(doc);
    const data = dataOf(kind, name);
    if (!data) return;
    const h = history(doc);
    h.past.push(JSON.stringify(data));
    if (h.past.length > MAX_HISTORY) h.past.shift();
    h.future = [];
  };

  /** Save an undo step for the current path (before a live drag). */
  const checkpoint = () => {
    const name = pathNameOf(focusRef.current);
    if (name) checkpointDoc(docKey('path', name));
  };

  /** Replace the current path (as shown: a turned step is turned back before it's stored). */
  const update = (def: PathDefinition, mode: HistoryMode = true) => {
    const f = focusRef.current;
    const name = pathNameOf(f);
    if (!name) return;
    if (mode !== false) checkpointDoc(docKey('path', name), typeof mode === 'string' ? mode : undefined);
    putPath(name, rotatedOf(f) ? rotate180(def) : def);
  };

  /** Replace a path by name, as stored. */
  const updatePath = (name: string, def: PathDefinition, mode: HistoryMode = true) => {
    if (!libRef.current.paths[name]) return;
    if (mode !== false) checkpointDoc(docKey('path', name), typeof mode === 'string' ? mode : undefined);
    putPath(name, def);
  };

  const updateAuton = (name: string, def: AutonDefinition, mode: HistoryMode = true) => {
    if (!libRef.current.autons[name]) return;
    if (mode !== false) checkpointDoc(docKey('auton', name), typeof mode === 'string' ? mode : undefined);
    putAuton(name, def);
  };

  const step = (dir: 'undo' | 'redo') => {
    const f = focusRef.current;
    const doc = docOf(f);
    if (!doc) return;
    const { kind, name } = splitKey(doc);
    const now = dataOf(kind, name);
    if (!now) return;
    const h = history(doc);
    const from = dir === 'undo' ? h.past : h.future;
    const to = dir === 'undo' ? h.future : h.past;
    const target = from.pop();
    if (!target) return;
    to.push(JSON.stringify(now));
    lastAction.current = null;
    if (kind === 'path') {
      const def = JSON.parse(target) as PathDefinition;
      putPath(name, def);
      setSelection(sel => sel.filter(i => i < def.points.length));
    } else {
      putAuton(name, JSON.parse(target) as AutonDefinition);
    }
  };

  // ---------- names ----------

  const validName = (kind: DocKind, raw: string, except?: string) => {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name || name === except) return null;
    if (!NAME_RE.test(name)) {
      alert('Use letters, numbers, spaces, - or _');
      return null;
    }
    const taken = kind === 'path' ? libRef.current.paths : libRef.current.autons;
    if (Object.keys(taken).some(n => n.toLowerCase() === name.toLowerCase() && n !== except)) {
      alert(`There's already ${kind === 'path' ? 'a path' : 'an auton'} called that.`);
      return null;
    }
    return name;
  };

  /** New empty path. With an auton, it's added to the end of it and opened there. */
  const createPath = async (raw: string, addTo?: string | null) => {
    const name = validName('path', raw);
    if (!name) return false;
    const def: PathDefinition = { points: [], params: null };
    setLib({ ...libRef.current, paths: { ...libRef.current.paths, [name]: def } });
    await flush(docKey('path', name));
    const auton = addTo ? libRef.current.autons[addTo] : undefined;
    if (addTo && auton) {
      updateAuton(addTo, { ...auton, steps: [...auton.steps, { path: name }] });
      setFocus({ kind: 'step', auton: addTo, step: auton.steps.length });
    } else {
      setFocus({ kind: 'path', path: name });
    }
    return true;
  };

  const createAuton = async (raw: string) => {
    const name = validName('auton', raw);
    if (!name) return false;
    setLib({ ...libRef.current, autons: { ...libRef.current.autons, [name]: { steps: [] } } });
    await flush(docKey('auton', name));
    setFocus({ kind: 'auton', auton: name });
    return true;
  };

  const moveDoc = (from: string, to: string) => {
    const h = histories.current.get(from);
    histories.current.delete(from);
    if (h) histories.current.set(to, h);
    if (dirtyRef.current.has(from)) markDirty(from, false);
  };

  const renamePath = async (oldName: string, raw: string) => {
    const name = validName('path', raw, oldName);
    if (!name) return;
    await flush(docKey('path', oldName));
    try {
      await store.rename('path', oldName, name);
    } catch (e) {
      alert(`Couldn't rename: ${(e as Error).message}`);
      return;
    }
    const def = libRef.current.paths[oldName];
    setLib({ ...libRef.current, paths: { ...without(libRef.current.paths, oldName), [name]: def } });
    moveDoc(docKey('path', oldName), docKey('path', name));
    // every auton that runs it follows the new name
    for (const [a, auton] of Object.entries(libRef.current.autons)) {
      if (auton.steps.some(s => s.path === oldName)) {
        putAuton(a, { ...auton, steps: auton.steps.map(s => (s.path === oldName ? { ...s, path: name } : s)) });
      }
    }
    const f = focusRef.current;
    if (f?.kind === 'path' && f.path === oldName) setFocus({ kind: 'path', path: name });
  };

  const renameAuton = async (oldName: string, raw: string) => {
    const name = validName('auton', raw, oldName);
    if (!name) return;
    await flush(docKey('auton', oldName));
    try {
      await store.rename('auton', oldName, name);
    } catch (e) {
      alert(`Couldn't rename: ${(e as Error).message}`);
      return;
    }
    const def = libRef.current.autons[oldName];
    setLib({ ...libRef.current, autons: { ...without(libRef.current.autons, oldName), [name]: def } });
    moveDoc(docKey('auton', oldName), docKey('auton', name));
    const f = focusRef.current;
    if (f?.kind === 'auton' && f.auton === oldName) setFocus({ kind: 'auton', auton: name });
    if (f?.kind === 'step' && f.auton === oldName) setFocus({ ...f, auton: name });
  };

  const dropDoc = (key: string) => {
    window.clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    histories.current.delete(key);
    markDirty(key, false);
  };

  const deletePath = async (name: string) => {
    const users = Object.entries(libRef.current.autons).filter(([, a]) => a.steps.some(s => s.path === name)).map(([n]) => n);
    const note = users.length ? `\n\nIt's used in ${users.join(', ')}, and will be taken out of ${users.length > 1 ? 'them' : 'it'}.` : '';
    if (!window.confirm(`Delete the path "${name}"? This can't be undone.${note}`)) return;
    try {
      await store.remove('path', name);
    } catch (e) {
      alert(`Couldn't delete: ${(e as Error).message}`);
      return;
    }
    dropDoc(docKey('path', name));
    setLib({ ...libRef.current, paths: without(libRef.current.paths, name) });
    for (const a of users) {
      const auton = libRef.current.autons[a];
      putAuton(a, { ...auton, steps: auton.steps.filter(s => s.path !== name) });
    }
    const f = focusRef.current;
    if (f?.kind === 'path' && f.path === name) setFocus(null);
    else if (f?.kind === 'step' && users.includes(f.auton)) setFocus({ kind: 'auton', auton: f.auton });
  };

  const deleteAuton = async (name: string) => {
    if (!window.confirm(`Delete the auton "${name}"? Its paths stay in the library. This can't be undone.`)) return;
    try {
      await store.remove('auton', name);
    } catch (e) {
      alert(`Couldn't delete: ${(e as Error).message}`);
      return;
    }
    dropDoc(docKey('auton', name));
    setLib({ ...libRef.current, autons: without(libRef.current.autons, name) });
    if (autonOf(focusRef.current) === name) setFocus(null);
  };

  // ---------- robot ----------

  const setRobot = (patch: Partial<RobotConfig>) => {
    setRobotState(r => {
      const next = { ...r, ...patch };
      window.clearTimeout(robotTimer.current);
      robotTimer.current = window.setTimeout(() => {
        const settings: Settings = { robot: { ...next } };
        store.writeSettings(settings).catch(e => console.error('settings write failed', e));
      }, SAVE_DELAY);
      return next;
    });
  };

  return {
    ready,
    dir,
    paths: lib.paths,
    autons: lib.autons,
    focus,
    setFocus,
    currentPathName,
    currentPath,
    rotated,
    currentAutonName,
    currentAuton,
    selection,
    setSelection,
    selectedIndex,
    setSelectedIndex,
    dirty,
    update,
    updatePath,
    updateAuton,
    checkpoint,
    undo: () => step('undo'),
    redo: () => step('redo'),
    saveAll,
    createPath,
    createAuton,
    renamePath,
    renameAuton,
    deletePath,
    deleteAuton,
    robot,
    setRobot,
  };
}

export type LibraryState = ReturnType<typeof useLibrary>;
