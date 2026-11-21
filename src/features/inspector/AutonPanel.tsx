import { useState } from 'react';
import type { AutonDefinition, PathDefinition } from '../../editor/types';
import type { HistoryMode } from '../../hooks/useLibrary';
import { arrivals, stepGap, stepView, type Offsets } from '../../editor/pathOps';
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
  /** new empty path, added to the end of this auton */
  onNewPath: () => void;
  duration: number;
  /** steps with a move that timed out in the ghost */
  timeoutSteps: number[];
  /** the robot's claw and goal offsets */
  offsets: Offsets;
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

/** An auton's paths in run order (drag to reorder), and the auton's own settings. */
export function AutonPanel({
  name, auton, paths, update, onOpenStep, hoverStep, onHoverStep, onNewPath, duration, timeoutSteps, offsets,
}: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const steps = auton.steps;

  const setSteps = (next: AutonDefinition['steps']) => update({ ...auton, steps: next });
  const move = (from: number, to: number) => {
    const next = [...steps];
    const [s] = next.splice(from, 1);
    next.splice(to, 0, s);
    setSteps(next);
  };
  const endDrag = () => {
    setDragFrom(null);
    setDropAt(null);
  };

  const first = steps[0] && paths[steps[0].path];
  const start = first?.points.length ? arrivals(stepView(first, steps[0]), offsets)[0] : null;
  const library = Object.keys(paths).sort((a, b) => a.localeCompare(b));

  return (
    <>
      <div className="section-head">
        <span>Paths <b className="count">{steps.length}</b></span>
        <MenuButton icon="plus" title="Add a path" empty="No paths yet"
          items={[
            { label: 'New path…', onSelect: onNewPath },
            ...(library.length ? [null] : []),
            ...library.map(p => ({ label: p, onSelect: () => setSteps([...steps, { path: p }]) })),
          ]} />
      </div>
      <div className="list scroll points" onMouseLeave={() => onHoverStep(null)}>
        {steps.map((s, k) => {
          const def = paths[s.path];
          const gap = stepGap(auton, paths, k, offsets);
          const warn = !def ? `"${s.path}" is missing` : gap != null && gap > 1
            ? `Starts ${fmt(gap)} in from where path ${k} ends` : timeoutSteps.includes(k) ? 'A move times out in the ghost' : null;
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
                if (dragFrom !== null && dragFrom !== k) move(dragFrom, k);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
              <span className="idx">{k + 1}</span>
              <span className={`grow ellipsis ${def ? '' : 'missing'}`}>{s.path}</span>
              {warn && <span className="warn-dot" title={warn} />}
              <span className="row-actions" onClick={e => e.stopPropagation()}>
                <IconButton icon="x" title="Take out of this auton (the path stays in the library)"
                  onClick={() => setSteps(steps.filter((_, j) => j !== k))} />
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
