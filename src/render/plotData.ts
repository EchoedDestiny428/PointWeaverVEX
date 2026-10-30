import { sampleIndex } from "../log/model";

export type TraceStyle = "line" | "dash" | "dots" | "steps";

export interface PlotTrace {
  series: string;
  slot: number;
  label: string;
  t: ArrayLike<number>;
  v: ArrayLike<number>;
  style: TraceStyle;
  discrete?: boolean;
}

const DOT_WINDOW = 0.15;
const PAD = 0.08;
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const n = (value: number): string => (Math.round(value * 1000) / 1000).toString();

export function segments(spans: Array<{ start: number; end: number; value: number }>): { t: Float64Array; v: Float64Array } {
  const kept = spans.filter((span) => Number.isFinite(span.value) && span.end > span.start);
  const t = new Float64Array(kept.length * 3);
  const v = new Float64Array(kept.length * 3);
  kept.forEach((span, i) => {
    t.set([span.start, span.end, span.end], i * 3);
    v.set([span.value, span.value, Number.NaN], i * 3);
  });
  return { t, v };
}

export function laneRange(traces: PlotTrace[]): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const trace of traces) {
    for (let i = 0; i < trace.v.length; i++) {
      const value = trace.v[i];
      if (!Number.isFinite(value)) continue;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  if (!Number.isFinite(lo)) return [-1, 1];
  if (hi - lo < 1e-9) {
    const pad = Math.max(1, Math.abs(lo) * 0.1);
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * PAD;
  return [lo - pad, hi + pad];
}

export function tracePath(trace: PlotTrace, duration: number, buckets = 1200): string {
  const { t, v } = trace;
  const parts: string[] = [];
  if (trace.style === "dots") {
    for (let i = 0; i < t.length; i++) if (Number.isFinite(v[i])) parts.push(`M${n(t[i])},${n(-v[i])}h0`);
    return parts.join("");
  }
  if (trace.style === "steps") {
    let open = false;
    for (let i = 0; i < t.length; i++) {
      if (!Number.isFinite(v[i])) {
        open = false;
        continue;
      }
      parts.push(`${open ? "L" : "M"}${n(t[i])},${n(-v[i])}`);
      open = true;
    }
    return parts.join("");
  }
  if (trace.discrete) {
    let open = false;
    let held = false;
    for (let i = 0; i < t.length; i++) {
      if (!Number.isFinite(v[i])) {
        if (held) parts.push(`H${n(t[i - 1])}`);
        open = held = false;
        continue;
      }
      held = open && v[i] === v[i - 1];
      if (held) continue;
      parts.push(open ? `H${n(t[i])}V${n(-v[i])}` : `M${n(t[i])},${n(-v[i])}`);
      open = true;
    }
    if (open && t.length > 0) parts.push(`H${n(Math.max(duration, t[t.length - 1]))}`);
    return parts.join("");
  }
  const width = Math.max(duration, 1e-6) / buckets;
  let open = false;
  let bucket = Number.NaN;
  let picks: number[] = [];
  const flush = () => {
    const unique = [...new Set(picks)].sort((a, b) => a - b);
    for (const i of unique) {
      parts.push(`${open ? "L" : "M"}${n(t[i])},${n(-v[i])}`);
      open = true;
    }
    picks = [];
  };
  let first = -1;
  let min = -1;
  let max = -1;
  let last = -1;
  for (let i = 0; i < t.length; i++) {
    if (!Number.isFinite(v[i])) {
      if (first >= 0) picks.push(first, min, max, last);
      flush();
      first = -1;
      bucket = Number.NaN;
      open = false;
      continue;
    }
    const k = Math.floor(t[i] / width);
    if (k !== bucket) {
      if (first >= 0) picks.push(first, min, max, last);
      flush();
      bucket = k;
      first = min = max = last = i;
      continue;
    }
    if (v[i] < v[min]) min = i;
    if (v[i] > v[max]) max = i;
    last = i;
  }
  if (first >= 0) picks.push(first, min, max, last);
  flush();
  return parts.join("");
}

export function traceValue(trace: PlotTrace, time: number): number {
  const { t, v } = trace;
  const i = sampleIndex(t, time);
  if (trace.style === "dots") {
    let best = Number.NaN;
    let gap = DOT_WINDOW;
    for (const j of [i, i + 1]) {
      if (j < 0 || j >= t.length || !Number.isFinite(v[j])) continue;
      const d = Math.abs(t[j] - time);
      if (d <= gap) {
        gap = d;
        best = v[j];
      }
    }
    return best;
  }
  if (i < 0) return Number.NaN;
  if (trace.style === "steps") return i + 1 < t.length && Number.isFinite(v[i + 1]) ? v[i] : Number.NaN;
  if (trace.discrete || i === t.length - 1) return v[i];
  const t0 = t[i];
  const t1 = t[i + 1];
  if (!Number.isFinite(v[i]) || !Number.isFinite(v[i + 1]) || t1 <= t0) return v[i];
  return v[i] + ((v[i + 1] - v[i]) * (time - t0)) / (t1 - t0);
}

export function timeTicks(duration: number, maxTicks = 8): number[] {
  if (!(duration > 0)) return [0];
  const step = STEPS.find((candidate) => duration / candidate <= maxTicks) ?? Math.ceil(duration / maxTicks / 600) * 600;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return ticks;
}

export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const text = value.toFixed(abs >= 1000 ? 0 : abs >= 10 ? 1 : 2);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

export function compactValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(0)}K`;
  if (abs >= 1000) return `${(value / 1e3).toFixed(1)}K`;
  return formatValue(value);
}
