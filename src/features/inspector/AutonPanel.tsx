import { useState } from 'react';
import type { AutonDefinition, PathDefinition } from '../../editor/types';
import type { HistoryMode } from '../../hooks/useLibrary';
import { arrivals, startOf, stepView, type Offsets } from '../../editor/pathOps';
import { Icon, IconButton } from '../../components/Icon';
import { MenuButton } from '../../components/Menu';
import { Toggle } from '../../components/Controls';

interface Props {
  name: string;
  auton: AutonDefinition;
  paths: Record<string, PathDefinition>;
  update: (def: AutonDefinition, mode?: HistoryMode) => void;
  onOpenStep: (k: number) => void;
  hoverStep: number | null;
  onHoverStep: (k: number | null) => void;
  /** new empty path, put into this auton at a position (the end without one) */
  onNewPath: (at?: number) => void;
  /** put a library path in at a position */
  onInsert: (at: number, path: string) => void;
  /** take the path at a position out */
  onRemove: (at: number) => void;
  /** move the path at `from` to `to` */
  onMove: (from: number, to: number) => void;
  duration: number;
  /** steps with a move that timed out in the ghost */
  timeoutSteps: number[];
  /** the robot's claw and goal offsets */
  offsets: Offsets;
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

/** An auton's paths in run order (drag to reorder), and the auton's own settings. */
export function AutonPanel({
  name, auton, paths, update, onOpenStep, hoverStep, onHoverStep, onNewPath, onInsert, onRemove, onMove, duration,
  timeoutSteps, offsets,
}: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const steps = auton.steps;

  const setSteps = (next: AutonDefinition['steps']) => update({ ...auton, steps: next });
  const endDrag = () => {
    setDragFrom(null);
    setDropAt(null);
  };

  const first = steps[0] && paths[steps[0].path];
  const start = first?.points.length ? startOf(arrivals(stepView(first, steps[0]), offsets)[0]) : null;
  const library = Object.keys(paths).sort((a, b) => a.localeCompare(b));
  /** what can go in at a position: a new path, or one from the library */
  const choices = (at: number) => [
    { label: 'New path…', onSelect: () => onNewPath(at) },
    ...(library.length ? [null] : []),
    ...library.map(p => ({ label: p, onSelect: () => onInsert(at, p) })),
  ];

  return (
    <>
      <div className="section-head">
        <span>Paths <b className="count">{steps.length}</b></span>
        <MenuButton icon="plus" title="Add a path at the end" heading="Add at the end" empty="No paths yet"
          items={choices(steps.length)} />
      </div>
      <div className="list scroll points" onMouseLeave={() => onHoverStep(null)}>
        {steps.map((s, k) => {
          const def = paths[s.path];
          // (a path that starts away from where the one before ends is driven to: run() moves to its point 0)
          const warn = !def ? `"${s.path}" is missing` : timeoutSteps.includes(k) ? 'A move times out in the ghost' : null;
          return (
            <div key={k}
              draggable
              className={[
                'list-row step-row',
                k === hoverStep && 'hovered',
                dropAt === k && dragFrom !== null && (dragFrom > k ? 'drop-above' : 'drop-below'),
              ].filter(Boolean).join(' ')}
              onClick={() => def && onOpenStep(k)}
              onMouseEnter={() => onHoverStep(k)}
              onDragStart={e => {
                e.dataTransfer.effectAllowed = 'move';
                setDragFrom(k);
              }}
              onDragOver={e => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDropAt(k);
              }}
              onDrop={e => {
                e.preventDefault();
                if (dragFrom !== null && dragFrom !== k) onMove(dragFrom, k);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
              <span className="idx">{k + 1}</span>
              <span className={`grow ellipsis ${def ? '' : 'missing'}`}>{s.path}</span>
              {warn && <span className="warn-dot" title={warn} />}
              <span className="row-actions" onClick={e => e.stopPropagation()}>
                <MenuButton icon="plus" title={`Insert a path after ${k + 1}`} heading={`Insert after ${k + 1}`}
                  items={choices(k + 1)} />
                <IconButton icon="x" title="Take out of this auton (the path stays in the library)" onClick={() => onRemove(k)} />
              </span>
              <span onClick={e => e.stopPropagation()}>
                <IconButton icon="rotate" active={!!s.rotate}
                  title={s.rotate ? 'Turned 180° (other half of the field). Click to use as drawn.' : 'Turn this use 180° (other half of the field)'}
                  onClick={() => setSteps(steps.map((x, j) => (j === k ? { ...x, rotate: x.rotate ? undefined : true } : x)))} />
              </span>
            </div>
          );
        })}
        {steps.length === 0 && <div className="empty">Add paths with + (or drag one in from the left)</div>}
      </div>

      <div className="inspector scroll">
        <div className="section-head"><span className="ellipsis">Auton <b className="count">{name}</b></span></div>
        <div className="pad stack">
          <div className="row-between" title="Skills runs get 60 s instead of 15 s">
            <span className="field-label">Skills (60 s)</span>
            <Toggle checked={!!auton.skills} title="Skills run" onChange={v => update({ ...auton, skills: v ? true : undefined })} />
          </div>
          <div className="readout" title="chassis.setPose at the start of run(): point 0 of the first path">
            <span className="field-label">Start pose</span>
            <span className="num">{start ? `${fmt(start.x)}, ${fmt(start.y)}, ${fmt(start.theta ?? 0)}°` : '—'}</span>
          </div>
          <div className="stats">
            <div><b>{duration.toFixed(2)}</b><span>s</span></div>
            <div><b>{steps.length}</b><span>paths</span></div>
          </div>
          <span className="hint">
            <Icon name="rotate" size={12} /> turns a use of a path 180° about the field centre, for the other half of the
            field. Editing a path changes it in every auton that uses it.
          </span>
        </div>
      </div>
    </>
  );
}
