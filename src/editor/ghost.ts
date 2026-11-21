import { DEFAULT_FIELD } from '../field';
import { CRIMSON_PROFILE } from '../profiles/crimson';
import type { RobotConfig } from '../robot/config';
import { parseCpp, pickRoutine } from '../program/cppParser';
import { simulate } from '../sim/runtime';
import { estimateKey, flatProgram, type Estimates, type FrameMap, type LineSource, type Pose, type SimStep } from './codegen';
import type { PathDefinition } from './types';
import { FIELD_SIZE } from './types';

/**
 * The ghost: the steps run through PointWeaver's LemLib simulator.
 *
 * The simulator works in LemLib's default frame on the Override field as drawn in src/field (origin at the field
 * centre, red on the left, heading 0 = +Y, clockwise). Crimson's frame is that turned 180 degrees with the origin
 * moved to the corner, and its heading 0 faces +X, so: x = 72 - X, y = 72 - Y, heading = H - 90.
 */
const HALF = FIELD_SIZE / 2;
export const toSimFrame: FrameMap = p => ({ x: HALF - p.x, y: HALF - p.y, theta: p.theta - 90 });
export const fromSimFrame: FrameMap = p => ({ x: HALF - p.x, y: HALF - p.y, theta: p.theta + 90 });

export interface GhostPose extends Pose {
  t: number;
  /** in/s */
  speed: number;
}

export interface Ghost {
  poses: GhostPose[];
  /** s */
  duration: number;
  /** moves that hit their timeout: which step and point */
  timeouts: LineSource[];
}

export const EMPTY_GHOST: Ghost = { poses: [], duration: 0, timeouts: [] };

/** Every simulated frame is kept up to this rate; the drawn trail and playback don't need more. */
const KEEP_EVERY_S = 0.02;

const run = (code: string, robot: RobotConfig, periodSeconds: number) => {
  const routine = pickRoutine(parseCpp(code));
  if (!routine) return null;
  return simulate(routine.body, {
    field: DEFAULT_FIELD,
    profile: CRIMSON_PROFILE,
    robot,
    mechanismOverrides: {},
    periodSeconds,
    obstacles: { walls: false, goals: false, loaders: false, elements: false },
  });
};

/** A suggested timeout from a call's ghost time: a quarter more, plus 100 ms, rounded up to 50 ms. */
export const estimateFromSeconds = (seconds: number) => Math.ceil((seconds * 1000 * 1.25 + 100) / 50) * 50;

const estimateCache = new WeakMap<PathDefinition, { robot: RobotConfig; estimates: Estimates }>();

/**
 * How long each call of a path takes in the ghost (as a suggested timeout, ms), run on its own from point 0 with
 * long timeouts. Calls that never finish get no estimate. Cached per path object and robot.
 */
export function estimatesFor(def: PathDefinition, robot: RobotConfig): Estimates {
  const hit = estimateCache.get(def);
  if (hit && hit.robot === robot) return hit.estimates;
  const estimates = new Map<string, number>();
  if (def.points.length > 1) {
    const { code, sources } = flatProgram([{ def }], toSimFrame, { clawOffset: robot.clawOffset, measure: true });
    const sim = run(code, robot, 300);
    for (const e of sim?.timeline ?? []) {
      const src = sources.get(e.line);
      if (e.kind !== 'motion' || !src || (e.status !== 'done' && e.status !== 'cancelled')) continue;
      if (src.call !== 'move' && src.call !== 'slow' && src.call !== 'turn') continue;
      estimates.set(estimateKey(src.point, src.call), estimateFromSeconds(e.end - e.start));
    }
  }
  estimateCache.set(def, { robot, estimates });
  return estimates;
}

export function simulateSteps(steps: SimStep[], robot: RobotConfig, periodSeconds: number): Ghost {
  if (!steps.some(s => s.def.points.length > 1)) return EMPTY_GHOST;
  const { code, sources } = flatProgram(steps, toSimFrame, {
    clawOffset: robot.clawOffset,
    estimates: def => estimatesFor(def, robot),
  });
  // let it run past the time limit so the whole path shows; the toolbar says when it's over
  const sim = run(code, robot, Math.max(periodSeconds * 4, 120));
  if (!sim) return EMPTY_GHOST;

  const every = Math.max(1, Math.round(KEEP_EVERY_S / sim.dt));
  const poses: GhostPose[] = [];
  const last = sim.frameCount - 1;
  for (let i = 0; i <= last; i += every) {
    const p = fromSimFrame({ x: sim.x[i], y: sim.y[i], theta: sim.theta[i] });
    const prev = poses.at(-1);
    const t = i * sim.dt;
    const speed = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / (t - prev.t) : 0;
    poses.push({ ...p, t, speed });
    if (i < last && i + every > last) i = last - every; // always keep the final frame
  }

  const timeouts = sim.timeline
    .filter(e => e.status === 'timeout' && sources.has(e.line))
    .map(e => sources.get(e.line)!);
  return { poses, duration: poses.at(-1)?.t ?? 0, timeouts };
}

/** The ghost's pose at time t (s), between frames. */
export function poseAt(ghost: Ghost, t: number): Pose | null {
  const ps = ghost.poses;
  if (!ps.length) return null;
  if (t <= 0) return ps[0];
  if (t >= ghost.duration) return ps[ps.length - 1];
  let lo = 0;
  let hi = ps.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ps[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = ps[lo];
  const b = ps[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  let dTheta = b.theta - a.theta;
  dTheta -= Math.round(dTheta / 360) * 360;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, theta: a.theta + dTheta * f };
}
