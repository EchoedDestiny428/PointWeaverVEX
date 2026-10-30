import type { Pose } from "../core/geometry";
import { motionAt, poseAt, sampleIndex } from "../log/model";
import type { MotionEvent, PoseReset, PoseSeries, ReplayLog } from "../log/model";
import type { RobotConfig } from "../robot/config";
import type { SimResult } from "../sim/runtime";
import { placeRobot, robotGlyph, sizeRobot } from "./robot";
import type { RobotGlyph } from "./robot";
import { svg } from "./svg";

export type FieldSeriesId = "robot" | "raw" | "vision" | "target";

export interface ReplayOptions {
  slots: Record<FieldSeriesId, number>;
  resets: PoseReset[];
  headings: number[];
}

interface Trace {
  series: PoseSeries;
  chunks: string[];
  ends: Int32Array;
  starts: Uint8Array;
  full: SVGPathElement;
  done: SVGGElement;
  traveled: SVGPathElement;
  shown: number;
}

const JUMP_IN = 6;
const JUMP_SPEED = 150;
const DOT_R = 0.9;
const RAY_IN = 9;
const CHUNK = 256;
const SIMPLIFY_IN = 0.15;
const SIMPLIFY_WINDOW = 256;
const fmt = (n: number): string => n.toFixed(2);

function dot(x: number, y: number): string {
  return `M${fmt(x - DOT_R)},${fmt(-y)}a${DOT_R},${DOT_R} 0 1 0 ${DOT_R * 2},0a${DOT_R},${DOT_R} 0 1 0 ${-DOT_R * 2},0`;
}

function simplify(series: PoseSeries, from: number, to: number, keep: Uint8Array): void {
  const { x, y } = series;
  keep[from] = 1;
  for (let a = from; a < to; a += SIMPLIFY_WINDOW) {
    const stack = [a, Math.min(a + SIMPLIFY_WINDOW, to)];
    keep[stack[0]] = keep[stack[1]] = 1;
    while (stack.length > 0) {
      const hi = stack.pop()!;
      const lo = stack.pop()!;
      const dx = x[hi] - x[lo];
      const dy = y[hi] - y[lo];
      const span = dx * dx + dy * dy;
      let worst = -1;
      let far = SIMPLIFY_IN;
      for (let k = lo + 1; k < hi; k++) {
        const f = span > 0 ? Math.min(1, Math.max(0, ((x[k] - x[lo]) * dx + (y[k] - y[lo]) * dy) / span)) : 0;
        const d = Math.hypot(x[k] - x[lo] - f * dx, y[k] - y[lo] - f * dy);
        if (d > far) {
          far = d;
          worst = k;
        }
      }
      if (worst < 0) continue;
      keep[worst] = 1;
      stack.push(lo, worst, worst, hi);
    }
  }
}

export function buildTrace(series: PoseSeries, breaks: number[]): Pick<Trace, "chunks" | "ends" | "starts"> {
  const n = series.t.length;
  const ends = new Int32Array(n);
  const starts = new Uint8Array(n);
  const finite = new Uint8Array(n);
  const keep = new Uint8Array(n);
  let open = false;
  let b = 0;
  let run = -1;
  for (let i = 0; i < n; i++) {
    const x = series.x[i];
    const y = series.y[i];
    finite[i] = Number.isFinite(x) && Number.isFinite(y) ? 1 : 0;
    let cut = !open || !finite[i];
    while (b < breaks.length && breaks[b] <= series.t[i]) {
      if (i > 0 && breaks[b] > series.t[i - 1]) cut = true;
      b++;
    }
    if (!cut && i > 0) {
      const dt = series.t[i] - series.t[i - 1];
      cut = Math.hypot(x - series.x[i - 1], y - series.y[i - 1]) > Math.max(JUMP_IN, JUMP_SPEED * dt);
    }
    starts[i] = cut ? 1 : 0;
    if (cut && run >= 0) simplify(series, run, i - 1, keep);
    if (finite[i] && cut) run = i;
    if (!finite[i]) run = -1;
    open = finite[i] === 1;
  }
  if (run >= 0) simplify(series, run, n - 1, keep);

  const chunks: string[] = [];
  let parts: string[] = [];
  let length = 0;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (i % CHUNK === 0 && i > 0) {
      chunks.push(parts.join(""));
      parts = [];
      length = 0;
      if (finite[i] && !starts[i] && last >= 0) {
        const joint = `M${fmt(series.x[last])},${fmt(-series.y[last])}`;
        parts.push(joint);
        length += joint.length;
      }
    }
    if (finite[i] && keep[i]) {
      const part = `${starts[i] ? "M" : "L"}${fmt(series.x[i])},${fmt(-series.y[i])}`;
      parts.push(part);
      length += part.length;
      last = i;
    }
    ends[i] = length;
  }
  chunks.push(parts.join(""));
  return { chunks, ends, starts };
}

export class ReplayScene {
  private readonly planned: SVGPathElement;
  private readonly groups: Record<FieldSeriesId, SVGGElement[]>;
  private readonly jumps: SVGGElement;
  private readonly visionAll: SVGPathElement;
  private readonly visionPast: SVGPathElement;
  private readonly crosshair: SVGGElement;
  private readonly ray: SVGLineElement;
  private readonly ghost: RobotGlyph;
  private readonly robot: RobotGlyph;
  private readonly traces: { robot: Trace; raw: Trace };
  private log: ReplayLog | null = null;
  private headings: number[] = [];
  private visionDots: string[] = [];
  private visionShown = -1;

  constructor(root: SVGGElement) {
    this.planned = svg("path", { class: "rp-planned", d: "" }, root);
    const raw = svg("g", { class: "rp-series rp-raw" }, root);
    const robot = svg("g", { class: "rp-series rp-robot" }, root);
    const vision = svg("g", { class: "rp-series rp-vision" }, root);
    this.jumps = svg("g", { class: "rp-jumps" }, root);
    const target = svg("g", { class: "rp-series rp-target" }, root);
    const ghost = svg("g", { class: "rp-series rp-raw" }, root);
    const body = svg("g", { class: "rp-series rp-robot" }, root);
    this.groups = { robot: [robot, body], raw: [raw, ghost], vision: [vision], target: [target] };

    const trace = (parent: SVGGElement): Trace => ({
      series: { key: "", t: new Float64Array(), x: new Float64Array(), y: new Float64Array(), theta: new Float64Array() },
      chunks: [],
      ends: new Int32Array(),
      starts: new Uint8Array(),
      full: svg("path", { class: "rp-trace rp-full", d: "" }, parent),
      done: svg("g", {}, parent),
      traveled: svg("path", { class: "rp-trace", d: "" }, parent),
      shown: 0,
    });
    this.traces = { raw: trace(raw), robot: trace(robot) };
    this.visionAll = svg("path", { class: "rp-dots rp-full", d: "" }, vision);
    this.visionPast = svg("path", { class: "rp-dots", d: "" }, vision);
    this.crosshair = svg("g", { class: "rp-crosshair" }, target);
    svg("circle", { cx: 0, cy: 0, r: 1.7 }, this.crosshair);
    svg("line", { x1: -3.4, y1: 0, x2: 3.4, y2: 0 }, this.crosshair);
    svg("line", { x1: 0, y1: -3.4, x2: 0, y2: 3.4 }, this.crosshair);
    this.ray = svg("line", { class: "rp-ray" }, target);
    this.ghost = robotGlyph(ghost, "robot rp-ghost");
    this.robot = robotGlyph(body, "robot rp-body");
  }

  load(log: ReplayLog, robot: RobotConfig, options: ReplayOptions): void {
    this.log = log;
    this.headings = options.headings;
    for (const [id, nodes] of Object.entries(this.groups)) {
      for (const node of nodes) node.setAttribute("style", `--c: var(--series-${options.slots[id as FieldSeriesId]})`);
    }
    this.resize(robot);

    const resetTimes = log.resets.map((reset) => reset.t);
    for (const [id, series] of [
      ["robot", log.poses.robot],
      ["raw", log.poses.raw],
    ] as const) {
      const trace = this.traces[id];
      Object.assign(trace, { series, shown: 0 }, buildTrace(series, id === "robot" ? resetTimes : []));
      trace.full.setAttribute("d", trace.chunks.join(""));
      trace.done.replaceChildren(...trace.chunks.slice(0, -1).map((d) => svg("path", { class: "rp-trace", d, display: "none" })));
      trace.traveled.setAttribute("d", "");
    }

    const vision = log.poses.vision;
    this.visionDots = [];
    for (let i = 0; i < vision.t.length; i++) {
      this.visionDots.push(Number.isFinite(vision.x[i]) && Number.isFinite(vision.y[i]) ? dot(vision.x[i], vision.y[i]) : "");
    }
    this.visionAll.setAttribute("d", this.visionDots.join(""));
    this.visionShown = -1;

    this.jumps.replaceChildren();
    for (const reset of options.resets) {
      if (![reset.from.x, reset.from.y, reset.to.x, reset.to.y].every(Number.isFinite)) continue;
      const g = svg("g", { class: "rp-jump" }, this.jumps);
      const line = { x1: fmt(reset.from.x), y1: fmt(-reset.from.y), x2: fmt(reset.to.x), y2: fmt(-reset.to.y) };
      svg("line", { ...line, class: "rp-jump-hit" }, g);
      svg("line", { ...line, class: "reset-jump" }, g);
      svg("circle", { cx: line.x2, cy: line.y2, r: 0.8, class: "reset-dot" }, g);
      const jump = Math.hypot(reset.to.x - reset.from.x, reset.to.y - reset.from.y);
      const title = svg("title", {}, g);
      title.textContent = `Reset #${reset.index + 1} · ${reset.source || "unknown source"}\n${jump.toFixed(1)} in at ${reset.t.toFixed(2)} s`;
    }
  }

  resize(robot: RobotConfig): void {
    sizeRobot(this.ghost, robot);
    sizeRobot(this.robot, robot);
  }

  setPlanned(result: SimResult | null): void {
    if (!result || result.frameCount === 0) {
      this.planned.setAttribute("d", "");
      return;
    }
    const parts: string[] = [];
    for (let i = 0; i < result.frameCount; i += 3) parts.push(`${i === 0 ? "M" : "L"}${fmt(result.x[i])},${fmt(-result.y[i])}`);
    this.planned.setAttribute("d", parts.join(""));
  }

  setHidden(id: FieldSeriesId, hidden: boolean): void {
    for (const node of this.groups[id]) node.classList.toggle("is-off", hidden);
  }

  showTime(time: number): void {
    const log = this.log;
    if (!log) return;
    const robotPose = poseAt(log.poses.robot, time);
    placeRobot(this.robot, robotPose);
    placeRobot(this.ghost, poseAt(log.poses.raw, time));
    this.advance(this.traces.robot, time, robotPose);
    this.advance(this.traces.raw, time, poseAt(log.poses.raw, time));

    const shown = sampleIndex(log.poses.vision.t, time) + 1;
    if (shown !== this.visionShown) {
      this.visionShown = shown;
      this.visionPast.setAttribute("d", this.visionDots.slice(0, shown).join(""));
    }
    this.showTarget(motionAt(log, time), robotPose);
  }

  private advance(trace: Trace, time: number, pose: Pose | null): void {
    const i = sampleIndex(trace.series.t, time);
    const chunk = i < 0 ? 0 : Math.floor(i / CHUNK);
    if (chunk !== trace.shown) {
      const paths = trace.done.children;
      for (let k = Math.min(chunk, trace.shown); k < Math.max(chunk, trace.shown); k++) {
        if (k < chunk) paths[k]?.removeAttribute("display");
        else paths[k]?.setAttribute("display", "none");
      }
      trace.shown = chunk;
    }
    if (i < 0) {
      trace.traveled.setAttribute("d", "");
      return;
    }
    let d = trace.chunks[chunk].slice(0, trace.ends[i]);
    if (pose && i + 1 < trace.starts.length && !trace.starts[i + 1] && Number.isFinite(pose.x)) d += `L${fmt(pose.x)},${fmt(-pose.y)}`;
    trace.traveled.setAttribute("d", d);
  }

  private showTarget(motion: MotionEvent | undefined, robot: Pose | null): void {
    const target = motion?.target;
    const point = target && Number.isFinite(target.x) && Number.isFinite(target.y) ? target : null;
    if (point) this.crosshair.setAttribute("transform", `translate(${fmt(point.x)} ${fmt(-point.y)})`);
    this.crosshair.setAttribute("visibility", point ? "visible" : "hidden");

    const heading = motion ? (Number.isFinite(target?.theta) ? target!.theta : this.headings[motion.index]) : Number.NaN;
    const from = motion?.kind === 2 ? point : robot;
    if (!motion || !from || !Number.isFinite(heading)) {
      this.ray.setAttribute("visibility", "hidden");
      return;
    }
    const a = (heading * Math.PI) / 180;
    this.ray.setAttribute("visibility", "visible");
    this.ray.setAttribute("x1", fmt(from.x));
    this.ray.setAttribute("y1", fmt(-from.y));
    this.ray.setAttribute("x2", fmt(from.x + Math.sin(a) * RAY_IN));
    this.ray.setAttribute("y2", fmt(-(from.y + Math.cos(a) * RAY_IN)));
  }
}
