import type { HeadingAction, MoveParams, PathDefinition, TurnDirection } from '../../editor/types';
import { DEFAULTS } from '../../editor/types';
import type { HistoryMode } from '../../hooks/useLibrary';
import { IconButton } from '../../components/Icon';
import { NumberField, Segmented, Toggle } from '../../components/Controls';
import {
  arrivals, removePoint, resolveParams, shownHeading, updatePathParams, updatePoint, updatePointParams, wrapDeg, type Offsets,
} from '../../editor/pathOps';
import { estimateKey, type Estimates } from '../../editor/codegen';
import { targetById } from '../../editor/targets';

interface Props {
  path: PathDefinition;
  name: string;
  selectedIndex: number | null;
  /** how many points are selected; more than 1 = a box-selected group */
  selectionCount: number;
  onDeleteSelection: () => void;
  update: (def: PathDefinition, mode?: HistoryMode) => void;
  onSelect: (i: number | null) => void;
  duration: number;
  /** editing a step of an auton: its name, and whether the step is turned around */
  auton: { name: string; rotated: boolean; first: boolean; onRotate: (v: boolean) => void } | null;
  /** the ghost's suggested timeouts for this path */
  estimates: Estimates;
  /** the robot's claw and goal offsets (where the robot ends up, so which way the next point is) */
  offsets: Offsets;
}

const show = (v: number | null | undefined, fallback: number | string) => (v != null ? String(v) : String(fallback));
const speed = (v: number | null) => (v == null ? null : Math.max(0, Math.min(127, Math.round(v))));
const positive = (v: number | null) => (v == null ? null : Math.max(0, v));

const ACTIONS: { value: HeadingAction; label: string; title: string }[] = [
  { value: 'pose', label: 'Drive into', title: 'chassis.moveToPose: arrive facing the heading' },
  { value: 'turn', label: 'Turn', title: 'chassis.moveToPoint, then chassis.turnToHeading in place' },
  { value: 'donut', label: 'Donut', title: 'chassis.moveToPoint, then chassis.donut (orbit turn) to the heading' },
];

const DIRECTIONS: { value: TurnDirection; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'The shorter way' },
  { value: 'cw', label: 'CW', title: 'Clockwise' },
  { value: 'ccw', label: 'CCW', title: 'Counterclockwise' },
];

export function Inspector({
  path, name, selectedIndex, selectionCount, onDeleteSelection, update, onSelect, duration, auton, estimates, offsets,
}: Props) {
  const point = selectedIndex != null ? path.points[selectedIndex] : null;
  const pp = path.params ?? {};

  if (selectionCount > 1) {
    return (
      <div className="inspector scroll">
        <div className="section-head">
          <span>Selected <b className="count">{selectionCount}</b></span>
          <IconButton icon="trash" title="Delete selected points (Del)" onClick={onDeleteSelection} />
        </div>
        <div className="pad stack">
          <span className="hint">
            Drag any selected point to move them all. Click empty field, another point, or a heading handle
            to go back to one point. Shift + drag on empty field selects a new group.
          </span>
        </div>
      </div>
    );
  }

  if (!point || selectedIndex == null) {
    const setPath = (patch: Partial<MoveParams>, key: string) => update(updatePathParams(path, patch), key);
    return (
      <div className="inspector scroll">
        <div className="section-head"><span className="ellipsis">Path <b className="count">{name}</b></span></div>
        <div className="pad stack">
          {auton && (
            <div className="row-between" title="This auton drives the path turned 180° about the field centre (the other half of the field). The path itself doesn't change.">
              <span className="field-label">Turned 180° in {auton.name}</span>
              <Toggle checked={auton.rotated} title="Turn this use 180°" onChange={auton.onRotate} />
            </div>
          )}
          <div className="row-between" title="chassis.setPose at point 0 when this path starts">
            <span className="field-label">Set pose at start</span>
            <Toggle checked={!!path.resetPose || !!auton?.first} disabled={!!auton?.first}
              title={auton?.first ? 'The first path of an auton always sets the start pose' : 'Set pose to point 0'}
              onChange={v => update({ ...path, resetPose: v ? true : undefined })} />
          </div>
        </div>
        <div className="section-head sub"><span>Defaults</span></div>
        <div className="pad stack">
          <div className="grid-2">
            <NumberField label="Timeout" suffix="ms" step={100} nullable value={pp.timeout} placeholder="auto"
              title="Every move's timeout. Empty: each move's own estimate from the ghost (its time plus a quarter, plus 100 ms)."
              onChange={v => setPath({ timeout: positive(v) }, 'path-timeout')} />
            <NumberField label="Turn timeout" suffix="ms" step={100} nullable value={pp.turnTimeout} placeholder="auto"
              title="Every turn's and donut's timeout. Empty: each one's estimate from the ghost."
              onChange={v => setPath({ turnTimeout: positive(v) }, 'path-turn')} />
            <NumberField label="Max" suffix="/127" step={5} nullable value={pp.maxSpeed} placeholder="127"
              onChange={v => setPath({ maxSpeed: speed(v) }, 'path-max')} />
            <NumberField label="Min" suffix="/127" step={5} nullable value={pp.minSpeed} placeholder="0"
              onChange={v => setPath({ minSpeed: speed(v) }, 'path-min')} />
            <NumberField label="Exit" suffix="in" nullable value={pp.earlyExitRange} placeholder="off" title="Early exit range"
              onChange={v => setPath({ earlyExitRange: positive(v) }, 'path-exit')} />
          </div>
          <div className="stats">
            <div><b>{duration.toFixed(2)}</b><span>s</span></div>
            <div><b>{Math.max(0, path.points.length - 1)}</b><span>moves</span></div>
          </div>
        </div>
      </div>
    );
  }

  const i = selectedIndex;
  const set = (patch: Parameters<typeof updatePoint>[2], key: string) => update(updatePoint(path, i, patch), `pt-${i}-${key}`);
  const setParam = (patch: Partial<MoveParams>, key: string) => update(updatePointParams(path, i, patch), `pt-${i}-${key}`);
  const del = (
    <IconButton icon="trash" title="Delete point (Del)" onClick={() => {
      update(removePoint(path, i));
      onSelect(null);
    }} />
  );
  // the heading the point really gets: its own, or facing the next point
  const arrival = arrivals(path, offsets)[i];
  const shown = shownHeading(point, arrival, i);
  const hasNext = i < path.points.length - 1;
  const faced = !!arrival?.faced;
  const faceRow = (label: string, title: string) => (
    <div className="row-between" title={hasNext ? title : 'This is the last point of the path, so there is no next point to face'}>
      <span className="field-label">{label}</span>
      <Toggle checked={!!point.faceNext && hasNext} disabled={!hasNext} title={label}
        onChange={v => update(updatePoint(path, i, { faceNext: v ? true : null, ...(v ? {} : { theta: shown ?? point.theta }) }))} />
    </div>
  );
  const spot = targetById(point.target);
  // typing a position takes the point off its goal, pin or loader
  const position = (
    <>
      {spot && (
        <div className="snapped" title={spot.kind === 'goal'
          ? "The robot's centre drives to the goal's centre (it clips into the goal)"
          : "The robot stops with its claw's centre on this spot (Claw offset under Robot)"}>
          <span className="glow-dot" />
          <span className="grow ellipsis">{spot.kind === 'goal' ? `At ${spot.label}` : `Claw on ${spot.label}`}</span>
          <IconButton icon="x" title="Unsnap (keep the position)" onClick={() => update(updatePoint(path, i, { target: null }))} />
        </div>
      )}
      <div className="grid-2">
        <NumberField label="X" suffix="in" value={point.x}
          onChange={v => v != null && set({ x: Math.max(0, Math.min(144, v)), target: null }, 'x')} />
        <NumberField label="Y" suffix="in" value={point.y}
          onChange={v => v != null && set({ y: Math.max(0, Math.min(144, v)), target: null }, 'y')} />
      </div>
    </>
  );

  if (i === 0) {
    return (
      <div className="inspector scroll">
        <div className="section-head">
          <span>Start <b className="count">0</b></span>
          {del}
        </div>
        <div className="pad stack">
          {position}
          <div className="heading-row">
            <Toggle checked={point.theta != null} title="Start heading"
              onChange={on => update(updatePoint(path, i, { theta: on ? 0 : null }))} />
            <NumberField label="Heading" suffix="°" step={5} value={shown} disabled={point.theta == null || faced} placeholder="0"
              title={faced ? 'Facing point 1' : '0 faces red, clockwise'} onChange={v => v != null && set({ theta: wrapDeg(v) }, 'theta')} />
          </div>
          {point.theta != null && faceRow('Face point 1', 'Start facing point 1 (its back, when that move is reversed)')}
          <span className="hint">
            Where the path starts. The robot drives to the points after it.
            {auton?.first ? ' The auton sets its pose here.' : path.resetPose ? ' The path sets the pose here.' : ''}
          </span>
        </div>
      </div>
    );
  }

  const r = resolveParams(pp, point.params);
  const ov = point.params ?? {};
  const isLast = i === path.points.length - 1;
  const heading = point.theta != null;
  const atGoal = spot?.kind === 'goal';
  // a donut orbits the goal the robot is on, so it's only offered there
  const action = point.action === 'donut' && !atGoal ? 'turn' : point.action ?? 'pose';
  const turns = heading && action !== 'pose';
  const est = (call: 'move' | 'slow' | 'turn') => estimates.get(estimateKey(i, call));
  const auto = (given: number | null | undefined, call: 'move' | 'slow' | 'turn', fallback: number) =>
    show(given, est(call) ?? fallback);
  const estHint = (call: 'move' | 'slow' | 'turn') => {
    const e = est(call);
    return e != null ? `Empty: ${e} ms, the ghost's time plus a quarter, plus 100 ms` : 'Empty: no estimate (the ghost never finishes it)';
  };

  return (
    <div className="inspector scroll">
      <div className="section-head">
        <span>Point <b className="count">{i}</b></span>
        {del}
      </div>

      <div className="pad stack">
        {position}
        <div className="heading-row">
          <Toggle checked={heading} title="Heading (off = moveToPoint)"
            onChange={on => update(updatePoint(path, i, { theta: on ? 0 : null }))} />
          <NumberField label="Heading" suffix="°" step={5} value={shown} disabled={!heading || faced} placeholder="—"
            title={faced ? `Facing point ${i + 1}` : '0 faces red, clockwise'} onChange={v => v != null && set({ theta: wrapDeg(v) }, 'theta')} />
        </div>
        {heading && faceRow(`Face the next point (${i + 1})`, action === 'pose'
          ? 'chassis.moveToPose arriving facing the next point (its back, when that move is reversed)'
          : action === 'turn'
            ? 'chassis.turnToPoint toward the next point (its back, when that move is reversed)'
            : 'Donut until the robot faces the next point (its back, when that move is reversed)')}
        {heading && (
          <Segmented label="At the heading" value={action} options={atGoal ? ACTIONS : ACTIONS.filter(a => a.value !== 'donut')}
            onChange={v => update(updatePoint(path, i, { action: v === 'pose' ? null : v }))} />
        )}
        {heading && !atGoal && <span className="hint">Snap the point to a goal to donut there.</span>}
      </div>

      <div className="section-head sub">
        <span>Move <b className="count call-name">{heading && action === 'pose' ? 'moveToPose' : 'moveToPoint'}</b></span>
      </div>
      <div className="pad stack">
        <div className="grid-2">
          <NumberField label="Timeout" suffix="ms" step={100} nullable value={ov.timeout}
            placeholder={auto(pp.timeout, 'move', DEFAULTS.timeout)} title={estHint('move')}
            onChange={v => setParam({ timeout: positive(v) }, 'timeout')} />
          <NumberField label="Exit" suffix="in" nullable value={ov.earlyExitRange} disabled={isLast}
            placeholder={isLast ? 'off' : show(pp.earlyExitRange, 'off')} title={isLast ? 'Last point always arrives' : 'Early exit range'}
            onChange={v => setParam({ earlyExitRange: positive(v) }, 'exit')} />
          <NumberField label="Max" suffix="/127" step={5} nullable value={ov.maxSpeed} placeholder={show(pp.maxSpeed, 127)}
            onChange={v => setParam({ maxSpeed: speed(v) }, 'max')} />
          <NumberField label="Min" suffix="/127" step={5} nullable value={ov.minSpeed} placeholder={show(pp.minSpeed, 0)}
            onChange={v => setParam({ minSpeed: speed(v) }, 'min')} />
        </div>
        <div className="row-between" title="Drive backwards into this point (forwards = false)">
          <span className="field-label">Reverse</span>
          <Toggle checked={r.reverse} title="Drive backwards" onChange={v => setParam({ reverse: v ? true : null }, 'reverse')} />
        </div>
        <div className="field" title="For the last part of the move, a lower max speed: the code waits until that far in, cancels the move and drives the rest slower. Drag the diamond on the field too.">
          <span className="field-label">Slow down for the last</span>
          <div className="event-slider">
            <input type="range" min={0} max={0.95} step={0.05} value={r.slowdown} aria-label="Slow down for the last part of the move"
              onChange={el => {
                const v = Number(el.target.value);
                setParam({ slowdown: v > 0 ? v : null }, 'slowdown');
              }} />
            <span className="num">{Math.round(r.slowdown * 100)}%</span>
          </div>
        </div>
        {r.slowdown > 0 && (
          <div className="grid-2">
            <NumberField label="Slow max" suffix="/127" step={5} nullable value={ov.slowSpeed} placeholder={String(DEFAULTS.slowSpeed)}
              title="Max speed for the slow part" onChange={v => setParam({ slowSpeed: speed(v) }, 'slow-speed')} />
            <div className="readout est" title={estHint('slow')}>
              <span className="field-label">Slow part</span>
              <span className="num">{est('slow') != null ? `≈ ${est('slow')} ms` : '—'}</span>
            </div>
          </div>
        )}
        {atGoal && (
          <div className="row-between" title="chassis.waitUntilDone, then chassis.setPoseFromGoal: the robot is pushed against the goal, so its pose is set from the goal's">
            <span className="field-label">Reset pose from goal</span>
            <Toggle checked={r.goalReset} title="setPoseFromGoal after arriving"
              onChange={v => setParam({ goalReset: v ? null : false }, 'goal-reset')} />
          </div>
        )}
      </div>

      {turns && (
        <>
          <div className="section-head sub">
            <span>{action === 'turn' ? 'Turn' : 'Donut'} <b className="count call-name">{action === 'turn' ? 'turnToHeading' : 'donut'}</b></span>
          </div>
          <div className="pad stack">
            <div className="grid-2">
              <NumberField label="Timeout" suffix="ms" step={100} nullable value={ov.turnTimeout}
                placeholder={auto(pp.turnTimeout, 'turn', DEFAULTS.turnTimeout)}
                title={`Its own timeout, separate from the move's. ${estHint('turn')}`}
                onChange={v => setParam({ turnTimeout: positive(v) }, 'turn-timeout')} />
              <Segmented label="Direction" value={r.turnDirection} options={DIRECTIONS}
                onChange={v => setParam({ turnDirection: v === 'auto' ? null : v }, 'turn-dir')} />
              {action === 'donut' && (
                <>
                  <NumberField label="Fast" suffix="/127" step={5} nullable value={ov.donutFast} placeholder={String(DEFAULTS.donutFast)}
                    title="Outside wheels" onChange={v => setParam({ donutFast: speed(v) }, 'donut-fast')} />
                  <NumberField label="Slow" suffix="/127" step={5} nullable value={ov.donutSlow} placeholder={String(DEFAULTS.donutSlow)}
                    title="Inside wheels" onChange={v => setParam({ donutSlow: speed(v) }, 'donut-slow')} />
                </>
              )}
            </div>
            {action === 'donut' && (
              <div className="row-between" title="Orbit a point behind the robot (forwards = false). Follows Reverse until you set it.">
                <span className="field-label">Orbit behind</span>
                <Toggle checked={r.donutBehind} title="Orbit behind" onChange={v => setParam({ donutBehind: v }, 'donut-behind')} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
