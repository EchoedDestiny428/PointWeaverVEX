import { describe, expect, it } from "vitest";
import example from "../examples/crimson-skills-v1.cpp?raw";
import { boxHitsCircle, boxHitsRect, boxLeavesSquare, robotBox } from "../src/core/geometry";
import { angleError } from "../src/core/angle";
import { evaluate } from "../src/program/expression";
import { DEFAULT_FIELD } from "../src/field";
import { CRIMSON_PROFILE } from "../src/profiles/crimson";
import { parseCpp, pickRoutine } from "../src/program/cppParser";
import { DEFAULT_OBSTACLES } from "../src/sim/collisions";
import { simulate } from "../src/sim/runtime";
import type { SimResult } from "../src/sim/runtime";

const run = (code: string, overrides: Partial<Parameters<typeof simulate>[1]> = {}): SimResult =>
  simulate(pickRoutine(parseCpp(code))!.body, {
    field: DEFAULT_FIELD,
    profile: CRIMSON_PROFILE,
    robot: CRIMSON_PROFILE.robot,
    mechanismOverrides: {},
    periodSeconds: 15,
    obstacles: DEFAULT_OBSTACLES,
    ...overrides,
  });

const last = (result: SimResult) => ({
  x: result.x[result.frameCount - 1],
  y: result.y[result.frameCount - 1],
  theta: result.theta[result.frameCount - 1],
});

const entry = (result: SimResult, fragment: string) => result.timeline.find((e) => e.text.includes(fragment))!;

describe("angles and expressions", () => {
  it("measures turn error in the requested direction", () => {
    expect(angleError(90, 0)).toBe(90);
    expect(angleError(-90, 0, "cw")).toBe(270);
    expect(angleError(90, 0, "ccw")).toBe(-270);
  });

  it("evaluates arithmetic and getPose()", () => {
    const resolve = (name: string) => (name === "chassis.getPose().theta" ? 45 : undefined);
    expect(evaluate("-24 + 6 * (2 - 0.5)", resolve)).toBe(-15);
    expect(evaluate("chassis.getPose().theta", resolve)).toBe(45);
    expect(evaluate("2.5f", resolve)).toBe(2.5);
    expect(() => evaluate("elevator::kStage3", resolve)).toThrow();
  });
});

describe("collision geometry", () => {
  const box = robotBox({ x: 0, y: 0, theta: 45 }, 15, 15);
  it("detects circles, rectangles and walls", () => {
    expect(boxHitsCircle(box, { x: 9, y: 0 }, 1)).toBe(true);
    expect(boxHitsCircle(box, { x: 12, y: 0 }, 1)).toBe(false);
    expect(boxHitsRect(box, { x: 0, y: 12 }, 4, 4)).toBe(true);
    expect(boxHitsRect(box, { x: 0, y: 14 }, 4, 4)).toBe(false);
    expect(boxLeavesSquare(robotBox({ x: 66, y: 0, theta: 0 }, 15, 15), 72)).toBe(true);
  });
});

describe("motions", () => {
  it("drives to a point and stops there", () => {
    const result = run("chassis.setPose(0, -40, 0); chassis.moveToPoint(0, -16, 3000);");
    const end = last(result);
    expect(end.x).toBeCloseTo(0, 0);
    expect(Math.abs(end.y + 16)).toBeLessThan(1);
    expect(entry(result, "moveToPoint").status).toBe("done");
  });

  it("drives backwards when forwards is false", () => {
    const result = run("chassis.setPose(0, -40, 0); chassis.moveToPoint(0, -60, 3000, {.forwards = false});");
    const end = last(result);
    expect(Math.abs(end.y + 60)).toBeLessThan(1);
    expect(Math.abs(angleError(0, end.theta))).toBeLessThan(5);
  });

  it("turns the forced way round", () => {
    const result = run("chassis.setPose(-30, -30, 0); chassis.turnToHeading(-90, 3000, {.direction = lemlib::AngularDirection::CW_CLOCKWISE});");
    const turned = Math.max(...Array.from(result.theta));
    expect(turned).toBeGreaterThan(260);
    expect(Math.abs(angleError(-90, last(result).theta))).toBeLessThan(2);
  });

  it("stops a move when its timeout runs out", () => {
    const result = run("chassis.setPose(0, -60, 0); chassis.moveToPoint(0, 60, 500);");
    expect(entry(result, "moveToPoint").status).toBe("timeout");
  });
});

describe("LemLib timing rules", () => {
  it("runs the next line while an async move is still driving", () => {
    const result = run("chassis.setPose(0, -40, 0); chassis.moveToPoint(0, 0, 3000); claw::spin(127);");
    expect(entry(result, "claw::spin").start).toBeLessThan(0.05);
  });

  it("waits for the move with waitUntilDone", () => {
    const result = run("chassis.setPose(0, -40, 0); chassis.moveToPoint(0, -10, 3000); chassis.waitUntilDone(); claw::spin(127);");
    expect(entry(result, "claw::spin").start).toBeCloseTo(entry(result, "moveToPoint").end, 2);
  });

  it("queues a second move until the first one finishes", () => {
    const result = run("chassis.setPose(0, -40, 0); chassis.moveToPoint(0, -20, 3000); chassis.moveToPoint(20, -20, 3000);");
    const moves = result.timeline.filter((e) => e.kind === "motion");
    expect(moves[1].start).toBeGreaterThanOrEqual(moves[0].end - 0.011);
  });

  it("waits for every task in a parallel group", () => {
    const result = run("chassis.setPose(0, -40, 0); parallel({ [] { pros::delay(800); }, [] { pros::delay(300); }, }); claw::spin(127);");
    expect(entry(result, "claw::spin").start).toBeCloseTo(0.8, 2);
  });

  it("charges macro time from the team profile", () => {
    const result = run("macros::flip_out(10, 950); claw::spin(127);");
    expect(entry(result, "claw::spin").start).toBeCloseTo(0.9, 2);
  });

  it("records pose resets and wall collisions", () => {
    const result = run("chassis.setPose(0, -48, 180); chassis.moveToPoint(0, -72, 800); chassis.waitUntilDone(); chassis.setPose(0, -62, chassis.getPose().theta);");
    expect(result.collisions.some((c) => c.obstacleId === "wall")).toBe(true);
    expect(result.poseResets).toHaveLength(1);
  });
});

describe("Crimson skills example", () => {
  it("simulates to the end without errors", () => {
    const result = run(example, { periodSeconds: 60 });
    expect(result.finished).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.duration).toBeGreaterThan(10);
  });
});

describe("setPoseFromGoal", () => {
  it("puts the robot's centre the contact distance behind its back", () => {
    const result = run(`void run() {
      chassis.setPose(-40, -48, -90);
      chassis.moveToPoint(-24, -48, 3000, {.forwards = false});
      chassis.waitUntilDone();
      chassis.setPoseFromGoal(-24, -48);
    }`);
    const end = last(result);
    expect(end.x).toBeCloseTo(-24 + 7 * Math.sin((end.theta * Math.PI) / 180), 3);
    expect(end.y).toBeCloseTo(-48 + 7 * Math.cos((end.theta * Math.PI) / 180), 3);
    expect(end.x).toBeCloseTo(-31, 0);
    expect(result.poseResets.map((reset) => reset.line)).toEqual([5]);
  });

  it("uses the front and a custom distance when asked", () => {
    const end = last(run("void run() { chassis.setPose(0, 10, 180); chassis.setPoseFromGoal(0, 0, {.forwards = true, .distance = 9}); }"));
    expect(end.x).toBeCloseTo(0, 3);
    expect(end.y).toBeCloseTo(9, 3);
  });

  it("skips the reset when the snap would move the robot more than maxCorrection, like the robot", () => {
    const result = run("void run() { chassis.setPose(0, 0, 0); chassis.setPoseFromGoal(0, 0, {.distance = 12}); }");
    expect(last(result).y).toBeCloseTo(0, 3);
    expect(result.poseResets).toEqual([]);
    expect(result.diagnostics[0].message).toMatch(/more than maxCorrection/);
  });

  it("skips the reset when the robot is nowhere near the goal", () => {
    const result = run("void run() { chassis.setPose(30, 30, 0); chassis.setPoseFromGoal(-24, -48); }");
    expect(last(result).x).toBeCloseTo(30, 3);
    expect(result.diagnostics[0].message).toMatch(/too far to be touching it/);
  });
});
