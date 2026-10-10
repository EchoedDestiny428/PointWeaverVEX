import { describe, expect, it } from "vitest";
import example from "../examples/crimson-skills-v1.cpp?raw";
import { findParam } from "../src/program/ast";
import type { CallStmt, ParallelStmt } from "../src/program/ast";
import { blankComments, parseCpp, pickRoutine } from "../src/program/cppParser";
import { emitStatements } from "../src/program/emitCpp";

describe("blankComments", () => {
  it("removes comments but keeps line positions", () => {
    const source = "a(); // note\n/* block\nstill */ b();";
    const clean = blankComments(source);
    expect(clean.split("\n")).toHaveLength(3);
    expect(clean).not.toContain("note");
    expect(clean).toContain("b();");
  });
});

describe("parseCpp", () => {
  it("reads calls, params and line numbers", () => {
    const file = parseCpp(`void run() {\n  chassis.setPose(0, 0, 0);\n  chassis.moveToPoint(0, 24, 1000, {.forwards = false, .maxSpeed = 60});\n}`);
    const routine = pickRoutine(file)!;
    expect(routine.name).toBe("run");
    const move = routine.body[1] as CallStmt;
    expect(move.callee).toBe("chassis.moveToPoint");
    expect(move.line).toBe(3);
    expect(findParam(move.args[3], "forwards")).toBe("false");
    expect(findParam(move.args[3], "maxSpeed")).toBe("60");
  });

  it("reads parallel groups with lambdas and bare function names", () => {
    const file = parseCpp(`parallel({ macros::dual_setup, [] { chassis.moveToPoint(0, -12, 2000); chassis.waitUntilDone(); }, });`);
    const group = file.functions[0].body[0] as ParallelStmt;
    expect(group.kind).toBe("parallel");
    expect(group.tasks).toHaveLength(2);
    expect((group.tasks[0][0] as CallStmt).callee).toBe("macros::dual_setup");
    expect(group.tasks[1]).toHaveLength(2);
  });

  it("skips control flow and variables with a reason", () => {
    const file = parseCpp(`void run() {\n  int x = 4;\n  if (x > 2) { chassis.moveToPoint(0, 0, 100); }\n  pros::delay(100);\n}`);
    const kinds = pickRoutine(file)!.body.map((stmt) => stmt.kind);
    expect(kinds).toEqual(["unsupported", "unsupported", "call"]);
  });

  it("parses the Crimson skills example and picks run()", () => {
    const file = parseCpp(example);
    expect(file.functions.map((fn) => fn.name)).toEqual(["setup", "run"]);
    const routine = pickRoutine(file)!;
    expect(routine.body.length).toBeGreaterThan(20);
    expect(routine.body.filter((stmt) => stmt.kind === "parallel").length).toBeGreaterThan(5);
    expect(file.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("emits C++ that parses back to the same calls", () => {
    const routine = pickRoutine(parseCpp(example))!;
    const again = parseCpp(`void run() {\n${emitStatements(routine.body)}\n}`);
    const callees = (body: typeof routine.body): string[] =>
      body.flatMap((stmt) => (stmt.kind === "call" ? [stmt.callee] : stmt.kind === "parallel" ? stmt.tasks.flatMap(callees) : []));
    expect(callees(pickRoutine(again)!.body)).toEqual(callees(routine.body));
  });
});
