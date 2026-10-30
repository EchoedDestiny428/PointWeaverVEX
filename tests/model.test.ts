import { describe, expect, it } from "vitest";
import { KEY, motorHealthKey, motorKey, STRUCT_SCHEMAS, TYPE } from "../src/log/keys";
import { buildLog, channel, motionAt, parseMetadata, parseSource, phaseAt, poseAt, textAt, valueAt } from "../src/log/model";
import type { ReplayLog } from "../src/log/model";
import { parseWpilog } from "../src/log/wpilog";
import { WpilogWriter } from "../src/log/wpilogWriter";

const BOOT = 10;
const us = (seconds: number) => Math.round((BOOT + seconds) * 1e6);
const motion = (kind: number, x: number, y: number, theta: number, timeout: number) => ({
  kind,
  x,
  y,
  theta,
  timeout,
  maxSpeed: 127,
  minSpeed: 0,
  earlyExit: 0,
  forwards: true,
  async: true,
});

function sessionLog(): ReplayLog {
  const w = new WpilogWriter("Crimson Oct 19 2026 08:12:44");
  for (const [name, schema] of Object.entries(STRUCT_SCHEMAS)) w.schema(name, schema, us(0));
  w.write("/Metadata/Drivetrain", TYPE.string, us(0), "trackWidth=12.5,wheelDiameter=3.25,note=a=b");
  w.write(KEY.enabled, TYPE.boolean, us(0), false);
  w.write(KEY.autonomous, TYPE.boolean, us(0), false);
  w.write(KEY.autonSelected, TYPE.string, us(0), "TeamBad");
  w.write(KEY.enabled, TYPE.boolean, us(1), true);
  w.write(KEY.autonomous, TYPE.boolean, us(1), true);
  w.write(KEY.autonRunning, TYPE.boolean, us(1), true);

  const poses = [
    [0, 0, 0, 0],
    [0.5, 0, 0, 350],
    [1, 0, 10, 10],
    [1.5, 4, 20, 20],
    [2, 8, 20, 90],
  ];
  for (const [t, x, y, theta] of poses) {
    w.struct(KEY.robotPose, "Pose", us(t), { x, y, theta });
    w.struct(KEY.rawPose, "Pose", us(t), { x: x + 1, y, theta });
  }
  w.struct(motorKey("LeftA"), "Motor", us(1), { position: 0, velocity: 100, voltage: 6000, current: 1000, power: 5, torque: 0.3 });
  w.struct(motorKey("LeftA"), "Motor", us(1.5), { position: 300, velocity: 200, voltage: 12000, current: 2000, power: 10, torque: 0.6 });
  w.struct(motorHealthKey("LeftA"), "MotorHealth", us(1), { temperature: 45, efficiency: 50, faults: 0, flags: 0, overTemp: false, overCurrent: false });
  w.struct(motorHealthKey("LeftA"), "MotorHealth", us(1.5), { temperature: 55, efficiency: 40, faults: 1, flags: 0, overTemp: true, overCurrent: false });
  w.struct(KEY.controller, "Controller", us(1), { leftX: 0, leftY: 100, rightX: -20, rightY: 0, buttons: 0b101 });

  w.struct(KEY.motionCommand, "Motion", us(1.1), motion(1, 24, -48, Number.NaN, 1000));
  w.write(KEY.motionSource, TYPE.string, us(1.1), "src/autons/match/teambad.cpp:20");
  w.write(KEY.motionId, TYPE.int64, us(1.1), 7);
  w.write(KEY.motionActive, TYPE.boolean, us(1.12), true);
  w.write(KEY.motionActive, TYPE.boolean, us(1.6), false);
  w.struct(KEY.motionCommand, "Motion", us(1.7), motion(4, Number.NaN, Number.NaN, 90, 800));
  w.write(KEY.motionSource, TYPE.string, us(1.7), "src/autons/match/teambad.cpp:21");
  w.write(KEY.motionId, TYPE.int64, us(1.7), 8);
  w.write(KEY.motionActive, TYPE.boolean, us(1.72), true);
  w.struct(KEY.motionCommand, "Motion", us(1.9), motion(3, 0, 0, Number.NaN, 500));
  w.write(KEY.motionSource, TYPE.string, us(1.9), "src/autons/match/teambad.cpp:22");
  w.write(KEY.motionId, TYPE.int64, us(1.9), 9);
  w.write(KEY.motionActive, TYPE.boolean, us(2.5), false);

  w.struct(KEY.visionPose, "Pose", us(2.2), { x: 9, y: 21, theta: 90 });
  w.struct(KEY.resetFrom, "Pose", us(2.6), { x: 8, y: 20, theta: 90 });
  w.struct(KEY.resetTo, "Pose", us(2.6), { x: 10, y: 19, theta: 92 });
  w.write(KEY.resetSource, TYPE.string, us(2.6), "src/autons/match/teambad.cpp:26");
  w.struct(KEY.resetFrom, "Pose", us(2.8), { x: 10, y: 19, theta: 92 });
  w.struct(KEY.resetTo, "Pose", us(2.8), { x: 11, y: 19, theta: 92 });
  w.write(KEY.resetSource, TYPE.string, us(2.8) + 300, "src/autons/match/teambad.cpp:39");

  w.write(KEY.autonomous, TYPE.boolean, us(3), false);
  w.write(KEY.autonRunning, TYPE.boolean, us(3), false);
  w.write(KEY.enabled, TYPE.boolean, us(4), false);
  w.write(KEY.loggerDropped, TYPE.int64, us(5), 0);
  return buildLog(parseWpilog(w.toBytes()));
}

describe("log model", () => {
  const log = sessionLog();

  it("measures time in seconds from the first record", () => {
    expect(log.t0).toBe(us(0));
    expect(log.duration).toBeCloseTo(5, 6);
    expect(log.header).toBe("Crimson Oct 19 2026 08:12:44");
    expect(log.truncated).toBe(false);
  });

  it("flattens every numeric struct field into a channel", () => {
    expect(channel(log, "/Motors/LeftA/velocity")!.v).toEqual(Float64Array.of(100, 200));
    expect(log.channels.get("Motors/LeftA/Health/temperature")!.v).toEqual(Float64Array.of(45, 55));
    expect(log.channels.get("Odometry/Robot/theta")!.discrete).toBe(false);
    expect(log.channels.get("Motors/LeftA/Health/overTemp")!.discrete).toBe(true);
    expect(log.channels.get("Motors/LeftA/Health/faults")!.discrete).toBe(true);
    expect(log.channels.get("Controller/Master/buttons")!.v[0]).toBe(5);
    expect(log.channels.get("Controller/Master/leftY")!.discrete).toBe(true);
    expect(log.channels.get("Motion/Command/x")!.discrete).toBe(true);
    expect(log.channels.get("DriverStation/Enabled")!.discrete).toBe(true);
    expect(log.channels.has(".schema/struct:Pose")).toBe(false);
    expect(textAt(log.text.get("Auton/Selected"), 1)).toBe("TeamBad");
  });

  it("interpolates continuous channels and steps discrete ones", () => {
    const velocity = channel(log, "/Motors/LeftA/velocity");
    expect(valueAt(velocity, 1.25)).toBeCloseTo(150, 6);
    expect(valueAt(velocity, 0.5)).toBeNaN();
    expect(valueAt(velocity, 9)).toBe(200);
    expect(valueAt(channel(log, "/Motors/LeftA/Health/temperature"), 1.25)).toBeCloseTo(50, 6);
    const overTemp = channel(log, "/Motors/LeftA/Health/overTemp");
    expect(valueAt(overTemp, 1.49)).toBe(0);
    expect(valueAt(overTemp, 1.5)).toBe(1);
    expect(valueAt(undefined, 1)).toBeNaN();
  });

  it("interpolates heading the short way round without wrapping it", () => {
    const pose = poseAt(log.poses.robot, 0.75)!;
    expect(pose.y).toBeCloseTo(5, 6);
    expect(pose.theta).toBeCloseTo(360, 6);
    expect(poseAt(log.poses.robot, 1.75)!.theta).toBeCloseTo(55, 6);
    expect(poseAt(log.poses.robot, -1)).toBeNull();
    expect(log.poses.raw.x[0]).toBe(1);
    expect(log.poses.vision.t.length).toBe(1);
  });

  it("splits the session into phases", () => {
    expect(log.phases.map((p) => [p.kind, Math.round(p.start * 10) / 10, Math.round(p.end * 10) / 10])).toEqual([
      ["disabled", 0, 1],
      ["auton", 1, 3],
      ["driver", 3, 4],
      ["disabled", 4, 5],
    ]);
    expect(phaseAt(log, 2)).toBe("auton");
    expect(phaseAt(log, 3.5)).toBe("driver");
    expect(log.autons).toEqual([{ name: "TeamBad", start: expect.closeTo(1, 6), end: expect.closeTo(3, 6) }]);
  });

  it("pairs motions with their source and active span", () => {
    expect(log.motions.map((m) => [m.id, m.kindName, m.line, m.endReason])).toEqual([
      [7, "moveToPoint", 20, "inactive"],
      [8, "turnToHeading", 21, "next"],
      [9, "turnToPoint", 22, "inactive"],
    ]);
    const [first, second, third] = log.motions;
    expect(first.file).toBe("src/autons/match/teambad.cpp");
    expect(first.end).toBeCloseTo(1.6, 6);
    expect(first.target).toMatchObject({ x: 24, y: -48 });
    expect(first.target.theta).toBeNaN();
    expect(first.timeoutMs).toBe(1000);
    expect(second.end).toBeCloseTo(1.9, 6);
    expect(third.end).toBeCloseTo(2.5, 6);
    expect(motionAt(log, 1.3)).toBe(first);
    expect(motionAt(log, 1.65)).toBeUndefined();
    expect(motionAt(log, 2)).toBe(third);
  });

  it("pairs pose resets with their source", () => {
    expect(log.resets).toHaveLength(2);
    expect(log.resets[0]).toMatchObject({ line: 26, from: { x: 8, y: 20, theta: 90 }, to: { x: 10, y: 19, theta: 92 } });
    expect(log.resets[0].t).toBeCloseTo(2.6, 6);
    expect(log.resets[1]).toMatchObject({ line: 39, file: "src/autons/match/teambad.cpp" });
  });

  it("reads metadata and source strings", () => {
    expect(log.metadata.Drivetrain).toEqual({ trackWidth: "12.5", wheelDiameter: "3.25", note: "a=b" });
    expect(parseMetadata("a=1, b = two ,flag")).toEqual({ a: "1", b: "two", flag: "" });
    expect(parseSource("src/autons/skills/v1.cpp:42")).toEqual({ source: "src/autons/skills/v1.cpp:42", file: "src/autons/skills/v1.cpp", line: 42 });
    expect(parseSource("")).toEqual({ source: "", file: null, line: null });
  });

  it("drops PROS_ERR int32 sensor reads instead of graphing them", () => {
    const w = new WpilogWriter("Crimson");
    w.schema("Wheel", STRUCT_SCHEMAS.Wheel, us(0));
    w.struct(KEY.verticalWheel, "Wheel", us(0), { position: 0, velocity: 0, angle: 0 });
    w.struct(KEY.verticalWheel, "Wheel", us(0.02), { position: 2147483647, velocity: 2147483647, angle: 2147483647 });
    w.struct(KEY.verticalWheel, "Wheel", us(0.04), { position: 3600, velocity: 100, angle: 3600 });
    const wheels = buildLog(parseWpilog(w.toBytes()));
    const position = channel(wheels, `${KEY.verticalWheel}/position`);
    expect(Array.from(position?.v ?? [])).toEqual([0, 3600]);
    expect(valueAt(position, 0.02)).toBeCloseTo(1800, 6);
  });
});
