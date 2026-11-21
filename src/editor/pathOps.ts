import type { AutonDefinition, AutonStep, MoveParams, PathDefinition, PathPoint } from './types';
import { DEFAULTS, FIELD_SIZE } from './types';

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
  const moved = new Map(start.map(s => [s.i, { x: round1(s.x + ox), y: round1(s.y + oy) }]));
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
  })));
}

/** A step's path as the auton drives it (turned when the step says so). */
export const stepView = (def: PathDefinition, step: Pick<AutonStep, 'rotate'>) => (step.rotate ? rotate180(def) : def);

/** A point's settings with the path's defaults and LemLib's filled in. */
export function resolveParams(path: MoveParams | null | undefined, point: MoveParams | null | undefined) {
  const pick = <K extends keyof MoveParams>(k: K) => point?.[k] ?? path?.[k] ?? null;
  const reverse = pick('reverse') ?? false;
  return {
    timeout: pick('timeout') ?? DEFAULTS.timeout,
    reverse,
    maxSpeed: pick('maxSpeed') ?? DEFAULTS.maxSpeed,
    minSpeed: pick('minSpeed') ?? DEFAULTS.minSpeed,
    earlyExitRange: pick('earlyExitRange') ?? DEFAULTS.earlyExitRange,
    turnTimeout: pick('turnTimeout') ?? DEFAULTS.turnTimeout,
    turnDirection: pick('turnDirection') ?? 'auto',
    donutFast: pick('donutFast') ?? DEFAULTS.donutFast,
    donutSlow: pick('donutSlow') ?? DEFAULTS.donutSlow,
    donutBehind: pick('donutBehind') ?? reverse,
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
