import { wrap180 } from "../core/angle";
import type { Pose } from "../core/geometry";
import { EVENT_KEYS, KEY, METADATA_PREFIX, MOTION_KINDS, SCHEMA_PREFIX, TYPE } from "./keys";
import type { MotionKindId } from "./keys";
import { isIntegerType } from "./struct";
import type { StructSchema, StructValue } from "./struct";
import type { LogValue, ParsedWpilog, WpilogEntry, WpilogRecord } from "./wpilog";

export interface Series {
  key: string;
  type: string;
  discrete: boolean;
  t: Float64Array;
  v: Float64Array;
}

export interface TextSeries {
  key: string;
  t: Float64Array;
  v: string[];
}

export interface PoseSeries {
  key: string;
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  theta: Float64Array;
}

export interface SourceLocation {
  source: string;
  file: string | null;
  line: number | null;
}

export interface PoseReset extends SourceLocation {
  index: number;
  t: number;
  from: Pose;
  to: Pose;
}

export type MotionEnd = "inactive" | "next" | "log-end";

export interface MotionEvent extends SourceLocation {
  index: number;
  id: number;
  t: number;
  end: number;
  endReason: MotionEnd;
  kind: number;
  kindName: string;
  target: Pose;
  timeoutMs: number;
  maxSpeed: number;
  minSpeed: number;
  earlyExit: number;
  forwards: boolean;
  async: boolean;
}

export interface AutonRun {
  name: string;
  start: number;
  end: number | null;
}

export type PhaseKind = "disabled" | "auton" | "driver";

export interface Phase {
  kind: PhaseKind;
  start: number;
  end: number;
}

export interface LogEntrySummary {
  name: string;
  type: string;
  count: number;
}

export interface ReplayLog {
  header: string;
  t0: number;
  duration: number;
  channels: Map<string, Series>;
  text: Map<string, TextSeries>;
  poses: { robot: PoseSeries; raw: PoseSeries; vision: PoseSeries };
  resets: PoseReset[];
  motions: MotionEvent[];
  autons: AutonRun[];
  phases: Phase[];
  metadata: Record<string, Record<string, string>>;
  entries: LogEntrySummary[];
  truncated: boolean;
  warnings: string[];
}

const PAIR_TOLERANCE_US = 1000;

export const channelKey = (name: string): string => name.replace(/^\/+/, "");

export function parseMetadata(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      if (part.trim() !== "") out[part.trim()] = "";
      continue;
    }
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function parseSource(source: string): SourceLocation {
  const match = /^(.*):(\d+)$/.exec(source.trim());
  if (!match) return { source, file: source.trim() === "" ? null : source.trim(), line: null };
  return { source, file: match[1], line: Number(match[2]) };
}

export function sampleIndex(times: ArrayLike<number>, t: number): number {
  let hi = times.length - 1;
  if (hi < 0 || !(t >= times[0])) return -1;
  if (t >= times[hi]) return hi;
  let lo = 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function valueAt(series: Series | undefined, t: number): number {
  if (!series) return Number.NaN;
  const i = sampleIndex(series.t, t);
  if (i < 0) return Number.NaN;
  const v0 = series.v[i];
  if (series.discrete || i === series.t.length - 1) return v0;
  const t0 = series.t[i];
  const t1 = series.t[i + 1];
  const v1 = series.v[i + 1];
  if (!Number.isFinite(v0) || !Number.isFinite(v1) || t1 <= t0) return v0;
  return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

export function textAt(series: TextSeries | undefined, t: number): string | undefined {
  if (!series) return undefined;
  const i = sampleIndex(series.t, t);
  return i < 0 ? undefined : series.v[i];
}

export function poseAt(series: PoseSeries | undefined, t: number): Pose | null {
  if (!series) return null;
  const i = sampleIndex(series.t, t);
  if (i < 0) return null;
  const a = { x: series.x[i], y: series.y[i], theta: series.theta[i] };
  if (i === series.t.length - 1) return a;
  const t0 = series.t[i];
  const t1 = series.t[i + 1];
  if (t1 <= t0) return a;
  const f = (t - t0) / (t1 - t0);
  return {
    x: a.x + (series.x[i + 1] - a.x) * f,
    y: a.y + (series.y[i + 1] - a.y) * f,
    theta: a.theta + wrap180(series.theta[i + 1] - a.theta) * f,
  };
}

export function channel(log: ReplayLog, key: string): Series | undefined {
  return log.channels.get(channelKey(key));
}

export function phaseAt(log: ReplayLog, t: number): PhaseKind {
  return log.phases.find((phase) => t >= phase.start && t < phase.end)?.kind ?? log.phases.at(-1)?.kind ?? "disabled";
}

export function motionAt(log: ReplayLog, t: number): MotionEvent | undefined {
  for (let i = log.motions.length - 1; i >= 0; i--) {
    const motion = log.motions[i];
    if (motion.t <= t) return t < motion.end ? motion : undefined;
  }
  return undefined;
}

interface Leaf {
  path: string;
  discrete: boolean;
  read: (value: StructValue) => number;
  error?: number;
}

const PROS_ERR_INT32 = 2147483647;

function dropErrors(t: Float64Array, v: Float64Array, error: number | undefined): [Float64Array, Float64Array] {
  if (error === undefined || !v.includes(error)) return [t, v];
  const keep = Array.from(v.keys()).filter((i) => v[i] !== error);
  return [Float64Array.from(keep, (i) => t[i]), Float64Array.from(keep, (i) => v[i])];
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number.NaN;
}

function leaves(schema: StructSchema, event: boolean, prefix = "", get: (v: StructValue) => StructValue = (v) => v): Leaf[] {
  const out: Leaf[] = [];
  for (const field of schema.fields) {
    const path = `${prefix}${field.name}`;
    const discrete = event || field.type === "bool" || (isIntegerType(field.type) && (field.size <= 2 || field.type.startsWith("u")));
    const nested = field.nested;
    if (nested) {
      const count = field.array ? field.count : 1;
      for (let i = 0; i < count; i++) {
        const pick = field.array
          ? (v: StructValue) => ((get(v)[field.name] as StructValue[] | undefined)?.[i] ?? {})
          : (v: StructValue) => (get(v)[field.name] as StructValue | undefined) ?? {};
        out.push(...leaves(nested, event, field.array ? `${path}/${i}/` : `${path}/`, pick));
      }
    } else if (field.type === "char" && field.array) {
      continue;
    } else if (field.array) {
      for (let i = 0; i < field.count; i++) {
        out.push({ path: `${path}/${i}`, discrete, read: (v) => toNumber((get(v)[field.name] as unknown[] | undefined)?.[i]) });
      }
    } else {
      out.push({ path, discrete, read: (v) => toNumber(get(v)[field.name]), error: field.type === "int32" ? PROS_ERR_INT32 : undefined });
    }
  }
  return out;
}

function structRecords(entry: WpilogEntry): WpilogRecord[] {
  return entry.records.filter((r) => typeof r.value === "object" && !(r.value instanceof Uint8Array) && !Array.isArray(r.value));
}

function scalarNumber(value: LogValue): number {
  return typeof value === "number" || typeof value === "boolean" ? toNumber(value) : Number.NaN;
}

function buildChannels(parsed: ParsedWpilog, seconds: (us: number) => number): Map<string, Series> {
  const channels = new Map<string, Series>();
  const add = (key: string, type: string, discrete: boolean, t: Float64Array, v: Float64Array) => {
    if (t.length > 0) channels.set(key, { key, type, discrete, t, v });
  };
  for (const entry of parsed.entries) {
    if (entry.name.startsWith(SCHEMA_PREFIX)) continue;
    const base = channelKey(entry.name);
    const event = EVENT_KEYS.has(entry.name);
    if (entry.type.startsWith("struct:") && !entry.type.endsWith("[]")) {
      const schema = parsed.schemas.get(entry.type.slice("struct:".length));
      if (!schema) continue;
      const records = structRecords(entry);
      const t = Float64Array.from(records, (r) => seconds(r.timestamp));
      for (const leaf of leaves(schema, event)) {
        const [lt, lv] = dropErrors(t, Float64Array.from(records, (r) => leaf.read(r.value as StructValue)), leaf.error);
        add(`${base}/${leaf.path}`, entry.type, leaf.discrete, lt, lv);
      }
      continue;
    }
    if (entry.type === TYPE.boolean || entry.type === TYPE.int64 || entry.type === TYPE.double || entry.type === "float") {
      const discrete = event || entry.type === TYPE.boolean || entry.type === TYPE.int64;
      add(
        base,
        entry.type,
        discrete,
        Float64Array.from(entry.records, (r) => seconds(r.timestamp)),
        Float64Array.from(entry.records, (r) => scalarNumber(r.value)),
      );
      continue;
    }
    if (/^(boolean|int64|float|double)\[\]$/.test(entry.type)) {
      const width = entry.records.reduce((max, r) => Math.max(max, Array.isArray(r.value) ? r.value.length : 0), 0);
      const discrete = !/^(float|double)/.test(entry.type);
      const t = Float64Array.from(entry.records, (r) => seconds(r.timestamp));
      for (let i = 0; i < width; i++) {
        add(`${base}/${i}`, entry.type, discrete, t, Float64Array.from(entry.records, (r) => toNumber((r.value as unknown[])[i])));
      }
    }
  }
  return channels;
}

function buildText(parsed: ParsedWpilog, seconds: (us: number) => number): Map<string, TextSeries> {
  const text = new Map<string, TextSeries>();
  for (const entry of parsed.entries) {
    if (entry.type !== TYPE.string && entry.type !== "json") continue;
    const records = entry.records.filter((r) => typeof r.value === "string");
    if (records.length === 0) continue;
    const key = channelKey(entry.name);
    text.set(key, { key, t: Float64Array.from(records, (r) => seconds(r.timestamp)), v: records.map((r) => r.value as string) });
  }
  return text;
}

function buildPoses(entry: WpilogEntry | undefined, seconds: (us: number) => number): PoseSeries {
  const records = entry ? structRecords(entry) : [];
  const pick = (field: string) => Float64Array.from(records, (r) => toNumber((r.value as StructValue)[field]));
  return {
    key: entry ? channelKey(entry.name) : "",
    t: Float64Array.from(records, (r) => seconds(r.timestamp)),
    x: pick("x"),
    y: pick("y"),
    theta: pick("theta"),
  };
}

function asPose(value: LogValue | undefined): Pose {
  const v = (value && typeof value === "object" && !(value instanceof Uint8Array) && !Array.isArray(value) ? value : {}) as StructValue;
  return { x: toNumber(v.x), y: toNumber(v.y), theta: toNumber(v.theta) };
}

function pairer(entry: WpilogEntry | undefined): (timestamp: number) => WpilogRecord | undefined {
  const records = entry?.records ?? [];
  const used = new Set<number>();
  let from = 0;
  return (timestamp) => {
    while (from < records.length && (used.has(from) || records[from].timestamp < timestamp - PAIR_TOLERANCE_US)) from++;
    let best = -1;
    let bestGap = PAIR_TOLERANCE_US + 1;
    for (let i = from; i < records.length; i++) {
      if (used.has(i)) continue;
      const gap = Math.abs(records[i].timestamp - timestamp);
      if (gap < bestGap) {
        best = i;
        bestGap = gap;
      }
      if (records[i].timestamp > timestamp + PAIR_TOLERANCE_US) break;
    }
    if (best < 0) return undefined;
    used.add(best);
    return records[best];
  };
}

function buildResets(parsed: ParsedWpilog, seconds: (us: number) => number, robot: PoseSeries): PoseReset[] {
  const toEntry = parsed.byName.get(KEY.resetTo);
  if (!toEntry) return [];
  const fromPair = pairer(parsed.byName.get(KEY.resetFrom));
  const sourcePair = pairer(parsed.byName.get(KEY.resetSource));
  return toEntry.records.map((record, index) => {
    const t = seconds(record.timestamp);
    const fromRecord = fromPair(record.timestamp);
    const source = sourcePair(record.timestamp)?.value;
    const from = fromRecord ? asPose(fromRecord.value) : (poseAt(robot, t - 1e-6) ?? { x: Number.NaN, y: Number.NaN, theta: Number.NaN });
    return { index, t, from, to: asPose(record.value), ...parseSource(typeof source === "string" ? source : "") };
  });
}

function boolChanges(entry: WpilogEntry | undefined, seconds: (us: number) => number): Array<{ t: number; value: boolean }> {
  return (entry?.records ?? []).filter((r) => typeof r.value === "boolean").map((r) => ({ t: seconds(r.timestamp), value: r.value as boolean }));
}

function buildMotions(parsed: ParsedWpilog, seconds: (us: number) => number, duration: number): MotionEvent[] {
  const commands = parsed.byName.get(KEY.motionCommand);
  if (!commands) return [];
  const sourcePair = pairer(parsed.byName.get(KEY.motionSource));
  const idPair = pairer(parsed.byName.get(KEY.motionId));
  const inactive = boolChanges(parsed.byName.get(KEY.motionActive), seconds).filter((c) => !c.value).map((c) => c.t);
  const records = structRecords(commands);
  return records.map((record, index) => {
    const v = record.value as StructValue;
    const t = seconds(record.timestamp);
    const next = index + 1 < records.length ? seconds(records[index + 1].timestamp) : Number.POSITIVE_INFINITY;
    const off = inactive.find((time) => time > t) ?? Number.POSITIVE_INFINITY;
    const end = Math.min(off, next, duration);
    const endReason: MotionEnd = end === off ? "inactive" : end === next ? "next" : "log-end";
    const source = sourcePair(record.timestamp)?.value;
    const id = idPair(record.timestamp)?.value;
    const kind = toNumber(v.kind);
    return {
      index,
      id: typeof id === "number" ? id : index + 1,
      t,
      end,
      endReason,
      kind,
      kindName: MOTION_KINDS[kind as MotionKindId] ?? `kind ${kind}`,
      target: { x: toNumber(v.x), y: toNumber(v.y), theta: toNumber(v.theta) },
      timeoutMs: toNumber(v.timeout),
      maxSpeed: toNumber(v.maxSpeed),
      minSpeed: toNumber(v.minSpeed),
      earlyExit: toNumber(v.earlyExit),
      forwards: v.forwards === true,
      async: v.async === true,
      ...parseSource(typeof source === "string" ? source : ""),
    };
  });
}

function buildAutons(parsed: ParsedWpilog, seconds: (us: number) => number, text: Map<string, TextSeries>): AutonRun[] {
  const runs: AutonRun[] = [];
  const selected = text.get(channelKey(KEY.autonSelected));
  for (const change of boolChanges(parsed.byName.get(KEY.autonRunning), seconds)) {
    const open = runs.at(-1);
    if (change.value && (!open || open.end !== null)) {
      runs.push({ name: textAt(selected, change.t + 1e-6) ?? "", start: change.t, end: null });
    } else if (!change.value && open && open.end === null) {
      open.end = change.t;
    }
  }
  return runs;
}

function buildPhases(parsed: ParsedWpilog, seconds: (us: number) => number, duration: number): Phase[] {
  const changes = [
    ...boolChanges(parsed.byName.get(KEY.enabled), seconds).map((c) => ({ ...c, key: "enabled" as const })),
    ...boolChanges(parsed.byName.get(KEY.autonomous), seconds).map((c) => ({ ...c, key: "auton" as const })),
  ].sort((a, b) => a.t - b.t);
  const state = { enabled: false, auton: false };
  const kindNow = (): PhaseKind => (!state.enabled ? "disabled" : state.auton ? "auton" : "driver");
  const phases: Phase[] = [{ kind: "disabled", start: 0, end: duration }];
  for (const change of changes) {
    state[change.key] = change.value;
    const kind = kindNow();
    const current = phases[phases.length - 1];
    if (kind === current.kind) continue;
    if (change.t <= current.start) {
      current.kind = kind;
      const previous = phases[phases.length - 2];
      if (previous && previous.kind === kind) {
        previous.end = duration;
        phases.pop();
      }
      continue;
    }
    current.end = change.t;
    phases.push({ kind, start: change.t, end: duration });
  }
  return phases;
}

function buildMetadata(parsed: ParsedWpilog): Record<string, Record<string, string>> {
  const metadata: Record<string, Record<string, string>> = {};
  for (const entry of parsed.entries) {
    if (!entry.name.startsWith(METADATA_PREFIX)) continue;
    const last = entry.records.at(-1)?.value;
    if (typeof last === "string") metadata[entry.name.slice(METADATA_PREFIX.length)] = parseMetadata(last);
  }
  return metadata;
}

export function buildLog(parsed: ParsedWpilog): ReplayLog {
  const t0 = Number.isFinite(parsed.firstTimestamp) ? parsed.firstTimestamp : 0;
  const seconds = (us: number): number => (us - t0) / 1e6;
  const duration = Number.isFinite(parsed.lastTimestamp) ? seconds(parsed.lastTimestamp) : 0;
  const text = buildText(parsed, seconds);
  const robot = buildPoses(parsed.byName.get(KEY.robotPose), seconds);
  return {
    header: parsed.extraHeader,
    t0,
    duration,
    channels: buildChannels(parsed, seconds),
    text,
    poses: {
      robot,
      raw: buildPoses(parsed.byName.get(KEY.rawPose), seconds),
      vision: buildPoses(parsed.byName.get(KEY.visionPose), seconds),
    },
    resets: buildResets(parsed, seconds, robot),
    motions: buildMotions(parsed, seconds, duration),
    autons: buildAutons(parsed, seconds, text),
    phases: buildPhases(parsed, seconds, duration),
    metadata: buildMetadata(parsed),
    entries: parsed.entries.map((entry) => ({ name: entry.name, type: entry.type, count: entry.records.length })),
    truncated: parsed.truncated,
    warnings: parsed.warnings,
  };
}
