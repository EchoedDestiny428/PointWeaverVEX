import type { HeadingAction, MoveParams, PathDefinition, TurnDirection } from '../../editor/types';
import { DEFAULTS } from '../../editor/types';
import type { HistoryMode } from '../../hooks/useLibrary';
import { IconButton } from '../../components/Icon';
import { NumberField, Segmented, Toggle } from '../../components/Controls';
import { removePoint, resolveParams, updatePathParams, updatePoint, updatePointParams, wrapDeg } from '../../editor/pathOps';

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

export function Inspector({ path, name, selectedIndex, selectionCount, onDeleteSelection, update, onSelect, duration, auton }: Props) {
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
            <NumberField label="Timeout" suffix="ms" step={100} nullable value={pp.timeout} placeholder={String(DEFAULTS.timeout)}
              title="Each move's timeout" onChange={v => setPath({ timeout: positive(v) }, 'path-timeout')} />
            <NumberField label="Turn timeout" suffix="ms" step={100} nullable value={pp.turnTimeout} placeholder={String(DEFAULTS.turnTimeout)}
              title="Each turn's or donut's timeout" onChange={v => setPath({ turnTimeout: positive(v) }, 'path-turn')} />
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
  const position = (
    <div className="grid-2">
      <NumberField label="X" suffix="in" value={point.x} onChange={v => v != null && set({ x: Math.max(0, Math.min(144, v)) }, 'x')} />
      <NumberField label="Y" suffix="in" value={point.y} onChange={v => v != null && set({ y: Math.max(0, Math.min(144, v)) }, 'y')} />
    </div>
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
            <NumberField label="Heading" suffix="°" step={5} value={point.theta} disabled={point.theta == null} placeholder="0"
              title="0 faces red, clockwise" onChange={v => v != null && set({ theta: wrapDeg(v) }, 'theta')} />
          </div>
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
  const action = point.action ?? 'pose';
  const turns = heading && action !== 'pose';

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
          <NumberField label="Heading" suffix="°" step={5} value={point.theta} disabled={!heading} placeholder="—"
            title="0 faces red, clockwise" onChange={v => v != null && set({ theta: wrapDeg(v) }, 'theta')} />
        </div>
        {heading && (
          <Segmented label="At the heading" value={action} options={ACTIONS}
            onChange={v => update(updatePoint(path, i, { action: v === 'pose' ? null : v }))} />
        )}
      </div>

      <div className="section-head sub">
        <span>Move <b className="count call-name">{heading && action === 'pose' ? 'moveToPose' : 'moveToPoint'}</b></span>
      </div>
      <div className="pad stack">
        <div className="grid-2">
          <NumberField label="Timeout" suffix="ms" step={100} nullable value={ov.timeout} placeholder={show(pp.timeout, DEFAULTS.timeout)}
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
      </div>

      {turns && (
        <>
          <div className="section-head sub">
            <span>{action === 'turn' ? 'Turn' : 'Donut'} <b className="count call-name">{action === 'turn' ? 'turnToHeading' : 'donut'}</b></span>
          </div>
          <div className="pad stack">
            <div className="grid-2">
              <NumberField label="Timeout" suffix="ms" step={100} nullable value={ov.turnTimeout} placeholder={show(pp.turnTimeout, DEFAULTS.turnTimeout)}
                title="Its own timeout, separate from the move's" onChange={v => setParam({ turnTimeout: positive(v) }, 'turn-timeout')} />
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
