import {
  Box,
  BrickWall,
  Circle,
  CircleDashed,
  CodeXml,
  Cog,
  FileCode,
  FolderOpen,
  Hexagon,
  Hourglass,
  ListOrdered,
  LocateFixed,
  Medal,
  Moon,
  Navigation,
  OctagonAlert,
  Orbit,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Split,
  SquareArrowOutUpRight,
  Star,
  Sun,
  SunMoon,
  Timer,
  TimerOff,
  TriangleAlert,
  Trophy,
  Undo2,
  X,
  Zap,
} from "lucide";
import type { IconNode } from "lucide";
import example from "../../examples/crimson-skills-v1.cpp?raw";
import { DEFAULT_FIELD } from "../field";
import { CRIMSON_PROFILE } from "../profiles/crimson";
import type { Diagnostic } from "../program/ast";
import { discoverRoutines, routineProgram } from "../project/discover";
import type { Discovery, RoutineEntry, RoutineProgram } from "../project/discover";
import type { ProjectSnapshot } from "../project/types";
import { renderField } from "../render/fieldRenderer";
import { Scene } from "../render/scene";
import { svg } from "../render/svg";
import { ROBOT_FIELDS } from "../robot/config";
import type { CollisionEvent, ObstacleFilter, ObstacleKind } from "../sim/collisions";
import { simulate } from "../sim/runtime";
import type { SimResult, TimelineEntry } from "../sim/runtime";
import { desktop, readPicked } from "./desktop";
import { highlightLines } from "./highlight";
import { icon, setIcon } from "./icon";
import { defaultPrefs, defaultState, loadState, saveState } from "./storage";
import type { InspectorTab } from "./storage";

const STATIC_ICONS: Record<string, IconNode> = {
  CodeXml,
  FileCode,
  FolderOpen,
  ListOrdered,
  OctagonAlert,
  Play,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  Timer,
  TimerOff,
  TriangleAlert,
  Undo2,
};

const EXAMPLE: ProjectSnapshot = {
  root: "",
  name: "Example",
  files: [{ path: "src/autons/skills/v1.cpp", content: example }],
};

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const TABS: InspectorTab[] = ["timeline", "collisions", "code", "settings"];
const OBSTACLES: Array<[keyof ObstacleFilter, string, IconNode]> = [
  ["walls", "Walls", BrickWall],
  ["goals", "Goals", Hexagon],
  ["loaders", "Loaders", Box],
  ["elements", "Pins", Circle],
];
const OBSTACLE_ICONS: Record<ObstacleKind, IconNode> = { wall: BrickWall, goal: Hexagon, loader: Box, element: Circle };
const KIND_ICONS: Record<string, IconNode> = { mechanism: Cog, wait: Hourglass, pose: LocateFixed, instant: Zap, group: Split };
const NOW_KINDS = new Set(["motion", "mechanism", "wait"]);

function byId<T extends Element = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as unknown as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, title?: string): HTMLButtonElement {
  const node = el("button", className);
  node.type = "button";
  if (title) node.title = title;
  return node;
}

function entryIcon(entry: TimelineEntry): IconNode {
  if (entry.kind !== "motion") return KIND_ICONS[entry.kind] ?? Zap;
  const method = /\.(\w+)\s*\(/.exec(entry.text)?.[1] ?? "";
  if (method === "donut") return Orbit;
  if (/^(turn|swing)/.test(method)) return RotateCw;
  return Navigation;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
}

export async function startApp(): Promise<void> {
  const profile = CRIMSON_PROFILE;
  const field = DEFAULT_FIELD;
  const state = loadState(defaultState(profile));
  const root = document.documentElement;
  root.classList.toggle("is-desktop", desktop !== null);

  for (const node of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const found = STATIC_ICONS[node.dataset.icon ?? ""];
    if (found) node.prepend(icon(found));
  }

  const fieldSvg = byId<SVGSVGElement>("field");
  const fieldLayer = svg("g", { class: "field-layer" }, fieldSvg);
  const sceneLayer = svg("g", { class: "scene-layer" }, fieldSvg);
  const scene = new Scene(sceneLayer, renderField(fieldLayer, field));

  const fieldWrap = byId("field-wrap");
  const routineList = byId("routine-list");
  const projectName = byId("project-name");
  const folderButton = byId<HTMLButtonElement>("open-folder");
  const live = byId("live");
  const folderInput = byId<HTMLInputElement>("folder-input");
  const fileInput = byId<HTMLInputElement>("file-input");
  const playButton = byId<HTMLButtonElement>("play");
  const speedButton = byId<HTMLButtonElement>("speed");
  const scrubber = byId<HTMLInputElement>("scrubber");
  const clockNow = byId("clock-now");
  const clockTotal = byId("clock-total");
  const marks = byId("scrub-marks");
  const nowList = byId("now");
  const over = byId("over");
  const coords = byId("coords");
  const toastNode = byId("toast");
  const toastText = byId("toast-text");
  const timeline = byId("timeline");
  const collisions = byId("collisions");
  const diagnosticsList = byId("diagnostics");
  const codeView = byId("code");
  const codeFile = byId("code-file");
  const reveal = byId<HTMLButtonElement>("reveal");
  const themeButton = byId<HTMLButtonElement>("theme");

  let snapshot: ProjectSnapshot = EXAMPLE;
  let discovery: Discovery = discoverRoutines(EXAMPLE.files, profile);
  let entry: RoutineEntry | null = null;
  let program: RoutineProgram | null = null;
  let result: SimResult | null = null;
  let playhead = 0;
  let playing = false;
  let lastTimestamp = 0;
  let lastFrame = -1;
  let timelineRows: Array<{ entry: TimelineEntry; row: HTMLElement }> = [];
  let codeLines: HTMLElement[] = [];
  let activeLines = new Set<number>();
  let activeRows = new Set<number>();
  let toastTimer: number | undefined;
  let lastCodePath: string | null = null;

  const isExample = (): boolean => snapshot === EXAMPLE;
  const period = (): number => (entry ? (state.periods[entry.id] ?? entry.periodSeconds) : 15);
  const persist = debounce(() => saveState(state), 250);

  function toast(text: string, node: IconNode = RefreshCw): void {
    setIcon(toastNode, node, 14);
    toastText.textContent = text;
    toastNode.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastNode.classList.remove("show"), 1600);
  }

  function applyTheme(): void {
    if (state.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = state.theme;
    themeButton.replaceChildren(icon(state.theme === "system" ? SunMoon : state.theme === "light" ? Sun : Moon));
    themeButton.title = `Theme: ${state.theme}`;
    void desktop?.setTheme(state.theme);
  }

  function setPlaying(value: boolean): void {
    playing = value;
    setIcon(playButton, playing ? Pause : Play);
    playButton.title = playing ? "Pause (Space)" : "Play (Space)";
    fieldWrap.classList.toggle("is-playing", playing);
  }

  function seek(time: number): void {
    if (!result) return;
    playhead = Math.max(0, Math.min(result.duration, time));
    draw(true);
  }

  function showTab(tab: InspectorTab): void {
    state.tab = tab;
    for (const node of document.querySelectorAll<HTMLElement>("[data-tab]")) {
      const selected = node.dataset.tab === tab;
      node.setAttribute("aria-selected", String(selected));
      node.classList.toggle("is-selected", selected);
    }
    for (const node of document.querySelectorAll<HTMLElement>("[data-pane]")) {
      node.hidden = node.dataset.pane !== tab;
    }
    persist();
  }

  function focusLine(line: number | null): void {
    if (!line) return;
    const node = codeLines[line - 1];
    if (!node) return;
    for (const other of codeView.querySelectorAll(".is-focus")) other.classList.remove("is-focus");
    node.classList.add("is-focus");
    if (state.tab === "code") node.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function renderProjectChip(): void {
    projectName.textContent = isExample() ? "Open folder" : snapshot.name;
    folderButton.title = isExample() ? "Open a PROS project folder" : `${snapshot.root}\nClick to open a different folder`;
    folderButton.classList.toggle("is-cta", isExample());
    live.hidden = !desktop || isExample();
  }

  function renderRoutines(): void {
    routineList.replaceChildren();
    if (discovery.routines.length === 0) {
      const empty = el("div", "side-empty");
      empty.append(icon(FolderOpen, 22), el("p", undefined, "No routines found"));
      routineList.append(empty);
      return;
    }
    const groups = new Map<string, RoutineEntry[]>();
    for (const routine of discovery.routines) {
      const key = routine.registered ? routine.group || "routines" : "not in selector";
      groups.set(key, [...(groups.get(key) ?? []), routine]);
    }
    for (const [name, routines] of groups) {
      const section = el("section", "group");
      const head = el("div", "group-head");
      head.append(icon(name === "not in selector" ? CircleDashed : /skill/i.test(name) ? Medal : Trophy, 13), el("span", undefined, name));
      const list = el("ul");
      for (const routine of routines) {
        const li = el("li", "routine-row");
        const pick = button(`routine${routine.id === entry?.id ? " is-selected" : ""}`, routine.path);
        pick.append(el("span", "routine-name", routine.name));
        if (routine.isDefault) {
          const star = el("span", "routine-default");
          star.title = "Default routine";
          star.append(icon(Star, 12));
          pick.append(star);
        }
        pick.addEventListener("click", () => selectRoutine(routine, false));
        li.append(pick);
        if (desktop && !isExample()) {
          const open = button("icon-btn routine-open", "Open in editor");
          open.append(icon(SquareArrowOutUpRight, 14));
          open.addEventListener("click", () => void desktop?.reveal(routine.path));
          li.append(open);
        }
        list.append(li);
      }
      section.append(head, list);
      routineList.append(section);
    }
    if (isExample()) {
      const cta = button("side-cta");
      cta.append(icon(FolderOpen, 15), el("span", undefined, "Open your project"));
      cta.addEventListener("click", openFolder);
      routineList.append(cta);
    }
  }

  function renderCode(): void {
    const keepScroll = program?.file.path === lastCodePath ? codeView.scrollTop : null;
    codeView.replaceChildren();
    codeLines = [];
    activeLines = new Set();
    lastCodePath = program?.file.path ?? null;
    if (!program) {
      codeFile.querySelector(".code-path")?.remove();
      return;
    }
    const fileLabel = codeFile.querySelector(".code-path") ?? codeFile.appendChild(el("span", "code-path"));
    fileLabel.textContent = program.file.path;
    reveal.hidden = !desktop || isExample();
    const fragment = document.createDocumentFragment();
    highlightLines(program.file.source).forEach((tokens, index) => {
      const line = el("div", "cl");
      line.dataset.line = String(index + 1);
      const text = el("span", "cl-t");
      for (const token of tokens) {
        if (token.kind === "plain") text.append(token.text);
        else text.append(el("span", `tk-${token.kind}`, token.text));
      }
      line.append(el("span", "cl-n", String(index + 1)), text);
      fragment.append(line);
      codeLines.push(line);
    });
    codeView.append(fragment);
    const start = codeLines[program.run.line - 1];
    if (keepScroll !== null) codeView.scrollTop = keepScroll;
    else if (start) codeView.scrollTop = Math.max(0, start.offsetTop - 12);
  }

  function renderDiagnostics(list: Diagnostic[]): void {
    diagnosticsList.replaceChildren();
    for (const line of codeView.querySelectorAll(".has-diag")) {
      line.classList.remove("has-diag");
      line.removeAttribute("title");
    }
    for (const item of list) {
      const li = el("li", `diag diag-${item.severity}`);
      const go = button("diag-btn");
      go.append(icon(TriangleAlert, 14), el("span", "diag-line", item.line > 0 ? `L${item.line}` : "—"), el("span", "diag-text", item.message));
      go.addEventListener("click", () => focusLine(item.line));
      li.append(go);
      diagnosticsList.append(li);
      const node = codeLines[item.line - 1];
      if (node) {
        node.classList.add("has-diag");
        node.title = item.message;
      }
    }
    const badge = byId("badge-code");
    badge.textContent = list.length ? String(list.length) : "";
  }

  function metric(id: string, value: string, tone: "ok" | "warn" | "bad" | "zero", title: string): void {
    const node = byId(id);
    const bold = node.querySelector("b");
    if (bold) bold.textContent = value;
    node.className = `metric tone-${tone}`;
    node.title = title;
  }

  function renderMetrics(sim: SimResult, diagnostics: Diagnostic[]): void {
    let driven = 0;
    for (let i = 1; i < sim.frameCount; i++) driven += Math.hypot(sim.x[i] - sim.x[i - 1], sim.y[i] - sim.y[i - 1]);
    const timeouts = sim.timeline.filter((item) => item.status === "timeout").length;
    const overLimit = sim.duration > sim.periodSeconds;
    metric(
      "m-time",
      `${sim.duration.toFixed(1)}s`,
      overLimit ? "bad" : "ok",
      `Run time ${sim.duration.toFixed(2)} s of ${sim.periodSeconds} s\n${driven.toFixed(0)} in driven · ${sim.poseResets.length} pose resets`,
    );
    metric("m-hits", String(sim.collisions.length), sim.collisions.length ? "bad" : "zero", `${sim.collisions.length} collisions`);
    metric("m-timeouts", String(timeouts), timeouts ? "warn" : "zero", `${timeouts} moves timed out`);
    metric("m-warn", String(diagnostics.length), diagnostics.length ? "warn" : "zero", `${diagnostics.length} lines skipped or flagged`);
    byId("badge-collisions").textContent = sim.collisions.length ? String(sim.collisions.length) : "";
  }

  function compact(text: string): string {
    let out = text.trim().replace(/;$/, "").replace(/\s+/g, " ");
    for (const name of profile.chassisNames) if (out.startsWith(`${name}.`)) out = out.slice(name.length + 1);
    return out;
  }

  function renderTimeline(sim: SimResult): void {
    timeline.replaceChildren();
    timelineRows = [];
    activeRows = new Set();
    const fragment = document.createDocumentFragment();
    for (const item of sim.timeline) {
      const li = el("li", `ev ev-${item.kind} st-${item.status}${item.thread === "main" ? "" : " is-nested"}`);
      const row = button("ev-btn", item.text);
      const status = item.status === "timeout" ? TimerOff : item.status === "done" ? null : X;
      row.append(icon(entryIcon(item), 14), el("span", "ev-text", compact(item.text)));
      if (item.thread !== "main") row.append(el("span", "ev-thread", item.thread));
      row.append(el("span", "ev-time", item.start.toFixed(2)));
      if (status) {
        const mark = el("span", "ev-status");
        mark.title = item.status === "timeout" ? "Timed out" : item.status;
        mark.append(icon(status, 13));
        row.append(mark);
      }
      row.addEventListener("click", () => {
        setPlaying(false);
        seek(item.start);
        focusLine(item.line);
      });
      li.append(row);
      fragment.append(li);
      timelineRows.push({ entry: item, row: li });
    }
    timeline.append(fragment);
  }

  function renderCollisions(sim: SimResult): void {
    collisions.replaceChildren();
    if (sim.collisions.length === 0) {
      const empty = el("li", "empty");
      empty.append(icon(OctagonAlert, 20), el("span", undefined, "No collisions"));
      collisions.append(empty);
      return;
    }
    sim.collisions.forEach((event: CollisionEvent, index) => {
      const li = el("li", "hit");
      const row = button("hit-btn", event.command ?? "Before the first move");
      row.append(
        el("span", "hit-n", String(index + 1)),
        icon(OBSTACLE_ICONS[event.kind], 14),
        el("span", "hit-name", event.obstacleName),
        el("span", "hit-line", event.line ? `L${event.line}` : ""),
        el("span", "ev-time", event.start.toFixed(2)),
      );
      row.addEventListener("click", () => {
        setPlaying(false);
        seek(event.start);
        focusLine(event.line);
      });
      li.append(row);
      collisions.append(li);
    });
  }

  function renderMarks(sim: SimResult): void {
    marks.replaceChildren();
    const total = Math.max(sim.duration, 0.01);
    const pct = (t: number): string => `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
    for (const event of sim.collisions) {
      const mark = el("span", "mark mark-hit");
      mark.style.left = pct(event.start);
      mark.style.width = `max(2px, ${((event.end - event.start) / total) * 100}%)`;
      marks.append(mark);
    }
    for (const item of sim.timeline) {
      if (item.status !== "timeout") continue;
      const mark = el("span", "mark mark-timeout");
      mark.style.left = pct(item.end);
      marks.append(mark);
    }
    if (sim.periodSeconds < sim.duration) {
      const limit = el("span", "mark mark-limit");
      limit.style.left = pct(sim.periodSeconds);
      marks.append(limit);
    }
  }

  function renderPeriod(): void {
    for (const node of document.querySelectorAll<HTMLButtonElement>("[data-period]")) {
      node.setAttribute("aria-pressed", String(Number(node.dataset.period) === period()));
    }
  }

  function clearResult(): void {
    result = null;
    fieldWrap.classList.add("is-empty");
    timeline.replaceChildren();
    collisions.replaceChildren();
    diagnosticsList.replaceChildren();
    marks.replaceChildren();
    nowList.replaceChildren();
    for (const id of ["m-time", "m-hits", "m-timeouts", "m-warn"]) metric(id, "–", "zero", "");
    clockNow.textContent = "0.00";
    clockTotal.textContent = "";
  }

  function simulateNow(): void {
    program = entry ? routineProgram(discovery, entry) : null;
    if (!entry || !program) {
      renderCode();
      clearResult();
      return;
    }
    fieldWrap.classList.remove("is-empty");
    result = simulate(program.body, {
      field,
      profile,
      robot: state.prefs.robot,
      mechanismOverrides: state.prefs.mechanismOverrides,
      periodSeconds: period(),
      obstacles: state.prefs.obstacles,
    });
    const seen = new Set<string>();
    const diagnostics = [...program.diagnostics, ...result.diagnostics]
      .filter((item) => {
        const key = `${item.line}:${item.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.line - b.line);
    renderDiagnostics(diagnostics);
    renderMetrics(result, diagnostics);
    renderTimeline(result);
    renderCollisions(result);
    renderMarks(result);
    renderPeriod();
    scene.load(result, state.prefs.robot);
    scrubber.max = String(result.duration);
    clockTotal.textContent = ` / ${result.duration.toFixed(2)}`;
    playhead = Math.min(playhead, result.duration);
    lastFrame = -1;
    draw(true);
  }

  function selectRoutine(next: RoutineEntry | null, keepPlayhead: boolean): void {
    entry = next;
    state.routineId = next?.id ?? state.routineId;
    document.title = next ? `${next.name} · PointWeaver` : "PointWeaver";
    if (!keepPlayhead) {
      playhead = 0;
      setPlaying(false);
    }
    renderRoutines();
    program = entry ? routineProgram(discovery, entry) : null;
    renderCode();
    simulateNow();
    persist();
  }

  function useProject(next: ProjectSnapshot, reason: "open" | "restore" | "change"): void {
    const before = snapshot;
    snapshot = next;
    discovery = discoverRoutines(next.files, profile);
    renderProjectChip();
    const keep =
      discovery.routines.find((routine) => routine.id === state.routineId) ??
      discovery.routines.find((routine) => routine.isDefault) ??
      discovery.routines[0] ??
      null;
    selectRoutine(keep, reason === "change" && keep?.id === entry?.id);
    if (!desktop) state.snapshot = isExample() ? null : next;
    if (reason === "change") {
      const changed = next.files.find((file) => before.files.find((old) => old.path === file.path)?.content !== file.content);
      toast(changed ? (changed.path.split("/").pop() ?? changed.path) : "Updated");
    } else if (reason === "open") {
      toast(`${discovery.routines.length} routines`, FolderOpen);
    }
    persist();
  }

  async function openFolder(): Promise<void> {
    if (desktop) {
      const picked = await desktop.openFolder();
      if (picked) useProject(picked, "open");
    } else {
      folderInput.click();
    }
  }

  function updateNow(time: number): void {
    if (!result) return;
    nowList.replaceChildren();
    const active = result.timeline.filter((item) => NOW_KINDS.has(item.kind) && item.start <= time && time < item.end).slice(0, 4);
    for (const item of active) {
      const li = el("li", "now-item");
      const bar = el("span", "now-bar");
      const fill = el("i");
      fill.style.width = `${Math.min(100, ((time - item.start) / Math.max(0.001, item.end - item.start)) * 100)}%`;
      bar.append(fill);
      li.append(icon(entryIcon(item), 13), el("span", "now-text", compact(item.text)), bar);
      nowList.append(li);
    }
    const past = time - result.periodSeconds;
    over.hidden = past <= 0;
    over.textContent = past > 0 ? `+${past.toFixed(1)}s` : "";
  }

  function follow(container: HTMLElement, node: Element | undefined): void {
    if (!node || !playing) return;
    const box = container.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (rect.top < box.top || rect.bottom > box.bottom) node.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function draw(force = false): void {
    if (!result) return;
    const time = Math.max(0, Math.min(result.duration, playhead));
    scene.showTime(time);
    clockNow.textContent = time.toFixed(2);
    scrubber.value = String(time);
    scrubber.style.setProperty("--fill", `${(time / Math.max(result.duration, 0.001)) * 100}%`);
    const frame = Math.round(time / result.dt);
    if (frame === lastFrame && !force) return;
    lastFrame = frame;
    updateNow(time);

    const rows = new Set<number>();
    const lines = new Set<number>();
    timelineRows.forEach(({ entry: item, row }, index) => {
      const on = item.start <= time && time < item.end;
      row.classList.toggle("is-active", on);
      row.classList.toggle("is-past", item.end <= time && !on);
      if (on) {
        rows.add(index);
        if (item.kind !== "group") lines.add(item.line);
      }
    });
    const newRow = [...rows].find((index) => !activeRows.has(index));
    activeRows = rows;
    if (newRow !== undefined && state.tab === "timeline") follow(timeline.parentElement ?? timeline, timelineRows[newRow].row);

    for (const line of activeLines) if (!lines.has(line)) codeLines[line - 1]?.classList.remove("is-active");
    let newLine: number | undefined;
    for (const line of lines) {
      if (!activeLines.has(line)) newLine ??= line;
      codeLines[line - 1]?.classList.add("is-active");
    }
    activeLines = lines;
    if (newLine !== undefined && state.tab === "code") follow(codeView, codeLines[newLine - 1]);
  }

  function buildSettings(): void {
    const toggles = byId("obstacle-toggles");
    toggles.replaceChildren(
      ...OBSTACLES.map(([key, label, node]) => {
        const toggle = button("toggle", `Count ${label.toLowerCase()} as collisions`);
        toggle.setAttribute("aria-pressed", String(state.prefs.obstacles[key]));
        toggle.append(icon(node, 15), el("span", undefined, label));
        toggle.addEventListener("click", () => {
          state.prefs.obstacles[key] = !state.prefs.obstacles[key];
          toggle.setAttribute("aria-pressed", String(state.prefs.obstacles[key]));
          simulateNow();
          persist();
        });
        return toggle;
      }),
    );

    byId("robot-fields").replaceChildren(
      ...ROBOT_FIELDS.map((spec) => {
        const wrap = el("label", "num");
        const input = el("input");
        input.type = "number";
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        input.value = String(state.prefs.robot[spec.key]);
        input.addEventListener("change", () => {
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          state.prefs.robot[spec.key] = Math.min(spec.max, Math.max(spec.min, value));
          input.value = String(state.prefs.robot[spec.key]);
          simulateNow();
          persist();
        });
        const box = el("span", "num-box");
        box.append(input, el("span", "num-unit", spec.unit));
        wrap.append(el("span", "num-label", spec.label), box);
        return wrap;
      }),
    );

    byId("mechanism-fields").replaceChildren(
      ...Object.entries(profile.mechanismTimes).map(([callee, ms]) => {
        const wrap = el("label", "num inline");
        const input = el("input");
        input.type = "number";
        input.min = "0";
        input.step = "50";
        input.value = String(state.prefs.mechanismOverrides[callee] ?? ms);
        input.addEventListener("change", () => {
          const value = Number(input.value);
          if (!Number.isFinite(value) || value < 0) return;
          if (value === ms) delete state.prefs.mechanismOverrides[callee];
          else state.prefs.mechanismOverrides[callee] = value;
          simulateNow();
          persist();
        });
        const box = el("span", "num-box");
        box.append(input, el("span", "num-unit", "ms"));
        wrap.append(el("code", "num-label", callee.replace(/^macros::/, "")), box);
        wrap.title = callee;
        return wrap;
      }),
    );
  }

  folderButton.addEventListener("click", () => void openFolder());
  folderInput.addEventListener("change", async () => {
    const picked = await readPicked(folderInput.files);
    folderInput.value = "";
    if (picked) useProject(picked, "open");
  });
  fileInput.addEventListener("change", async () => {
    const picked = await readPicked(fileInput.files);
    fileInput.value = "";
    if (picked) useProject(picked, "open");
  });
  byId("open-file").hidden = desktop !== null;
  reveal.addEventListener("click", () => {
    if (entry) void desktop?.reveal(entry.path);
  });
  themeButton.addEventListener("click", () => {
    state.theme = state.theme === "system" ? "light" : state.theme === "light" ? "dark" : "system";
    applyTheme();
    persist();
  });

  for (const node of document.querySelectorAll<HTMLElement>("[data-tab]")) {
    node.addEventListener("click", () => showTab(node.dataset.tab as InspectorTab));
  }
  byId("m-hits").addEventListener("click", () => showTab("collisions"));
  byId("m-warn").addEventListener("click", () => showTab("code"));
  byId("m-timeouts").addEventListener("click", () => {
    showTab("timeline");
    timeline.querySelector(".st-timeout")?.scrollIntoView({ block: "center", behavior: "smooth" });
  });

  playButton.addEventListener("click", () => {
    if (!result) return;
    if (!playing && playhead >= result.duration - result.dt) playhead = 0;
    setPlaying(!playing);
  });
  byId("restart").addEventListener("click", () => {
    seek(0);
    setPlaying(true);
  });
  speedButton.addEventListener("click", () => {
    const index = SPEEDS.indexOf(state.speed);
    state.speed = SPEEDS[(index + 1) % SPEEDS.length];
    speedButton.textContent = `${state.speed}×`;
    persist();
  });
  scrubber.addEventListener("input", () => {
    setPlaying(false);
    seek(Number(scrubber.value));
  });
  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-period]")) {
    node.addEventListener("click", () => {
      if (!entry) return;
      const value = Number(node.dataset.period);
      if (value === entry.periodSeconds) delete state.periods[entry.id];
      else state.periods[entry.id] = value;
      simulateNow();
      persist();
    });
  }
  byId("reset-settings").addEventListener("click", () => {
    state.prefs = defaultPrefs(profile);
    buildSettings();
    simulateNow();
    persist();
  });

  codeView.addEventListener("click", (event) => {
    const line = Number((event.target as HTMLElement).closest<HTMLElement>(".cl")?.dataset.line);
    const hit = result?.timeline.find((item) => item.line === line);
    if (hit) {
      setPlaying(false);
      seek(hit.start);
      focusLine(line);
    }
  });

  const toField = (event: MouseEvent): { x: number; y: number } | null => {
    const matrix = fieldSvg.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const x = point.x;
    const y = -point.y;
    return Math.abs(x) <= field.half && Math.abs(y) <= field.half ? { x, y } : null;
  };
  fieldSvg.addEventListener("pointermove", (event) => {
    const at = toField(event);
    coords.textContent = at ? `${at.x.toFixed(1)}, ${at.y.toFixed(1)}` : "";
  });
  fieldSvg.addEventListener("pointerleave", () => {
    coords.textContent = "";
  });
  fieldSvg.addEventListener("click", (event) => {
    const at = toField(event);
    if (!at) return;
    const text = `${at.x.toFixed(1)}, ${at.y.toFixed(1)}`;
    navigator.clipboard?.writeText(text).then(
      () => toast(`Copied ${text}`, LocateFixed),
      () => undefined,
    );
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    if (event.key === " ") {
      event.preventDefault();
      playButton.click();
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      setPlaying(false);
      const step = event.shiftKey ? 1 : 0.1;
      seek(playhead + (event.key === "ArrowRight" ? step : -step));
    } else if (event.key === "Home") {
      event.preventDefault();
      seek(0);
    } else if (/^[1-4]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      showTab(TABS[Number(event.key) - 1]);
    }
  });

  const loop = (timestamp: number): void => {
    if (playing && result) {
      const elapsed = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : 0;
      playhead += Math.min(elapsed, 0.1) * state.speed;
      if (playhead >= result.duration) {
        playhead = result.duration;
        setPlaying(false);
      }
      draw();
    }
    lastTimestamp = timestamp;
    requestAnimationFrame(loop);
  };

  speedButton.textContent = `${state.speed}×`;
  applyTheme();
  setPlaying(false);
  showTab(state.tab);
  buildSettings();
  desktop?.onChange((next) => useProject(next, "change"));
  const restored = desktop ? await desktop.restore().catch(() => null) : state.snapshot;
  useProject(restored ?? EXAMPLE, "restore");
  requestAnimationFrame(loop);
}
