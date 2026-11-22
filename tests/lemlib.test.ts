import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD } from "../src/field";
import { CRIMSON_PROFILE } from "../src/profiles/crimson";
import { parseCpp, pickRoutine } from "../src/program/cppParser";
import { DEFAULT_OBSTACLES } from "../src/sim/collisions";
import { approachSpeed } from "../src/sim/kinematics";
import { simulate, type SimResult } from "../src/sim/runtime";

// LemLib's own frame here (what the simulator runs in): heading 0 faces +Y
const robot = { ...CRIMSON_PROFILE.robot, maxSpeed: 63, acceleration: 250, deceleration: 63 };
const run = (body: string): SimResult =>
  simulate(pickRoutine(parseCpp(`void run() {\n${body}\n}`))!.body, {
    field: DEFAULT_FIELD,
    profile: CRIMSON_PROFILE,
    robot,
    mechanismOverrides: {},
    periodSeconds: 60,
    obstacles: { ...DEFAULT_OBSTACLES, walls: false, goals: false, loaders: false },
  });
const last = (r: SimResult) => ({ x: r.x[r.frameCount - 1], y: r.y[r.frameCount - 1], theta: r.theta[r.frameCount - 1] });
const peakSpeed = (r: SimResult) => {
  let v = 0;
  for (let i = 1; i < r.frameCount; i++) v = Math.max(v, Math.hypot(r.x[i] - r.x[i - 1], r.y[i] - r.y[i - 1]) / r.dt);
  return v;
};

describe("braking", () => {
  it("speeds up at the acceleration and slows down at the deceleration", () => {
    const time = (from: number, to: number) => {
      let v = from;
      let t = 0;
      while (Math.abs(v - to) > 1e-9 && t < 5) { v = approachSpeed(v, to, robot, 0.01); t += 0.01; }
      return t;
    };
    expect(time(0, 63)).toBeCloseTo(63 / 250, 1);
    expect(time(63, 0)).toBeCloseTo(1, 1);
    // reversing brakes to a stop first, then speeds up the other way
    expect(time(63, -63)).toBeCloseTo(1 + 63 / 250, 1);
  });

  it("starts slowing far enough out to stop at the target", () => {
    const r = run("chassis.setPose(0, 0, 0);\nchassis.moveToPoint(0, 72, 4000);\nchassis.waitUntilDone();");
    // 63 in/s at 63 in/s^2 needs 31.5 in to stop; it still ends on the point
    expect(last(r).y).toBeCloseTo(72, 0);
    const at = (y: number) => {
      for (let i = 1; i < r.frameCount; i++) if (r.y[i] >= y) return (r.y[i] - r.y[i - 1]) / r.dt;
      return 0;
    };
    // on the braking curve: no faster than sqrt(2 * 63 * distance left) (plus a step of slack)
    for (const y of [45, 55, 65]) expect(at(y)).toBeLessThan(Math.sqrt(2 * 63 * (72 - y)) + 1.5);
    expect(at(55)).toBeGreaterThan(Math.sqrt(2 * 63 * 17) - 4);
  });
});

describe("LemLib's close range (7.5 in)", () => {
  it("doesn't steer inside it: a point 7 in away to the side is reached along the heading", () => {
    const r = run("chassis.setPose(0, 0, 0);\nchassis.moveToPoint(5, 5, 2000);\nchassis.waitUntilDone();");
    const end = last(r);
    expect(Math.abs(end.x)).toBeLessThan(0.1);
    expect(end.y).toBeCloseTo(5, 0);
    expect(Math.abs(end.theta)).toBeLessThan(0.5);
  });

  it("raises a slow move's speed limit to 60", () => {
    const r = run("chassis.setPose(0, 0, 0);\nchassis.moveToPoint(0, 6, 2000, {.maxSpeed = 20});\nchassis.waitUntilDone();");
    expect(peakSpeed(r)).toBeGreaterThan((20 / 127) * 63 + 2);
  });

  it("settles on the point (no 'passed it' exit)", () => {
    const r = run("chassis.setPose(0, 0, 0);\nchassis.moveToPoint(0, 20, 3000);\nchassis.waitUntilDone();");
    expect(last(r).y).toBeCloseTo(20, 0);
    expect(r.timeline.some(e => e.status === "timeout")).toBe(false);
  });

  it("ends a chained move at the line earlyExitRange short of the point", () => {
    const r = run("chassis.setPose(0, 0, 0);\nchassis.moveToPoint(0, 30, 3000, {.minSpeed = 60, .earlyExitRange = 5});\nchassis.waitUntilDone();");
    const move = r.timeline.find(e => /moveToPoint/.test(e.text ?? ""))!;
    const i = Math.round(move.end / r.dt);
    expect(r.y[i]).toBeGreaterThan(24.5);
    expect(r.y[i]).toBeLessThan(27);
  });
});
