import { Fragment, useEffect, useRef, useState } from 'react';
import type { LibraryState } from '../../hooks/useLibrary';
import type { Theme } from '../../hooks/useTheme';
import { ROBOT_FIELDS, type RobotConfig } from '../../robot/config';
import { CRIMSON_PROFILE } from '../../profiles/crimson';
import { store } from '../../editor/store';
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
  onNewPath: (auton: string | null) => void;
  /** set while a new path is being named, so the box shows in the right place */
  naming: { auton: string | null } | null;
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
  const { focus, autons, paths } = lib;

  const current = lib.currentAutonName;
  // the open auton is always unfolded
  useEffect(() => {
    if (current && !expanded.has(current)) setExpanded(new Set(expanded).add(current));
  }, [current]);

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
                      return (
                        <div key={k} className={`sub-row ${on ? 'selected' : ''} ${paths[s.path] ? '' : 'missing'}`}
                          title={paths[s.path] ? s.path : `"${s.path}" is missing`}
                          onClick={() => paths[s.path] && lib.setFocus({ kind: 'step', auton: name, step: k })}>
                          <span className="idx">{k + 1}</span>
                          <span className="grow ellipsis">{s.path}</span>
                          {s.rotate && <span className="rot" title="Turned 180°"><Icon name="rotate" size={12} /></span>}
                        </div>
                      );
                    })}
                    {naming?.auton === name ? (
                      <div className="sub-row editing">
                        <InlineInput initial="" placeholder="path name" onSubmit={v => lib.createPath(v, name)} onDone={onNamingDone} />
                      </div>
                    ) : (
                      <div className="sub-row add">
                        <MenuButton icon="plus" title="Add a path to this auton" empty="No paths yet"
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

        <div className="section-head sub">
          <span>Paths <b className="count">{pathNames.length}</b></span>
          <IconButton icon="plus" title="New path" onClick={() => onNewPath(null)} />
        </div>
        <div className="list">
          {pathNames.map(name => {
            const active = focus?.kind === 'path' && focus.path === name;
            const n = usage(name);
            if (renaming?.kind === 'path' && renaming.name === name) {
              return (
                <div key={name} className="list-row editing">
                  <InlineInput initial={name} onSubmit={v => lib.renamePath(name, v)} onDone={() => setRenaming(null)} />
                </div>
              );
            }
            return (
              <div key={name} className={`list-row ${active ? 'selected' : ''}`} draggable
                title="Drag onto an auton to add it"
                onDragStart={e => {
                  e.dataTransfer.setData(DRAG_TYPE, name);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => lib.setFocus({ kind: 'path', path: name })}
                onDoubleClick={() => setRenaming({ kind: 'path', name })}>
                <Icon name="route" size={14} />
                <span className="grow ellipsis">{name}</span>
                {n > 0 && <span className="uses" title={`Used ${n} time${n > 1 ? 's' : ''} in autons`}>{n}×</span>}
                {lib.dirty.has(`path:${name}`) && <span className="dirty-dot" title="Saving…" />}
                <span className="row-actions" onClick={e => e.stopPropagation()}>
                  {current && <IconButton icon="addPath" title={`Add to ${current}`} onClick={() => addStep(current, name)} />}
                  <IconButton icon="pencil" title="Rename (every auton follows)" onClick={() => setRenaming({ kind: 'path', name })} />
                  <IconButton icon="x" title="Delete path" onClick={() => lib.deletePath(name)} />
                </span>
              </div>
            );
          })}
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
        <div className="section-head">
          <span>Field</span>
          <span className="head-actions">
            <IconButton icon="grid" title={grid ? 'Hide 6 in grid (G)' : 'Show 6 in grid (G)'} active={grid} onClick={onToggleGrid} />
            <IconButton icon="speed" title={speedColors ? 'Plain ghost trail (V)' : 'Color the ghost trail by speed (V)'}
              active={speedColors} onClick={onToggleSpeedColors} />
          </span>
        </div>
      </div>
    </aside>
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
    width: 'Width', length: 'Length', trackWidth: 'Track', maxSpeed: 'Speed', acceleration: 'Accel',
    maxTurnRate: 'Turn', turnAcceleration: 'Turn accel', clawOffset: 'Claw',
  };
  const changed = ROBOT_FIELDS.some(f => robot[f.key] !== d[f.key]);
  return (
    <>
      {/* always rendered so it can animate closed too; inert while closed so its fields can't be tabbed into */}
      <div className={`drawer ${open ? 'open' : ''}`} inert={!open} aria-hidden={!open}>
        <div className="drawer-inner">
          <div className="grid-2 drawer-body">
            {ROBOT_FIELDS.map(f => (
              <NumberField key={f.key} label={short[f.key]} suffix={f.unit} step={f.step} value={robot[f.key]}
                title={`${f.label} (${f.min}–${f.max} ${f.unit})`}
                onChange={v => v != null && setRobot({ [f.key]: Math.max(f.min, Math.min(f.max, v)) })} />
            ))}
          </div>
        </div>
      </div>
      <div className="section-head">
        <span>Robot</span>
        <span className="head-actions">
          {changed && <IconButton icon="x" title="Back to Crimson's numbers" onClick={() => setRobot({ ...d })} />}
          <IconButton icon="sliders" title="Robot size and speed for the ghost, and the claw offset (used in the code)" active={open} onClick={onToggle} />
        </span>
      </div>
    </>
  );
}
