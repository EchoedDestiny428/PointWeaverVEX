import { describe, expect, it } from 'vitest';
import { CRIMSON_PROFILE } from '../src/profiles/crimson';
import { autonCode, cppName, flatProgram, num, pathCode, type CodeOptions } from '../src/editor/codegen';
import { estimateFromSeconds, estimatesFor, fromSimFrame, poseAt, simulateSteps, toSimFrame } from '../src/editor/ghost';
import { arrivals, resolveParams, rotate180, stepGap, wrapDeg } from '../src/editor/pathOps';
import { mirrorTarget, targetById } from '../src/editor/targets';
import type { AutonDefinition, PathDefinition } from '../src/editor/types';

const robot = CRIMSON_PROFILE.robot;
// no early exits: stops wait for LemLib's own exit conditions (tests/exits.test.ts has the early ones)
const settled = { ...robot, exitMove: 0, exitGoal: 0, exitTurn: 0, exitDonut: 0 };
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
    // loaders sit against the side wall, centred 12 in from the end wall
    const blue = targetById('loader-blue-top')!;
    const red = targetById('loader-red-bottom')!;
    expect(blue.kind).toBe('loader');
    expect([blue.x, blue.y, red.x, red.y].map(v => Math.round(v * 100) / 100)).toEqual([2.4, 12, 141.6, 132]);
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

  it('moves the robot round the goal on a donut, and starts the next move from there', () => {
    // backing into the goal from above: reset to (24, 55.5) facing +Y, goal behind; donut to heading 0 (+X)
    const def = path([
      { x: 24, y: 80 },
      { x: 24, y: 48, target: 'goal-blue-2', theta: 0, action: 'donut', params: { reverse: true } },
      { x: 60, y: 48 },
    ]);
    const arr = arrivals(def, opts);
    expect(arr[1].rest!.y).toBeCloseTo(55.5);
    // it orbits the goal: still 7.5 in from it, now on the +X side, having turned clockwise 90 degrees
    expect(arr[1].donut!.pivot.x).toBeCloseTo(24);
    expect(arr[1].donut!.pivot.y).toBeCloseTo(48);
    expect(arr[1].donut!.x).toBeCloseTo(31.5);
    expect(arr[1].donut!.y).toBeCloseTo(48);
    expect(arr[1].donut!.sweep).toBeCloseTo(90);
    // the next move heads off from the donut's end
    expect(arr[2].theta).toBeCloseTo(0);
    const code = pathCode('p', { ...def, points: def.points.map((q, i) => (i === 2 ? { ...q, params: { slowdown: 0.5 } } : q)) }, opts);
    expect(code).toContain('    chassis.waitUntil(14.25);');
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
    { x: 48, y: 24, target: 'goal-blue-3', theta: 90, action: 'donut', params: { donutFast: 110, donutSlow: 40, reverse: true } },
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
      '    chassis.donut(90, 1000, {.forwards = false, .fastSpeed = 110, .slowSpeed = 40});',
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

  describe('facing the next point', () => {
    it('turns toward it with turnToPoint (its back when the next move reverses)', () => {
      const p = path([
        { x: 18, y: 72, theta: 0 },
        { x: 48, y: 72, theta: 0, action: 'turn', faceNext: true },
        { x: 48, y: 100 },
      ]);
      expect(arrivals(p, opts)[1].final).toBeCloseTo(-90);
      expect(pathCode('p', p, opts)).toContain('    chassis.moveToPoint(48, 72, 2000);\n    chassis.turnToPoint(48, 100, 1000); // facing point 2');
      const back = { ...p, points: p.points.map((q, i) => (i === 2 ? { ...q, params: { reverse: true } } : q)) };
      expect(arrivals(back, opts)[1].final).toBeCloseTo(90);
      expect(pathCode('p', back, opts)).toContain('chassis.turnToPoint(48, 100, 1000, {.forwards = false}); // facing point 2');
    });

    it('arrives facing it with moveToPose', () => {
      const p = path([{ x: 18, y: 72, theta: 0 }, { x: 48, y: 72, theta: 0, faceNext: true }, { x: 48, y: 100 }]);
      expect(pathCode('p', p, opts)).toContain('    chassis.moveToPose(48, 72, -90, 2000); // facing point 2');
    });

    it('donuts round the goal until it faces it', () => {
      const p = path([
        { x: 24, y: 80 },
        { x: 24, y: 48, target: 'goal-blue-2', theta: 180, action: 'donut', faceNext: true, params: { reverse: true } },
        { x: 60, y: 48 },
      ]);
      const a = arrivals(p, opts)[1];
      // facing (60, 48) from anywhere on the orbit = facing it from the goal: heading 0
      expect(a.final).toBeCloseTo(0);
      expect(a.donut!.x).toBeCloseTo(31.5);
      expect(a.donut!.y).toBeCloseTo(48);
      expect(pathCode('p', p, opts)).toContain('    chassis.donut(0, 1000, {.forwards = false}); // facing point 2');
    });

    it('starts facing point 1, and does nothing on the last point', () => {
      const p = path([{ x: 18, y: 72, theta: 90, faceNext: true }, { x: 48, y: 100, theta: 45, action: 'turn', faceNext: true }]);
      const code = autonCode('A', { steps: [{ path: 'p' }] }, { p }, opts);
      expect(code).toContain('    chassis.setPose(18, 72, -43.03);');
      expect(code).toContain('    chassis.turnToHeading(45, 1000);');
    });

    it('turns the ghost toward it', () => {
      const def = path([
        { x: 18, y: 72, theta: 0 },
        { x: 48, y: 72, theta: 0, action: 'turn', faceNext: true },
        { x: 48, y: 100 },
      ]);
      const ghost = simulateSteps([{ def }], settled, 15);
      expect(ghost.timeouts).toEqual([]);
      // after the turn, before it drives on: facing +Y
      const turned = ghost.poses.find(q => Math.abs(wrapDeg(q.theta + 90)) < 3 && Math.hypot(q.x - 48, q.y - 72) < 2);
      expect(turned).toBeDefined();
    });
  });

  describe('paths after the first in an auton', () => {
    const a = path([{ x: 18, y: 72, theta: 0 }, { x: 48, y: 72 }]);
    const b = path([{ x: 60, y: 96, theta: 90 }, { x: 60, y: 120 }]);

    it('drive to their point 0 first', () => {
      const code = autonCode('A', { steps: [{ path: 'a' }, { path: 'b' }] }, { a, b }, opts);
      expect(code).toContain([
        'void run() {',
        '    chassis.setPose(18, 72, 0);',
        '    a();',
        '    chassis.moveToPose(60, 96, 90, 2000); // to the start of b()',
        '    b();',
        '}',
      ].join('\n'));
    });

    it("don't when the robot is already there, or the path sets its own pose", () => {
      const near = path([{ x: 48.5, y: 72 }, { x: 60, y: 72 }]);
      expect(autonCode('A', { steps: [{ path: 'a' }, { path: 'near' }] }, { a, near }, opts)).toContain('    a();\n    near();');
      const own = { ...b, resetPose: true };
      expect(autonCode('A', { steps: [{ path: 'a' }, { path: 'own' }] }, { a, own }, opts)).toContain('    a();\n    own();');
    });

    it("use point 0's settings and the ghost's estimate", () => {
      const back = path([{ x: 60, y: 96, params: { reverse: true, maxSpeed: 80 } }, { x: 60, y: 120 }]);
      const code = autonCode('A', { steps: [{ path: 'a' }, { path: 'back' }] }, { a, back },
        { ...opts, estimates: def => estimatesFor(def, robot) });
      expect(code).toMatch(/ {4}chassis\.moveToPoint\(60, 96, \d+, \{\.forwards = false, \.maxSpeed = 80\}\); \/\/ to the start of back\(\)/);
      expect(code).not.toContain('chassis.moveToPoint(60, 96, 2000');
    });

    it('are driven in the ghost', () => {
      const { sources, code } = flatProgram([{ def: a }, { def: b }], p => p, opts);
      const line = code.split('\n').findIndex(l => l.includes('moveToPose(60, 96, 90')) + 1;
      expect(sources.get(line)).toEqual({ step: 1, point: 0, call: 'move' });
      const ghost = simulateSteps([{ def: a }, { def: b }], robot, 15);
      expect(ghost.timeouts).toEqual([]);
      expect(ghost.poses.some(q => Math.hypot(q.x - 60, q.y - 96) < 1.5)).toBe(true);
    });
  });

  describe('starting at a goal', () => {
    const atGoal = (reverse: boolean) => path([
      { x: 24, y: 48, theta: 0, target: 'goal-blue-2', params: reverse ? { reverse: true } : null },
      { x: 24, y: 80 },
    ]);

    it('starts the robot against the goal, on the side its direction says', () => {
      // goal in front (facing +X into it): the centre is 7.5 in short of it
      const front = arrivals(atGoal(false), opts)[0];
      expect(front.rest!.x).toBeCloseTo(16.5);
      expect(front.rest!.y).toBeCloseTo(48);
      // backed against it: 7.5 in the other way
      const back = arrivals(atGoal(true), opts)[0];
      expect(back.rest!.x).toBeCloseTo(31.5);
      const code = autonCode('A', { steps: [{ path: 'g' }] }, { g: atGoal(true) }, opts);
      expect(code).toContain('    chassis.setPose(31.5, 48, 0);');
      // the next move starts there
      expect(arrivals(atGoal(true), opts)[1].theta).toBeCloseTo(-wrapDeg(Math.atan2(32, -7.5) * 180 / Math.PI));
    });

    it('drives into it and resets when a later path starts there', () => {
      const before = path([{ x: 60, y: 100, theta: 0 }, { x: 60, y: 60 }]);
      const code = autonCode('A', { steps: [{ path: 'before' }, { path: 'g' }] }, { before, g: atGoal(true) }, opts);
      expect(code).toContain([
        '    chassis.moveToPose(24, 48, 0, 2000, {.forwards = false}); // to the start of g()',
        '    chassis.waitUntilDone();',
        '    chassis.setPoseFromGoal(24, 48, {.distance = 7.5});',
        '    g();',
      ].join('\n'));
    });

    it("doesn't when the path before left the robot against that goal", () => {
      const into = path([{ x: 60, y: 48, theta: 0 }, { x: 24, y: 48, target: 'goal-blue-2', params: { reverse: true } }]);
      const code = autonCode('A', { steps: [{ path: 'into' }, { path: 'g' }] }, { into, g: atGoal(true) }, opts);
      expect(code).toContain('    into();\n    g();');
    });

    it('starts the ghost there', () => {
      const ghost = simulateSteps([{ def: atGoal(true) }], robot, 15);
      expect(ghost.poses[0].x).toBeCloseTo(31.5, 1);
      expect(ghost.poses[0].y).toBeCloseTo(48, 1);
    });
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
    // (with moves between them: these paths don't start where the one before ends)
    expect(code.split('\n').filter(l => /^ {4}\w+\(\);$/.test(l))).toEqual(['    a_b();', '    a_b_2();', '    a_b_rot180();']);
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
  it('rounds a call time up into a timeout, with the leeway', () => {
    expect(estimateFromSeconds(1)).toBe(1350);
    expect(estimateFromSeconds(0.2)).toBe(350);
    expect(estimateFromSeconds(1, 300)).toBe(1550);
    expect(estimateFromSeconds(1, 0)).toBe(1250);
  });

  it('takes the leeway from the robot settings', () => {
    const p = path([{ x: 18, y: 72, theta: 0 }, { x: 60, y: 72 }]);
    const base = estimatesFor(p, robot).get('1:move')!;
    expect(estimatesFor(p, { ...robot, timeoutLeeway: 600 }).get('1:move')).toBe(base + 500);
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

  it('donuts at the measured rate (about 1 s for 90 degrees), and the setting changes it', () => {
    const def = path([
      { x: 60, y: 48, theta: 180 },
      { x: 24, y: 48, target: 'goal-blue-2', theta: 90, action: 'donut', params: { reverse: true } },
    ]);
    const donutTime = (r: typeof robot) => {
      const est = estimatesFor(def, r).get('1:turn')!;
      // the estimate is the ghost's time x1.25 + leeway, rounded up to 50 ms: back out the time
      return (est - r.timeoutLeeway) / 1.25;
    };
    expect(donutTime(robot)).toBeGreaterThan(800);
    expect(donutTime(robot)).toBeLessThan(1150);
    expect(donutTime({ ...robot, donutRate: 200 })).toBeLessThan(donutTime(robot) * 0.65);
  });

  it('donuts around the goal it reset against', () => {
    const def = path([
      { x: 60, y: 72, theta: 0 },
      { x: 24, y: 48, target: 'goal-blue-2', theta: 90, action: 'donut', params: { reverse: true } },
    ]);
    const ghost = simulateSteps([{ def }], CRIMSON_PROFILE.robot, 15);
    const end = poseAt(ghost, ghost.duration)!;
    // turned to the heading, still 7.5 in from the goal's centre, where the editor says it ends up
    expect(Math.abs(wrapDeg(end.theta - 90))).toBeLessThan(5);
    expect(Math.hypot(end.x - 24, end.y - 48)).toBeCloseTo(7.5, 0);
    const done = arrivals(def, robot)[1].donut!;
    expect(Math.hypot(end.x - done.x, end.y - done.y)).toBeLessThan(2);
  });

  it("stops as tightly as the robot's LemLib exit ranges", () => {
    const def = path([{ x: 18, y: 72, theta: 0 }, { x: 60, y: 72 }, { x: 60, y: 72, theta: 90, action: 'turn' }]);
    const end = (r: typeof robot) => {
      const g = simulateSteps([{ def: { ...def, points: def.points.slice(0, 2) } }], r, 15);
      return poseAt(g, g.duration)!;
    };
    // robotconfig.cpp: within 0.2 in for 100 ms
    const tight = end(settled);
    expect(Math.hypot(tight.x - 60, tight.y - 72)).toBeLessThan(0.3);
    // a loose small exit with no wait lets it stop further out
    const loose = end({ ...settled, linearSmallError: 3, linearSmallTime: 0 });
    expect(Math.hypot(loose.x - 60, loose.y - 72)).toBeGreaterThan(1);
    // a turn settles inside 1 degree, without swinging past
    const g = simulateSteps([{ def }], settled, 15);
    const last = poseAt(g, g.duration)!;
    expect(Math.abs(wrapDeg(last.theta - 90))).toBeLessThan(1);
    expect(g.timeouts).toEqual([]);
  });

  it("doesn't stall when a move ends a little beside its target", () => {
    // the slow part arrives at an angle and stops 0.8 in off; LemLib's large-error exit ends it
    const def = path([
      { x: 18, y: 84, theta: -90 },
      { x: 48, y: 48, target: 'cup-yellow-2' },
      { x: 24, y: 48, target: 'goal-blue-2', theta: 180, action: 'donut', params: { reverse: true } },
      { x: 2.4, y: 12, target: 'loader-blue-top', params: { slowdown: 0.3, slowSpeed: 40 } },
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
    // it stops against the goal (it can't get into it): the move ends half an inch out and it coasts in, so the
    // reset finds it where it already is
    for (const p of ghost.poses) expect(Math.hypot(p.x - 24, p.y - 48)).toBeGreaterThan(7.45);
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
