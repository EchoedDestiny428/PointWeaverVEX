import { afterEach, describe, expect, it, vi } from "vitest";
import skills from "../examples/crimson-skills-v1.cpp?raw";
import teambad from "../examples/crimson-teambad.cpp?raw";
import { wrap180 } from "../src/core/angle";
import { analyze } from "../src/log/analyze";
import { buildLog, poseAt } from "../src/log/model";
import { makeSampleLog } from "../src/log/sample";
import { parseWpilog } from "../src/log/wpilog";
import { CRIMSON_PROFILE } from "../src/profiles/crimson";
import { discoverRoutines } from "../src/project/discover";
import { laneRange, segments, timeTicks, tracePath, traceValue } from "../src/render/plotData";
import { buildTrace } from "../src/render/replayScene";
import type { PlotTrace } from "../src/render/plotData";
import {
  channelTree,
  FIXED_SERIES,
  matchRoutine,
  nextSlot,
  searchChannels,
  shortChannel,
  targetHeadings,
  unitFor,
  voltScale,
} from "../src/ui/replayModel";
import { defaultState, loadState, MAX_LOG_CHANNELS, validRotation } from "../src/ui/storage";

const trace = (t: number[], v: number[], style: PlotTrace["style"], discrete = false): PlotTrace => ({
  series: "s",
  slot: 1,
  label: "s",
  t,
  v,
  style,
  discrete,
});

describe("plot data", () => {
  it("turns motion spans into broken step segments", () => {
    const { t, v } = segments([
      { start: 1, end: 2, value: 5 },
      { start: 2, end: 3, value: Number.NaN },
      { start: 3, end: 4, value: -2 },
    ]);
    expect([...t]).toEqual([1, 2, 2, 3, 4, 4]);
    expect([...v].map((x) => (Number.isNaN(x) ? "gap" : x))).toEqual([5, 5, "gap", -2, -2, "gap"]);
    const steps = trace([...t], [...v], "steps");
    expect(traceValue(steps, 1.5)).toBe(5);
    expect(traceValue(steps, 2.5)).toBeNaN();
    expect(traceValue(steps, 3.9)).toBe(-2);
    expect(traceValue(steps, 4.5)).toBeNaN();
    expect(tracePath(steps, 4)).toBe("M1,-5L2,-5M3,2L4,2");
  });

  it("pads the range and never returns an empty one", () => {
    expect(laneRange([trace([0, 1], [0, 10], "line")])).toEqual([-0.8, 10.8]);
    expect(laneRange([trace([0, 1], [3, 3], "line")])).toEqual([2, 4]);
    expect(laneRange([trace([0], [Number.NaN], "line")])).toEqual([-1, 1]);
  });

  it("decimates long lines but keeps the extremes", () => {
    const t = Array.from({ length: 10000 }, (_, i) => i / 1000);
    const v = t.map((x) => Math.sin(x * 7));
    v[4321] = 9;
    v[7777] = -9;
    const d = tracePath(trace(t, v, "line"), 10, 200);
    expect(d.split(/[ML]/).length - 1).toBeLessThanOrEqual(800);
    expect(d).toContain(",-9");
    expect(d).toContain(",9");
    expect(d.startsWith("M0,")).toBe(true);
  });

  it("breaks lines at gaps and draws discrete channels as steps", () => {
    expect(tracePath(trace([0, 1, 2, 3], [1, Number.NaN, 2, 3], "line"), 3, 1000)).toBe("M0,-1M2,-2L3,-3");
    expect(tracePath(trace([0, 1, 2], [0, 1, 0], "line", true), 5)).toBe("M0,0H1V-1H2V0H5");
    expect(tracePath(trace([0, 1, 2, 3, 4, 5], [2, 2, 2, Number.NaN, 3, 3], "line", true), 6)).toBe("M0,-2H2M4,-3H6");
    expect(tracePath(trace([0.5, 1], [2, Number.NaN], "dots"), 2)).toBe("M0.5,-2h0");
  });

  it("reads values the way the plot draws them", () => {
    const line = trace([0, 2], [0, 10], "line");
    expect(traceValue(line, 1)).toBe(5);
    expect(traceValue(line, -1)).toBeNaN();
    expect(traceValue(line, 5)).toBe(10);
    expect(traceValue(trace([0, 2], [0, 10], "line", true), 1)).toBe(0);
    const dots = trace([1, 3], [4, 6], "dots");
    expect(traceValue(dots, 1.1)).toBe(4);
    expect(traceValue(dots, 2)).toBeNaN();
  });

  it("picks round time ticks", () => {
    expect(timeTicks(28)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(timeTicks(3)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
    expect(timeTicks(0)).toEqual([0]);
  });
});

describe("replay model helpers", () => {
  const log = buildLog(parseWpilog(makeSampleLog({ source: teambad })));
  const analysis = analyze(log, { csv: false });

  it("gives the four field series fixed, distinct slots and hands out the rest in order", () => {
    expect(FIXED_SERIES.map((s) => s.slot)).toEqual([1, 2, 3, 4]);
    expect(nextSlot([])).toBe(5);
    expect(nextSlot([{ key: "a", slot: 5 }, { key: "b", slot: 7 }])).toBe(6);
    expect(nextSlot([5, 6, 7, 8].map((slot) => ({ key: String(slot), slot })))).toBeNull();
    expect(MAX_LOG_CHANNELS).toBe(4);
  });

  it("names and units channels from the log's own metadata", () => {
    expect(shortChannel("Motors/LeftA/Health/temperature")).toBe("LeftA temperature");
    expect(shortChannel("Vision/Tx")).toBe("Vision Tx");
    expect(unitFor("Motors/LeftA/velocity", log.metadata.Units)).toBe("rpm");
    expect(unitFor("Motors/Intake/Health/temperature", log.metadata.Units)).toBe("°C");
    expect(unitFor("System/Battery/voltage", log.metadata.Units)).toBe("V");
    expect(unitFor("Odometry/Robot/theta", log.metadata.Units)).toBe("°");
    expect(unitFor("Logger/Bytes", log.metadata.Units)).toBe("");
    expect(unitFor("Motors/LeftA/velocity", undefined)).toBe("");
  });

  it("builds a channel tree and searches every channel", () => {
    const keys = [...log.channels.keys()];
    const tree = channelTree(keys);
    expect(tree.children.get("Motors")?.children.get("LeftA")?.children.get("Health")?.children.get("temperature")?.key).toBe(
      "Motors/LeftA/Health/temperature",
    );
    expect(searchChannels(keys, "intake TEMP").sort()).toEqual(["Motors/Intake/Health/overTemp", "Motors/Intake/Health/temperature"]);
    expect(searchChannels(keys, "battery volt")).toEqual(["System/Battery/voltage"]);
    expect(searchChannels(keys, "")).toHaveLength(Math.min(keys.length, 200));
  });

  it("matches the log's auton to a project routine by name, then by source file", () => {
    const files = [
      { path: "src/autons/skills/v1.cpp", content: skills },
      { path: "src/autons/match/teambad.cpp", content: teambad },
    ];
    const { routines } = discoverRoutines(files, CRIMSON_PROFILE);
    expect(matchRoutine(log, routines)?.path).toBe("src/autons/match/teambad.cpp");
    const renamed = routines.map((routine) => ({ ...routine, name: `x${routine.name}` }));
    expect(matchRoutine(log, renamed)?.path).toBe("src/autons/match/teambad.cpp");
    expect(matchRoutine(log, routines.filter((routine) => !routine.path.includes("teambad")))).toBeNull();
  });

  it("unwraps target headings next to the robot's accumulated heading", () => {
    const headings = targetHeadings(log, analysis);
    expect(headings).toHaveLength(log.motions.length);
    log.motions.forEach((motion, i) => {
      if (!Number.isFinite(headings[i])) return;
      const near = poseAt(log.poses.robot, motion.end)!.theta;
      expect(Math.abs(headings[i] - near)).toBeLessThanOrEqual(180);
      const raw = Number.isFinite(motion.target.theta) ? motion.target.theta : analysis.motions[i].targetHeading;
      expect(Math.abs(wrap180(headings[i] - raw))).toBeLessThan(1e-9);
    });
    expect(headings.some(Number.isFinite)).toBe(true);
  });

  it("reads battery millivolts when the log says so or the numbers look like it", () => {
    const series = { key: "k", type: "float", discrete: false, t: new Float64Array([0]), v: new Float64Array([12400]) };
    expect(voltScale(series, "mV")).toBe(0.001);
    expect(voltScale(series, "V")).toBe(1);
    expect(voltScale(series, undefined)).toBe(0.001);
    expect(voltScale({ ...series, v: new Float64Array([12.4]) }, undefined)).toBe(1);
  });
});

describe("field trace", () => {
  it("drops points the eye can't see but keeps turnarounds, resets and chunk joints", () => {
    const points: Array<[number, number, number]> = [];
    for (let k = 0; k <= 600; k++) points.push([k * 0.02, 0, k * 0.04]);
    for (let k = 1; k <= 300; k++) points.push([12 + k * 0.02, 0, 24 - k * 0.04]);
    points.push([18.02, 30, 30], [18.04, 30, 31]);
    const series = {
      key: "",
      t: Float64Array.from(points, (p) => p[0]),
      x: Float64Array.from(points, (p) => p[1]),
      y: Float64Array.from(points, (p) => p[2]),
      theta: new Float64Array(points.length),
    };
    const trace = buildTrace(series, [18.01]);
    const d = trace.chunks.join("");
    expect(d).toContain("L0.00,-24.00");
    expect(d).toContain("M30.00,-30.00");
    expect(d.match(/[ML]/g)!.length).toBeLessThan(20);
    expect(trace.starts[901]).toBe(1);
    expect(trace.chunks.length).toBe(4);
    for (const chunk of trace.chunks) expect(chunk.startsWith("M")).toBe(true);
    expect(trace.ends[600]).toBeGreaterThan(0);
  });
});

describe("saved view state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only accepts quarter-turn field rotations", () => {
    expect([0, 90, 180, 270].map(validRotation)).toEqual([0, 90, 180, 270]);
    expect([45, -90, 360, "90", null, undefined].map(validRotation)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("validates rotation and log channels when loading", () => {
    const saved = {
      prefs: { fieldRotation: 270 },
      logChannels: ["a", 3, "b", "a", "c", "d", "e"],
      hiddenSeries: ["raw", false],
      tab: "log",
    };
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved), setItem: () => undefined });
    const state = loadState(defaultState(CRIMSON_PROFILE));
    expect(state.prefs.fieldRotation).toBe(270);
    expect(state.logChannels).toEqual(["a", "b", "c", "d"]);
    expect(state.hiddenSeries).toEqual(["raw"]);
    expect(state.tab).toBe("log");
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ prefs: { fieldRotation: 30 } }), setItem: () => undefined });
    expect(loadState(defaultState(CRIMSON_PROFILE)).prefs.fieldRotation).toBe(0);
  });
});
