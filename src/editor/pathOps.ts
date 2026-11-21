import type { AutonDefinition, AutonStep, HeadingAction, MoveParams, PathDefinition, PathPoint } from './types';
import { DEFAULTS, FIELD_SIZE } from './types';
import { mirrorTarget, targetById } from './targets';

export const round2 = (v: number) => Math.round(v * 100) / 100;
/** Dragged points land on the nearest tenth of an inch. */
export const round1 = (v: number) => Math.round(v * 10) / 10;

export const clampToField = (x: number, y: number, round = round1) => ({
  x: round(Math.max(0, Math.min(FIELD_SIZE, x))),
  y: round(Math.max(0, Math.min(FIELD_SIZE, y))),
});

/** -180 < d <= 180 */
export const wrapDeg = (d: number) => {
  const w = ((((d + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
};

const withPoints = (def: PathDefinition, points: PathPoint[]): PathDefinition => ({ ...def, points });

export function updatePoint(def: PathDefinition, i: number, patch: Partial<PathPoint>): PathDefinition {
  return withPoints(def, def.points.map((p, j) => (j === i ? { ...p, ...patch } : p)));
}

const tidy = (params: MoveParams) => (Object.values(params).every(v => v == null) ? null : params);

export function updatePointParams(def: PathDefinition, i: number, patch: Partial<MoveParams>): PathDefinition {
  return withPoints(def, def.points.map((p, j) => (j === i ? { ...p, params: tidy({ ...(p.params ?? {}), ...patch }) } : p)));
}

export function updatePathParams(def: PathDefinition, patch: Partial<MoveParams>): PathDefinition {
  return { ...def, params: tidy({ ...(def.params ?? {}), ...patch }) };
}

export function insertPoint(def: PathDefinition, index: number, p: PathPoint): PathDefinition {
  const points = [...def.points];
  points.splice(index, 0, p);
  return withPoints(def, points);
}

export function removePoint(def: PathDefinition, index: number): PathDefinition {
  return withPoints(def, def.points.filter((_, j) => j !== index));
}

export function removePoints(def: PathDefinition, indices: number[]): PathDefinition {
  const drop = new Set(indices);
  return withPoints(def, def.points.filter((_, j) => !drop.has(j)));
}

/** Where some points were when a group drag started. */
export type PointStart = { i: number; x: number; y: number };

/** Move a group of points by (dx, dy), clamped so the whole group stays on the field. */
export function offsetPoints(def: PathDefinition, start: PointStart[], dx: number, dy: number): PathDefinition {
  if (start.length === 0) return def;
  const xs = start.map(s => s.x);
  const ys = start.map(s => s.y);
  const ox = Math.max(-Math.min(...xs), Math.min(FIELD_SIZE - Math.max(...xs), dx));
  const oy = Math.max(-Math.min(...ys), Math.min(FIELD_SIZE - Math.max(...ys), dy));
  const moved = new Map(start.map(s => [s.i, { x: round1(s.x + ox), y: round1(s.y + oy), target: null }]));
  return withPoints(def, def.points.map((p, j) => {
    const m = moved.get(j);
    return m ? { ...p, ...m } : p;
  }));
}

export function movePoint(def: PathDefinition, from: number, to: number): PathDefinition {
  const points = [...def.points];
  const [p] = points.splice(from, 1);
  points.splice(to, 0, p);
  return withPoints(def, points);
}

/** New point a foot past the last one, or a start spot by the blue wall. */
export function appendPoint(def: PathDefinition): PathDefinition {
  const last = def.points[def.points.length - 1];
  if (!last) return withPoints(def, [{ x: 18, y: 72, theta: 0 }]);
  return withPoints(def, [...def.points, { ...clampToField(last.x + 12, last.y), theta: null }]);
}

/** Turn the path 180 degrees about the field centre. Doing it twice gives back the same path. */
export function rotate180(def: PathDefinition): PathDefinition {
  return withPoints(def, def.points.map(p => ({
    ...p,
    x: round2(FIELD_SIZE - p.x),
    y: round2(FIELD_SIZE - p.y),
    theta: p.theta != null ? wrapDeg(p.theta + 180) : p.theta,
    ...(p.target ? { target: mirrorTarget(p.target) } : {}),
  })));
}

/** A step's path as the auton drives it (turned when the step says so). */
export const stepView = (def: PathDefinition, step: Pick<AutonStep, 'rotate'>) => (step.rotate ? rotate180(def) : def);

/**
 * A point's settings with the path's defaults and LemLib's filled in. Timeouts stay null when neither sets one:
 * the code then uses the ghost's estimate.
 */
export function resolveParams(path: MoveParams | null | undefined, point: MoveParams | null | undefined) {
  const pick = <K extends keyof MoveParams>(k: K) => point?.[k] ?? path?.[k] ?? null;
  const reverse = pick('reverse') ?? false;
  return {
    timeout: pick('timeout'),
    reverse,
    maxSpeed: pick('maxSpeed') ?? DEFAULTS.maxSpeed,
    minSpeed: pick('minSpeed') ?? DEFAULTS.minSpeed,
    earlyExitRange: pick('earlyExitRange') ?? DEFAULTS.earlyExitRange,
    turnTimeout: pick('turnTimeout'),
    turnDirection: pick('turnDirection') ?? 'auto',
    donutFast: pick('donutFast') ?? DEFAULTS.donutFast,
    donutSlow: pick('donutSlow') ?? DEFAULTS.donutSlow,
    donutBehind: pick('donutBehind') ?? reverse,
    // per point only
    slowdown: Math.max(0, Math.min(0.95, point?.slowdown ?? 0)),
    slowSpeed: point?.slowSpeed ?? DEFAULTS.slowSpeed,
    goalReset: point?.goalReset ?? true,
  };
}

export type ResolvedParams = ReturnType<typeof resolveParams>;

/** How far a step's start is from where the step before it ends (in), or null for the first step. */
export function stepGap(auton: AutonDefinition, paths: Record<string, PathDefinition>, k: number): number | null {
  if (k <= 0) return null;
  const prev = paths[auton.steps[k - 1]?.path];
  const cur = paths[auton.steps[k]?.path];
  if (!prev?.points.length || !cur?.points.length) return null;
  const a = stepView(prev, auton.steps[k - 1]).points.at(-1)!;
  const b = stepView(cur, auton.steps[k]).points[0];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** What a point does with its heading (null without one). A donut needs a goal, so anywhere else it's a turn. */
export function actionOf(p: PathPoint): HeadingAction | null {
  if (p.theta == null) return null;
  const a = p.action ?? 'pose';
  return a === 'donut' && targetById(p.target)?.kind !== 'goal' ? 'turn' : a;
}

/** Unit vector a heading faces (0 = +X, clockwise). */
export const headingVector = (theta: number) => {
  const r = (theta * Math.PI) / 180;
  return { x: Math.cos(r), y: -Math.sin(r) };
};

/** Heading of a direction (0 = +X, clockwise). */
export const headingOf = (dx: number, dy: number) => wrapDeg((Math.atan2(-dy, dx) * 180) / Math.PI);

export interface Arrival {
  /** where the robot's centre is sent */
  x: number;
  y: number;
  /** which way the robot faces when it gets there (before any turn) */
  theta: number;
}

/**
 * Where the robot's centre goes for each point, and which way it faces there. A goal point sends the centre to the
 * goal; a pin or loader point stops short so the claw (clawOffset in front of the centre) is on the spot, facing the
 * point's heading (moveToPose) or the way it drives in.
 */
export function arrivals(def: PathDefinition, clawOffset: number): Arrival[] {
  const out: Arrival[] = [];
  def.points.forEach((p, i) => {
    const prev = out[i - 1];
    const r = resolveParams(def.params, p.params);
    let theta: number;
    if (p.theta != null && (i === 0 || actionOf(p) === 'pose')) theta = p.theta;
    else if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-6) theta = wrapDeg(headingOf(p.x - prev.x, p.y - prev.y) + (r.reverse ? 180 : 0));
    else theta = p.theta ?? prev?.theta ?? 0;
    const t = targetById(p.target);
    if (!t || t.kind === 'goal' || clawOffset <= 0) {
      out.push({ x: p.x, y: p.y, theta });
      return;
    }
    // claw on the spot: the centre stops clawOffset behind it, along the way the robot faces as it arrives
    const f = headingVector(theta);
    out.push({ x: p.x - f.x * clawOffset, y: p.y - f.y * clawOffset, theta });
  });
  return out;
}
