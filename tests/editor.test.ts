import { describe, expect, it } from 'vitest';
import { CRIMSON_PROFILE } from '../src/profiles/crimson';
import { autonCode, cppName, flatProgram, num, pathCode } from '../src/editor/codegen';
import { fromSimFrame, poseAt, simulateSteps, toSimFrame } from '../src/editor/ghost';
import { resolveParams, rotate180, stepGap, wrapDeg } from '../src/editor/pathOps';
import type { AutonDefinition, PathDefinition } from '../src/editor/types';

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
    expect(r).toMatchObject({ timeout: 1500, maxSpeed: 60, minSpeed: 0, reverse: true, turnTimeout: 1000, donutBehind: true });
  });

  it('measures the gap between steps', () => {
    const paths = { a: path([{ x: 0, y: 0 }, { x: 10, y: 0 }]), b: path([{ x: 10, y: 3 }, { x: 20, y: 0 }]) };
    const auton: AutonDefinition = { steps: [{ path: 'a' }, { path: 'b' }] };
    expect(stepGap(auton, paths, 0)).toBeNull();
    expect(stepGap(auton, paths, 1)).toBeCloseTo(3);
  });
});

describe('code', () => {
  const score = path([
    { x: 18, y: 72, theta: 0 },
    { x: 48, y: 72, theta: null },
    { x: 48, y: 48, theta: -90, params: { reverse: true, maxSpeed: 90, earlyExitRange: 4 } },
    { x: 24, y: 48, theta: 180, action: 'turn', params: { turnTimeout: 800, turnDirection: 'cw' } },
    { x: 24, y: 30, theta: 90, action: 'donut', params: { donutFast: 127, donutSlow: 30, reverse: true } },
  ], { params: { timeout: 1500 } });

  it('uses moveToPose for a heading and moveToPoint without one', () => {
    expect(pathCode('Score', score)).toBe([
      '// Score, made in PointWeaver.',
      "// Field frame: (0, 0) is the corner on blue's right, +X toward red, heading 0 faces red, clockwise. Inches.",
      '',
      'void score() {',
      '    chassis.moveToPoint(48, 72, 1500);',
      '    chassis.moveToPose(48, 48, -90, 1500, {.forwards = false, .maxSpeed = 90, .earlyExitRange = 4});',
      '    chassis.moveToPoint(24, 48, 1500);',
      '    chassis.turnToHeading(180, 800, {.direction = lemlib::AngularDirection::CW_CLOCKWISE});',
      '    chassis.moveToPoint(24, 30, 1500, {.forwards = false});',
      '    chassis.donut(90, 1000, {.forwards = false, .fastSpeed = 127, .slowSpeed = 30});',
      '}',
      '',
    ].join('\n'));
  });

  it('writes a function per path, a _rot180 one for a turned use, and run()', () => {
    const paths = {
      'Score': score,
      'park': path([{ x: 24, y: 30, theta: 90 }, { x: 72, y: 20, theta: null }], { resetPose: true }),
    };
    const auton: AutonDefinition = { steps: [{ path: 'Score' }, { path: 'park' }, { path: 'park', rotate: true }, { path: 'gone' }] };
    const code = autonCode('Skills', auton, paths);
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
    const code = autonCode('A', { steps: [{ path: 'a b' }, { path: 'a_b' }, { path: 'a b', rotate: true }] }, { 'a b': p, a_b: p });
    expect(code).toContain('void a_b() {');
    expect(code).toContain('void a_b_2() {');
    expect(code).toContain('    a_b();\n    a_b_2();\n    a_b_rot180();');
  });

  it('writes an empty run() for an empty auton', () => {
    expect(autonCode('Empty', { steps: [] }, {})).toContain('void run() {}');
  });

  it('maps every flat line back to its point', () => {
    const { code, sources } = flatProgram([{ def: score }], p => p);
    const lines = code.split('\n');
    expect(lines[1]).toBe('    chassis.setPose(18, 72, 0);');
    expect(sources.get(2)).toEqual({ step: 0, point: 0 });
    expect(sources.get(5)).toEqual({ step: 0, point: 3 });
    expect(sources.get(6)).toEqual({ step: 0, point: 3 });
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
    expect(ghost.timeouts).toEqual([{ step: 0, point: 1 }]);
  });
});
