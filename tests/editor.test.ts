import { describe, expect, it } from 'vitest';
import { CRIMSON_PROFILE } from '../src/profiles/crimson';
import { autonCode, cppName, flatProgram, num, pathCode, type CodeOptions } from '../src/editor/codegen';
import { estimateFromSeconds, estimatesFor, fromSimFrame, poseAt, simulateSteps, toSimFrame } from '../src/editor/ghost';
import { arrivals, resolveParams, rotate180, stepGap, wrapDeg } from '../src/editor/pathOps';
import { mirrorTarget, targetById } from '../src/editor/targets';
import type { AutonDefinition, PathDefinition } from '../src/editor/types';

const robot = CRIMSON_PROFILE.robot;
const opts: CodeOptions = { clawOffset: 6.3, goalOffset: 7.5 };

const path = (points: PathDefinition['points'], extra: Partial<PathDefinition> = {}): PathDefinition => ({
  points,
  params: null,
  ...extra,
});

describe('names and numbers', () => {
  it('turns path names into C++ names', () => {
    expect(cppName('Left side 2')).toBe('left_side_2');
    expect(cppName('  goal-rush  ')).toBe('goal_rush');
    expect(cppName('2 ball')).toBe('path_2_ball');
    expect(cppName('run')).toBe('run_path');
    expect(cppName('---')).toBe('path');
  });

  it('writes short numbers', () => {
    expect(num(24)).toBe('24');
    expect(num(24.456)).toBe('24.46');
    expect(num(-0.001)).toBe('0');
    expect(wrapDeg(270)).toBe(-90);
    expect(wrapDeg(-180)).toBe(180);
  });
});

describe('path operations', () => {
  it('turns a path 180 degrees about the field centre and back', () => {
    const p = path([{ x: 18, y: 72, theta: 0 }, { x: 48, y: 24, theta: null }]);
    const r = rotate180(p);
    expect(r.points).toEqual([{ x: 126, y: 72, theta: 180 }, { x: 96, y: 120, theta: null }]);
    expect(rotate180(r).points).toEqual(p.points);
  });

  it('fills settings from the point, then the path, then LemLib', () => {
    const r = resolveParams({ timeout: 1500, maxSpeed: 90 }, { maxSpeed: 60, reverse: true });
    // timeouts nobody set stay empty: the code fills them from the ghost's estimates
    expect(r).toMatchObject({ timeout: 1500, maxSpeed: 60, minSpeed: 0, reverse: true, turnTimeout: null, donutBehind: true });
  });

  it('measures the gap between steps', () => {
    const paths = { a: path([{ x: 0, y: 0 }, { x: 10, y: 0 }]), b: path([{ x: 10, y: 3 }, { x: 20, y: 0 }]) };
    const auton: AutonDefinition = { steps: [{ path: 'a' }, { path: 'b' }] };
    expect(stepGap(auton, paths, 0, opts)).toBeNull();
    expect(stepGap(auton, paths, 1, opts)).toBeCloseTo(3);
  });

  it('places goals, pins and loaders in the Crimson frame and pairs them across the field', () => {
    expect(targetById('goal-blue-2')).toMatchObject({ kind: 'goal', x: 24, y: 48, label: 'blue goal 2' });
    expect(targetById('goal-red-3')).toMatchObject({ x: 96, y: 120 });
    expect(targetById('cup-yellow-2')).toMatchObject({ kind: 'pin', x: 48, y: 48 });
    expect(targetById('loader-red-top')?.x).toBeGreaterThan(140);
    expect(mirrorTarget('goal-blue-2')).toBe('goal-red-2');
    expect(mirrorTarget('goal-1a')).toBe('goal-1b');
    expect(mirrorTarget('cup-pin-top')).toBe('cup-pin-bottom');
    expect(mirrorTarget('loader-red-top')).toBe('loader-blue-bottom');
    // crosses and plain wall cups aren't claw spots
    expect(targetById('cross-1')).toBeNull();
    expect(targetById('wall-cup-0-a')).toBeNull();
  });

  it('keeps a turned path on the matching spots', () => {
    const p = path([{ x: 18, y: 72, theta: 0 }, { x: 24, y: 48, target: 'goal-blue-2' }]);
    expect(rotate180(p).points[1]).toMatchObject({ x: 120, y: 96, target: 'goal-red-2' });
    expect(rotate180(rotate180(p)).points).toEqual(p.points);
  });

  it('stops short of a pin so the claw is on it', () => {
    // driving straight at it along +X: the centre stops one claw offset before it
    const straight = arrivals(path([{ x: 18, y: 48, theta: 0 }, { x: 48, y: 48, target: 'cup-yellow-2' }]), opts);
    expect(straight[1].x).toBeCloseTo(41.7);
    expect(straight[1].y).toBeCloseTo(48);
    // arriving at heading -90 (facing +Y): the centre is below the pin
    const posed = arrivals(path([{ x: 18, y: 30, theta: 0 }, { x: 48, y: 48, theta: -90, target: 'cup-yellow-2' }]), opts);
    expect(posed[1].x).toBeCloseTo(48);
    expect(posed[1].y).toBeCloseTo(41.7);
    // goals take the centre all the way in
    expect(arrivals(path([{ x: 18, y: 48 }, { x: 24, y: 48, target: 'goal-blue-2' }]), opts)[1]).toMatchObject({ x: 24, y: 48 });
  });

  it('puts the robot goalOffset out from a goal after the reset, on the side it came in', () => {
    // driving +X into the goal: it ends 7.5 in short of the centre, facing it
    const fwd = arrivals(path([{ x: 0, y: 48 }, { x: 24, y: 48, target: 'goal-blue-2' }]), opts)[1];
    expect(fwd.rest!.x).toBeCloseTo(16.5);
    expect(fwd.rest!.y).toBeCloseTo(48);
    // backing in from above: still on the side it came from
    const back = arrivals(path([{ x: 24, y: 80 }, { x: 24, y: 48, target: 'goal-blue-2', params: { reverse: true } }]), opts)[1];
    expect(back.rest!.x).toBeCloseTo(24);
    expect(back.rest!.y).toBeCloseTo(55.5);
    // no reset, no rest spot
    const off = arrivals(path([{ x: 0, y: 48 }, { x: 24, y: 48, target: 'goal-blue-2', params: { goalReset: false } }]), opts)[1];
    expect(off.rest).toBeUndefined();
  });

  it("measures the gap between steps from where a goal reset leaves the robot", () => {
    const paths = {
      a: path([{ x: 0, y: 48 }, { x: 24, y: 48, target: 'goal-blue-2' }]),
      b: path([{ x: 16.5, y: 48 }, { x: 16.5, y: 80 }]),
    };
    expect(stepGap({ steps: [{ path: 'a' }, { path: 'b' }] }, paths, 1, opts)).toBeCloseTo(0);
  });
});

describe('code', () => {
  const score = path([
    { x: 18, y: 72, theta: 0 },
    { x: 48, y: 72, theta: null },
    { x: 48, y: 48, theta: -90, params: { reverse: true, maxSpeed: 90, earlyExitRange: 4 } },
    { x: 36, y: 40, theta: 180, action: 'turn', params: { turnTimeout: 800, turnDirection: 'cw' } },
    { x: 48, y: 24, target: 'goal-blue-3', theta: 90, action: 'donut', params: { donutFast: 127, donutSlow: 30, reverse: true } },
  ], { params: { timeout: 1500 } });

  it('uses moveToPose for a heading and moveToPoint without one, and resets at a goal before a donut', () => {
    expect(pathCode('Score', score, opts)).toBe([
      '// Score, made in PointWeaver.',
      "// Field frame: (0, 0) is the corner on blue's right, +X toward red, heading 0 faces red, clockwise. Inches.",
      '',
      'void score() {',
      '    chassis.moveToPoint(48, 72, 1500);',
      '    chassis.moveToPose(48, 48, -90, 1500, {.forwards = false, .maxSpeed = 90, .earlyExitRange = 4});',
      '    chassis.moveToPoint(36, 40, 1500);',
      '    chassis.turnToHeading(180, 800, {.direction = lemlib::AngularDirection::CW_CLOCKWISE});',
      '    chassis.moveToPoint(48, 24, 1500, {.forwards = false}); // blue goal 3',
      '    chassis.waitUntilDone();',
      '    chassis.setPoseFromGoal(48, 24, {.distance = 7.5});',
      '    chassis.donut(90, 1000, {.forwards = false, .fastSpeed = 127, .slowSpeed = 30});',
      '}',
      '',
    ].join('\n'));
  });

  it('only donuts at a goal, and can skip the goal reset', () => {
    const p = path([
      { x: 18, y: 72, theta: 0 },
      { x: 30, y: 72, theta: 90, action: 'donut' },
      { x: 24, y: 48, target: 'goal-blue-2', params: { goalReset: false } },
      { x: 30, y: 30, target: 'goal-blue-2' },
    ]);
    const code = pathCode('p', p, opts);
    expect(code).toContain('    chassis.moveToPoint(30, 72, 2000);\n    chassis.turnToHeading(90, 1000);');
    expect(code).toContain('    chassis.moveToPoint(24, 48, 2000); // blue goal 2\n    chassis.moveToPoint(30, 30, 2000); // blue goal 2');
    // driving forwards into a goal puts it in front of the robot
    expect(code).toContain('    chassis.waitUntilDone();\n    chassis.setPoseFromGoal(24, 48, {.forwards = true, .distance = 7.5});');
    expect(code.match(/setPoseFromGoal/g)).toHaveLength(1);
  });

  it("leaves crimson::DonutParams' default speeds out", () => {
    const p = path([{ x: 18, y: 72, theta: 0 }, { x: 24, y: 48, target: 'goal-blue-2', theta: 90, action: 'donut' }]);
    expect(pathCode('p', p, opts)).toContain('    chassis.donut(90, 1000);');
  });

  it('puts the claw on a pin or loader', () => {
    const p = path([{ x: 18, y: 48, theta: 0 }, { x: 48, y: 48, target: 'cup-yellow-2' }]);
    expect(pathCode('p', p, opts)).toContain('    chassis.moveToPoint(41.7, 48, 2000); // claw on yellow pin (48, 48)');
  });

  it('slows down for the last part of a move', () => {
    const p = path([{ x: 18, y: 72, theta: 0 }, { x: 68, y: 72, params: { slowdown: 0.2, slowSpeed: 40 } }]);
    expect(pathCode('p', p, opts)).toContain([
      '    chassis.moveToPoint(68, 72, 2000);',
      '    chassis.waitUntil(40);',
      '    chassis.cancelMotion();',
      '    chassis.moveToPoint(68, 72, 2000, {.maxSpeed = 40}); // last 20%',
    ].join('\n'));
  });

  it('writes a function per path, a _rot180 one for a turned use, and run()', () => {
    const paths = {
      'Score': score,
      'park': path([{ x: 24, y: 30, theta: 90 }, { x: 72, y: 20, theta: null }], { resetPose: true }),
    };
    const auton: AutonDefinition = { steps: [{ path: 'Score' }, { path: 'park' }, { path: 'park', rotate: true }, { path: 'gone' }] };
    const code = autonCode('Skills', auton, paths, opts);
    expect(code).toContain('void score() {');
    expect(code).toContain('// park\nvoid park() {\n    chassis.setPose(24, 30, 90);\n    chassis.moveToPoint(72, 20, 2000);\n}');
    expect(code).toContain('// park, turned 180 degrees\nvoid park_rot180() {\n    chassis.setPose(120, 114, -90);\n    chassis.moveToPoint(72, 124, 2000);\n}');
    expect(code).toContain([
      'void run() {',
      '    chassis.setPose(18, 72, 0);',
      '    score();',
      '    park();',
      '    park_rot180();',
      '    // missing path "gone"',
      '}',
    ].join('\n'));
    // every function is written once
    expect(code.match(/void park\(\)/g)).toHaveLength(1);
  });

  it('keeps C++ names unique', () => {
    const p = path([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    const code = autonCode('A', { steps: [{ path: 'a b' }, { path: 'a_b' }, { path: 'a b', rotate: true }] }, { 'a b': p, a_b: p }, opts);
    expect(code).toContain('void a_b() {');
    expect(code).toContain('void a_b_2() {');
    expect(code).toContain('    a_b();\n    a_b_2();\n    a_b_rot180();');
  });

  it('writes an empty run() for an empty auton', () => {
    expect(autonCode('Empty', { steps: [] }, {}, opts)).toContain('void run() {}');
  });

  it('maps every flat line back to its point', () => {
    const { code, sources } = flatProgram([{ def: score }], p => p, opts);
    const lines = code.split('\n');
    expect(lines[1]).toBe('    chassis.setPose(18, 72, 0);');
    expect(sources.get(2)).toEqual({ step: 0, point: 0, call: 'pose' });
    expect(sources.get(5)).toEqual({ step: 0, point: 3, call: 'move' });
    expect(sources.get(6)).toEqual({ step: 0, point: 3, call: 'turn' });
    // the ghost resets at goals too, so it jumps back out to where the robot really is
    expect(code).toContain('setPoseFromGoal');
  });
});

describe('estimated timeouts', () => {
  it('rounds a call time up into a timeout', () => {
    expect(estimateFromSeconds(1)).toBe(1350);
    expect(estimateFromSeconds(0.2)).toBe(350);
  });

  it('times every call in the ghost and uses that when no timeout is set', () => {
    const p = path([
      { x: 18, y: 72, theta: 0 },
      { x: 60, y: 72, theta: 90, action: 'turn' },
      { x: 60, y: 30, params: { slowdown: 0.3, timeout: 3000 } },
    ]);
    const est = estimatesFor(p, robot);
    for (const key of ['1:move', '1:turn', '2:move', '2:slow']) {
      expect(est.get(key)).toBeGreaterThan(100);
      expect(est.get(key)! % 50).toBe(0);
    }
    // cached for the same path and robot
    expect(estimatesFor(p, robot)).toBe(est);
    const code = pathCode('p', p, { ...opts, estimates: def => estimatesFor(def, robot) });
    expect(code).toContain(`    chassis.moveToPoint(60, 72, ${est.get('1:move')});`);
    expect(code).toContain(`    chassis.turnToHeading(90, ${est.get('1:turn')});`);
    // a timeout you typed wins
    expect(code).toContain('    chassis.moveToPoint(60, 30, 3000);');
  });
});

describe('ghost', () => {
  it('converts to the simulator frame and back', () => {
    const p = { x: 18, y: 100, theta: 30 };
    expect(fromSimFrame(toSimFrame(p))).toEqual(p);
    // heading 0 faces red (+X); in the simulator red is -x, which is heading -90
    expect(toSimFrame({ x: 144, y: 72, theta: 0 })).toEqual({ x: -72, y: 0, theta: -90 });
  });

  it('drives the path in the Crimson frame', () => {
    const def = path([{ x: 18, y: 72, theta: 0 }, { x: 60, y: 72 }, { x: 60, y: 40, theta: -90 }]);
    const ghost = simulateSteps([{ def }], CRIMSON_PROFILE.robot, 15);
    expect(ghost.duration).toBeGreaterThan(1);
    const start = poseAt(ghost, 0)!;
    expect(start.x).toBeCloseTo(18, 1);
    expect(start.y).toBeCloseTo(72, 1);
    // halfway through the first leg it's driving toward +X without turning
    const mid = ghost.poses.find(p => p.x > 35)!;
    expect(Math.abs(wrapDeg(mid.theta))).toBeLessThan(5);
    expect(mid.y).toBeCloseTo(72, 0);
    const end = poseAt(ghost, ghost.duration)!;
    // LemLib-style settling: within a couple of inches
    expect(Math.hypot(end.x - 60, end.y - 40)).toBeLessThan(2);
    // heading 90 faces -Y, so arriving at heading -90 faces +Y
    expect(Math.abs(wrapDeg(end.theta - -90))).toBeLessThan(6);
  });

  it('runs an auton step turned around', () => {
    const def = path([{ x: 18, y: 72, theta: 0 }, { x: 40, y: 72 }]);
    const ghost = simulateSteps([{ def, rotate: true }], CRIMSON_PROFILE.robot, 15);
    const end = poseAt(ghost, ghost.duration)!;
    expect(Math.hypot(end.x - 104, end.y - 72)).toBeLessThan(2);
  });

  it('pins a timed-out move on its point', () => {
    const def = path([{ x: 18, y: 72, theta: 0 }, { x: 130, y: 72, params: { timeout: 300 } }]);
    const ghost = simulateSteps([{ def }], CRIMSON_PROFILE.robot, 15);
    expect(ghost.timeouts).toEqual([{ step: 0, point: 1, call: 'move' }]);
  });

  it('donuts around the goal it reset against', () => {
    const def = path([
      { x: 60, y: 72, theta: 0 },
      { x: 24, y: 48, target: 'goal-blue-2', theta: 90, action: 'donut', params: { reverse: true } },
    ]);
    const ghost = simulateSteps([{ def }], CRIMSON_PROFILE.robot, 15);
    const end = poseAt(ghost, ghost.duration)!;
    // turned to the heading, still 7.5 in from the goal's centre
    expect(Math.abs(wrapDeg(end.theta - 90))).toBeLessThan(5);
    expect(Math.hypot(end.x - 24, end.y - 48)).toBeCloseTo(7.5, 0);
  });

  it("doesn't stall when a move ends a little beside its target", () => {
    // the slow part arrives at an angle and stops 0.8 in off; LemLib's large-error exit ends it
    const def = path([
      { x: 18, y: 84, theta: -90 },
      { x: 48, y: 48, target: 'cup-yellow-2' },
      { x: 24, y: 48, target: 'goal-blue-2', theta: 180, action: 'donut', params: { reverse: true } },
      { x: 2.4, y: 12.4, target: 'loader-blue-top', params: { slowdown: 0.3, slowSpeed: 40 } },
    ]);
    expect(simulateSteps([{ def }], CRIMSON_PROFILE.robot, 15).timeouts).toEqual([]);
    expect(estimatesFor(def, robot).get('3:slow')).toBeLessThan(2000);
  });

  it('drives into a goal and through a slowdown', () => {
    const def = path([
      { x: 18, y: 72, theta: 0 },
      { x: 60, y: 72, params: { slowdown: 0.5, slowSpeed: 30 } },
      { x: 24, y: 48, target: 'goal-blue-2', params: { reverse: true } },
    ]);
    const ghost = simulateSteps([{ def }], CRIMSON_PROFILE.robot, 15);
    expect(ghost.timeouts).toEqual([]);
    // into the goal, then the reset puts it 7.5 in back out, on the side it came from
    expect(ghost.jumps).toHaveLength(1);
    const k = ghost.jumps[0];
    expect(Math.hypot(ghost.poses[k - 1].x - 24, ghost.poses[k - 1].y - 48)).toBeLessThan(2);
    const rest = arrivals(def, robot)[2].rest!;
    const end = poseAt(ghost, ghost.duration)!;
    expect(Math.hypot(end.x - rest.x, end.y - rest.y)).toBeLessThan(1.5);
    expect(Math.hypot(end.x - 24, end.y - 48)).toBeCloseTo(7.5, 0);
    // slower over the last half of the first move than before it
    const fast = ghost.poses.filter(p => p.x > 30 && p.x < 36 && Math.abs(p.y - 72) < 2);
    const slow = ghost.poses.filter(p => p.x > 48 && p.x < 54 && Math.abs(p.y - 72) < 2);
    const avg = (ps: typeof ghost.poses) => ps.reduce((n, p) => n + p.speed, 0) / ps.length;
    expect(avg(slow)).toBeLessThan(avg(fast));
  });
});
