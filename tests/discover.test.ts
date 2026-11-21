import { describe, expect, it } from "vitest";
import { CRIMSON_PROFILE } from "../src/profiles/crimson";
import { discoverRoutines, routineProgram } from "../src/project/discover";
import type { ProjectFile } from "../src/project/types";

const selector = `
namespace autons {
namespace {
constexpr std::string_view kDefaultRoutine = "SkillsV1";
constexpr std::array kRoutines{
    Routine{"Test", match::test::setup, match::test::run},
    Routine{"SkillsV1", skills::v1::setup, skills::v1::run},
    Routine{"None", nullptr, nullptr},
};
}
}`;

const routine = (ns: string, body: string, setup = "") => `
#include "autons/routine.hpp"
namespace autons::${ns} {
void setup() {${setup}}
void run() {
${body}
}
}`;

const project: ProjectFile[] = [
  { path: "src/autons/selector.cpp", content: selector },
  { path: "src/autons/match/test.cpp", content: routine("match::test", "chassis.setPose(0, 0, 0);\nchassis.moveToPoint(0, 24, 1000);", "intake_lift.set_value(true);") },
  { path: "src/autons/skills/v1.cpp", content: routine("skills::v1", "chassis.setPose(-38, -63.4, 180);\nchassis.turnToHeading(90, 800);") },
  { path: "src/autons/match/draft.cpp", content: routine("match::draft", "chassis.moveToPoint(12, 12, 900);") },
  { path: "src/main.cpp", content: "void initialize() { chassis.calibrate(); }\nvoid opcontrol() { chassis.arcade(1, 2); }" },
  { path: "include/robotconfig.hpp", content: "void run() { chassis.moveToPoint(1, 1, 1); }" },
];

describe("routine discovery", () => {
  const found = discoverRoutines(project, CRIMSON_PROFILE);

  it("lists selector routines in registry order with their names", () => {
    const registered = found.routines.filter((r) => r.registered);
    expect(registered.map((r) => r.name)).toEqual(["Test", "SkillsV1"]);
    expect(registered.map((r) => r.path)).toEqual(["src/autons/match/test.cpp", "src/autons/skills/v1.cpp"]);
    expect(found.hasRegistry).toBe(true);
  });

  it("marks the default routine and picks the time limit from the folder", () => {
    const skills = found.routines.find((r) => r.name === "SkillsV1")!;
    const test = found.routines.find((r) => r.name === "Test")!;
    expect(skills.isDefault).toBe(true);
    expect(test.isDefault).toBe(false);
    expect(skills.periodSeconds).toBe(60);
    expect(test.periodSeconds).toBe(15);
  });

  it("still lists drivable files that are not in the selector yet", () => {
    const draft = found.routines.find((r) => r.path.endsWith("draft.cpp"))!;
    expect(draft.registered).toBe(false);
    expect(draft.name).toBe("draft");
  });

  it("ignores functions that never drive the chassis and non-source files", () => {
    expect(found.routines.some((r) => r.path === "src/main.cpp")).toBe(false);
    expect(found.routines.some((r) => r.path.endsWith(".hpp"))).toBe(false);
  });

  it("runs setup() before run()", () => {
    const test = found.routines.find((r) => r.name === "Test")!;
    const program = routineProgram(found, test)!;
    expect(program.body.map((stmt) => (stmt.kind === "call" ? stmt.callee : stmt.kind))).toEqual([
      "intake_lift.set_value",
      "chassis.setPose",
      "chassis.moveToPoint",
    ]);
  });

  it("falls back to file names when there is no selector", () => {
    const loose = discoverRoutines([{ path: "src/autons/skills/v2.cpp", content: routine("skills::v2", "chassis.moveToPoint(0, 1, 500);") }], CRIMSON_PROFILE);
    expect(loose.routines.map((r) => [r.name, r.registered, r.periodSeconds])).toEqual([["v2", true, 60]]);
  });
});
