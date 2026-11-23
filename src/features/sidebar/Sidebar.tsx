import { Fragment, useEffect, useRef, useState } from 'react';
import type { LibraryState } from '../../hooks/useLibrary';
import type { Theme } from '../../hooks/useTheme';
import { ROBOT_FIELDS, type RobotConfig } from '../../robot/config';
import { CRIMSON_PROFILE } from '../../profiles/crimson';
import { store } from '../../editor/store';
import { LOADERS, LOADER_NOMINAL, type LoaderOffsets } from '../../editor/targets';
import { allFolders, buildTree, folderOf, leafOf, type FolderNode } from '../../editor/names';
import { Icon, IconButton } from '../../components/Icon';
import { NumberField } from '../../components/Controls';
import { MenuButton } from '../../components/Menu';

interface Props {
  lib: LibraryState;
  theme: Theme;
  onToggleTheme: () => void;
  grid: boolean;
  onToggleGrid: () => void;
  speedColors: boolean;
  onToggleSpeedColors: () => void;
  /** asks for a new path's name (adding it to an auton when given) */
  /** a new path to name: in the library, or into an auton at a position (the end without one) */
  onNewPath: (auton: string | null, at?: number) => void;
  /** set while a new path is being named, so the box shows in the right place */
  naming: { auton: string | null; at?: number } | null;
  onNamingDone: () => void;
}

const DRAG_TYPE = 'application/x-pointweaver-path';

/** Inline name box. Submits once (Enter or blur), Escape cancels. */
function InlineInput({ initial, placeholder, onSubmit, onDone }: {
  initial: string;
  placeholder?: string;
  onSubmit: (v: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = async (submit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (submit && value.trim() && value.trim() !== initial) await onSubmit(value);
    onDone();
  };
  return (
    <input autoFocus className="inline-input" placeholder={placeholder} value={value} onChange={e => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={e => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }} />
  );
}

const CLOSED_KEY = 'pw:closedFolders';
const readClosed = (): Set<string> => {
  try {
    const v = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};
const saveClosed = (s: Set<string>) => {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...s]));
  } catch { /* not important */ }
};
/** indent for a row at a folder depth (px) */
const indent = (depth: number) => ({ paddingLeft: 8 + depth * 14 });

const shortDir = (dir: string) => {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('\\');
};

export function Sidebar({
  lib, theme, onToggleTheme, grid, onToggleGrid, speedColors, onToggleSpeedColors, onNewPath, naming, onNamingDone,
}: Props) {
  const [creatingAuton, setCreatingAuton] = useState(false);
  const [renaming, setRenaming] = useState<{ kind: 'path' | 'auton'; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [robotOpen, setRobotOpen] = useState(false);
  const [fieldOpen, setFieldOpen] = useState(false);
  // path folders: which are folded (remembered), which is being renamed, which path waits for a new folder's name
  const [closed, setClosedState] = useState<Set<string>>(readClosed);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [newFolderFor, setNewFolderFor] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const { focus, autons, paths } = lib;
  const setClosed = (next: Set<string>) => {
    setClosedState(next);
    saveClosed(next);
  };

  const current = lib.currentAutonName;
  // the open auton is always unfolded
  useEffect(() => {
    if (current && !expanded.has(current)) setExpanded(new Set(expanded).add(current));
  }, [current]);

  // the open path's folders are unfolded
  const openPath = focus?.kind === 'path' ? focus.path : null;
  useEffect(() => {
    if (!openPath) return;
    const f = folderOf(openPath);
    if (!f) return;
    const parts = f.split('/');
    const need = parts.map((_, i) => parts.slice(0, i + 1).join('/')).filter(p => closed.has(p));
    if (need.length) setClosed(new Set([...closed].filter(p => !need.includes(p))));
  }, [openPath]);

  const toggle = (name: string) => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
  };

  const addStep = (auton: string, path: string) => {
    const a = autons[auton];
    if (!a) return;
    lib.updateAuton(auton, { ...a, steps: [...a.steps, { path }] });
    setExpanded(new Set(expanded).add(auton));
  };

  const usage = (path: string) =>
    Object.values(autons).reduce((n, a) => n + a.steps.filter(s => s.path === path).length, 0);

  const autonNames = Object.keys(autons).sort((a, b) => a.localeCompare(b));
  const pathNames = Object.keys(paths).sort((a, b) => a.localeCompare(b));
  const tree = buildTree(pathNames);
  const folders = allFolders(pathNames);

  /** drop target for a dragged path: a folder row ('' = the Paths header, out of any folder) */
  const folderDrop = (folder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropFolder(folder);
    },
    onDragLeave: () => setDropFolder(d => (d === folder ? null : d)),
    onDrop: (e: React.DragEvent) => {
      const path = e.dataTransfer.getData(DRAG_TYPE);
      setDropFolder(null);
      if (path) {
        e.preventDefault();
        lib.movePaths([path], folder);
      }
    },
  });

  const pathRow = (name: string, depth: number) => {
    const active = focus?.kind === 'path' && focus.path === name;
    const n = usage(name);
    const here = folderOf(name);
    if (renaming?.kind === 'path' && renaming.name === name) {
      return (
        <div key={name} className="list-row editing" style={indent(depth)}>
          <InlineInput initial={name} onSubmit={v => lib.renamePath(name, v)} onDone={() => setRenaming(null)} />
        </div>
      );
    }
    if (newFolderFor === name) {
      return (
        <div key={name} className="list-row editing" style={indent(depth)}>
          <InlineInput initial="" placeholder={`new folder for "${leafOf(name)}"`}
            onSubmit={v => lib.movePaths([name], here ? `${here}/${v.trim()}` : v.trim())} onDone={() => setNewFolderFor(null)} />
        </div>
      );
    }
    return (
      <div key={name} className={`list-row ${active ? 'selected' : ''}`} draggable style={indent(depth)}
        title={`${name}\nDrag onto an auton to add it, or onto a folder to move it there`}
        onDragStart={e => {
          e.dataTransfer.setData(DRAG_TYPE, name);
          e.dataTransfer.effectAllowed = 'copyMove';
        }}
        onClick={() => lib.setFocus({ kind: 'path', path: name })}
        onDoubleClick={() => setRenaming({ kind: 'path', name })}>
        <Icon name="route" size={14} />
        <span className="grow ellipsis">{leafOf(name)}</span>
        {n > 0 && <span className="uses" title={`Used ${n} time${n > 1 ? 's' : ''} in autons`}>{n}×</span>}
        {lib.dirty.has(`path:${name}`) && <span className="dirty-dot" title="Saving…" />}
        <span className="row-actions" onClick={e => e.stopPropagation()}>
          {current && <IconButton icon="addPath" title={`Add to ${current}`} onClick={() => addStep(current, name)} />}
          <MenuButton icon="folder" title="Move to a folder" heading="Move to" align="left"
            items={[
              { label: here ? 'New folder in here…' : 'New folder…', onSelect: () => setNewFolderFor(name) },
              ...(here ? [{ label: 'Out of folders', onSelect: () => lib.movePaths([name], '') }] : []),
              ...(folders.filter(f => f !== here).length ? [null] : []),
              ...folders.filter(f => f !== here).map(f => ({ label: f, onSelect: () => lib.movePaths([name], f) })),
            ]} />
          <IconButton icon="pencil" title="Rename (every auton follows; use a / for a folder)" onClick={() => setRenaming({ kind: 'path', name })} />
          <IconButton icon="x" title="Delete path" onClick={() => lib.deletePath(name)} />
        </span>
      </div>
    );
  };

  const folderRows = (node: FolderNode, depth: number): React.ReactNode[] => node.folders.flatMap(f => {
    const open = !closed.has(f.path);
    if (renamingFolder === f.path) {
      return [
        <div key={`folder:${f.path}`} className="list-row editing" style={indent(depth)}>
          <InlineInput initial={f.path} onSubmit={v => lib.renameFolder(f.path, v)} onDone={() => setRenamingFolder(null)} />
        </div>,
      ];
    }
    return [
      <div key={`folder:${f.path}`} className={['list-row folder-row', dropFolder === f.path && 'drop-into'].filter(Boolean).join(' ')}
        style={indent(depth)} title={`${f.path}: ${f.count} path${f.count === 1 ? '' : 's'}. Drop a path here to move it in`}
        onClick={() => {
          const next = new Set(closed);
          if (open) next.add(f.path);
          else next.delete(f.path);
          setClosed(next);
        }}
        onDoubleClick={() => setRenamingFolder(f.path)}
        {...folderDrop(f.path)}>
        <span className={`chevron ${open ? 'open' : ''}`}><Icon name="chevron" size={12} /></span>
        <Icon name="folder" size={14} />
        <span className="grow ellipsis">{f.name}</span>
        <b className="count">{f.count}</b>
        <span className="row-actions" onClick={e => e.stopPropagation()}>
          <IconButton icon="pencil" title="Rename the folder (every path in it, and every auton, follows)" onClick={() => setRenamingFolder(f.path)} />
        </span>
      </div>,
      ...(open ? [...folderRows(f, depth + 1), ...f.items.map(p => pathRow(p, depth + 1))] : []),
    ];
  });

  return (
    <aside className="panel left">
      <div className="brand">
        <Icon name="logo" size={18} />
        <span className="grow">PointWeaver</span>
        <IconButton icon={theme === 'day' ? 'moon' : 'sun'} title={theme === 'day' ? 'Night mode' : 'Day mode'} onClick={onToggleTheme} />
      </div>

      <button type="button" className="project-btn" disabled={!store.reveal}
        title={lib.dir ? `Saved in ${lib.dir}. Click to open the folder.` : 'Saved in this browser'}
        onClick={() => store.reveal?.().catch(e => alert(`Couldn't open the folder: ${(e as Error).message}`))}>
        <Icon name="folder" />
        <span>{lib.dir ? shortDir(lib.dir) : 'Browser storage'}</span>
      </button>

      <div className="side-scroll scroll">
        <div className="section-head">
          <span>Autons <b className="count">{autonNames.length}</b></span>
          <IconButton icon="plus" title="New auton" onClick={() => setCreatingAuton(true)} />
        </div>
        <div className="list">
          {autonNames.map(name => {
            const auton = autons[name];
            const open = expanded.has(name);
            const active = focus?.kind === 'auton' && focus.auton === name;
            if (renaming?.kind === 'auton' && renaming.name === name) {
              return (
                <div key={name} className="list-row editing">
                  <InlineInput initial={name} onSubmit={v => lib.renameAuton(name, v)} onDone={() => setRenaming(null)} />
                </div>
              );
            }
            return (
              <Fragment key={name}>
                <div
                  className={['list-row auton-row', active && 'selected', dropOn === name && 'drop-into'].filter(Boolean).join(' ')}
                  onClick={() => lib.setFocus({ kind: 'auton', auton: name })}
                  onDoubleClick={() => setRenaming({ kind: 'auton', name })}
                  onDragOver={e => {
                    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    setDropOn(name);
                  }}
                  onDragLeave={() => setDropOn(d => (d === name ? null : d))}
                  onDrop={e => {
                    const path = e.dataTransfer.getData(DRAG_TYPE);
                    setDropOn(null);
                    if (path) {
                      e.preventDefault();
                      addStep(name, path);
                    }
                  }}
                >
                  <button type="button" className={`chevron ${open ? 'open' : ''}`} aria-label={open ? 'Fold' : 'Unfold'}
                    onClick={e => {
                      e.stopPropagation();
                      toggle(name);
                    }}>
                    <Icon name="chevron" size={12} />
                  </button>
                  <span className="grow ellipsis">{name}</span>
                  {auton.skills && <span className="tag" title="Skills (60 s)">60s</span>}
                  {lib.dirty.has(`auton:${name}`) && <span className="dirty-dot" title="Saving…" />}
                  <span className="row-actions" onClick={e => e.stopPropagation()}>
                    <IconButton icon="pencil" title="Rename" onClick={() => setRenaming({ kind: 'auton', name })} />
                    <IconButton icon="x" title="Delete auton" onClick={() => lib.deleteAuton(name)} />
                  </span>
                </div>
                {open && (
                  <div className={`sub-list ${active || current === name ? 'selected' : ''}`}>
                    {auton.steps.map((s, k) => {
                      const on = focus?.kind === 'step' && focus.auton === name && focus.step === k;
                      // a new path being named to go in right after this one
                      const namingHere = naming?.auton === name && naming.at === k + 1 && k + 1 < auton.steps.length;
                      return (
                        <Fragment key={k}>
                          <div className={`sub-row ${on ? 'selected' : ''} ${paths[s.path] ? '' : 'missing'}`}
                            title={paths[s.path] ? s.path : `"${s.path}" is missing`}
                            onClick={() => paths[s.path] && lib.setFocus({ kind: 'step', auton: name, step: k })}>
                            <span className="idx">{k + 1}</span>
                            <span className="grow ellipsis">
                              {folderOf(s.path) && <span className="faint">{folderOf(s.path)}/</span>}{leafOf(s.path)}
                            </span>
                            {s.rotate && <span className="rot" title="Turned 180°"><Icon name="rotate" size={12} /></span>}
                            <span className="row-actions" onClick={e => e.stopPropagation()}>
                              <MenuButton icon="plus" title={`Insert a path after ${k + 1}`} heading={`Insert after ${k + 1}`}
                                align="left" empty="No paths yet"
                                items={[
                                  { label: 'New path…', onSelect: () => onNewPath(name, k + 1) },
                                  ...(pathNames.length ? [null] : []),
                                  ...pathNames.map(p => ({ label: p, onSelect: () => lib.insertStep(name, k + 1, p) })),
                                ]} />
                              <IconButton icon="x" title="Take out of this auton (the path stays in the library)"
                                onClick={() => lib.removeStep(name, k)} />
                            </span>
                          </div>
                          {namingHere && (
                            <div className="sub-row editing">
                              <InlineInput initial="" placeholder="path name" onSubmit={v => lib.createPath(v, name, k + 1)} onDone={onNamingDone} />
                            </div>
                          )}
                        </Fragment>
                      );
                    })}
                    {naming?.auton === name && (naming.at == null || naming.at >= auton.steps.length) ? (
                      <div className="sub-row editing">
                        <InlineInput initial="" placeholder="path name" onSubmit={v => lib.createPath(v, name)} onDone={onNamingDone} />
                      </div>
                    ) : (
                      <div className="sub-row add">
                        <MenuButton icon="plus" title="Add a path at the end of this auton" heading="Add at the end" align="left" empty="No paths yet"
                          items={[
                            { label: 'New path…', onSelect: () => onNewPath(name) },
                            ...(pathNames.length ? [null] : []),
                            ...pathNames.map(p => ({ label: p, onSelect: () => addStep(name, p) })),
                          ]} />
                        <span className="faint">{auton.steps.length ? 'Add path' : 'Add a path, or drag one here'}</span>
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
          {creatingAuton && (
            <div className="list-row editing">
              <InlineInput initial="" placeholder="auton name" onSubmit={lib.createAuton} onDone={() => setCreatingAuton(false)} />
            </div>
          )}
          {autonNames.length === 0 && !creatingAuton && <div className="empty">Make an auton with +</div>}
        </div>

        <div className={['section-head sub', dropFolder === '' && 'drop-into'].filter(Boolean).join(' ')}
          title="Drop a path here to take it out of its folder" {...folderDrop('')}>
          <span>Paths <b className="count">{pathNames.length}</b></span>
          <IconButton icon="plus" title="New path (name it folder/name to put it in a folder)" onClick={() => onNewPath(null)} />
        </div>
        <div className="list">
          {folderRows(tree, 0)}
          {tree.items.map(name => pathRow(name, 0))}
          {naming && naming.auton == null && (
            <div className="list-row editing">
              <InlineInput initial="" placeholder="path name" onSubmit={v => lib.createPath(v)} onDone={onNamingDone} />
            </div>
          )}
          {pathNames.length === 0 && !naming && <div className="empty">Paths you make show up here</div>}
        </div>
      </div>

      <div className="panel-foot">
        <RobotSection robot={lib.robot} setRobot={lib.setRobot} open={robotOpen} onToggle={() => setRobotOpen(!robotOpen)} />
        <FieldDrawer offsets={lib.loaderOffsets} setOffset={lib.setLoaderOffset} open={fieldOpen} />
        <div className="section-head">
          <span>Field</span>
          <span className="head-actions">
            {Object.keys(lib.loaderOffsets).length > 0 && (
              <IconButton icon="x" title="Loaders back where the manual puts them (12 in from the corner)"
                onClick={() => lib.setLoaderOffset(Object.fromEntries(Object.keys(LOADERS).map(id => [id, 0])))} />
            )}
            <IconButton icon="grid" title={grid ? 'Hide 6 in grid (G)' : 'Show 6 in grid (G)'} active={grid} onClick={onToggleGrid} />
            <IconButton icon="speed" title={speedColors ? 'Plain ghost trail (V)' : 'Color the ghost trail by speed (V)'}
              active={speedColors} onClick={onToggleSpeedColors} />
            <IconButton icon="sliders" title="Loader offsets: for a field whose loaders aren't where the manual puts them"
              active={fieldOpen} onClick={() => setFieldOpen(!fieldOpen)} />
          </span>
        </div>
      </div>
    </aside>
  );
}

const LOADER_OFFSET_LIMIT = 10; // in either way: past that it's not a loader that was bolted on a little off

/**
 * How this field was built: each loader's offset from where the manual puts it (12 in from the corner, along its wall).
 * Moving one moves its glow, its drawing and every point snapped to it, so the code drives to the loader as built.
 */
function FieldDrawer({ offsets, setOffset, open }: {
  offsets: LoaderOffsets;
  setOffset: (patch: LoaderOffsets) => void;
  open: boolean;
}) {
  const order = ['loader-blue-bottom', 'loader-blue-top', 'loader-red-top', 'loader-red-bottom'];
  return (
    <div className={`drawer ${open ? 'open' : ''}`} inert={!open} aria-hidden={!open}>
      <div className="drawer-inner">
        <div className="grid-2 drawer-body">
          <span className="drawer-label" title={`The manual centres each loader ${LOADER_NOMINAL} in from the corner along its wall. Measure this field's and put in how far off it is: + is farther from the corner. Left and right are as seen from that alliance's driver station.`}>
            Loader offsets (0 = {LOADER_NOMINAL} in from the corner)
          </span>
          {order.map(id => {
            const off = offsets[id] ?? 0;
            const name = LOADERS[id].name;
            return (
              <NumberField key={id} label={name[0].toUpperCase() + name.slice(1)} suffix="in" step={0.25} value={off}
                title={`${name} loader: ${Math.round((LOADER_NOMINAL + off) * 100) / 100} in from the corner (${LOADER_NOMINAL} + ${off}); points on it move with it`}
                onChange={v => v != null && setOffset({ [id]: Math.max(-LOADER_OFFSET_LIMIT, Math.min(LOADER_OFFSET_LIMIT, v)) })} />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The ghost's robot: size and how fast it drives. The settings slide up out of the Robot header (a drawer above it)
 * so the header and its buttons never move.
 */
function RobotSection({ robot, setRobot, open, onToggle }: {
  robot: RobotConfig;
  setRobot: (patch: Partial<RobotConfig>) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const d = CRIMSON_PROFILE.robot;
  const short: Record<keyof RobotConfig, string> = {
    width: 'Width', length: 'Length', trackWidth: 'Track', maxSpeed: 'Speed', acceleration: 'Accel', deceleration: 'Braking',
    maxTurnRate: 'Turn', turnAcceleration: 'Turn accel', clawOffset: 'Claw', goalOffset: 'Goal', timeoutLeeway: 'Leeway', donutRate: 'Donut', horizontalDrift: 'Drift',
    linearSmallError: 'Move small', linearSmallTime: 'for', linearLargeError: 'Move large', linearLargeTime: 'for',
    angularSmallError: 'Turn small', angularSmallTime: 'for', angularLargeError: 'Turn large', angularLargeTime: 'for',
  };
  const field = (f: (typeof ROBOT_FIELDS)[number]) => (
    <NumberField key={f.key} label={short[f.key]} suffix={f.unit} step={f.step} value={robot[f.key]}
      title={`${f.label} (${f.min}–${f.max} ${f.unit})`}
      onChange={v => v != null && setRobot({ [f.key]: Math.max(f.min, Math.min(f.max, v)) })} />
  );
  const changed = ROBOT_FIELDS.some(f => robot[f.key] !== d[f.key]);
  return (
    <>
      {/* always rendered so it can animate closed too; inert while closed so its fields can't be tabbed into */}
      <div className={`drawer ${open ? 'open' : ''}`} inert={!open} aria-hidden={!open}>
        <div className="drawer-inner">
          <div className="grid-2 drawer-body">
            {ROBOT_FIELDS.filter(f => !f.exit).map(field)}
            <span className="drawer-label" title="lemlib::ControllerSettings in the robot's robotconfig.cpp: a move or turn is done once it stays within the small range for its time, or the large range for its time">
              Exit ranges (robotconfig.cpp)
            </span>
            {ROBOT_FIELDS.filter(f => f.exit).map(field)}
          </div>
        </div>
      </div>
      <div className="section-head">
        <span>Robot</span>
        <span className="head-actions">
          {changed && <IconButton icon="x" title="Back to Crimson's numbers" onClick={() => setRobot({ ...d })} />}
          <IconButton icon="sliders" title="Robot size and speed for the ghost; claw and goal offsets and the timeout leeway (used in the code)" active={open} onClick={onToggle} />
        </span>
      </div>
    </>
  );
}
