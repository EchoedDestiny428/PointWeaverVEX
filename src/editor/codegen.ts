import type { AutonDefinition, PathDefinition } from './types';
import { DEFAULTS } from './types';
import { actionOf, arrivals, resolveParams, restOf, stepView, wrapDeg, type Offsets, type ResolvedParams } from './pathOps';
import { targetById, where } from './targets';

/**
 * LemLib code for autons and paths (PROS 4 + LemLib 0.5).
 *
 * A point with a heading becomes chassis.moveToPose, one without becomes chassis.moveToPoint. A point that turns
 * (or, at a goal, donuts) at its heading moves with moveToPoint, then turns in place with its own timeout. Point 0
 * is where the path starts, so it never makes a move; it sets the pose when the path (or the auton) starts there.
 *
 * A point at a goal sends the robot's centre to the goal's centre (it clips into the goal), then waits and resets
 * the pose from the goal, goalOffset out from its centre. A point at a pin or loader stops where the claw is on it
 * (see arrivals in pathOps).
 * A slowdown drives the first part of the move, then cancels it and drives the rest at a lower max speed.
 * A heading can face the next point instead: turnToPoint, a donut (or moveToPose) to the heading that faces it.
 * In an auton, every path after the first starts with a move to its point 0, unless the path before already left
 * the robot there (or the path sets its own pose).
 * Timeouts nobody set come from the ghost (estimates); without any, LemLib-ish defaults.
 */

export interface Pose {
  x: number;
  y: number;
  theta: number;
}

/** Maps a field-frame pose to the frame the code is written in (identity for the output; the simulator's own). */
export type FrameMap = (p: Pose) => Pose;

const identity: FrameMap = p => p;

/** What a generated line does, so the ghost's timings can be matched back to it. */
export type CallKind = 'pose' | 'move' | 'slow' | 'turn' | 'reset';

/** Ghost-measured timeouts (ms) for one path's calls, by estimateKey. */
export type Estimates = ReadonlyMap<string, number>;
export const estimateKey = (point: number, call: 'move' | 'slow' | 'turn') => `${point}:${call}`;

export interface CodeOptions extends Offsets {
  /** the estimated timeouts for a path (as stored, before any turn) */
  estimates?: (def: PathDefinition) => Estimates | undefined;
}

/** A number the way it reads best in C++: at most two decimals, no trailing zeros, no -0. */
export function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

const KEYWORDS = new Set(
  ('alignas alignof and asm auto bitand bitor bool break case catch char class compl concept const consteval constexpr '
    + 'constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum '
    + 'explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr '
    + 'operator or private protected public register reinterpret_cast requires return short signed sizeof static '
    + 'static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union '
    + 'unsigned using virtual void volatile wchar_t while xor main run setup chassis').split(' '),
);

/** A path's name as a C++ function name: "Left side 2" -> left_side_2. */
export function cppName(name: string): string {
  let id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!id) id = 'path';
  if (/^[0-9]/.test(id)) id = `path_${id}`;
  if (KEYWORDS.has(id)) id = `${id}_path`;
  return id;
}

/** Where a generated line came from, so a timed-out motion can be pinned on its point. */
export interface LineSource {
  step: number;
  point: number;
  call: CallKind;
}

interface Line {
  text: string;
  source?: LineSource;
}

const params = (entries: [string, string | null][]) => {
  const set = entries.filter((e): e is [string, string] => e[1] != null);
  return set.length ? `, {${set.map(([k, v]) => `.${k} = ${v}`).join(', ')}}` : '';
};

const direction = (d: ResolvedParams['turnDirection']) =>
  d === 'cw' ? 'lemlib::AngularDirection::CW_CLOCKWISE' : d === 'ccw' ? 'lemlib::AngularDirection::CCW_COUNTERCLOCKWISE' : null;

/**
 * code: the output. ghost: for the simulator. measure: the simulator with long timeouts, to time every call for the
 * estimates.
 */
type Mode = 'code' | 'ghost' | 'measure';

const MEASURE_TIMEOUT = 8000;

interface PathOpts {
  setPose: boolean;
  map: FrameMap;
  offsets: Offsets;
  estimates?: Estimates;
  mode: Mode;
  /** the estimated timeout for a lead-in move, timed as a path of its own */
  leadInEstimate?: (alone: PathDefinition) => number | undefined;
}

/** The body of one path: setPose (when asked) and the calls for every point after point 0. */
function pathLines(def: PathDefinition, step: number, opts: PathOpts): Line[] {
  const lines: Line[] = [];
  const pts = def.points;
  const arr = arrivals(def, opts.offsets);
  const { map, mode } = opts;
  const push = (text: string, point: number, call: CallKind) => lines.push({ text, source: { step, point, call } });

  if (pts.length && opts.setPose) {
    const at = map(arr[0]);
    push(`chassis.setPose(${num(at.x)}, ${num(at.y)}, ${num(wrapDeg(at.theta))});`, 0, 'pose');
  }

  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const a = arr[i];
    const r = resolveParams(def.params, p.params);
    const t = targetById(p.target);
    const action = actionOf(p);
    const timeout = (call: 'move' | 'slow' | 'turn') => {
      if (mode === 'measure') return MEASURE_TIMEOUT;
      const set = call === 'turn' ? r.turnTimeout : r.timeout;
      return set ?? opts.estimates?.get(`${i}:${call}`) ?? (call === 'turn' ? DEFAULTS.turnTimeout : DEFAULTS.timeout);
    };
    const facing = a.faced ? `facing point ${i + 1}` : '';
    const comment = [
      !t ? '' : t.kind === 'goal' ? t.label : `claw on ${t.label} ${where(t)}`,
      action === 'pose' ? facing : '',
    ].filter(Boolean).join(', ');
    const to = map({ x: a.x, y: a.y, theta: a.theta });
    const theta = num(wrapDeg(to.theta));
    // the heading after a turn or donut (its own, or the one facing the next point)
    const after = num(wrapDeg(map({ x: a.x, y: a.y, theta: a.final }).theta));
    const move = (maxSpeed: number, ms: number) => {
      const rest = params([
        ['forwards', r.reverse ? 'false' : null],
        ['maxSpeed', maxSpeed !== 127 ? num(maxSpeed) : null],
        ['minSpeed', r.minSpeed !== 0 ? num(r.minSpeed) : null],
        ['earlyExitRange', r.earlyExitRange !== 0 ? num(r.earlyExitRange) : null],
      ]);
      return action === 'pose'
        ? `chassis.moveToPose(${num(to.x)}, ${num(to.y)}, ${theta}, ${num(ms)}${rest});`
        : `chassis.moveToPoint(${num(to.x)}, ${num(to.y)}, ${num(ms)}${rest});`;
    };

    if (r.slowdown > 0) {
      // full speed until the last part, then the same move again, slower
      const from = restOf(arr[i - 1]);
      const cut = (1 - r.slowdown) * Math.hypot(a.x - from.x, a.y - from.y);
      push(`${move(r.maxSpeed, timeout('move'))}${comment ? ` // ${comment}` : ''}`, i, 'move');
      push(`chassis.waitUntil(${num(cut)});`, i, 'move');
      push('chassis.cancelMotion();', i, 'move');
      push(`${move(Math.min(r.maxSpeed, r.slowSpeed), timeout('slow'))} // last ${Math.round(r.slowdown * 100)}%`, i, 'slow');
    } else {
      push(`${move(r.maxSpeed, timeout('move'))}${comment ? ` // ${comment}` : ''}`, i, 'move');
    }

    if (t?.kind === 'goal' && r.goalReset) {
      // the robot can't get to the goal's centre: once it stops against the goal, put it where it really is (the
      // ghost does it too, so it jumps back out of the goal)
      const g = map({ x: t.x, y: t.y, theta: 0 });
      push('chassis.waitUntilDone();', i, 'reset');
      push(`chassis.setPoseFromGoal(${num(g.x)}, ${num(g.y)}${params([
        ['forwards', r.reverse ? null : 'true'],
        ['distance', num(opts.offsets.goalOffset)],
      ])});`, i, 'reset');
    }

    if (action === 'turn' && a.faced) {
      // LemLib aims at the point itself, from wherever the robot really is
      const n = map({ x: pts[i + 1].x, y: pts[i + 1].y, theta: 0 });
      const nextReverse = resolveParams(def.params, pts[i + 1].params).reverse;
      push(`chassis.turnToPoint(${num(n.x)}, ${num(n.y)}, ${num(timeout('turn'))}${params([
        ['forwards', nextReverse ? 'false' : null],
        ['direction', direction(r.turnDirection)],
      ])}); // ${facing}`, i, 'turn');
    } else if (action === 'turn') {
      push(`chassis.turnToHeading(${after}, ${num(timeout('turn'))}${params([['direction', direction(r.turnDirection)]])});`, i, 'turn');
    } else if (action === 'donut') {
      push(`chassis.donut(${after}, ${num(timeout('turn'))}${params([
        ['direction', direction(r.turnDirection)],
        ['forwards', r.donutBehind ? 'false' : null],
        // crimson::DonutParams defaults (prelude-to-chaos: include/motion/chassis.hpp)
        ['fastSpeed', r.donutFast !== DEFAULTS.donutFast ? num(r.donutFast) : null],
        ['slowSpeed', r.donutSlow !== DEFAULTS.donutSlow ? num(r.donutSlow) : null],
      ])});${a.faced ? ` // ${facing}` : ''}`, i, 'turn');
    }
  }
  return lines;
}

const fn = (name: string, body: string[], comment?: string) => [
  ...(comment ? [`// ${comment}`] : []),
  body.length ? `void ${name}() {` : `void ${name}() {}`,
  ...(body.length ? [...body.map(l => `    ${l}`), '}'] : []),
];

const FRAME_NOTE = '// Field frame: (0, 0) is the corner on blue\'s right, +X toward red, heading 0 faces red, clockwise. Inches.';

/** One path on its own, as a function. */
export function pathCode(name: string, def: PathDefinition, opts: CodeOptions): string {
  const body = pathLines(def, 0, {
    setPose: !!def.resetPose, map: identity, offsets: opts, estimates: opts.estimates?.(def), mode: 'code',
  }).map(l => l.text);
  return [`// ${name}, made in PointWeaver.`, FRAME_NOTE, '', ...fn(cppName(name), body)].join('\n') + '\n';
}

/** Where a path leaves the robot (after any reset or donut), and which way it faces. */
function endOf(view: PathDefinition, offsets: Offsets): Pose | null {
  const arr = arrivals(view, offsets);
  const last = arr.at(-1);
  if (!last) return null;
  const at = restOf(last);
  return { x: at.x, y: at.y, theta: last.final };
}

/** Closer than this (in) to where the path before left it, the robot is already at a path's start. */
export const LEAD_IN_GAP = 1;

/**
 * The move to point 0 of a path that follows another in an auton, or nothing when the robot is already there (or
 * the path sets its own pose). It uses point 0's heading (moveToPose) and settings. Its timeout, unless point 0 sets
 * one, is the ghost's estimate for that one move.
 */
function leadIn(from: Pose | null, view: PathDefinition, step: number, opts: PathOpts & { label?: string }): Line[] {
  const p0 = view.points[0];
  if (!from || !p0 || view.resetPose) return [];
  const a0 = arrivals(view, opts.offsets)[0];
  if (Math.hypot(a0.x - from.x, a0.y - from.y) <= LEAD_IN_GAP) return [];
  const r = resolveParams(view.params, p0.params);
  const pose = p0.theta != null;
  let ms = MEASURE_TIMEOUT;
  if (opts.mode !== 'measure') {
    // time it on its own: from where the robot is to point 0
    const alone: PathDefinition = {
      params: view.params,
      points: [{ x: from.x, y: from.y, theta: from.theta }, { x: a0.x, y: a0.y, theta: pose ? a0.theta : null, params: p0.params }],
    };
    ms = r.timeout ?? opts.leadInEstimate?.(alone) ?? DEFAULTS.timeout;
  }
  const to = opts.map({ x: a0.x, y: a0.y, theta: a0.theta });
  const rest = params([
    ['forwards', r.reverse ? 'false' : null],
    ['maxSpeed', r.maxSpeed !== 127 ? num(r.maxSpeed) : null],
    ['minSpeed', r.minSpeed !== 0 ? num(r.minSpeed) : null],
    ['earlyExitRange', r.earlyExitRange !== 0 ? num(r.earlyExitRange) : null],
  ]);
  const text = pose
    ? `chassis.moveToPose(${num(to.x)}, ${num(to.y)}, ${num(wrapDeg(to.theta))}, ${num(ms)}${rest});`
    : `chassis.moveToPoint(${num(to.x)}, ${num(to.y)}, ${num(ms)}${rest});`;
  return [{ text: opts.label ? `${text} // to the start of ${opts.label}` : text, source: { step, point: 0, call: 'move' } }];
}

/**
 * A whole auton: a function for every path it uses (one more, ending in _rot180, for a path it also uses turned
 * around), then run(), which sets the start pose and calls them in order.
 */
export function autonCode(name: string, auton: AutonDefinition, paths: Record<string, PathDefinition>, opts: CodeOptions): string {
  // one C++ name per path name, kept unique even when two names would read the same
  const names = new Map<string, string>();
  const used = new Set<string>();
  const nameOf = (path: string) => {
    let id = names.get(path);
    if (id) return id;
    const base = cppName(path);
    id = base;
    for (let n = 2; used.has(id) || used.has(`${id}_rot180`); n++) id = `${base}_${n}`;
    names.set(path, id);
    used.add(id).add(`${id}_rot180`);
    return id;
  };

  const out: string[] = [`// ${name}, made in PointWeaver.`, FRAME_NOTE];
  const written = new Set<string>();
  const calls: string[] = [];
  let at: Pose | null = null; // where the paths so far leave the robot
  auton.steps.forEach((step, k) => {
    const def = paths[step.path];
    if (!def) {
      calls.push(`// missing path "${step.path}"`);
      return;
    }
    const id = `${nameOf(step.path)}${step.rotate ? '_rot180' : ''}`;
    const view = stepView(def, step);
    calls.push(...leadIn(at, view, k, {
      setPose: false, map: identity, offsets: opts, mode: 'code', label: `${id}()`,
      leadInEstimate: alone => opts.estimates?.(alone)?.get('1:move'),
    }).map(l => l.text));
    calls.push(`${id}();`);
    at = endOf(view, opts) ?? at;
    if (written.has(id)) return;
    written.add(id);
    // the auton's start pose is set in run(), so the first step's own setPose (if any) stays in its function
    const body = pathLines(stepView(def, step), k, {
      setPose: !!def.resetPose, map: identity, offsets: opts, estimates: opts.estimates?.(def), mode: 'code',
    }).map(l => l.text);
    out.push('', ...fn(id, body, step.rotate ? `${step.path}, turned 180 degrees` : step.path));
  });

  const first = auton.steps[0];
  const firstDef = first && paths[first.path];
  const run: string[] = [];
  if (firstDef?.points.length && !firstDef.resetPose) {
    const a = arrivals(stepView(firstDef, first), opts)[0];
    run.push(`chassis.setPose(${num(a.x)}, ${num(a.y)}, ${num(wrapDeg(a.theta))});`);
  }
  run.push(...calls);
  out.push('', ...fn('run', run));
  return out.join('\n') + '\n';
}

/** Steps to simulate: a path and whether it's turned around. */
export interface SimStep {
  def: PathDefinition;
  rotate?: boolean | null;
}

/**
 * The steps as one flat run() for the simulator, in its frame, with the source of every line (1-based numbers).
 * The first step always sets the pose.
 */
export function flatProgram(
  steps: SimStep[],
  map: FrameMap,
  opts: CodeOptions & { measure?: boolean },
): { code: string; sources: Map<number, LineSource> } {
  const lines: Line[] = [];
  let at: Pose | null = null; // where the steps so far leave the robot
  steps.forEach((s, k) => {
    const view = stepView(s.def, s);
    const pathOpts: PathOpts = {
      setPose: k === 0 || !!s.def.resetPose,
      map,
      offsets: opts,
      estimates: opts.estimates?.(s.def),
      mode: opts.measure ? 'measure' : 'ghost',
      leadInEstimate: alone => opts.estimates?.(alone)?.get('1:move'),
    };
    if (k > 0) lines.push(...leadIn(at, view, k, pathOpts));
    lines.push(...pathLines(view, k, pathOpts));
    at = endOf(view, opts) ?? at;
  });
  const sources = new Map<number, LineSource>();
  const code = ['void run() {'];
  for (const l of lines) {
    code.push(`    ${l.text}`);
    if (l.source) sources.set(code.length, l.source);
  }
  code.push('}');
  return { code: code.join('\n') + '\n', sources };
}
