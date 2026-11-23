import { describe, expect, it } from "vitest";
import { autonCode, pathCode, type CodeOptions } from "../src/editor/codegen";
import { simulateSteps } from "../src/editor/ghost";
import { CRIMSON_PROFILE } from "../src/profiles/crimson";
import type { PathDefinition } from "../src/editor/types";

const opts: CodeOptions = { clawOffset: 6.3, goalOffset: 7.5 };
const robot = CRIMSON_PROFILE.robot;
const path = (points: PathDefinition["points"], extra: Partial<PathDefinition> = {}): PathDefinition => ({ points, params: null, ...extra });

describe("waits (pros::delay)", () => {
  it("waits at the start, right after the setPose, before the first move", () => {
    const p = path([{ x: 30, y: 30, theta: 0, params: { wait: 1500 } }, { x: 60, y: 30 }], { resetPose: true });
    const code = pathCode("p", p, opts);
    expect(code).toContain("    chassis.setPose(30, 30, 0);\n    pros::delay(1500);\n    chassis.moveToPoint(60, 30,");
  });

  it("waits after a point once its moves are done", () => {
    const p = path([{ x: 30, y: 30, theta: 0 }, { x: 60, y: 30, theta: 90, action: "turn", params: { wait: 250 } }, { x: 60, y: 10 }]);
    const code = pathCode("p", p, opts);
    expect(code).toContain("chassis.turnToHeading(90,");
    expect(code).toMatch(/turnToHeading\(90, \d+\);\n {4}chassis\.waitUntilDone\(\);\n {4}pros::delay\(250\);\n {4}chassis\.moveToPoint\(60, 10,/);
  });

  it("puts the start's wait after the auton's setPose in run()", () => {
    const p = path([{ x: 30, y: 30, theta: 0, params: { wait: 1500 } }, { x: 60, y: 30 }]);
    const code = autonCode("A", { steps: [{ path: "p" }] }, { p }, opts);
    expect(code).toContain("void p() {\n    pros::delay(1500);\n    chassis.moveToPoint(60, 30,");
    expect(code).toContain("void run() {\n    chassis.setPose(30, 30, 0);\n    p();");
  });

  it("waits for a lead-in to arrive before the next path's start wait", () => {
    const a = path([{ x: 30, y: 30, theta: 0 }, { x: 60, y: 30 }]);
    const b = path([{ x: 60, y: 60, params: { wait: 500 } }, { x: 90, y: 60 }]);
    const code = autonCode("A", { steps: [{ path: "a" }, { path: "b" }] }, { a, b }, opts);
    expect(code).toMatch(/moveToPoint\(60, 60, \d+\); \/\/ to the start of b\(\)\n {4}chassis\.waitUntilDone\(\);\n {4}b\(\);/);
  });

  it("the ghost waits too", () => {
    const fast = path([{ x: 30, y: 30, theta: 0 }, { x: 60, y: 30 }]);
    const slow = path([{ x: 30, y: 30, theta: 0, params: { wait: 1500 } }, { x: 60, y: 30 }]);
    const t0 = simulateSteps([{ def: fast }], robot, 15).duration;
    const t1 = simulateSteps([{ def: slow }], robot, 15).duration;
    expect(t1 - t0).toBeCloseTo(1.5, 1);
  });
});
