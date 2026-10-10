import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD } from "../src/field";
import { CRIMSON_PROFILE } from "../src/profiles/crimson";
import type { LoopStmt } from "../src/program/ast";
import { parseCpp, parseLoopHeader, pickRoutine } from "../src/program/cppParser";
import { emitRoutine } from "../src/program/emitCpp";
import { replaceName } from "../src/program/loops";
import { discoverRoutines } from "../src/project/discover";
import { DEFAULT_OBSTACLES } from "../src/sim/collisions";
import { simulate } from "../src/sim/runtime";
import type { SimResult } from "../src/sim/runtime";

const run = (code: string): SimResult =>
  simulate(pickRoutine(parseCpp(code))!.body, {
    field: DEFAULT_FIELD,
    profile: CRIMSON_PROFILE,
    robot: CRIMSON_PROFILE.robot,
    mechanismOverrides: {},
    periodSeconds: 60,
    obstacles: { ...DEFAULT_OBSTACLES, walls: false, goals: false, loaders: false },
  });

describe("loop headers", () => {
  it("reads range loops over a brace list", () => {
    expect(parseLoopHeader("const double stage : {ns::kStage1, ns::kStage2, 3 * 2}")).toEqual({
      kind: "range",
      variable: "stage",
      items: ["ns::kStage1", "ns::kStage2", "3 * 2"],
    });
  });

  it("reads counted loops with any step spelling", () => {
    expect(parseLoopHeader("int i = 0; i < 4; i++")).toMatchObject({ kind: "count", variable: "i", start: "0", compare: "<", end: "4", step: "1" });
    expect(parseLoopHeader("std::size_t n = 6; n >= 2; n -= 2")).toMatchObject({ start: "6", compare: ">=", end: "2", step: "-(2)" });
    expect(parseLoopHeader("int k = 3; k > 0; --k")).toMatchObject({ step: "-1" });
    expect(parseLoopHeader("int k = 0; k <= 9; k = k + 3")).toMatchObject({ step: "3" });
  });

  it("refuses loops it can't count", () => {
    expect(parseLoopHeader("auto stage : kStages")).toBeNull();
    expect(parseLoopHeader("int i = 0; j < 4; i++")).toBeNull();
    expect(parseLoopHeader(";;")).toBeNull();
  });
});

describe("loop variable substitution", () => {
  it("replaces only the whole variable", () => {
    expect(replaceName("stage + kOffset", "stage", "ns::kStage2")).toBe("ns::kStage2 + kOffset");
    expect(replaceName("stage_count + obj.stage + ns::stage + stage::x", "stage", "9")).toBe("stage_count + obj.stage + ns::stage + stage::x");
    expect(replaceName("12 * i", "i", "-1")).toBe("12 * (-1)");
  });
});

describe("loops in routines", () => {
  const source = `
void run() {
    for (const double stage : {subsystems::elevator::kStage1, subsystems::elevator::kStage2,
                               subsystems::elevator::kStage3, subsystems::elevator::kStage4}) {
        parallel({
            [stage] { macros::flip_out(stage, pivot::kFlippedMotorDeg + 80); },
            [] { pros::delay(100); },
        });
    }
}`;

  it("parses the loop with its lambda captures", () => {
    const loop = pickRoutine(parseCpp(source))!.body[0] as LoopStmt;
    expect(loop.kind).toBe("loop");
    expect(loop.line).toBe(3);
    expect(loop.body[0]).toMatchObject({ kind: "parallel", captures: ["stage", ""] });
  });

  it("runs one pass per value with the value substituted", () => {
    const result = run(source);
    const passes = result.timeline.filter((entry) => entry.kind === "loop").map((entry) => entry.text);
    expect(passes).toEqual(["stage = kStage1 · 1/4", "stage = kStage2 · 2/4", "stage = kStage3 · 3/4", "stage = kStage4 · 4/4"]);
    const flips = result.timeline.filter((entry) => entry.kind === "mechanism").map((entry) => entry.text);
    expect(flips[1]).toContain("flip_out(subsystems::elevator::kStage2,");
    expect(result.duration).toBeCloseTo(3.6, 1);
    expect(result.diagnostics).toEqual([]);
  });

  it("drives through counted passes", () => {
    const result = run(`void run() {
      chassis.setPose(0, 0, 0);
      for (int i = 1; i <= 2; i++) {
        chassis.moveToPoint(0, 12 * i, 3000);
        chassis.waitUntilDone();
      }
    }`);
    expect(result.y[result.frameCount - 1]).toBeGreaterThan(23);
    expect(result.timeline.filter((entry) => entry.kind === "motion").map((entry) => entry.text)).toEqual([
      "chassis.moveToPoint(0, 12 * 1, 3000);",
      "chassis.moveToPoint(0, 12 * 2, 3000);",
    ]);
  });

  it("skips loops whose bounds are unknown and says why", () => {
    const result = run("void run() { for (int i = 0; i < count; i++) { pros::delay(100); } }");
    expect(result.duration).toBeLessThan(0.05);
    expect(result.diagnostics[0].message).toMatch(/isn't a plain number/);
  });

  it("writes loops and captures back out", () => {
    const routine = pickRoutine(parseCpp(source))!;
    const again = pickRoutine(parseCpp(emitRoutine("run", routine.body)))!;
    expect(emitRoutine("run", again.body)).toBe(emitRoutine("run", routine.body));
    expect(emitRoutine("run", routine.body)).toContain("[stage] {");
  });

  it("finds routines whose driving is inside a loop", () => {
    const found = discoverRoutines(
      [{ path: "src/autons/skills/v3.cpp", content: "void run() { for (int i = 0; i < 2; i++) { chassis.moveToPoint(0, 1, 500); } }" }],
      CRIMSON_PROFILE,
    );
    expect(found.routines.map((routine) => routine.name)).toEqual(["v3"]);
  });
});
