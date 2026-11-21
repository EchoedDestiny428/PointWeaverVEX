import type { AutonDefinition, PathDefinition, PathPoint } from './types';
import { resolveParams, stepView, wrapDeg, type ResolvedParams } from './pathOps';

/**
 * LemLib code for autons and paths (PROS 4 + LemLib 0.5).
 *
 * A point with a heading becomes chassis.moveToPose, one without becomes chassis.moveToPoint. A point that turns
 * (or donuts) at its heading moves with moveToPoint, then turns in place with its own timeout. Point 0 is where the
 * path starts, so it never makes a move; it sets the pose when the path (or the auton) starts there.
 */

export interface Pose {
  x: number;
  y: number;
  theta: number;
}

/** Maps a field-frame pose to the frame the code is written in (identity for the output; the simulator's own). */
export type FrameMap = (p: Pose) => Pose;

const identity: FrameMap = p => p;

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

/** The calls for driving to one point (and turning there). */
function pointCalls(p: PathPoint, r: ResolvedParams, map: FrameMap): string[] {
  const at = map({ x: p.x, y: p.y, theta: p.theta ?? 0 });
  const heading = p.theta != null;
  const action = p.action ?? 'pose';
  const move = params([
    ['forwards', r.reverse ? 'false' : null],
    ['maxSpeed', r.maxSpeed !== 127 ? num(r.maxSpeed) : null],
    ['minSpeed', r.minSpeed !== 0 ? num(r.minSpeed) : null],
    ['earlyExitRange', r.earlyExitRange !== 0 ? num(r.earlyExitRange) : null],
  ]);
  const theta = num(wrapDeg(at.theta));
  if (heading && action === 'pose') {
    return [`chassis.moveToPose(${num(at.x)}, ${num(at.y)}, ${theta}, ${num(r.timeout)}${move});`];
  }
  const out = [`chassis.moveToPoint(${num(at.x)}, ${num(at.y)}, ${num(r.timeout)}${move});`];
  if (heading && action === 'turn') {
    out.push(`chassis.turnToHeading(${theta}, ${num(r.turnTimeout)}${params([['direction', direction(r.turnDirection)]])});`);
  } else if (heading && action === 'donut') {
    out.push(`chassis.donut(${theta}, ${num(r.turnTimeout)}${params([
      ['direction', direction(r.turnDirection)],
      ['forwards', r.donutBehind ? 'false' : null],
      ['fastSpeed', num(r.donutFast)],
      ['slowSpeed', num(r.donutSlow)],
    ])});`);
  }
  return out;
}

const setPose = (p: PathPoint, map: FrameMap) => {
  const at = map({ x: p.x, y: p.y, theta: p.theta ?? 0 });
  return `chassis.setPose(${num(at.x)}, ${num(at.y)}, ${num(wrapDeg(at.theta))});`;
};

/** The body of one path: setPose (when asked) and a move for every point after point 0. */
function pathLines(def: PathDefinition, step: number, opts: { setPose: boolean; map: FrameMap }): Line[] {
  const lines: Line[] = [];
  const pts = def.points;
  if (pts.length && opts.setPose) lines.push({ text: setPose(pts[0], opts.map), source: { step, point: 0 } });
  for (let i = 1; i < pts.length; i++) {
    const r = resolveParams(def.params, pts[i].params);
    for (const text of pointCalls(pts[i], r, opts.map)) lines.push({ text, source: { step, point: i } });
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
export function pathCode(name: string, def: PathDefinition): string {
  const body = pathLines(def, 0, { setPose: !!def.resetPose, map: identity }).map(l => l.text);
  return [`// ${name}, made in PointWeaver.`, FRAME_NOTE, '', ...fn(cppName(name), body)].join('\n') + '\n';
}

/**
 * A whole auton: a function for every path it uses (one more, ending in _rot180, for a path it also uses turned
 * around), then run(), which sets the start pose and calls them in order.
 */
export function autonCode(name: string, auton: AutonDefinition, paths: Record<string, PathDefinition>): string {
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
  auton.steps.forEach((step, k) => {
    const def = paths[step.path];
    if (!def) {
      calls.push(`// missing path "${step.path}"`);
      return;
    }
    const id = `${nameOf(step.path)}${step.rotate ? '_rot180' : ''}`;
    calls.push(`${id}();`);
    if (written.has(id)) return;
    written.add(id);
    const view = stepView(def, step);
    // the auton's start pose is set in run(), so the first step's own setPose (if any) stays in its function
    const body = pathLines(view, k, { setPose: !!def.resetPose, map: identity }).map(l => l.text);
    out.push('', ...fn(id, body, step.rotate ? `${step.path}, turned 180 degrees` : step.path));
  });

  const first = auton.steps[0];
  const firstDef = first && paths[first.path];
  const run: string[] = [];
  if (firstDef?.points.length && !firstDef.resetPose) run.push(setPose(stepView(firstDef, first).points[0], identity));
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
export function flatProgram(steps: SimStep[], map: FrameMap): { code: string; sources: Map<number, LineSource> } {
  const lines: Line[] = [];
  steps.forEach((s, k) => {
    lines.push(...pathLines(stepView(s.def, s), k, { setPose: k === 0 || !!s.def.resetPose, map }));
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
