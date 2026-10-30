import { toRadians, wrap180 } from "../core/angle";
import { headingTo } from "../core/geometry";
import type { Pose } from "../core/geometry";
import { KEY, LEFT_DRIVE, MOTORS, RIGHT_DRIVE } from "./keys";
import { channel, channelKey, phaseAt, poseAt, sampleIndex, valueAt } from "./model";
import type { MotionEvent, PoseReset, PoseSeries, ReplayLog, Series } from "./model";

export interface MotionStats {
  motion: MotionEvent;
  duration: number;
  timedOut: boolean;
  chained: boolean;
  start: Pose | null;
  end: Pose | null;
  targetHeading: number;
  positionError: number;
  headingError: number;
  overshoot: number;
  overshootUnit: "in" | "deg";
  reach: number;
  peakSpeed: number;
  peakTurnRate: number;
  pathDeviation: number;
  travelRatio: number;
}

export interface ResetStats {
  reset: PoseReset;
  dx: number;
  dy: number;
  dtheta: number;
  jump: number;
  traveled: number;
  turned: number;
  driftPer100: number;
  headingPer360: number;
  rawDrift: number;
  headingKept: boolean;
  initial: boolean;
}

export interface MotorStats {
  name: string;
  peakTemp: number;
  avgTemp: number;
  peakCurrent: number;
  overTempTime: number;
  overCurrentTime: number;
  avgEfficiency: number;
}

export interface MechanismStats {
  name: string;
  moves: number;
  medianSettle: number;
  maxSettle: number;
  unsettled: number;
  steadyError: number;
}

export interface Fit {
  scale: number;
  explained: number;
  count: number;
}

export interface OdometryHealth {
  stationaryTime: number;
  imuDriftRate: number;
  worstImuDriftRate: number;
  creepRate: number;
  travelRatio: number;
  travelRatioRange: [number, number];
  slipMotions: number[];
  turnRateRatio: number;
  effectiveTrackWidth: number;
  horizontalOffset: number;
  verticalOffset: number;
  linearScale: Fit;
  headingScale: Fit;
}

export interface BatteryStats {
  start: number;
  min: number;
  minAt: number;
  end: number;
  sag: number;
  peakCurrent: number;
  capacityStart: number;
  capacityEnd: number;
}

export interface Finding {
  severity: "high" | "medium" | "info";
  text: string;
}

export interface Constants {
  trackWidth: number;
  driveWheelDiameter: number;
  driveRpm: number;
  cartridgeRpm: number;
  trackingWheelDiameter: number;
  verticalOffset: number;
  horizontalOffset: number;
  assumed: string[];
}

export interface LogSummary {
  duration: number;
  motions: number;
  timedOut: number;
  resets: number;
  maxJump: number;
  maxRawDrift: number;
  batteryMin: number;
}

export interface LogAnalysis {
  markdown: string;
  csv: string;
  summary: LogSummary;
  findings: Finding[];
  motions: MotionStats[];
  resets: ResetStats[];
  motors: MotorStats[];
  mechanisms: MechanismStats[];
  odometry: OdometryHealth;
  battery: BatteryStats;
  constants: Constants;
  vision: { fixes: number; meanResidual: number; maxResidual: number };
  logger: { dropped: number; overruns: number; bytes: number };
}

export interface AnalyzeOptions {
  name?: string;
  csv?: boolean;
  csvRateHz?: number;
}

const TIMEOUT_SLACK_S = 0.02;
const RESET_GRACE_S = 0.03;
const MAX_CSV_ROWS = 360_000;
const REACH_IN = 1;
const REACH_DEG = 1;
const STILL_SPEED = 0.3;
const STILL_RPM = 3;
const STILL_MIN_S = 2;
const HOT_C = 55;
const LINEAR_KINDS = new Set([1, 2]);
const TURN_KINDS = new Set([3, 4, 5, 6, 7]);
const POINT_HEADING_KINDS = new Set([3, 5]);
const FORWARDS_KINDS = new Set([1, 2, 3, 5, 7]);

export function reportFileNames(logName: string): { report: string; csv: string } {
  const base = logName.replace(/\.wpilog$/i, "");
  return { report: `${base}.report.md`, csv: `${base}.signals.csv` };
}

function num(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const text = value.toFixed(digits);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

const signed = (value: number, digits = 1): string => (Number.isFinite(value) && value > 0 ? `+${num(value, digits)}` : num(value, digits));
const pct = (ratio: number, digits = 1): string => (Number.isFinite(ratio) ? `${signed(ratio * 100, digits)}%` : "—");

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function seriesMax(series: Series | undefined, from = -Infinity, to = Infinity): { value: number; at: number } {
  let value = Number.NaN;
  let at = Number.NaN;
  if (!series) return { value, at };
  for (let i = 0; i < series.t.length; i++) {
    const t = series.t[i];
    if (t < from || t > to) continue;
    const v = series.v[i];
    if (Number.isFinite(v) && !(v <= value)) {
      value = v;
      at = t;
    }
  }
  return { value, at };
}

function timeWhere(series: Series | undefined, end: number, test: (v: number) => boolean): number {
  if (!series) return 0;
  let total = 0;
  for (let i = 0; i < series.t.length; i++) {
    if (!test(series.v[i])) continue;
    const next = i + 1 < series.t.length ? series.t[i + 1] : end;
    total += Math.max(0, next - series.t[i]);
  }
  return total;
}

function timeAverage(series: Series | undefined, end: number, keep: (i: number) => boolean = () => true): number {
  if (!series) return Number.NaN;
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < series.t.length; i++) {
    const v = series.v[i];
    if (!Number.isFinite(v) || !keep(i)) continue;
    const next = i + 1 < series.t.length ? series.t[i + 1] : end;
    const w = Math.max(next - series.t[i], 1e-3);
    sum += v * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : Number.NaN;
}

function unitScale(series: Series | undefined, threshold: number, declared?: string): number {
  if (declared === "A" || declared === "V") return 1;
  if (declared === "mA" || declared === "mV") return 1 / 1000;
  const peak = seriesMax(series ? { ...series, v: series.v.map(Math.abs) } : undefined).value;
  return Number.isFinite(peak) && peak > threshold ? 1 / 1000 : 1;
}

function metaNumber(log: ReplayLog, sections: RegExp, keys: string[]): number {
  const wanted = keys.map((key) => key.toLowerCase());
  const names = Object.keys(log.metadata);
  const scopes: Array<[string[], string[]]> = [
    [names.filter((name) => sections.test(name)), wanted],
    [names, wanted.slice(0, 1)],
  ];
  for (const [scope, aliases] of scopes) {
    for (const key of aliases) {
      for (const name of scope) {
        for (const [k, v] of Object.entries(log.metadata[name])) {
          if (k.toLowerCase() === key && Number.isFinite(Number.parseFloat(v))) return Number.parseFloat(v);
        }
      }
    }
  }
  return Number.NaN;
}

function readConstants(log: ReplayLog): Constants {
  const assumed: string[] = [];
  const pick = (label: string, fallback: number, sections: RegExp, keys: string[]): number => {
    const value = metaNumber(log, sections, keys);
    if (Number.isFinite(value)) return value;
    assumed.push(`${label}=${fallback}`);
    return fallback;
  };
  return {
    trackWidth: pick("trackWidth", 12.5, /drive/i, ["trackWidth", "track"]),
    driveWheelDiameter: pick("driveWheelDiameter", 3.25, /drive/i, ["driveWheelDiameter", "wheelDiameter", "wheel"]),
    driveRpm: pick("driveRpm", 360, /drive/i, ["driveRpm", "rpm"]),
    cartridgeRpm: pick("cartridgeRpm", 600, /drive/i, ["cartridgeRpm", "cartridge", "gearset"]),
    trackingWheelDiameter: pick("trackingWheelDiameter", 2, /odom|tracking/i, ["trackingWheelDiameter", "wheelDiameter", "diameter"]),
    verticalOffset: pick("verticalOffset", 0.5, /odom|tracking/i, ["verticalOffset", "vertical"]),
    horizontalOffset: pick("horizontalOffset", -0.7, /odom|tracking/i, ["horizontalOffset", "horizontal"]),
    assumed,
  };
}

interface Kinematics {
  pose: PoseSeries;
  valid: Uint8Array;
  speed: Float64Array;
  turnRate: Float64Array;
  distance: Float64Array;
  turned: Float64Array;
}

function kinematics(pose: PoseSeries, resets: PoseReset[]): Kinematics {
  const n = pose.t.length;
  const valid = new Uint8Array(n);
  const speed = new Float64Array(n);
  const turnRate = new Float64Array(n);
  const distance = new Float64Array(n);
  const turned = new Float64Array(n);
  let r = 0;
  for (let i = 1; i < n; i++) {
    const t0 = pose.t[i - 1];
    const t1 = pose.t[i];
    while (r < resets.length && resets[r].t <= t0) r++;
    const jumped = r < resets.length && resets[r].t <= t1;
    const dt = t1 - t0;
    const ds = Math.hypot(pose.x[i] - pose.x[i - 1], pose.y[i] - pose.y[i - 1]);
    const dtheta = pose.theta[i] - pose.theta[i - 1];
    const ok = !jumped && dt > 0 && dt <= 0.25 && Number.isFinite(ds) && Number.isFinite(dtheta);
    valid[i] = ok ? 1 : 0;
    speed[i] = ok ? ds / dt : Number.NaN;
    turnRate[i] = ok ? dtheta / dt : Number.NaN;
    distance[i] = distance[i - 1] + (ok ? ds : 0);
    turned[i] = turned[i - 1] + (ok ? Math.abs(dtheta) : 0);
  }
  return { pose, valid, speed, turnRate, distance, turned };
}

function cumulativeAt(values: Float64Array, times: Float64Array, t: number): number {
  const i = sampleIndex(times, t);
  return i < 0 ? 0 : values[i];
}

function poseNear(pose: PoseSeries, resets: PoseReset[], t: number): Pose | null {
  const i = sampleIndex(pose.t, t);
  if (i < 0) return null;
  const t0 = pose.t[i];
  const t1 = i + 1 < pose.t.length ? pose.t[i + 1] : Number.POSITIVE_INFINITY;
  let before: PoseReset | undefined;
  let after: PoseReset | undefined;
  for (const reset of resets) {
    if (reset.t <= t0 || reset.t > t1) continue;
    if (reset.t <= t) before = reset;
    else after ??= reset;
  }
  if (!before && !after) return poseAt(pose, t);
  const sample = (k: number): Pose => ({ x: pose.x[k], y: pose.y[k], theta: pose.theta[k] });
  const a = before ? { t: before.t, p: before.to } : { t: t0, p: sample(i) };
  const b = after ? { t: after.t, p: after.from } : Number.isFinite(t1) ? { t: t1, p: sample(i + 1) } : null;
  if (!b || b.t <= a.t) return a.p;
  const f = (t - a.t) / (b.t - a.t);
  return { x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f, theta: a.p.theta + wrap180(b.p.theta - a.p.theta) * f };
}

function targetHeadingOf(motion: MotionEvent, at: Pose | null): number {
  if (POINT_HEADING_KINDS.has(motion.kind)) {
    if (!at || !Number.isFinite(motion.target.x) || !Number.isFinite(motion.target.y)) return Number.NaN;
    return headingTo(at, motion.target) + (motion.forwards ? 0 : 180);
  }
  return motion.target.theta;
}

function wheelInches(series: Series | undefined, diameter: number, from: number, to: number): number {
  const delta = valueAt(series, to) - valueAt(series, from);
  return (delta / 100 / 360) * Math.PI * diameter;
}

function driveInches(log: ReplayLog, constants: Constants, from: number, to: number): number {
  const sides = [LEFT_DRIVE, RIGHT_DRIVE].map((names) => {
    const deltas = names
      .map((name) => valueAt(channel(log, `/Motors/${name}/position`), to) - valueAt(channel(log, `/Motors/${name}/position`), from))
      .filter(Number.isFinite);
    return deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : Number.NaN;
  });
  const degrees = (sides[0] + sides[1]) / 2;
  return (degrees / 360) * (constants.driveRpm / constants.cartridgeRpm) * Math.PI * constants.driveWheelDiameter;
}

function analyzeMotion(log: ReplayLog, kin: Kinematics, motion: MotionEvent, constants: Constants): MotionStats {
  const pose = kin.pose;
  const resets = log.resets;
  const lead = resets.filter((reset) => reset.t > motion.t && reset.t <= Math.min(motion.end, motion.t + RESET_GRACE_S)).at(-1);
  const begin = lead ? lead.t : motion.t;
  const start = poseNear(pose, resets, begin);
  const cut = resets.find((reset) => reset.t > begin + 1e-6 && reset.t <= motion.end);
  const stop = cut ? cut.t : motion.end;
  const beforeCut = cut ? sampleIndex(pose.t, cut.t - 1e-6) : -1;
  const end = cut ? cut.from : poseNear(pose, resets, motion.end);
  const duration = motion.end - motion.t;
  const timedOut = motion.endReason !== "log-end" && Number.isFinite(motion.timeoutMs) && duration >= motion.timeoutMs / 1000 - TIMEOUT_SLACK_S;
  const linear = LINEAR_KINDS.has(motion.kind);
  const turn = TURN_KINDS.has(motion.kind);
  const target = motion.target;
  const targetHeading = turn || motion.kind === 2 ? targetHeadingOf(motion, motion.kind === 5 ? end : start) : Number.NaN;
  const positionError = linear && end ? Math.hypot(target.x - end.x, target.y - end.y) : Number.NaN;
  const headingError = Number.isFinite(targetHeading) && end ? wrap180(targetHeading - end.theta) : Number.NaN;

  let overshoot = Number.NaN;
  let reach = Number.NaN;
  let peakSpeed = Number.NaN;
  let peakTurnRate = Number.NaN;
  let pathDeviation = Number.NaN;
  const first = Math.max(0, sampleIndex(pose.t, begin));
  const last = cut ? beforeCut : sampleIndex(pose.t, stop);
  const ux = start ? target.x - start.x : Number.NaN;
  const uy = start ? target.y - start.y : Number.NaN;
  const length = Math.hypot(ux, uy);
  const turnStart = start && Number.isFinite(targetHeading) ? wrap180(targetHeading - start.theta) : Number.NaN;
  const turnSign = Math.abs(turnStart) > 0.5 ? Math.sign(turnStart) : 0;
  for (let i = first; i <= last && i < pose.t.length; i++) {
    if (pose.t[i] < begin) continue;
    if (kin.valid[i]) {
      peakSpeed = Math.max(Number.isFinite(peakSpeed) ? peakSpeed : 0, kin.speed[i]);
      peakTurnRate = Math.max(Number.isFinite(peakTurnRate) ? peakTurnRate : 0, Math.abs(kin.turnRate[i]));
    }
    const elapsed = pose.t[i] - motion.t;
    if (linear && length > 1e-6) {
      const px = pose.x[i] - target.x;
      const py = pose.y[i] - target.y;
      const past = (px * ux + py * uy) / length;
      overshoot = Math.max(Number.isFinite(overshoot) ? overshoot : 0, past);
      if (motion.kind === 1) {
        const off = Math.abs(((pose.x[i] - start!.x) * uy - (pose.y[i] - start!.y) * ux) / length);
        pathDeviation = Math.max(Number.isFinite(pathDeviation) ? pathDeviation : 0, off);
      }
      if (!Number.isFinite(reach) && Math.hypot(px, py) < REACH_IN) reach = elapsed;
    } else if (turn && Number.isFinite(targetHeading)) {
      const heading = motion.kind === 5 ? targetHeadingOf(motion, { x: pose.x[i], y: pose.y[i], theta: 0 }) : targetHeading;
      const error = wrap180(heading - pose.theta[i]);
      if (turnSign !== 0) overshoot = Math.max(Number.isFinite(overshoot) ? overshoot : 0, -turnSign * error);
      if (!Number.isFinite(reach) && Math.abs(error) < REACH_DEG) reach = elapsed;
    }
  }
  if (linear && length <= 1e-6) overshoot = Number.NaN;

  let travelRatio = Number.NaN;
  if (linear) {
    const tracking = Math.abs(wheelInches(channel(log, `${KEY.verticalWheel}/position`), constants.trackingWheelDiameter, motion.t, motion.end));
    const drive = Math.abs(driveInches(log, constants, motion.t, motion.end));
    if (tracking > 3) travelRatio = drive / tracking;
  }

  return {
    motion,
    duration,
    timedOut,
    chained: motion.minSpeed > 0 || motion.earlyExit > 0,
    start,
    end,
    targetHeading,
    positionError,
    headingError,
    overshoot,
    overshootUnit: linear ? "in" : "deg",
    reach,
    peakSpeed,
    peakTurnRate,
    pathDeviation,
    travelRatio,
  };
}

function analyzeResets(log: ReplayLog, kin: Kinematics): ResetStats[] {
  const pose = kin.pose;
  return log.resets.map((reset, i) => {
    const previous = i > 0 ? log.resets[i - 1].t : (pose.t[0] ?? 0);
    const traveled = cumulativeAt(kin.distance, pose.t, reset.t) - cumulativeAt(kin.distance, pose.t, previous);
    const turned = cumulativeAt(kin.turned, pose.t, reset.t) - cumulativeAt(kin.turned, pose.t, previous);
    const dx = reset.to.x - reset.from.x;
    const dy = reset.to.y - reset.from.y;
    const dtheta = wrap180(reset.to.theta - reset.from.theta);
    const jump = Math.hypot(dx, dy);
    const initial = i === 0 || traveled < 1;
    const headingKept = reset.to.theta === reset.from.theta;
    const below = sampleIndex(pose.t, reset.t);
    const after = below >= 0 && pose.t[below] === reset.t ? below : below + 1;
    const raw = after < pose.t.length ? poseAt(log.poses.raw, pose.t[after]) : null;
    return {
      reset,
      dx,
      dy,
      dtheta,
      jump,
      traveled,
      turned,
      driftPer100: initial || traveled < 6 ? Number.NaN : (jump / traveled) * 100,
      headingPer360: initial || headingKept || turned < 45 ? Number.NaN : (dtheta / turned) * 360,
      rawDrift: raw ? Math.hypot(raw.x - pose.x[after], raw.y - pose.y[after]) : Number.NaN,
      headingKept,
      initial,
    };
  });
}

function fitThroughOrigin(pairs: Array<{ error: number[]; driven: number[] }>, minNorm: number): Fit {
  let dot = 0;
  let norm = 0;
  let total = 0;
  for (const { error, driven } of pairs) {
    error.forEach((e, i) => {
      dot += e * driven[i];
      norm += driven[i] * driven[i];
      total += e * e;
    });
  }
  if (pairs.length < 2 || norm < minNorm) return { scale: Number.NaN, explained: Number.NaN, count: pairs.length };
  const scale = dot / norm;
  let residual = 0;
  for (const { error, driven } of pairs) error.forEach((e, i) => (residual += (e - scale * driven[i]) ** 2));
  return { scale, explained: total > 0 ? 1 - residual / total : Number.NaN, count: pairs.length };
}

function scaleFits(log: ReplayLog, resets: ResetStats[]): { linear: Fit; heading: Fit } {
  const linear: Array<{ error: number[]; driven: number[] }> = [];
  const heading: Array<{ error: number[]; driven: number[] }> = [];
  for (let i = 1; i < resets.length; i++) {
    const stats = resets[i];
    if (stats.initial) continue;
    const before = log.resets[i - 1].to;
    const from = stats.reset.from;
    const dx = from.x - before.x;
    const dy = from.y - before.y;
    if (Math.hypot(dx, dy) >= 6) linear.push({ error: [stats.dx, stats.dy], driven: [dx, dy] });
    const rotated = from.theta - before.theta;
    if (!stats.headingKept && Math.abs(rotated) >= 45) heading.push({ error: [stats.dtheta], driven: [rotated] });
  }
  return { linear: fitThroughOrigin(linear, 24 * 24), heading: fitThroughOrigin(heading, 90 * 90) };
}

function wheelSideRpm(log: ReplayLog, names: string[], t: number): number {
  const values = names.map((name) => valueAt(channel(log, `/Motors/${name}/velocity`), t)).filter(Number.isFinite);
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
}

function odometryHealth(log: ReplayLog, kin: Kinematics, motions: MotionStats[], resets: ResetStats[], constants: Constants): OdometryHealth {
  const pose = kin.pose;
  const imu = channel(log, `${KEY.imu}/rotation`);
  const headingOf = (t: number): number => (imu ? valueAt(imu, t) : (poseNear(pose, log.resets, t)?.theta ?? Number.NaN));
  const rpmToIps = (rpm: number) => (rpm / 60) * (constants.driveRpm / constants.cartridgeRpm) * Math.PI * constants.driveWheelDiameter;

  let stationaryTime = 0;
  let driftSum = 0;
  let creepSum = 0;
  let worst = Number.NaN;
  let windowStart = -1;
  const closeWindow = (endIndex: number) => {
    if (windowStart < 0) return;
    const a = pose.t[windowStart];
    const b = pose.t[endIndex];
    windowStart = -1;
    if (b - a < STILL_MIN_S) return;
    const drift = headingOf(b) - headingOf(a);
    const creep = Math.hypot(pose.x[endIndex] - pose.x[sampleIndex(pose.t, a)], pose.y[endIndex] - pose.y[sampleIndex(pose.t, a)]);
    if (!Number.isFinite(drift)) return;
    stationaryTime += b - a;
    driftSum += drift;
    creepSum += Number.isFinite(creep) ? creep : 0;
    const rate = Math.abs(drift / (b - a)) * 60;
    worst = Number.isFinite(worst) ? Math.max(worst, rate) : rate;
  };
  for (let i = 1; i < pose.t.length; i++) {
    const t = pose.t[i];
    const motorsStill = [...LEFT_DRIVE, ...RIGHT_DRIVE].every((name) => {
      const v = valueAt(channel(log, `/Motors/${name}/velocity`), t);
      return !Number.isFinite(v) || Math.abs(v) < STILL_RPM;
    });
    const still = kin.valid[i] === 1 && kin.speed[i] < STILL_SPEED && Math.abs(kin.turnRate[i]) < 1 && motorsStill;
    if (still && windowStart < 0) windowStart = i - 1;
    if (!still) closeWindow(i - 1);
  }
  closeWindow(pose.t.length - 1);

  const ratios = motions.filter((m) => Number.isFinite(m.travelRatio)).map((m) => m.travelRatio);
  const travelRatio = median(ratios);
  const slipMotions = motions
    .filter((m) => Number.isFinite(m.travelRatio) && Math.abs(m.travelRatio / travelRatio - 1) > 0.08)
    .map((m) => m.motion.index + 1);

  let wDot = 0;
  let wNorm = 0;
  let hDot = 0;
  let vDot = 0;
  let thetaNorm = 0;
  const vertical = channel(log, `${KEY.verticalWheel}/position`);
  const horizontal = channel(log, `${KEY.horizontalWheel}/position`);
  for (const stats of motions) {
    if (!TURN_KINDS.has(stats.motion.kind) || stats.motion.kind === 5 || stats.motion.kind === 6 || stats.motion.kind === 7) continue;
    const a = stats.motion.t;
    const b = stats.motion.end;
    for (let i = Math.max(1, sampleIndex(pose.t, a)); i < pose.t.length && pose.t[i] <= b; i++) {
      if (!kin.valid[i]) continue;
      const t = pose.t[i];
      const imuRate = imu ? (valueAt(imu, t) - valueAt(imu, pose.t[i - 1])) / (t - pose.t[i - 1]) : kin.turnRate[i];
      if (!Number.isFinite(imuRate) || Math.abs(imuRate) < 30) continue;
      const left = rpmToIps(wheelSideRpm(log, LEFT_DRIVE, t));
      const right = rpmToIps(wheelSideRpm(log, RIGHT_DRIVE, t));
      const wheelRate = ((left - right) / constants.trackWidth) * (180 / Math.PI);
      if (!Number.isFinite(wheelRate)) continue;
      wDot += wheelRate * imuRate;
      wNorm += imuRate * imuRate;
    }
    const turnedRad = toRadians(headingOf(b) - headingOf(a));
    if (Math.abs(turnedRad) < toRadians(20)) continue;
    const travel = Math.hypot((stats.end?.x ?? 0) - (stats.start?.x ?? 0), (stats.end?.y ?? 0) - (stats.start?.y ?? 0));
    if (travel > 1.5) continue;
    hDot += wheelInches(horizontal, constants.trackingWheelDiameter, a, b) * turnedRad;
    vDot += wheelInches(vertical, constants.trackingWheelDiameter, a, b) * turnedRad;
    thetaNorm += turnedRad * turnedRad;
  }
  const turnRateRatio = wNorm > 0 ? wDot / wNorm : Number.NaN;
  const fits = scaleFits(log, resets);

  return {
    stationaryTime,
    imuDriftRate: stationaryTime > 0 ? (driftSum / stationaryTime) * 60 : Number.NaN,
    worstImuDriftRate: worst,
    creepRate: stationaryTime > 0 ? (creepSum / stationaryTime) * 60 : Number.NaN,
    travelRatio,
    travelRatioRange: ratios.length > 0 ? [Math.min(...ratios), Math.max(...ratios)] : [Number.NaN, Number.NaN],
    slipMotions,
    turnRateRatio,
    effectiveTrackWidth: constants.trackWidth * turnRateRatio,
    horizontalOffset: thetaNorm > 0 && horizontal ? Math.abs(hDot / thetaNorm) : Number.NaN,
    verticalOffset: thetaNorm > 0 && vertical ? Math.abs(vDot / thetaNorm) : Number.NaN,
    linearScale: fits.linear,
    headingScale: fits.heading,
  };
}

function motorNames(log: ReplayLog): string[] {
  const found = new Set<string>(MOTORS);
  for (const key of log.channels.keys()) {
    const match = /^Motors\/([^/]+)\//.exec(key);
    if (match) found.add(match[1]);
  }
  return [...found].filter((name) => [...log.channels.keys()].some((key) => key.startsWith(`Motors/${name}/`)));
}

function analyzeMotors(log: ReplayLog): MotorStats[] {
  return motorNames(log).map((name) => {
    const at = (field: string) => log.channels.get(`Motors/${name}/${field}`);
    const temperature = at("Health/temperature");
    const current = at("current");
    const velocity = at("velocity");
    const efficiency = at("Health/efficiency");
    const scale = unitScale(current, 20, log.metadata.Units?.motorCurrent);
    return {
      name,
      peakTemp: seriesMax(temperature).value,
      avgTemp: timeAverage(temperature, log.duration),
      peakCurrent: seriesMax(current ? { ...current, v: current.v.map(Math.abs) } : undefined).value * scale,
      overTempTime: timeWhere(at("Health/overTemp"), log.duration, (v) => v >= 0.5),
      overCurrentTime: timeWhere(at("Health/overCurrent"), log.duration, (v) => v >= 0.5),
      avgEfficiency: timeAverage(efficiency, log.duration, (i) => !velocity || Math.abs(valueAt(velocity, efficiency!.t[i])) > 5),
    };
  });
}

function analyzeMechanisms(log: ReplayLog): MechanismStats[] {
  const out: MechanismStats[] = [];
  for (const key of [KEY.elevator, KEY.pivot]) {
    const base = channelKey(key);
    const target = log.channels.get(`${base}/target`);
    const position = log.channels.get(`${base}/position`);
    const settled = log.channels.get(`${base}/settled`);
    if (!target || !position) continue;
    const changes: number[] = [];
    for (let i = 1; i < target.t.length; i++) {
      if (Math.abs(target.v[i] - target.v[i - 1]) > 1e-6) changes.push(target.t[i]);
    }
    const settles: number[] = [];
    let unsettled = 0;
    changes.forEach((t, k) => {
      const until = k + 1 < changes.length ? changes[k + 1] : log.duration;
      let seenMoving = false;
      let done = Number.NaN;
      for (let i = Math.max(0, sampleIndex(position.t, t)); i < position.t.length && position.t[i] <= until; i++) {
        const time = position.t[i];
        if (time < t) continue;
        const ok = settled ? valueAt(settled, time) >= 0.5 : Math.abs(valueAt(target, time) - position.v[i]) < Math.max(1, Math.abs(target.v[0]) * 0.02);
        if (!ok) seenMoving = true;
        else if (seenMoving) {
          done = time - t;
          break;
        }
      }
      if (Number.isFinite(done)) settles.push(done);
      else if (seenMoving) unsettled++;
    });
    const steady: number[] = [];
    if (settled) {
      for (let i = 0; i < position.t.length; i++) {
        if (valueAt(settled, position.t[i]) >= 0.5) steady.push(Math.abs(valueAt(target, position.t[i]) - position.v[i]));
      }
    }
    out.push({
      name: key.split("/").at(-1)!,
      moves: changes.length,
      medianSettle: median(settles),
      maxSettle: settles.length > 0 ? Math.max(...settles) : Number.NaN,
      unsettled,
      steadyError: steady.length > 0 ? Math.max(...steady) : Number.NaN,
    });
  }
  return out;
}

function analyzeBattery(log: ReplayLog): BatteryStats {
  const voltage = channel(log, `${KEY.battery}/voltage`);
  const current = channel(log, `${KEY.battery}/current`);
  const capacity = channel(log, `${KEY.battery}/capacity`);
  const vScale = unitScale(voltage, 100, log.metadata.Units?.batteryVoltage);
  const enabled = log.phases.filter((phase) => phase.kind !== "disabled");
  const firstEnabled = enabled[0]?.start ?? 0;
  let start = Number.NaN;
  let min = Number.NaN;
  let minAt = Number.NaN;
  if (voltage) {
    const rest = [];
    for (let i = 0; i < voltage.t.length && voltage.t[i] <= firstEnabled; i++) rest.push(voltage.v[i]);
    start = (rest.length > 0 ? rest[rest.length - 1] : voltage.v[0]) * vScale;
    const lowest = { value: Number.POSITIVE_INFINITY, at: Number.NaN };
    for (let i = 0; i < voltage.t.length; i++) {
      const v = voltage.v[i];
      if (Number.isFinite(v) && v < lowest.value) {
        lowest.value = v;
        lowest.at = voltage.t[i];
      }
    }
    min = lowest.value * vScale;
    minAt = lowest.at;
  }
  const end = voltage ? voltage.v[voltage.v.length - 1] * vScale : Number.NaN;
  return {
    start,
    min,
    minAt,
    end,
    sag: start - min,
    peakCurrent: seriesMax(current ? { ...current, v: current.v.map(Math.abs) } : undefined).value * unitScale(current, 50, log.metadata.Units?.batteryCurrent),
    capacityStart: capacity ? capacity.v[0] : Number.NaN,
    capacityEnd: capacity ? capacity.v[capacity.v.length - 1] : Number.NaN,
  };
}

function analyzeVision(log: ReplayLog): LogAnalysis["vision"] {
  const vision = log.poses.vision;
  const residuals: number[] = [];
  for (let i = 0; i < vision.t.length; i++) {
    const robot = poseNear(log.poses.robot, log.resets, vision.t[i]);
    if (robot) residuals.push(Math.hypot(vision.x[i] - robot.x, vision.y[i] - robot.y));
  }
  return {
    fixes: vision.t.length,
    meanResidual: residuals.length > 0 ? residuals.reduce((a, b) => a + b, 0) / residuals.length : Number.NaN,
    maxResidual: residuals.length > 0 ? Math.max(...residuals) : Number.NaN,
  };
}

function lastValue(log: ReplayLog, key: string): number {
  const series = channel(log, key);
  return series && series.v.length > 0 ? series.v[series.v.length - 1] : Number.NaN;
}

function where(source: { source: string; file: string | null; line: number | null }): string {
  if (!source.file) return source.source || "?";
  const short = source.file.replace(/^.*?src\//, "").replace(/^autons\//, "");
  return source.line === null ? short : `${short}:${source.line}`;
}

function targetText(motion: MotionEvent): string {
  const t = motion.target;
  if (motion.kind === 4 || motion.kind === 6 || motion.kind === 7) return `${num(t.theta, 0)}°`;
  if (motion.kind === 2) return `${num(t.x)},${num(t.y)},${num(t.theta, 0)}°`;
  return `${num(t.x)},${num(t.y)}`;
}

function findingsFor(analysis: Omit<LogAnalysis, "markdown" | "csv" | "findings" | "summary">, log: ReplayLog): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], text: string) => findings.push({ severity, text });
  if (log.truncated) add("medium", "The log ends mid-record (robot lost power or the SD card was pulled while writing); the tail is missing.");
  for (const m of analysis.motions.filter((s) => s.timedOut)) {
    const err = Number.isFinite(m.positionError) ? `${num(m.positionError)} in` : `${num(m.headingError)}°`;
    add("high", `Motion #${m.motion.index + 1} ${m.motion.kindName} at ${where(m.motion)} timed out (${num(m.duration, 2)} s of ${num(m.motion.timeoutMs / 1000, 2)} s), ending ${err} off target.`);
  }
  for (const r of analysis.resets.filter((s) => !s.initial && (s.jump >= 2 || Math.abs(s.dtheta) >= 3))) {
    const rate = Number.isFinite(r.driftPer100) ? `, ${num(r.driftPer100)} in per 100 in driven` : "";
    const heading = r.headingKept ? "heading kept" : `${signed(r.dtheta)}°`;
    add(r.jump >= 4 ? "high" : "medium", `Reset #${r.reset.index + 1} at ${where(r.reset)} corrected ${num(r.jump)} in (${heading})${rate}.`);
  }
  const o = analysis.odometry;
  const lin = o.linearScale;
  if (Number.isFinite(lin.scale) && Math.abs(lin.scale) >= 0.02 && lin.count >= 3 && lin.explained >= 0.7) {
    add("medium", `Resets say odometry reads ${num(Math.abs(lin.scale) * 100)}% ${lin.scale > 0 ? "short" : "long"} (fit over ${lin.count} resets explains ${num(lin.explained * 100, 0)}% of the corrections).`);
  }
  const hdg = o.headingScale;
  if (Number.isFinite(hdg.scale) && Math.abs(hdg.scale) >= 0.01 && hdg.count >= 3 && hdg.explained >= 0.7) {
    add("medium", `Resets say heading reads ${num(Math.abs(hdg.scale) * 100)}% ${hdg.scale > 0 ? "short" : "long"} per degree turned (fit over ${hdg.count} resets).`);
  }
  if (Number.isFinite(o.imuDriftRate) && Math.abs(o.imuDriftRate) >= 1) add("medium", `IMU drifts ${num(o.imuDriftRate, 2)}°/min while the robot is still.`);
  if (o.slipMotions.length > 0) add("medium", `Drive encoders and tracking wheel disagree on motions ${o.slipMotions.map((n) => `#${n}`).join(", ")} (wheel slip or a lifted tracking wheel).`);
  if (Number.isFinite(o.turnRateRatio) && Math.abs(o.turnRateRatio - 1) >= 0.1) {
    add("info", `Wheels turn ${num(o.turnRateRatio, 2)}× faster than the IMU sees; effective track width ≈ ${num(o.effectiveTrackWidth, 2)} in.`);
  }
  for (const motor of analysis.motors) {
    if (motor.overTempTime > 0 || motor.peakTemp >= HOT_C) {
      add("high", `${motor.name} motor ran hot: peak ${num(motor.peakTemp, 0)} °C, over-temp for ${num(motor.overTempTime)} s.`);
    }
  }
  const limited = analysis.motors.filter((motor) => motor.overCurrentTime >= 0.5);
  if (limited.length > 0) {
    add("medium", `Motors at their current limit: ${limited.map((motor) => `${motor.name} ${num(motor.overCurrentTime)} s`).join(", ")} (pushing or stalled).`);
  }
  const b = analysis.battery;
  if (Number.isFinite(b.min) && (b.min < 11 || b.sag > 1.5)) add("medium", `Battery sagged to ${num(b.min, 2)} V (from ${num(b.start, 2)} V) at ${num(b.minAt)} s.`);
  if (analysis.logger.dropped > 0) add("medium", `The logger dropped ${analysis.logger.dropped} records (buffer full).`);
  if (analysis.logger.overruns > 0) add("info", `The telemetry loop overran ${analysis.logger.overruns} times.`);
  if (analysis.vision.fixes > 0 && analysis.vision.meanResidual > 3) {
    add("info", `Vision fixes sit ${num(analysis.vision.meanResidual)} in from odometry on average (max ${num(analysis.vision.maxResidual)} in).`);
  }
  const order = { high: 0, medium: 1, info: 2 };
  return findings.sort((a, c) => order[a.severity] - order[c.severity]);
}

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function renderMarkdown(log: ReplayLog, a: Omit<LogAnalysis, "markdown" | "csv" | "summary">, name: string): string {
  const out: string[] = [];
  const records = log.entries.reduce((sum, entry) => sum + entry.count, 0);
  out.push(`# Log report: ${name}`);
  out.push(`${log.header || "no header"} · ${num(log.duration)} s · ${records} records${log.truncated ? " · truncated" : ""}`);
  out.push("Units: inches, degrees (LemLib: 0° = +Y, clockwise +), seconds from the first record.");

  out.push("\n## Findings");
  out.push(a.findings.length > 0 ? a.findings.map((f) => `- **${f.severity}** ${f.text}`).join("\n") : "- Nothing stands out.");

  out.push("\n## Session");
  out.push(table(["phase", "start", "end", "length"], log.phases.map((p) => [p.kind, num(p.start, 2), num(p.end, 2), num(p.end - p.start, 2)])));
  for (const run of log.autons) {
    out.push(`- Auton **${run.name || "?"}**: ${num(run.start, 2)}–${run.end === null ? "log end" : num(run.end, 2)} s`);
  }
  const b = a.battery;
  out.push(`- Battery: ${num(b.start, 2)} V start, ${num(b.min, 2)} V min at ${num(b.minAt)} s, ${num(b.end, 2)} V end, sag ${num(b.sag, 2)} V, peak ${num(b.peakCurrent, 1)} A, charge ${num(b.capacityStart, 0)}→${num(b.capacityEnd, 0)}%`);
  out.push(`- Logger: ${num(a.logger.dropped, 0)} dropped, ${num(a.logger.overruns, 0)} loop overruns, ${num(a.logger.bytes / 1024, 0)} KB`);

  const metadata = Object.entries(log.metadata);
  if (metadata.length > 0 || a.constants.assumed.length > 0) {
    out.push("\n## Robot constants");
    for (const [section, values] of metadata) {
      out.push(`- ${section}: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    if (a.constants.assumed.length > 0) out.push(`- Assumed (missing from metadata): ${a.constants.assumed.join(", ")}`);
  }

  const timedOut = a.motions.filter((m) => m.timedOut).length;
  out.push(`\n## Motions (${a.motions.length}, ${timedOut} timed out)`);
  out.push("time = command to end; reach = first time within 1 in / 1°; err = at the end (+ = target clockwise); over = past the target; dev = max off the straight line; ratio = drive encoders / tracking wheel travel.");
  out.push(
    table(
      ["#", "t", "source", "kind", "target", "time/timeout", "end", "reach", "pos err", "hdg err", "over", "peak in/s", "peak °/s", "dev", "ratio", "notes"],
      a.motions.map((m) => {
        const notes = [
          m.timedOut ? "TIMED OUT" : "",
          m.chained ? `chain(min ${num(m.motion.minSpeed, 0)}, exit ${num(m.motion.earlyExit, 1)})` : "",
          FORWARDS_KINDS.has(m.motion.kind) && !m.motion.forwards ? "back" : "",
          m.motion.maxSpeed < 127 ? `max ${num(m.motion.maxSpeed, 0)}` : "",
        ].filter(Boolean);
        return [
          String(m.motion.index + 1),
          num(m.motion.t, 2),
          where(m.motion),
          m.motion.kindName,
          targetText(m.motion),
          `${num(m.duration, 2)}/${num(m.motion.timeoutMs / 1000, 2)}`,
          m.motion.endReason,
          num(m.reach, 2),
          num(m.positionError, 2),
          signed(m.headingError, 1),
          Number.isFinite(m.overshoot) ? `${num(m.overshoot, m.overshootUnit === "in" ? 2 : 1)}${m.overshootUnit === "in" ? " in" : "°"}` : "—",
          num(m.peakSpeed, 0),
          num(m.peakTurnRate, 0),
          num(m.pathDeviation, 2),
          num(m.travelRatio, 3),
          notes.join(" "),
        ];
      }),
    ),
  );

  out.push(`\n## Pose resets (${a.resets.length})`);
  out.push("jump = to − from (the odometry error this reset removed); travel/turned since the previous reset; raw drift = distance from the uncorrected pose.");
  out.push(
    table(
      ["#", "t", "source", "dx", "dy", "dθ", "jump", "travel", "turned", "in/100 in", "°/360°", "raw drift", "notes"],
      a.resets.map((r) => [
        String(r.reset.index + 1),
        num(r.reset.t, 2),
        where(r.reset),
        signed(r.dx, 2),
        signed(r.dy, 2),
        signed(r.dtheta, 1),
        num(r.jump, 2),
        num(r.traveled, 0),
        num(r.turned, 0),
        num(r.driftPer100, 2),
        signed(r.headingPer360, 2),
        num(r.rawDrift, 1),
        [r.initial ? "start pose" : "", r.headingKept ? "heading kept" : ""].filter(Boolean).join(" "),
      ]),
    ),
  );

  const o = a.odometry;
  const c = a.constants;
  out.push("\n## Odometry health");
  out.push(`- IMU drift while still: ${signed(o.imuDriftRate, 2)}°/min over ${num(o.stationaryTime)} s (worst window ${num(o.worstImuDriftRate, 2)}°/min); position creep ${num(o.creepRate, 2)} in/min`);
  out.push(`- Linear scale from resets: ${pct(o.linearScale.scale)} over ${o.linearScale.count} resets, explains ${num(o.linearScale.explained * 100, 0)}% of the corrections (+ = odometry reads short: grow trackingWheelDiameter ${num(c.trackingWheelDiameter, 3)} by that much; low % = the jumps aren't a scale error)`);
  out.push(`- Heading scale from resets: ${pct(o.headingScale.scale)} over ${o.headingScale.count} resets with a heading, explains ${num(o.headingScale.explained * 100, 0)}% (+ = IMU reads short)`);
  out.push(`- Drive encoders / tracking wheel travel on moves: ${num(o.travelRatio, 3)}× median (range ${num(o.travelRatioRange[0], 3)}–${num(o.travelRatioRange[1], 3)})${o.slipMotions.length > 0 ? `; off by >8% on ${o.slipMotions.map((n) => `#${n}`).join(", ")}` : ""}`);
  out.push(`- Turn rate, drive wheels / IMU: ${num(o.turnRateRatio, 3)}× → effective track width ${num(o.effectiveTrackWidth, 2)} in (configured ${num(c.trackWidth, 2)})`);
  out.push(`- Tracking wheel offsets from in-place turns: |horizontal| ${num(o.horizontalOffset, 2)} in (configured ${num(c.horizontalOffset, 2)}), |vertical| ${num(o.verticalOffset, 2)} in (configured ${num(c.verticalOffset, 2)})`);

  out.push("\n## Motors");
  out.push(
    table(
      ["motor", "peak °C", "avg °C", "peak A", "over-temp s", "over-current s", "avg eff %"],
      a.motors.map((m) => [m.name, num(m.peakTemp, 0), num(m.avgTemp, 0), num(m.peakCurrent, 2), num(m.overTempTime, 1), num(m.overCurrentTime, 1), num(m.avgEfficiency, 0)]),
    ),
  );

  if (a.mechanisms.length > 0) {
    out.push("\n## Mechanisms");
    out.push(
      table(
        ["mechanism", "moves", "median settle s", "max settle s", "never settled", "max error while settled"],
        a.mechanisms.map((m) => [m.name, String(m.moves), num(m.medianSettle, 2), num(m.maxSettle, 2), String(m.unsettled), num(m.steadyError, 2)]),
      ),
    );
  }

  out.push("\n## Vision");
  out.push(a.vision.fixes > 0 ? `- ${a.vision.fixes} fixes; residual vs odometry ${num(a.vision.meanResidual, 2)} in mean, ${num(a.vision.maxResidual, 2)} in max` : "- No vision fixes.");

  if (log.warnings.length > 0) {
    out.push("\n## Log warnings");
    out.push(log.warnings.map((w) => `- ${w}`).join("\n"));
  }
  return `${out.filter((line) => line !== "").join("\n")}\n`;
}

const CSV_COLUMNS = [
  "t",
  "phase",
  "motion",
  "robot_x",
  "robot_y",
  "robot_theta",
  "raw_x",
  "raw_y",
  "raw_theta",
  "drift_in",
  "speed_ips",
  "turn_dps",
  "imu_rotation",
  "vertical_wheel_in",
  "horizontal_wheel_in",
  "left_rpm",
  "right_rpm",
  "left_volts",
  "right_volts",
  "battery_v",
  "battery_a",
  "elevator_target",
  "elevator_position",
  "pivot_target",
  "pivot_position",
  "max_motor_temp",
] as const;

function renderCsv(log: ReplayLog, kin: Kinematics, constants: Constants, rateHz: number): string {
  const enabled = log.phases.filter((phase) => phase.kind !== "disabled");
  const spans = enabled.length > 0 ? enabled.map((p) => [p.start, p.end] as const) : [[0, log.duration] as const];
  const covered = spans.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
  const step = Math.max(1 / rateHz, covered / MAX_CSV_ROWS);
  const ch = (key: string) => channel(log, key);
  const vertical = ch(`${KEY.verticalWheel}/position`);
  const horizontal = ch(`${KEY.horizontalWheel}/position`);
  const imu = ch(`${KEY.imu}/rotation`);
  const battery = ch(`${KEY.battery}/voltage`);
  const batteryCurrent = ch(`${KEY.battery}/current`);
  const vScale = unitScale(battery, 100, log.metadata.Units?.batteryVoltage);
  const aScale = unitScale(batteryCurrent, 50, log.metadata.Units?.batteryCurrent);
  const motorVolts = unitScale(ch(`/Motors/${LEFT_DRIVE[0]}/voltage`), 100, log.metadata.Units?.motorVoltage);
  const temps = MOTORS.map((name) => ch(`/Motors/${name}/Health/temperature`)).filter((s): s is Series => s !== undefined);
  const side = (names: string[], field: string, t: number) => {
    const values = names.map((name) => valueAt(ch(`/Motors/${name}/${field}`), t)).filter(Number.isFinite);
    return values.length > 0 ? values.reduce((x, y) => x + y, 0) / values.length : Number.NaN;
  };
  const wheel = (series: Series | undefined, t: number) => (valueAt(series, t) / 100 / 360) * Math.PI * constants.trackingWheelDiameter;
  const cell = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : "");
  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const [from, to] of spans) {
    for (let k = 0; from + k * step <= to + 1e-9; k++) {
      const t = from + k * step;
      const robot = poseNear(log.poses.robot, log.resets, t);
      const raw = poseAt(log.poses.raw, t);
      const motion = log.motions.find((m) => m.t <= t && t < m.end);
      const at = Math.min(sampleIndex(kin.pose.t, t) + 1, kin.pose.t.length - 1);
      const speed = at > 0 && kin.valid[at] ? kin.speed[at] : Number.NaN;
      const turn = at > 0 && kin.valid[at] ? kin.turnRate[at] : Number.NaN;
      const maxTemp = temps.reduce((max, s) => Math.max(max, valueAt(s, t)), Number.NEGATIVE_INFINITY);
      const row = [
        cell(t),
        phaseAt(log, t),
        motion ? String(motion.id) : "",
        cell(robot?.x ?? Number.NaN),
        cell(robot?.y ?? Number.NaN),
        cell(robot?.theta ?? Number.NaN),
        cell(raw?.x ?? Number.NaN),
        cell(raw?.y ?? Number.NaN),
        cell(raw?.theta ?? Number.NaN),
        cell(robot && raw ? Math.hypot(robot.x - raw.x, robot.y - raw.y) : Number.NaN),
        cell(speed),
        cell(turn),
        cell(valueAt(imu, t)),
        cell(wheel(vertical, t)),
        cell(wheel(horizontal, t)),
        cell(side(LEFT_DRIVE, "velocity", t)),
        cell(side(RIGHT_DRIVE, "velocity", t)),
        cell(side(LEFT_DRIVE, "voltage", t) * motorVolts),
        cell(side(RIGHT_DRIVE, "voltage", t) * motorVolts),
        cell(valueAt(battery, t) * vScale),
        cell(valueAt(batteryCurrent, t) * aScale),
        cell(valueAt(ch(`${KEY.elevator}/target`), t)),
        cell(valueAt(ch(`${KEY.elevator}/position`), t)),
        cell(valueAt(ch(`${KEY.pivot}/target`), t)),
        cell(valueAt(ch(`${KEY.pivot}/position`), t)),
        cell(Number.isFinite(maxTemp) ? maxTemp : Number.NaN),
      ];
      lines.push(row.join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function analyze(log: ReplayLog, options: AnalyzeOptions = {}): LogAnalysis {
  const constants = readConstants(log);
  const kin = kinematics(log.poses.robot, log.resets);
  const motions = log.motions.map((motion) => analyzeMotion(log, kin, motion, constants));
  const resets = analyzeResets(log, kin);
  const partial = {
    motions,
    resets,
    motors: analyzeMotors(log),
    mechanisms: analyzeMechanisms(log),
    odometry: odometryHealth(log, kin, motions, resets, constants),
    battery: analyzeBattery(log),
    constants,
    vision: analyzeVision(log),
    logger: {
      dropped: lastValue(log, KEY.loggerDropped),
      overruns: lastValue(log, KEY.loggerOverruns),
      bytes: lastValue(log, KEY.loggerBytes),
    },
  };
  const findings = findingsFor(partial, log);
  const withFindings = { ...partial, findings };
  const corrections = resets.filter((r) => !r.initial);
  let maxRawDrift = 0;
  for (let i = 0; i < log.poses.robot.t.length; i++) {
    const raw = poseAt(log.poses.raw, log.poses.robot.t[i]);
    if (raw) maxRawDrift = Math.max(maxRawDrift, Math.hypot(log.poses.robot.x[i] - raw.x, log.poses.robot.y[i] - raw.y));
  }
  return {
    ...withFindings,
    summary: {
      duration: log.duration,
      motions: motions.length,
      timedOut: motions.filter((m) => m.timedOut).length,
      resets: corrections.length,
      maxJump: corrections.reduce((max, r) => Math.max(max, r.jump), 0),
      maxRawDrift,
      batteryMin: partial.battery.min,
    },
    markdown: renderMarkdown(log, withFindings, options.name ?? "log"),
    csv: options.csv === false ? "" : renderCsv(log, kin, constants, options.csvRateHz ?? 50),
  };
}
