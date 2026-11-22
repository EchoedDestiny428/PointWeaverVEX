import { toDegrees, toRadians, wrap180 } from "../core/angle";
import { distance, robotBox } from "../core/geometry";
import type { Pose } from "../core/geometry";
import type { FieldDefinition } from "../field/types";
import type { CallStmt, Diagnostic, LoopStmt, SourceRef, Stmt } from "../program/ast";
import { findParam } from "../program/ast";
import { ExpressionError, evaluate } from "../program/expression";
import { loopPasses, MAX_LOOP_PASSES, substitute } from "../program/loops";
import type { LoopPasses } from "../program/loops";
import { mechanismDuration } from "../profiles/types";
import type { TeamProfile } from "../profiles/types";
import type { RobotConfig } from "../robot/config";
import { buildObstacles, CollisionTracker } from "./collisions";
import type { CollisionContext, CollisionEvent, ObstacleFilter } from "./collisions";
import { findMotionCommand } from "./commands";
import type { ArgReader, MotionCommand } from "./commands";
import { approach, approachSpeed, integrate } from "./kinematics";
import type { DriveState } from "./kinematics";
import type { Motion } from "./motions/types";

export interface SimSettings {
  field: FieldDefinition;
  profile: TeamProfile;
  robot: RobotConfig;
  mechanismOverrides: Record<string, number>;
  periodSeconds: number;
  obstacles: ObstacleFilter;
  dt?: number;
}

export type EntryKind = "motion" | "mechanism" | "wait" | "pose" | "instant" | "group" | "loop";
export type EntryStatus = "running" | "done" | "timeout" | "cancelled" | "unfinished";

export interface TimelineEntry {
  id: number;
  thread: string;
  line: number;
  text: string;
  kind: EntryKind;
  start: number;
  end: number;
  status: EntryStatus;
}

export interface PoseReset {
  time: number;
  line: number;
  from: Pose;
  to: Pose;
}

export interface SimResult {
  dt: number;
  frameCount: number;
  duration: number;
  periodSeconds: number;
  finished: boolean;
  x: Float32Array;
  y: Float32Array;
  theta: Float32Array;
  hit: Uint8Array;
  timeline: TimelineEntry[];
  collisions: CollisionEvent[];
  poseResets: PoseReset[];
  diagnostics: Diagnostic[];
}

type Task = Generator<void, void, void>;

interface Thread {
  label: string;
  task: Task;
  done: boolean;
  steppedAt: number;
}

interface ActiveMotion {
  motion: Motion;
  entry: TimelineEntry;
  elapsed: number;
}

const OVERRUN_SECONDS = 15;
const EPSILON = 1e-6;
const GOAL_CONTACT_DISTANCE = 7;
const GOAL_MAX_CORRECTION = 10;
const DELAY_CALLS = new Set(["pros::delay", "pros::c::delay", "delay", "pros::Task::delay", "vex::wait"]);

class Runtime {
  time = 0;
  tick = 0;
  readonly state: DriveState = { pose: { x: 0, y: 0, theta: 0 }, v: 0, w: 0 };
  active: ActiveMotion | null = null;
  lastMotion: TimelineEntry | null = null;
  readonly threads: Thread[] = [];
  readonly timeline: TimelineEntry[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly poseResets: PoseReset[] = [];
  private nextEntryId = 1;
  private readonly reported = new Set<string>();
  private hasPose = false;

  constructor(readonly settings: Required<SimSettings>) {}

  spawn(label: string, task: Task): Thread {
    const thread: Thread = { label, task, done: false, steppedAt: -1 };
    this.threads.push(thread);
    this.advance(thread);
    return thread;
  }

  private advance(thread: Thread): void {
    thread.steppedAt = this.tick;
    if (thread.task.next().done) {
      thread.done = true;
    }
  }

  begin(thread: string, source: SourceRef, kind: EntryKind): TimelineEntry {
    const entry: TimelineEntry = {
      id: this.nextEntryId++,
      thread,
      line: source.line,
      text: source.text,
      kind,
      start: this.time,
      end: Number.NaN,
      status: "running",
    };
    this.timeline.push(entry);
    return entry;
  }

  finish(entry: TimelineEntry, status: EntryStatus): void {
    entry.end = this.time;
    entry.status = status;
  }

  instant(thread: string, source: SourceRef, kind: EntryKind): void {
    this.finish(this.begin(thread, source, kind), "done");
  }

  report(line: number, severity: Diagnostic["severity"], message: string): void {
    const key = `${line}|${message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostics.push({ line, severity, message });
  }

  readonly resolve = (name: string): number | undefined => {
    if (name === "M_PI") return Math.PI;
    for (const chassis of this.settings.profile.chassisNames) {
      if (name === `${chassis}.getPose().x`) return this.state.pose.x;
      if (name === `${chassis}.getPose().y`) return this.state.pose.y;
      if (name === `${chassis}.getPose().theta`) return this.state.pose.theta;
    }
    return undefined;
  };

  evaluate(text: string): number {
    return evaluate(text, this.resolve);
  }

  reader(stmt: CallStmt, paramsIndex: number): ArgReader {
    const params = stmt.args[paramsIndex];
    const exprText = (index: number): string | undefined => {
      const arg = stmt.args[index];
      return arg && arg.kind === "expr" ? arg.text : undefined;
    };
    return {
      number: (index, name) => {
        const text = exprText(index);
        if (text === undefined) throw new ExpressionError(`\`${name}\` is missing.`);
        return this.evaluate(text);
      },
      text: exprText,
      paramNumber: (key, fallback) => {
        const value = findParam(params, key);
        return value === undefined ? fallback : this.evaluate(value);
      },
      paramBool: (key, fallback) => {
        const value = findParam(params, key);
        if (value === undefined) return fallback;
        if (value === "true") return true;
        if (value === "false") return false;
        return this.evaluate(value) !== 0;
      },
      paramDirection: (key) => {
        const value = findParam(params, key) ?? "";
        if (/CCW|COUNTER/i.test(value)) return "ccw";
        if (/CW|CLOCKWISE/i.test(value)) return "cw";
        return "auto";
      },
    };
  }

  setPose(pose: Pose, line: number): void {
    const from = { ...this.state.pose };
    this.state.pose.x = pose.x;
    this.state.pose.y = pose.y;
    this.state.pose.theta = pose.theta;
    if (this.hasPose && (distance(from, pose) > 0.25 || Math.abs(wrap180(from.theta - pose.theta)) > 1)) {
      this.poseResets.push({ time: this.time, line, from, to: { ...pose } });
    }
    this.hasPose = true;
  }

  runThreads(): void {
    for (let i = this.threads.length - 1; i >= 0; i--) {
      const thread = this.threads[i];
      if (!thread.done && thread.steppedAt !== this.tick) {
        this.advance(thread);
      }
    }
  }

  stepMotion(dt: number): void {
    const robot = this.settings.robot;
    if (this.active) {
      const active = this.active;
      const status = active.motion.step(this.state, dt, robot);
      active.elapsed += dt;
      if (status === "done") this.endMotion("done");
      else if (active.elapsed * 1000 >= active.motion.timeoutMs - EPSILON) this.endMotion("timeout");
      return;
    }
    this.state.v = approachSpeed(this.state.v, 0, robot, dt);
    this.state.w = approach(this.state.w, 0, robot.turnAcceleration * dt);
    integrate(this.state, dt);
  }

  endMotion(status: EntryStatus): void {
    if (!this.active) return;
    const { motion, entry } = this.active;
    this.finish(entry, status);
    if (status === "done" && !motion.keepsMoving) {
      this.state.v = 0;
      this.state.w = 0;
    }
    this.lastMotion = entry;
    this.active = null;
  }

  get idle(): boolean {
    return this.active === null && this.threads.every((thread) => thread.done);
  }

  context(): CollisionContext {
    const entry = this.active?.entry ?? this.lastMotion;
    return entry ? { line: entry.line, command: entry.text } : { line: null, command: null };
  }

  closeOpenEntries(): void {
    for (const entry of this.timeline) {
      if (entry.status === "running") {
        entry.end = this.time;
        entry.status = "unfinished";
      }
    }
  }
}

function* runList(rt: Runtime, statements: Stmt[], thread: string): Task {
  for (const stmt of statements) {
    yield* runStatement(rt, stmt, thread);
  }
}

function* runStatement(rt: Runtime, stmt: Stmt, thread: string): Task {
  if (stmt.kind === "unsupported") {
    rt.report(stmt.line, "warning", stmt.reason);
    return;
  }
  if (stmt.kind === "parallel") {
    const group = rt.begin(thread, stmt, "group");
    const children = stmt.tasks.map((task, index) => {
      const label = `L${stmt.line}${String.fromCharCode(65 + index)}`;
      return rt.spawn(label, runList(rt, task, label));
    });
    while (children.some((child) => !child.done)) yield;
    rt.finish(group, "done");
    return;
  }
  if (stmt.kind === "loop") {
    yield* runLoop(rt, stmt, thread);
    return;
  }
  yield* runCall(rt, stmt, thread);
}

function* runLoop(rt: Runtime, stmt: LoopStmt, thread: string): Task {
  let passes: LoopPasses;
  try {
    passes = loopPasses(stmt.iteration, (text) => rt.evaluate(text));
  } catch {
    rt.report(stmt.line, "warning", "This loop's start, end or step isn't a plain number, so the loop is skipped.");
    return;
  }
  if (passes.capped) {
    rt.report(stmt.line, "warning", `This loop runs more than ${MAX_LOOP_PASSES} times, so only the first ${MAX_LOOP_PASSES} passes are simulated.`);
  }
  const { variable } = stmt.iteration;
  const total = passes.values.length;
  for (const [index, value] of passes.values.entries()) {
    const label = value.replace(/\b[A-Za-z_]\w*::/g, "");
    const pass = rt.begin(thread, { line: stmt.line, text: `${variable} = ${label} · ${index + 1}/${total}` }, "loop");
    yield* runList(rt, substitute(stmt.body, variable, value), thread);
    rt.finish(pass, "done");
  }
}

function* waitSeconds(rt: Runtime, seconds: number): Task {
  const end = rt.time + Math.max(0, seconds);
  while (rt.time < end - EPSILON) yield;
}

function* runCall(rt: Runtime, stmt: CallStmt, thread: string): Task {
  const split = stmt.callee.lastIndexOf(".");
  const owner = split > 0 ? stmt.callee.slice(0, split) : "";
  if (rt.settings.profile.chassisNames.includes(owner)) {
    yield* runChassis(rt, stmt, thread, stmt.callee.slice(split + 1));
    return;
  }
  if (DELAY_CALLS.has(stmt.callee)) {
    let ms: number;
    try {
      ms = rt.reader(stmt, -1).number(0, "time");
    } catch (error) {
      rt.report(stmt.line, "error", `${(error as Error).message} This delay is skipped.`);
      return;
    }
    const entry = rt.begin(thread, stmt, "wait");
    yield* waitSeconds(rt, ms / 1000);
    rt.finish(entry, "done");
    return;
  }
  const duration = mechanismDuration(rt.settings.profile, stmt.callee, rt.settings.mechanismOverrides);
  if (duration === undefined) {
    rt.report(stmt.line, "warning", `\`${stmt.callee}\` isn't a known command, so it's treated as instant.`);
    rt.instant(thread, stmt, "instant");
    return;
  }
  if (duration <= 0) {
    rt.instant(thread, stmt, "mechanism");
    return;
  }
  const entry = rt.begin(thread, stmt, "mechanism");
  yield* waitSeconds(rt, duration / 1000);
  rt.finish(entry, "done");
}

function* runChassis(rt: Runtime, stmt: CallStmt, thread: string, method: string): Task {
  const command = findMotionCommand(method);
  if (command) {
    yield* runMotion(rt, stmt, thread, command);
    return;
  }
  switch (method) {
    case "setPose": {
      const args = rt.reader(stmt, -1);
      try {
        let theta = args.number(2, "theta");
        if (args.text(3)?.trim() === "true") theta = toDegrees(theta);
        rt.setPose({ x: args.number(0, "x"), y: args.number(1, "y"), theta }, stmt.line);
      } catch (error) {
        rt.report(stmt.line, "error", `${(error as Error).message} This setPose is skipped.`);
        return;
      }
      rt.instant(thread, stmt, "pose");
      return;
    }
    case "setPoseFromGoal": {
      const args = rt.reader(stmt, 2);
      let goal: { x: number; y: number };
      let reach: number;
      let limit: number;
      let side: number;
      try {
        goal = { x: args.number(0, "goalX"), y: args.number(1, "goalY") };
        reach = args.paramNumber("distance", GOAL_CONTACT_DISTANCE);
        limit = args.paramNumber("maxCorrection", GOAL_MAX_CORRECTION);
        side = args.paramBool("forwards", false) ? -1 : 1;
      } catch (error) {
        rt.report(stmt.line, "error", `${(error as Error).message} This reset is skipped.`);
        return;
      }
      const now = rt.state.pose;
      const heading = toRadians(now.theta);
      const snapped = { x: goal.x + side * reach * Math.sin(heading), y: goal.y + side * reach * Math.cos(heading), theta: now.theta };
      const correction = distance(now, snapped);
      if (correction > limit) {
        rt.report(stmt.line, "warning", `The snap would move the robot ${correction.toFixed(1)} in (more than maxCorrection, ${limit} in), too far to be touching it, so the reset is skipped.`);
        rt.instant(thread, stmt, "instant");
        return;
      }
      rt.setPose(snapped, stmt.line);
      rt.instant(thread, stmt, "pose");
      return;
    }
    case "waitUntilDone": {
      const entry = rt.begin(thread, stmt, "wait");
      while (rt.active) yield;
      rt.finish(entry, "done");
      return;
    }
    case "waitUntil": {
      let target: number;
      try {
        target = rt.reader(stmt, -1).number(0, "distance");
      } catch (error) {
        rt.report(stmt.line, "error", `${(error as Error).message} This wait is skipped.`);
        return;
      }
      const entry = rt.begin(thread, stmt, "wait");
      while (rt.active && rt.active.motion.traveled < target) yield;
      rt.finish(entry, "done");
      return;
    }
    case "cancelMotion":
    case "cancelAllMotions":
      rt.endMotion("cancelled");
      rt.instant(thread, stmt, "instant");
      return;
    case "calibrate":
    case "getPose":
    case "setBrakeMode":
      rt.instant(thread, stmt, "instant");
      return;
    default:
      rt.report(stmt.line, "warning", `\`${stmt.callee}\` isn't simulated yet, so it's skipped.`);
  }
}

function* runMotion(rt: Runtime, stmt: CallStmt, thread: string, command: MotionCommand): Task {
  while (rt.active) yield;
  let motion: Motion;
  try {
    motion = command.create(rt.reader(stmt, command.paramsIndex));
  } catch (error) {
    rt.report(stmt.line, "error", `${(error as Error).message} This move is skipped.`);
    return;
  }
  const entry = rt.begin(thread, stmt, "motion");
  rt.active = { motion, entry, elapsed: 0 };
  const asyncArg = stmt.args[command.asyncIndex];
  const isAsync = !(asyncArg && asyncArg.kind === "expr" && asyncArg.text.trim() === "false");
  if (isAsync) {
    yield;
    return;
  }
  while (rt.active && rt.active.entry === entry) yield;
}

export function simulate(statements: Stmt[], options: SimSettings): SimResult {
  const settings: Required<SimSettings> = { dt: 0.01, ...options };
  const { dt, robot, field } = settings;
  const rt = new Runtime(settings);
  rt.spawn("main", runList(rt, statements, "main"));

  const maxFrames = Math.ceil((settings.periodSeconds + OVERRUN_SECONDS) / dt) + 1;
  const x = new Float32Array(maxFrames);
  const y = new Float32Array(maxFrames);
  const theta = new Float32Array(maxFrames);
  const hit = new Uint8Array(maxFrames);
  const tracker = new CollisionTracker(buildObstacles(field, settings.obstacles), field.half);

  let frame = 0;
  for (;;) {
    rt.tick = frame;
    rt.time = frame * dt;
    if (frame > 0) rt.stepMotion(dt);
    rt.runThreads();
    const pose = rt.state.pose;
    x[frame] = pose.x;
    y[frame] = pose.y;
    theta[frame] = pose.theta;
    hit[frame] = tracker.update(rt.time, robotBox(pose, robot.width, robot.length), rt.context()) ? 1 : 0;
    frame++;
    if (rt.idle || frame >= maxFrames) break;
  }

  const finished = rt.idle;
  tracker.closeAll(rt.time + dt);
  rt.closeOpenEntries();
  if (!finished) {
    rt.report(0, "warning", `The routine was still running after ${(rt.time + dt).toFixed(1)} s, so the simulation stops there.`);
  }
  rt.diagnostics.sort((a, b) => a.line - b.line);

  return {
    dt,
    frameCount: frame,
    duration: (frame - 1) * dt,
    periodSeconds: settings.periodSeconds,
    finished,
    x: x.subarray(0, frame),
    y: y.subarray(0, frame),
    theta: theta.subarray(0, frame),
    hit: hit.subarray(0, frame),
    timeline: rt.timeline,
    collisions: tracker.events,
    poseResets: rt.poseResets,
    diagnostics: rt.diagnostics,
  };
}
