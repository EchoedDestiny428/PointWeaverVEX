import { Check, Info, LocateFixed, Navigation, OctagonAlert, Orbit, RotateCw, TimerOff, TriangleAlert, X } from "lucide";
import type { IconNode } from "lucide";
import type { LogAnalysis } from "../log/analyze";
import { KEY } from "../log/keys";
import { channel, motionAt, phaseAt, poseAt, valueAt } from "../log/model";
import type { MotionEvent, ReplayLog } from "../log/model";
import { Plot } from "../render/plot";
import type { PlotLane } from "../render/plot";
import { segments } from "../render/plotData";
import type { PlotTrace } from "../render/plotData";
import type { ReplayScene } from "../render/replayScene";
import type { RobotConfig } from "../robot/config";
import { button, byId, el } from "./dom";
import { icon } from "./icon";
import { channelTree, FIXED_SERIES, nextSlot, searchChannels, shortChannel, targetHeadings, unitFor, voltScale } from "./replayModel";
import type { ChannelNode, ChannelPick, SeriesDef } from "./replayModel";
import { MAX_LOG_CHANNELS } from "./storage";
import type { AppState } from "./storage";

export interface LoadedLog {
  name: string;
  path: string | null;
  log: ReplayLog;
  analysis: LogAnalysis;
}

export interface ReplayHost {
  state: AppState;
  persist(): void;
  seek(time: number): void;
  focusSource(file: string | null, line: number | null): void;
  toast(text: string, node?: IconNode): void;
}

interface Readout {
  value: HTMLElement;
  read(time: number): string;
}

const TURN_KINDS = new Set([3, 4, 5, 6]);
const FINDING_ICONS: Record<string, IconNode> = { high: OctagonAlert, medium: TriangleAlert, info: Info };

export function motionIcon(motion: MotionEvent): IconNode {
  if (motion.kind === 7) return Orbit;
  return TURN_KINDS.has(motion.kind) ? RotateCw : Navigation;
}

const num = (value: number, digits = 1): string => {
  if (!Number.isFinite(value)) return "—";
  const text = value.toFixed(digits);
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text;
};
const short = (value: number): string => String(Number(value.toFixed(1)) || 0);

export function motionText(motion: MotionEvent): string {
  const { x, y, theta } = motion.target;
  const point = Number.isFinite(x) && Number.isFinite(y) ? `${short(x)}, ${short(y)}` : "";
  const heading = Number.isFinite(theta) ? `${short(theta)}°` : "";
  return [motion.kindName, [point, heading].filter(Boolean).join(", ")].filter(Boolean).join(" ");
}

const fileName = (file: string | null): string => file?.split("/").pop() ?? "";

export class ReplayView {
  private readonly plot: Plot;
  private loaded: LoadedLog | null = null;
  private series: SeriesDef[] = [];
  private headings: number[] = [];
  private picks: ChannelPick[] = [];
  private readouts: Readout[] = [];
  private motionRows: HTMLElement[] = [];
  private activeMotion = -2;
  private pastMotions = -1;
  private lastTime = 0;
  private readonly legend = byId("legend");
  private readonly picker = byId("picker");
  private readonly search = byId<HTMLInputElement>("picker-search");
  private readonly pickList = byId("picker-list");
  private readonly addButton = byId<HTMLButtonElement>("add-channel");
  private readonly nowList = byId("now");

  constructor(
    private readonly host: ReplayHost,
    private readonly scene: ReplayScene,
  ) {
    this.plot = new Plot(byId("plot-body"), icon(Navigation, 13), {
      seek: (time) => host.seek(time),
      describe: (time) => {
        const log = this.loaded?.log;
        return log ? `${time.toFixed(2)} s · ${phaseAt(log, time)}` : time.toFixed(2);
      },
    });
    this.addButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.picker.hidden) this.openPicker();
      else this.closePicker();
    });
    this.search.addEventListener("input", () => this.renderPicker());
    this.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closePicker();
      if (event.key === "Enter") this.pickList.querySelector<HTMLButtonElement>(".pick-leaf:not(:disabled)")?.click();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!this.picker.hidden && !this.picker.contains(event.target as Node) && event.target !== this.addButton) this.closePicker();
    });
  }

  get current(): LoadedLog | null {
    return this.loaded;
  }

  open(loaded: LoadedLog, robot: RobotConfig): void {
    this.loaded = loaded;
    const { log, analysis } = loaded;
    const present: Record<string, boolean> = {
      robot: log.poses.robot.t.length > 0,
      raw: log.poses.raw.t.length > 0,
      vision: log.poses.vision.t.length > 0,
      target: log.motions.length > 0,
    };
    this.series = FIXED_SERIES.filter((def) => present[def.id]);
    this.picks = [];
    for (const key of this.host.state.logChannels) {
      const slot = nextSlot(this.picks);
      if (slot !== null && log.channels.has(key)) this.picks.push({ key, slot });
    }
    const initial = new Set(analysis.resets.filter((reset) => reset.initial).map((reset) => reset.reset.index));
    this.headings = targetHeadings(log, analysis);
    this.scene.load(log, robot, {
      slots: Object.fromEntries(FIXED_SERIES.map((def) => [def.id, def.slot])) as Record<SeriesDef["id"], number>,
      resets: log.resets.filter((reset) => !initial.has(reset.index)),
      headings: this.headings,
    });
    this.plot.load(
      log.duration,
      log.phases.filter((phase) => phase.kind !== "disabled"),
      log.motions.map((motion, index) => ({
        start: motion.t,
        end: motion.end,
        title: `${motionText(motion)}\n${motion.source || "unknown source"} · ${(motion.end - motion.t).toFixed(2)} s`,
        timedOut: analysis.motions[index]?.timedOut ?? false,
      })),
      this.lanes(),
    );
    this.renderLegend();
    this.applyHidden();
    this.renderPane();
    this.activeMotion = -2;
    this.pastMotions = -1;
    delete this.nowList.dataset.key;
    this.closePicker();
  }

  show(time: number): MotionEvent | undefined {
    const loaded = this.loaded;
    if (!loaded) return undefined;
    this.scene.showTime(time);
    const motion = motionAt(loaded.log, time);
    const index = motion?.index ?? -1;
    this.lastTime = time;
    this.plot.showTime(time, index);
    for (const readout of this.readouts) {
      const text = readout.read(time);
      if (readout.value.textContent !== text) readout.value.textContent = text;
    }
    const past = loaded.log.motions.reduce((count, item) => count + (item.end <= time ? 1 : 0), 0);
    if (index !== this.activeMotion || past !== this.pastMotions) {
      const moved = index !== this.activeMotion;
      this.activeMotion = index;
      this.pastMotions = past;
      this.motionRows.forEach((row, i) => {
        row.classList.toggle("is-active", i === index);
        row.classList.toggle("is-past", loaded.log.motions[i].end <= time && i !== index);
      });
      if (moved && index >= 0) this.reveal(this.motionRows[index]);
    }
    this.showNow(motion, time);
    return motion;
  }

  private reveal(row: HTMLElement): void {
    const pane = row.closest<HTMLElement>(".pane");
    if (!pane || pane.hidden || pane.clientHeight === 0) return;
    const box = pane.getBoundingClientRect();
    const top = box.top + (pane.querySelector<HTMLElement>(".log-top")?.offsetHeight ?? 0);
    const rect = row.getBoundingClientRect();
    if (rect.top < top) pane.scrollTop -= top - rect.top + 4;
    else if (rect.bottom > box.bottom) pane.scrollTop += rect.bottom - box.bottom + 4;
  }

  renderMarks(marks: HTMLElement): void {
    const log = this.loaded?.log;
    marks.replaceChildren();
    if (!log) return;
    const total = Math.max(log.duration, 0.01);
    const pct = (t: number): string => `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
    for (const phase of log.phases) {
      if (phase.kind === "disabled") continue;
      const mark = el("span", `mark mark-phase mark-${phase.kind}`);
      mark.style.left = pct(phase.start);
      mark.style.width = `${((phase.end - phase.start) / total) * 100}%`;
      mark.title = phase.kind;
      marks.append(mark);
    }
    for (const motion of log.motions) {
      const mark = el("span", "mark mark-motion");
      mark.style.left = pct(motion.t);
      marks.append(mark);
    }
    this.loaded?.analysis.resets.forEach((reset) => {
      if (reset.initial) return;
      const mark = el("span", "mark mark-reset");
      mark.style.left = pct(reset.reset.t);
      marks.append(mark);
    });
    this.loaded?.analysis.motions.forEach((stats) => {
      if (!stats.timedOut) return;
      const mark = el("span", "mark mark-timeout");
      mark.style.left = pct(stats.motion.end);
      marks.append(mark);
    });
  }

  private lanes(): PlotLane[] {
    const loaded = this.loaded;
    if (!loaded) return [];
    const { log } = loaded;
    const { robot, raw, vision } = log.poses;
    const has = new Set(this.series.map((def) => def.id));
    const headings = this.headings;
    const pose = (field: "x" | "y" | "theta", target: (motion: MotionEvent, index: number) => number): PlotTrace[] => {
      const traces: PlotTrace[] = [];
      const def = (id: SeriesDef["id"]) => FIXED_SERIES.find((item) => item.id === id)!;
      if (has.has("robot")) traces.push({ series: "robot", slot: def("robot").slot, label: "Robot", t: robot.t, v: robot[field], style: "line" });
      if (has.has("raw")) traces.push({ series: "raw", slot: def("raw").slot, label: "Raw", t: raw.t, v: raw[field], style: "dash" });
      if (has.has("vision") && field !== "theta") traces.push({ series: "vision", slot: def("vision").slot, label: "Vision", t: vision.t, v: vision[field], style: "dots" });
      if (has.has("target")) {
        const steps = segments(log.motions.map((motion, index) => ({ start: motion.t, end: motion.end, value: target(motion, index) })));
        traces.push({ series: "target", slot: def("target").slot, label: "Target", ...steps, style: "steps" });
      }
      return traces;
    };
    const lanes: PlotLane[] = [
      { id: "x", label: "X", unit: "in", title: "Field X (in)", traces: pose("x", (motion) => motion.target.x) },
      { id: "y", label: "Y", unit: "in", title: "Field Y (in)", traces: pose("y", (motion) => motion.target.y) },
      { id: "theta", label: "Heading", unit: "°", title: "Heading (LemLib degrees, not wrapped)", traces: pose("theta", (_, index) => headings[index]) },
    ];
    for (const pick of this.picks) {
      const series = log.channels.get(pick.key);
      if (!series) continue;
      const label = shortChannel(pick.key);
      lanes.push({
        id: pick.key,
        label,
        unit: unitFor(pick.key, log.metadata.Units),
        title: pick.key,
        traces: [{ series: pick.key, slot: pick.slot, label, t: series.t, v: series.v, style: "line", discrete: series.discrete }],
      });
    }
    return lanes;
  }

  private hidden(): Set<string> {
    return new Set(this.host.state.hiddenSeries);
  }

  private applyHidden(): void {
    const hidden = this.hidden();
    for (const def of FIXED_SERIES) this.scene.setHidden(def.id, hidden.has(def.id));
    this.plot.setHidden(hidden);
    for (const chip of this.legend.querySelectorAll<HTMLElement>("[data-series]")) {
      chip.querySelector(".chip-toggle")?.setAttribute("aria-pressed", String(!hidden.has(chip.dataset.series ?? "")));
    }
  }

  private toggleSeries(id: string): void {
    const hidden = this.hidden();
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    this.host.state.hiddenSeries = [...hidden];
    this.applyHidden();
    this.host.persist();
  }

  private chip(id: string, label: string, slot: number, title: string, removable: boolean): HTMLElement {
    const chip = el("span", "chip");
    chip.dataset.series = id;
    chip.style.setProperty("--c", `var(--series-${slot})`);
    const toggle = button("chip-toggle", `${title}\nClick to show or hide`);
    toggle.append(el("i", "chip-key"), el("span", "chip-name", label));
    toggle.addEventListener("click", () => this.toggleSeries(id));
    chip.append(toggle);
    if (removable) {
      const remove = button("chip-x", "Remove from the graph");
      remove.append(icon(X, 12));
      remove.addEventListener("click", () => this.toggleChannel(id));
      chip.append(remove);
    }
    return chip;
  }

  private renderLegend(): void {
    this.legend.replaceChildren(
      ...this.series.map((def) => this.chip(def.id, def.label, def.slot, def.title, false)),
      ...this.picks.map((pick) => this.chip(pick.key, shortChannel(pick.key), pick.slot, pick.key, true)),
    );
    this.addButton.disabled = !this.loaded;
  }

  private toggleChannel(key: string): void {
    const at = this.picks.findIndex((pick) => pick.key === key);
    if (at >= 0) {
      this.picks.splice(at, 1);
      this.host.state.hiddenSeries = this.host.state.hiddenSeries.filter((id) => id !== key);
    } else {
      const slot = nextSlot(this.picks);
      if (slot === null || this.picks.length >= MAX_LOG_CHANNELS) {
        this.host.toast(`Up to ${MAX_LOG_CHANNELS} channels`, TriangleAlert);
        return;
      }
      this.picks.push({ key, slot });
    }
    this.host.state.logChannels = this.picks.map((pick) => pick.key);
    this.host.persist();
    this.renderLegend();
    this.plot.setLanes(this.lanes());
    this.applyHidden();
    if (!this.picker.hidden) this.renderPicker();
  }

  private openPicker(): void {
    this.picker.hidden = false;
    this.addButton.setAttribute("aria-expanded", "true");
    this.search.value = "";
    this.renderPicker();
    this.search.focus();
  }

  private closePicker(): void {
    this.picker.hidden = true;
    this.addButton.setAttribute("aria-expanded", "false");
  }

  private leaf(key: string, text: string): HTMLButtonElement {
    const picked = this.picks.some((pick) => pick.key === key);
    const leaf = button("pick-leaf", key);
    leaf.setAttribute("aria-pressed", String(picked));
    leaf.disabled = !picked && this.picks.length >= MAX_LOG_CHANNELS;
    leaf.append(el("span", "pick-name", text));
    if (picked) leaf.append(icon(Check, 13));
    leaf.addEventListener("click", () => this.toggleChannel(key));
    return leaf;
  }

  private branch(node: ChannelNode, depth: number): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const child of node.children.values()) {
      if (child.key) out.push(this.leaf(child.key, child.name));
      if (child.children.size === 0) continue;
      const group = el("details", "pick-group");
      group.open = depth === 0 && node.children.size <= 2;
      const summary = el("summary", undefined, child.name);
      summary.append(el("span", "pick-count", String(this.countLeaves(child))));
      group.append(summary, ...this.branch(child, depth + 1));
      out.push(group);
    }
    return out;
  }

  private countLeaves(node: ChannelNode): number {
    let count = node.key ? 1 : 0;
    for (const child of node.children.values()) count += this.countLeaves(child);
    return count;
  }

  private renderPicker(): void {
    const log = this.loaded?.log;
    this.pickList.replaceChildren();
    if (!log) return;
    const keys = [...log.channels.keys()].sort((a, b) => a.localeCompare(b));
    const query = this.search.value.trim();
    if (query) {
      const found = searchChannels(keys, query);
      this.pickList.append(...found.map((key) => this.leaf(key, key)));
      if (found.length === 0) this.pickList.append(el("p", "pick-empty", "No channels"));
    } else {
      this.pickList.append(...this.branch(channelTree(keys), 0));
    }
  }

  private renderPane(): void {
    const loaded = this.loaded;
    if (!loaded) return;
    const { log, analysis } = loaded;
    const file = byId("log-file");
    file.querySelector(".log-name")?.remove();
    file.append(el("span", "log-name", loaded.name));
    file.title = [loaded.path ?? loaded.name, log.header].filter(Boolean).join("\n");
    this.renderReadout(log);

    const findings = byId("log-findings");
    findings.replaceChildren(
      ...analysis.findings.map((finding) => {
        const li = el("li", `finding finding-${finding.severity}`);
        li.append(icon(FINDING_ICONS[finding.severity] ?? Info, 14), el("span", undefined, finding.text));
        return li;
      }),
    );
    byId("log-findings-head").hidden = analysis.findings.length === 0;

    const motions = byId("log-motions");
    this.motionRows = log.motions.map((motion, index) => {
      const timedOut = analysis.motions[index]?.timedOut ?? false;
      const li = el("li", `ev ev-motion${timedOut ? " st-timeout" : ""}`);
      const row = button("ev-btn", `${motion.source || "unknown source"}${timedOut ? "\nTimed out" : ""}`);
      row.append(icon(motionIcon(motion), 14), el("span", "ev-text", motionText(motion)));
      row.append(el("span", "ev-thread", motion.line ? `L${motion.line}` : "—"), el("span", "ev-time", motion.t.toFixed(2)));
      if (timedOut) {
        const mark = el("span", "ev-status");
        mark.append(icon(TimerOff, 13));
        row.append(mark);
      }
      row.addEventListener("click", () => {
        this.host.seek(motion.t);
        this.host.focusSource(motion.file, motion.line);
      });
      li.append(row);
      return li;
    });
    motions.replaceChildren(...this.motionRows);
    byId("log-motions-count").textContent = String(log.motions.length);

    const resets = byId("log-resets");
    resets.replaceChildren(
      ...analysis.resets.map((stats) => {
        const reset = stats.reset;
        const li = el("li", "ev ev-pose");
        const row = button("ev-btn", `${reset.source || "unknown source"}\ndx ${num(stats.dx)} · dy ${num(stats.dy)} · dθ ${num(stats.dtheta)}°`);
        row.append(icon(LocateFixed, 14), el("span", "ev-text", stats.initial ? "start" : `${num(stats.jump)} in`));
        row.append(el("span", "ev-thread", reset.line ? `L${reset.line}` : "—"), el("span", "ev-time", reset.t.toFixed(2)));
        row.addEventListener("click", () => {
          this.host.seek(reset.t);
          this.host.focusSource(reset.file, reset.line);
        });
        li.append(row);
        return li;
      }),
    );
    byId("log-resets-count").textContent = String(analysis.resets.filter((reset) => !reset.initial).length);
  }

  private renderReadout(log: ReplayLog): void {
    const box = byId("readout");
    box.replaceChildren();
    this.readouts = [];
    const battery = channel(log, `${KEY.battery}/voltage`);
    const vScale = voltScale(battery, log.metadata.Units?.batteryVoltage);
    const add = (label: string, read: (time: number) => string, slot?: number, onClick?: (time: number) => void) => {
      const key = el("dt", "ro-key");
      if (slot) {
        key.style.setProperty("--c", `var(--series-${slot})`);
        key.append(el("i", "chip-key"));
      }
      key.append(label);
      const value = el("dd", "ro-value");
      if (onClick) {
        value.classList.add("is-link");
        value.addEventListener("click", () => onClick(this.lastTime));
      }
      box.append(key, value);
      this.readouts.push({ value, read });
    };
    const pose = (series: ReplayLog["poses"]["robot"]) => (time: number) => {
      const p = poseAt(series, time);
      return p ? `${num(p.x)}, ${num(p.y)}, ${num(p.theta)}°` : "—";
    };
    for (const def of this.series) {
      if (def.id === "robot") add(def.label, pose(log.poses.robot), def.slot);
      if (def.id === "raw") add(def.label, pose(log.poses.raw), def.slot);
    }
    if (this.series.some((def) => def.id === "raw")) {
      add("Drift", (time) => {
        const a = poseAt(log.poses.robot, time);
        const b = poseAt(log.poses.raw, time);
        return a && b ? `${num(Math.hypot(a.x - b.x, a.y - b.y))} in` : "—";
      });
    }
    if (battery) add("Battery", (time) => `${num(valueAt(battery, time) * vScale, 2)} V`);
    add("Phase", (time) => {
      const phase = phaseAt(log, time);
      const auton = log.autons.find((run) => run.start <= time && (run.end === null || time <= run.end));
      return auton?.name ? `${phase} · ${auton.name}` : phase;
    });
    add("Motion", (time) => {
      const motion = motionAt(log, time);
      return motion ? motionText(motion) : "—";
    });
    add(
      "Source",
      (time) => {
        const motion = motionAt(log, time);
        return motion?.file ? `${fileName(motion.file)}:${motion.line ?? "?"}` : "—";
      },
      undefined,
      (time) => {
        const motion = motionAt(log, time);
        if (motion) this.host.focusSource(motion.file, motion.line);
      },
    );
  }

  private showNow(motion: MotionEvent | undefined, time: number): void {
    const key = motion ? `m${motion.index}` : "";
    if (this.nowList.dataset.key !== key || (motion && !this.nowList.querySelector(".now-bar"))) {
      this.nowList.dataset.key = key;
      this.nowList.replaceChildren();
      if (motion) {
        const li = el("li", "now-item");
        const bar = el("span", "now-bar");
        bar.append(el("i"));
        li.append(icon(motionIcon(motion), 13), el("span", "now-text", motionText(motion)), bar);
        this.nowList.append(li);
      }
    }
    const fill = this.nowList.querySelector<HTMLElement>(".now-bar i");
    if (motion && fill) fill.style.width = `${Math.min(100, ((time - motion.t) / Math.max(0.001, motion.end - motion.t)) * 100)}%`;
  }
}
