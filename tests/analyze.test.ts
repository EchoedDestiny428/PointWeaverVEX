import { describe, expect, it } from "vitest";
import teambad from "../examples/crimson-teambad.cpp?raw";
import { analyze, reportFileNames } from "../src/log/analyze";
import { KEY, STRUCT_SCHEMAS, TYPE } from "../src/log/keys";
import { buildLog } from "../src/log/model";
import { makeSampleLog } from "../src/log/sample";
import { parseWpilog } from "../src/log/wpilog";
import { WpilogWriter } from "../src/log/wpilogWriter";

describe("tuning report on the synthetic auton log", () => {
  const log = buildLog(parseWpilog(makeSampleLog({ source: teambad })));
  const report = analyze(log, { name: "sample.wpilog" });
  const findings = report.findings.map((f) => `${f.severity}: ${f.text}`).join("\n");

  it("covers a whole match: disabled, auton, driver, disabled", () => {
    expect(log.phases.map((p) => p.kind)).toEqual(["disabled", "auton", "driver", "disabled"]);
    expect(log.autons[0].name).toBe("TeamBad");
    expect(log.motions.length).toBeGreaterThan(10);
    expect(log.resets.length).toBeGreaterThanOrEqual(4);
    expect(log.poses.vision.t.length).toBeGreaterThan(3);
    expect(log.warnings).toEqual([]);
  });

  it("flags the timed-out motion with its source line", () => {
    const timedOut = report.motions.filter((m) => m.timedOut);
    expect(timedOut.map((m) => m.motion.line)).toContain(20);
    expect(report.motions.find((m) => m.motion.line === 50)!.timedOut).toBe(false);
    expect(findings).toMatch(/high: Motion #\d+ moveToPoint at match\/teambad\.cpp:20 timed out/);
  });

  it("flags the drift jump at a setPoseFromGoal reset", () => {
    const reset = report.resets.find((r) => r.reset.line === 26)!;
    expect(reset.initial).toBe(false);
    expect(reset.headingKept).toBe(true);
    expect(reset.jump).toBeGreaterThan(2);
    expect(reset.driftPer100).toBeGreaterThan(5);
    expect(report.resets[0].initial).toBe(true);
    expect(findings).toMatch(/Reset #\d+ at match\/teambad\.cpp:26 corrected [\d.]+ in/);
  });

  it("flags the over-temperature motor", () => {
    const intake = report.motors.find((m) => m.name === "Intake")!;
    expect(intake.overTempTime).toBeGreaterThan(1);
    expect(intake.peakTemp).toBeGreaterThanOrEqual(55);
    expect(report.motors.find((m) => m.name === "LeftA")!.overTempTime).toBe(0);
    expect(findings).toMatch(/high: Intake motor ran hot/);
  });

  it("measures odometry health from the tracking wheels and IMU", () => {
    expect(report.odometry.horizontalOffset).toBeCloseTo(0.7, 1);
    expect(report.odometry.turnRateRatio).toBeGreaterThan(1.03);
    expect(report.odometry.travelRatio).toBeGreaterThan(1);
    expect(report.odometry.stationaryTime).toBeGreaterThan(2);
    expect(report.battery.min).toBeLessThan(report.battery.start);
    expect(report.vision.fixes).toBe(log.poses.vision.t.length);
  });

  it("summarizes the session for the transport bar", () => {
    expect(report.summary).toMatchObject({ motions: log.motions.length, timedOut: 2, resets: log.resets.length - 1 });
    expect(report.summary.maxJump).toBeGreaterThan(4);
    expect(report.summary.maxRawDrift).toBeGreaterThan(report.summary.maxJump);
    expect(analyze(log, { csv: false }).csv).toBe("");
  });

  it("writes a compact markdown report and a 50 Hz CSV", () => {
    for (const heading of ["## Findings", "## Session", "## Robot constants", "## Motions", "## Pose resets", "## Odometry health", "## Motors", "## Vision"]) {
      expect(report.markdown).toContain(heading);
    }
    expect(report.markdown).toContain("LinearPID: kP=9.5");
    expect(report.markdown.length).toBeLessThan(20000);
    const lines = report.csv.trim().split("\n");
    expect(lines[0].startsWith("t,phase,motion,robot_x,robot_y,robot_theta,raw_x")).toBe(true);
    const enabled = log.phases.filter((p) => p.kind !== "disabled").reduce((sum, p) => sum + (p.end - p.start), 0);
    expect(lines.length - 1).toBeGreaterThanOrEqual(Math.floor(enabled * 50));
    expect(lines[1].split(",")).toHaveLength(lines[0].split(",").length);
  });
});

describe("report details", () => {
  it("names the report files after the log", () => {
    expect(reportFileNames("C:/logs/crimson_0003.wpilog")).toEqual({
      report: "C:/logs/crimson_0003.report.md",
      csv: "C:/logs/crimson_0003.signals.csv",
    });
  });

  it("calls a motion timed out within 20 ms of its timeout", () => {
    const w = new WpilogWriter();
    w.schema("Motion", STRUCT_SCHEMAS.Motion, 0);
    w.schema("Pose", STRUCT_SCHEMAS.Pose, 0);
    const command = (t: number, timeout: number) =>
      w.struct(KEY.motionCommand, "Motion", t, { kind: 4, x: Number.NaN, y: Number.NaN, theta: 90, timeout, maxSpeed: 127, minSpeed: 0, earlyExit: 0, forwards: false, async: true });
    for (let t = 0; t <= 3e6; t += 20000) w.struct(KEY.robotPose, "Pose", t, { x: 0, y: 0, theta: Math.min(90, t / 10000) });
    command(100000, 500);
    w.write(KEY.motionActive, TYPE.boolean, 100000, true);
    w.write(KEY.motionActive, TYPE.boolean, 585000, false);
    command(1000000, 500);
    w.write(KEY.motionActive, TYPE.boolean, 1000000, true);
    w.write(KEY.motionActive, TYPE.boolean, 1470000, false);
    const report = analyze(buildLog(parseWpilog(w.toBytes())));
    expect(report.motions.map((m) => m.timedOut)).toEqual([true, false]);
    expect(report.motions[1].headingError).toBeCloseTo(0, 6);
  });

  it("measures a motion from the pose reset next to its command, never across the jump", () => {
    const resetAt = 1.005;
    const us = (s: number) => Math.round(s * 1e6);
    for (const commandAt of [1.015, 1.0]) {
      const w = new WpilogWriter();
      w.schema("Motion", STRUCT_SCHEMAS.Motion, 0);
      w.schema("Pose", STRUCT_SCHEMAS.Pose, 0);
      for (let k = 0; k <= 100; k++) {
        const s = k * 0.02;
        const x = s < resetAt ? 0 : Math.min(24, (s - resetAt) * 48);
        w.struct(KEY.robotPose, "Pose", us(s), { x, y: s < resetAt ? 0 : -48, theta: 90 });
      }
      w.struct(KEY.resetFrom, "Pose", us(resetAt), { x: 0, y: 0, theta: 90 });
      w.struct(KEY.resetTo, "Pose", us(resetAt), { x: 0, y: -48, theta: 90 });
      w.write(KEY.resetSource, TYPE.string, us(resetAt), "src/autons/a.cpp:10");
      w.struct(KEY.motionCommand, "Motion", us(commandAt), { kind: 1, x: 24, y: -48, theta: Number.NaN, timeout: 2000, maxSpeed: 127, minSpeed: 0, earlyExit: 0, forwards: true, async: true });
      w.write(KEY.motionActive, TYPE.boolean, us(1.04), true);
      w.write(KEY.motionActive, TYPE.boolean, us(1.7), false);
      const [motion] = analyze(buildLog(parseWpilog(w.toBytes()))).motions;
      expect(motion.start!.y, `command at ${commandAt}`).toBeCloseTo(-48, 6);
      expect(motion.positionError).toBeCloseTo(0, 6);
      expect(motion.pathDeviation).toBeCloseTo(0, 6);
      expect(motion.peakSpeed).toBeCloseTo(48, 0);
    }
  });
});
