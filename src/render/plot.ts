import { compactValue, formatValue, laneRange, timeTicks, tracePath, traceValue } from "./plotData";
import type { PlotTrace } from "./plotData";
import { svg } from "./svg";

export interface PlotLane {
  id: string;
  label: string;
  unit: string;
  title: string;
  traces: PlotTrace[];
}

export interface PlotSpan {
  start: number;
  end: number;
  title: string;
  timedOut: boolean;
}

export interface PlotBand {
  start: number;
  end: number;
  kind: string;
}

export interface PlotHandlers {
  seek(time: number): void;
  describe(time: number): string;
}

interface LaneView {
  lane: PlotLane;
  paths: Array<[PlotTrace, SVGPathElement]>;
}

const TRACE_ORDER: Record<PlotTrace["style"], number> = { steps: 0, dash: 1, line: 2, dots: 3 };

function div(className: string, parent?: Element, text?: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
}

const pct = (value: number): string => `${(value * 100).toFixed(3)}%`;

export class Plot {
  private readonly grid: HTMLDivElement;
  private readonly track: HTMLDivElement;
  private readonly lanesBox: HTMLDivElement;
  private readonly ticks: HTMLDivElement;
  private readonly under: HTMLDivElement;
  private readonly over: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly hover: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private duration = 1;
  private views: LaneView[] = [];
  private spans: HTMLDivElement[] = [];
  private active = -1;
  private hidden: ReadonlySet<string> = new Set();
  private dragging = false;

  constructor(
    host: HTMLElement,
    trackIcon: Element,
    private readonly handlers: PlotHandlers,
  ) {
    this.grid = div("plot-grid", host);
    this.under = div("plot-under", this.grid);
    const trackRow = div("plot-row plot-track", this.grid);
    div("plot-label", trackRow).append(trackIcon);
    this.track = div("plot-data", trackRow);
    this.lanesBox = div("plot-lanes", this.grid);
    const axisRow = div("plot-row plot-axis", this.grid);
    div("plot-label", axisRow);
    this.ticks = div("plot-data", axisRow);
    this.over = div("plot-over", this.grid);
    this.hover = div("plot-hover", this.over);
    this.head = div("plot-cursor", this.over);
    this.tip = div("plot-tip", this.grid);
    this.tip.hidden = true;
    this.hover.hidden = true;

    this.grid.addEventListener("pointerdown", (event) => {
      const time = this.timeAt(event.clientX);
      if (time === null || event.button !== 0) return;
      this.dragging = true;
      this.grid.setPointerCapture(event.pointerId);
      this.handlers.seek(time);
    });
    this.grid.addEventListener("pointermove", (event) => {
      const time = this.timeAt(event.clientX);
      if (this.dragging && time !== null) this.handlers.seek(time);
      this.showHover(time, event);
    });
    const stop = (event: PointerEvent) => {
      this.dragging = false;
      if (this.grid.hasPointerCapture(event.pointerId)) this.grid.releasePointerCapture(event.pointerId);
    };
    this.grid.addEventListener("pointerup", stop);
    this.grid.addEventListener("pointercancel", stop);
    this.grid.addEventListener("pointerleave", () => this.showHover(null));
  }

  load(duration: number, bands: PlotBand[], spans: PlotSpan[], lanes: PlotLane[]): void {
    this.duration = Math.max(duration, 1e-3);
    this.under.replaceChildren();
    for (const band of bands) {
      const node = div(`plot-band band-${band.kind}`, this.under);
      node.style.left = pct(band.start / this.duration);
      node.style.width = pct((band.end - band.start) / this.duration);
    }
    this.track.replaceChildren();
    this.spans = spans.map((span) => {
      const node = div(`plot-span${span.timedOut ? " is-timeout" : ""}`, this.track);
      node.style.left = pct(span.start / this.duration);
      node.style.width = `max(2px, ${pct((span.end - span.start) / this.duration)})`;
      node.title = span.title;
      return node;
    });
    this.active = -1;
    this.ticks.replaceChildren();
    for (const tick of timeTicks(this.duration)) {
      const node = div("plot-tick", this.ticks, String(tick));
      node.style.left = pct(tick / this.duration);
    }
    this.setLanes(lanes);
  }

  setLanes(lanes: PlotLane[]): void {
    this.lanesBox.replaceChildren();
    this.views = lanes.map((lane) => {
      const row = div("plot-row plot-lane", this.lanesBox);
      const label = div("plot-label", row);
      label.title = lane.title;
      const [lo, hi] = laneRange(lane.traces);
      const name = div("lane-name", label, lane.label);
      if (lane.unit) name.append(Object.assign(document.createElement("span"), { className: "lane-unit", textContent: lane.unit }));
      div("lane-hi", label, compactValue(hi));
      div("lane-lo", label, compactValue(lo));
      const plot = svg("svg", { class: "plot-data lane-plot", viewBox: `0 ${-hi} ${this.duration} ${hi - lo}`, preserveAspectRatio: "none" }, row);
      if (lo < 0 && hi > 0) svg("line", { x1: 0, x2: this.duration, y1: 0, y2: 0, class: "lane-zero" }, plot);
      const ordered = [...lane.traces].sort((a, b) => TRACE_ORDER[a.style] - TRACE_ORDER[b.style]);
      const paths = ordered.map((trace): [PlotTrace, SVGPathElement] => [
        trace,
        svg("path", { d: tracePath(trace, this.duration), class: `trace trace-${trace.style}`, style: `--c: var(--series-${trace.slot})` }, plot),
      ]);
      return { lane, paths };
    });
    this.setHidden(this.hidden);
  }

  setHidden(hidden: ReadonlySet<string>): void {
    this.hidden = hidden;
    for (const view of this.views) {
      for (const [trace, path] of view.paths) path.classList.toggle("is-off", hidden.has(trace.series));
    }
  }

  showTime(time: number, activeSpan: number): void {
    this.head.style.left = pct(Math.min(1, Math.max(0, time / this.duration)));
    if (activeSpan === this.active) return;
    this.spans[this.active]?.classList.remove("is-active");
    this.spans[activeSpan]?.classList.add("is-active");
    this.active = activeSpan;
  }

  private timeAt(clientX: number): number | null {
    const rect = this.over.getBoundingClientRect();
    if (rect.width <= 0 || clientX < rect.left - 4 || clientX > rect.right + 4) return null;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * this.duration;
  }

  private showHover(time: number | null, event?: PointerEvent): void {
    if (time === null || !event) {
      this.hover.hidden = true;
      this.tip.hidden = true;
      return;
    }
    this.hover.hidden = false;
    this.hover.style.left = pct(time / this.duration);
    this.tip.replaceChildren();
    div("tip-time", this.tip, this.handlers.describe(time));
    for (const view of this.views) {
      const shown = view.paths
        .filter(([trace]) => !this.hidden.has(trace.series))
        .map(([trace]) => [trace, traceValue(trace, time)] as const)
        .filter(([trace, value]) => Number.isFinite(value) || trace.style === "line" || trace.style === "dash");
      if (shown.length === 0) continue;
      const row = div("tip-row", this.tip);
      const values = div("tip-values", row);
      for (const [trace, value] of shown) {
        const item = div(`tip-value tip-${trace.style}`, values);
        item.style.setProperty("--c", `var(--series-${trace.slot})`);
        item.title = trace.label;
        item.append(Object.assign(document.createElement("i"), { className: "tip-key" }), formatValue(value));
      }
      div("tip-lane", row, view.lane.label);
    }
    this.tip.hidden = false;
    const box = this.grid.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const width = this.tip.offsetWidth;
    this.tip.style.left = `${x + 14 + width > box.width ? Math.max(0, x - 14 - width) : x + 14}px`;
    this.tip.style.top = `${Math.max(0, Math.min(y - 10, this.grid.offsetHeight - this.tip.offsetHeight))}px`;
  }
}
