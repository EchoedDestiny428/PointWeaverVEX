import { describe, expect, it } from "vitest";
import { autonCode, exitsOf, pathCode, type CodeOptions } from "../src/editor/codegen";
import { estimatesFor, routeEstimates, simulateSteps } from "../src/editor/ghost";
import type { PathDefinition } from "../src/editor/types";
import { DEFAULT_FIELD } from "../src/field";
import { CRIMSON_PROFILE } from "../src/profiles/crimson";
import { parseCpp, pickRoutine } from "../src/program/cppParser";
import { DEFAULT_OBSTACLES } from "../src/sim/collisions";
import { simulate, type GoalStop, type SimResult } from "../src/sim/runtime";

const robot = CRIMSON_PROFILE.robot;
const opts: CodeOptions = { clawOffset: 6.3, goalOffset: 7.5, exits: exitsOf(robot) };
const off: CodeOptions = { clawOffset: 6.3, goalOffset: 7.5 };
const settled = { ...robot, exitMove: 0, exitGoal: 0, exitTurn: 0, exitDonut: 0 };
const path = (points: PathDefinition["points"], extra: Partial<PathDefinition> = {}): PathDefinition => ({ points, params: null, ...extra });

describe("early exits in the code", () => {
  it("ends a stop 1 in short on moveToPoint's exit line, and leaves the old code alone without exits", () => {
    const p = path([{ x: 18, y: 72, theta: 0 }, { x: 60, y: 72 }]);
    expect(pathCode("p", p, opts)).toContain("chassis.moveToPoint(60, 72, 2000, {.minSpeed = 1, .earlyExitRange = 1});");
    expect(pathCode("p", p, off)).toContain("chassis.moveToPoint(60, 72, 2000);");
  });

  it("ends a goal move 1.5 in before touching, lets it coast in, then resets from the goal", () => {
    const p = path([{ x: 60, y: 48, theta: 180 }, { x: 24, y: 48, target: "goal-blue-2", params: { reverse: true } }]);
    expect(pathCode("p", p, opts)).toContain(
      "chassis.moveToPoint(24, 48, 2000, {.forwards = false, .minSpeed = 1, .earlyExitRange = 9}); // blue goal 2\n"
      + "    chassis.waitUntilDone();\n    pros::delay(100);\n    chassis.setPoseFromGoal(24, 48, {.distance = 7.5});");
    // a line at or inside the goal offset could never be crossed (the robot stops against the goal there), and 0 is
    // off: either way it waits for the timeout against the goal, as before
    for (const goal of [7.5, 0]) {
      expect(pathCode("p", p, { ...opts, exits: { ...opts.exits!, goal } })).toContain("chassis.moveToPoint(24, 48, 2000, {.forwards = false}); // blue goal 2");
    }
  });

  it("takes a point's Exit at a goal only when it's outside the goal offset", () => {
    const at = (earlyExitRange: number) => pathCode("p", path([
      { x: 60, y: 48, theta: 180 },
      { x: 24, y: 48, target: "goal-blue-2", params: { reverse: true, earlyExitRange } },
    ]), opts);
    expect(at(10)).toContain(".earlyExitRange = 10}); // blue goal 2");
    // 2 in from the goal's centre is inside it: the robot's goal exit instead
    expect(at(2)).toContain(".earlyExitRange = 9}); // blue goal 2");
  });

  it("turns a point's own Exit off with the robot's", () => {
    const p = path([{ x: 18, y: 72, theta: 0 }, { x: 60, y: 72, params: { earlyExitRange: 3 } }]);
    expect(pathCode("p", p, { ...opts, exits: { ...opts.exits!, move: 0 } })).toContain("chassis.moveToPoint(60, 72, 2000, {.earlyExitRange = 3});");
  });

  it("still lets a goal move with no reset coast in before the next move", () => {
    const p = path([
      { x: 60, y: 48, theta: 180 },
      { x: 24, y: 48, target: "goal-blue-2", params: { reverse: true, goalReset: false } },
      { x: 40, y: 30 },
    ]);
    expect(pathCode("p", p, opts)).toContain(".earlyExitRange = 9}); // blue goal 2\n    chassis.waitUntilDone();\n    pros::delay(100);\n    chassis.moveToPoint(40, 30,");
  });

  it("ends turns and donuts close to their heading", () => {
    const p = path([
      { x: 60, y: 72, theta: 0 },
      { x: 60, y: 48, theta: 90, action: "turn", params: { turnDirection: "cw" } },
      { x: 24, y: 48, target: "goal-blue-2", theta: 90, action: "donut", params: { reverse: true } },
      { x: 30, y: 30, theta: 0, action: "turn", faceNext: true, params: { reverse: true } },
      { x: 40, y: 10, params: { reverse: true } },
    ]);
    const code = pathCode("p", p, opts);
    expect(code).toContain("chassis.turnToHeading(90, 1000, {.direction = lemlib::AngularDirection::CW_CLOCKWISE, .minSpeed = 1, .earlyExitRange = 1});");
    expect(code).toContain("chassis.donut(90, 1000, {.forwards = false, .earlyExitRange = 1.5});");
    expect(code).toContain("chassis.turnToPoint(40, 10, 1000, {.forwards = false, .minSpeed = 1, .earlyExitRange = 1}); // facing point 4");
  });

  it("keeps a point's own motion chaining, and takes an earlyExitRange alone as where it ends", () => {
    const p = path([
      { x: 18, y: 72, theta: 0 },
      { x: 40, y: 72, params: { minSpeed: 40, earlyExitRange: 4 } },
      { x: 60, y: 72, params: { earlyExitRange: 3 } },
    ]);
    const code = pathCode("p", p, opts);
    expect(code).toContain("chassis.moveToPoint(40, 72, 2000, {.minSpeed = 40, .earlyExitRange = 4});");
    expect(code).toContain("chassis.moveToPoint(60, 72, 2000, {.minSpeed = 1, .earlyExitRange = 3});");
  });

  it("writes a straight moveToPose as the moveToPoint it amounts to, and leaves a curved one to LemLib", () => {
    // the claw (6.3 in ahead) on the loader: the centre stops at 135.3, straight along heading 0
    const straight = path([{ x: 127.2, y: 13, theta: 0 }, { x: 141.6, y: 13, theta: 0, target: "loader-red-top" }]);
    expect(pathCode("p", straight, opts)).toMatch(/chassis\.moveToPoint\(135\.3, 13, \d+, \{\.minSpeed = 1, \.earlyExitRange = 1\}\); \/\/ claw on red left loader/);
    const curved = path([{ x: 18, y: 72, theta: 0 }, { x: 60, y: 72 }, { x: 60, y: 40, theta: -90 }]);
    expect(pathCode("p", curved, opts)).toMatch(/chassis\.moveToPose\(60, 40, -90, \d+\);\n\}/);
    // without exits it's the moveToPose as set
    expect(pathCode("p", straight, off)).toMatch(/chassis\.moveToPose\(135\.3, 13, 0, \d+\);/);
  });

  it("starts a slowed part far enough out to cross its exit line", () => {
    // 36 in into the goal, slowed for the last 20%: the slow part would start 7.2 in out, inside the 9 in exit,
    // so it starts 11 in out instead (9 + 2)
    const p = path([{ x: 60, y: 48, theta: 180 }, { x: 24, y: 48, target: "goal-blue-2", params: { reverse: true, slowdown: 0.2 } }]);
    const code = pathCode("p", p, opts);
    expect(code).toContain("chassis.waitUntil(25);\n    chassis.cancelMotion();\n    chassis.moveToPoint(24, 48, 2000, {.forwards = false, .maxSpeed = 50, .minSpeed = 1, .earlyExitRange = 9}); // last 31%");
    // without exits it's the slowdown as set
    expect(pathCode("p", p, off)).toContain("chassis.waitUntil(28.8);");
  });

  it("doesn't ask for an exit a move starts inside of; into a goal it pushes briefly instead", () => {
    const p = path([{ x: 30, y: 48, theta: 180 }, { x: 24, y: 48, target: "goal-blue-2", params: { reverse: true } }]);
    expect(pathCode("p", p, opts)).toContain("chassis.moveToPoint(24, 48, 2000, {.forwards = false}); // blue goal 2\n    pros::delay(250);\n    chassis.cancelMotion();\n    chassis.waitUntilDone();\n    chassis.setPoseFromGoal(");
    const q = path([{ x: 59.5, y: 72, theta: 0 }, { x: 60, y: 72 }]);
    expect(pathCode("p", q, opts)).toContain("chassis.moveToPoint(60, 72, 2000);");
  });

  it("times a lead-in into a goal with the goal's exit", () => {
    const a = path([{ x: 60, y: 72, theta: 0 }, { x: 60, y: 48 }]);
    const b = path([{ x: 24, y: 48, target: "goal-blue-2", params: { reverse: true } }, { x: 40, y: 30 }]);
    const code = autonCode("A", { steps: [{ path: "a" }, { path: "b" }] }, { a, b }, { ...opts, estimates: d => estimatesFor(d, robot) });
    const lead = code.match(/chassis\.moveToPoint\(24, 48, (\d+), \{\.forwards = false, \.minSpeed = 1, \.earlyExitRange = 9\}\); \/\/ to the start of b\(\)/);
    expect(lead).not.toBeNull();
    expect(Number(lead![1])).toBeLessThan(2000);
    expect(code).toContain("// to the start of b()\n    chassis.waitUntilDone();\n    pros::delay(100);\n    chassis.setPoseFromGoal(24, 48, {.distance = 7.5});");
  });

  it("ends a lead-in early too", () => {
    const a = path([{ x: 18, y: 72, theta: 0 }, { x: 48, y: 72 }]);
    const b = path([{ x: 48, y: 100 }, { x: 60, y: 100 }]);
    const code = autonCode("A", { steps: [{ path: "a" }, { path: "b" }] }, { a, b }, opts);
    expect(code).toMatch(/chassis\.moveToPoint\(48, 100, \d+, \{\.minSpeed = 1, \.earlyExitRange = 1\}\); \/\/ to the start of b\(\)/);
  });
});

describe("timeouts where the auton drives them", () => {
  it("gives a path used twice (once turned) the longest of its times, never less than on its own", () => {
    // clear of every goal (the ghost can't drive through one), turned too
    const loop = path([{ x: 40, y: 60, theta: -90 }, { x: 40, y: 84 }, { x: 40, y: 60, params: { reverse: true } }]);
    const steps = [{ def: loop }, { def: loop, rotate: true }, { def: loop }];
    const inRun = routeEstimates(steps, robot)(loop);
    const alone = estimatesFor(loop, robot);
    for (const [key, ms] of alone) expect(inRun.get(key)).toBeGreaterThanOrEqual(ms);
    expect([...inRun.keys()].sort()).toEqual([...alone.keys()].sort());
  });
});

describe("the ghost, like the robot", () => {
  const goal = path([{ x: 60, y: 48, theta: 180 }, { x: 24, y: 48, target: "goal-blue-2", params: { reverse: true, slowdown: 0.5 } }]);

  it("stalls against a goal it's aimed into and waits out the timeout, unless the move ends early", () => {
    const stalled = simulateSteps([{ def: goal }], settled, 15);
    expect(stalled.timeouts).toEqual([{ step: 0, point: 1, call: "slow" }]);
    for (const p of stalled.poses) expect(Math.hypot(p.x - 24, p.y - 48)).toBeGreaterThan(7.45);
    const early = simulateSteps([{ def: goal }], robot, 15);
    expect(early.timeouts).toEqual([]);
    expect(early.duration).toBeLessThan(stalled.duration - 0.5);
  });

  it("gives a stalled goal move no estimate (it never finishes), so it keeps the default timeout", () => {
    expect(estimatesFor(goal, settled).get("1:slow")).toBeUndefined();
    expect(estimatesFor(goal, robot).get("1:slow")).toBeLessThan(1500);
  });

  it("slides along a goal it only grazes, instead of stopping dead", () => {
    // passing 6 in from goal-blue-2's centre, heading along +Y: it touches the 7.5 in disc side-on
    const graze = path([{ x: 30, y: 20, theta: -90 }, { x: 30, y: 80 }]);
    const g = simulateSteps([{ def: graze }], robot, 15);
    expect(g.timeouts).toEqual([]);
    const end = g.poses.at(-1)!;
    expect(Math.hypot(end.x - 30, end.y - 80)).toBeLessThan(2);
  });

  it("ends a donut on entering its earlyExitRange", () => {
    const donut = path([{ x: 60, y: 48, theta: 180 }, { x: 24, y: 48, target: "goal-blue-2", theta: 90, action: "donut", params: { reverse: true } }]);
    const time = (r: typeof robot) => estimatesFor(donut, r).get("1:turn")!;
    expect(time(robot)).toBeLessThan(time({ ...robot, exitDonut: 0 }));
  });
});

describe("the simulator, like LemLib 0.5.6", () => {
  const run = (body: string, goalStops: GoalStop[] = []): SimResult =>
    simulate(pickRoutine(parseCpp(`void run() {\n${body}\n}`))!.body, {
      field: DEFAULT_FIELD,
      profile: CRIMSON_PROFILE,
      robot: settled,
      mechanismOverrides: {},
      periodSeconds: 60,
      obstacles: { ...DEFAULT_OBSTACLES, walls: false, goals: false, loaders: false },
      goalStops,
    });
  const motion = (r: SimResult, k: number) => r.timeline.filter(e => e.kind === "motion")[k];

  it("doesn't count distance it couldn't drive: a waitUntil past the goal waits for the timeout", () => {
    const r = run("chassis.setPose(0, 0, 0);\nchassis.moveToPoint(0, 30, 1500);\nchassis.waitUntil(26);\nchassis.cancelMotion();", [{ x: 0, y: 30, radius: 7.5 }]);
    expect(motion(r, 0).status).toBe("timeout");
    expect(r.y[r.frameCount - 1]).toBeCloseTo(22.5, 1);
  });

  it("settles a moveToPose on both lateral exits: at least the large one's 500 ms within 1 in", () => {
    const pose = run("chassis.setPose(0, 0, 0);\nchassis.moveToPose(0, 30, 0, 4000);\nchassis.waitUntilDone();");
    const point = run("chassis.setPose(0, 0, 0);\nchassis.moveToPoint(0, 30, 4000);\nchassis.waitUntilDone();");
    const time = (r: SimResult) => motion(r, 0).end - motion(r, 0).start;
    expect(motion(pose, 0).status).toBe("done");
    // a moveToPoint takes the small exit alone (0.2 in for 100 ms)
    expect(time(pose)).toBeGreaterThan(time(point) + 0.15);
    let within = 0;
    while (Math.abs(30 - pose.y[within]) > 1) within++;
    expect(motion(pose, 0).end - within * pose.dt).toBeGreaterThan(0.49);
  });

  it("chains a moveToPose (minSpeed) out as soon as it's within 7.5 in", () => {
    const r = run("chassis.setPose(0, 0, 0);\nchassis.moveToPose(0, 30, 0, 4000, {.minSpeed = 1, .earlyExitRange = 1});\nchassis.waitUntilDone();");
    const end = motion(r, 0).end;
    const k = Math.round(end / r.dt);
    expect(30 - r.y[k]).toBeGreaterThan(6.5);
    expect(30 - r.y[k]).toBeLessThan(7.6);
  });
});
