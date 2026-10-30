import { toRadians, wrap360 } from "../core/angle";
import { forward, rightOf } from "../core/geometry";
import type { Pose } from "../core/geometry";
import { DEFAULT_FIELD } from "../field";
import { findParam } from "../program/ast";
import type { CallStmt, Stmt } from "../program/ast";
import { parseCpp } from "../program/cppParser";
import { evaluate } from "../program/expression";
import { CRIMSON_PROFILE } from "../profiles/crimson";
import { DEFAULT_OBSTACLES } from "../sim/collisions";
import { integrate } from "../sim/kinematics";
import type { DriveState } from "../sim/kinematics";
import { simulate } from "../sim/runtime";
import type { SimResult, TimelineEntry } from "../sim/runtime";
import { KEY, METADATA_PREFIX, MOTORS, motorHealthKey, motorKey, STRUCT_SCHEMAS, TYPE } from "./keys";
import type { MotorName, StructName } from "./keys";
import type { StructInput } from "./struct";
import { WpilogWriter } from "./wpilogWriter";
import type { WritableValue } from "./wpilogWriter";

export interface SampleOptions {
  source: string;
  sourcePath?: string;
  routine?: string;
  seed?: number;
}

const BOOT = 0.412;
const AUTON_START = 3;
const AUTON_LENGTH = 15;
const DRIVER_START = AUTON_START + AUTON_LENGTH;
const DRIVER_END = DRIVER_START + 8;
const LOG_END = DRIVER_END + 2.6;
const TICK = 0.02;
const SIM_DT = 0.01;

const TRACK_WIDTH = 12.5;
const EFFECTIVE_TRACK = 13.6;
const DRIVE_WHEEL = 3.25;
const DRIVE_GEAR = 600 / 360;
const TRACKING_WHEEL = 2;
const VERTICAL_OFFSET = 0.5;
const HORIZONTAL_OFFSET = -0.7;
const ODOM_LINEAR = 0.988;
const IMU_BIAS = 0.8 / 60;
const MAX_SPEED = 55;

const MOTION_ARGS: Record<string, { kind: number; x?: number; y?: number; theta?: number; timeout: number; params: number; async: number; forwards: boolean }> = {
  moveToPoint: { kind: 1, x: 0, y: 1, timeout: 2, params: 3, async: 4, forwards: true },
  moveToPose: { kind: 2, x: 0, y: 1, theta: 2, timeout: 3, params: 4, async: 5, forwards: true },
  turnToPoint: { kind: 3, x: 0, y: 1, timeout: 2, params: 3, async: 4, forwards: true },
  turnToHeading: { kind: 4, theta: 0, timeout: 1, params: 2, async: 3, forwards: false },
  swingToPoint: { kind: 5, x: 0, y: 1, timeout: 3, params: 4, async: 5, forwards: true },
  swingToHeading: { kind: 6, theta: 0, timeout: 2, params: 3, async: 4, forwards: false },
  donut: { kind: 7, theta: 0, timeout: 1, params: 2, async: 3, forwards: true },
};

const ELEVATOR_TARGETS: Record<string, number> = { flip_out: 900, home: 0, dual_setup: 500, dual_pickup_height: 1300, dual_pickup: 1100, go_to: 700 };
const UNITS =
  "distance=in,heading=deg,headingZero=+Y,headingPositive=clockwise,timestamp=us," +
  "motorPosition=deg,motorVelocity=rpm,motorVoltage=V,motorCurrent=A,motorPower=W,motorTorque=Nm," +
  "motorTemperature=C,motorEfficiency=pct,wheel=centideg,wheelVelocity=centideg/s,imuAngle=deg," +
  "imuGyro=deg/s,imuAccel=g,batteryVoltage=V,batteryCurrent=A,batteryCapacity=pct," +
  "batteryTemperature=C,mechanismElevator=motorDeg,mechanismPivot=motorDeg,power=-127..127";

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function collectCalls(statements: Stmt[], out: CallStmt[] = []): CallStmt[] {
  for (const stmt of statements) {
    if (stmt.kind === "call") out.push(stmt);
    else if (stmt.kind === "parallel") stmt.tasks.forEach((task) => collectCalls(task, out));
    else if (stmt.kind === "loop") collectCalls(stmt.body, out);
  }
  return out;
}

function number(text: string | undefined, fallback = Number.NaN): number {
  if (text === undefined) return fallback;
  try {
    return evaluate(text, () => undefined);
  } catch {
    return fallback;
  }
}

function motionStruct(call: CallStmt): StructInput | null {
  const method = call.callee.slice(call.callee.lastIndexOf(".") + 1);
  const spec = MOTION_ARGS[method];
  if (!spec) return null;
  const arg = (index: number | undefined) => {
    if (index === undefined) return undefined;
    const a = call.args[index];
    return a && a.kind === "expr" ? a.text : undefined;
  };
  const params = call.args[spec.params];
  const param = (key: string, fallback: number) => number(findParam(params, key), fallback);
  const isDonut = spec.kind === 7;
  const forwardsText = findParam(params, "forwards");
  return {
    kind: spec.kind,
    x: number(arg(spec.x)),
    y: number(arg(spec.y)),
    theta: number(arg(spec.theta)),
    timeout: number(arg(spec.timeout), 0),
    maxSpeed: isDonut ? Number.NaN : param("maxSpeed", 127),
    minSpeed: isDonut ? Number.NaN : param("minSpeed", 0),
    earlyExit: param("earlyExitRange", 0),
    forwards: spec.forwards && forwardsText !== "false",
    async: arg(spec.async)?.trim() !== "false",
  };
}

interface MechanismState {
  target: number;
  position: number;
  velocity: number;
  settledFor: number;
}

interface MotorSample {
  position: number;
  velocity: number;
  voltage: number;
  current: number;
  temperature: number;
}

class Sampler {
  readonly writer: WpilogWriter;
  private readonly last = new Map<string, unknown>();

  constructor(header: string) {
    this.writer = new WpilogWriter(header);
  }

  us(t: number): number {
    return Math.round(t * 1e6);
  }

  value(key: string, type: string, t: number, value: WritableValue): void {
    this.writer.write(key, type, this.us(t), value);
  }

  struct(key: string, name: StructName, t: number, value: StructInput): void {
    this.writer.struct(key, name, this.us(t), value);
  }

  changed(key: string, type: string, t: number, value: boolean | number | string): void {
    if (this.last.get(key) === value) return;
    this.last.set(key, value);
    this.value(key, type, t, value);
  }

  changedStruct(key: string, name: StructName, t: number, value: StructInput): void {
    const signature = JSON.stringify(value);
    if (this.last.get(key) === signature) return;
    this.last.set(key, signature);
    this.struct(key, name, t, value);
  }
}

function simulateRoutine(source: string, routine: string): { result: SimResult; calls: CallStmt[] } {
  const file = parseCpp(source);
  const run = file.functions.find((fn) => fn.name === routine) ?? file.functions.find((fn) => fn.name === "run") ?? file.functions[0];
  const setup = file.functions.find((fn) => fn.name === "setup");
  const body = setup && setup !== run ? [...setup.body, ...run.body] : run.body;
  const result = simulate(body, {
    field: DEFAULT_FIELD,
    profile: CRIMSON_PROFILE,
    robot: CRIMSON_PROFILE.robot,
    mechanismOverrides: {},
    periodSeconds: AUTON_LENGTH,
    obstacles: DEFAULT_OBSTACLES,
    dt: SIM_DT,
  });
  return { result, calls: collectCalls(body) };
}

export function makeSampleLog(options: SampleOptions): Uint8Array {
  const sourcePath = options.sourcePath ?? "src/autons/match/teambad.cpp";
  const rand = random(options.seed ?? 4202);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const { result: sim, calls } = simulateRoutine(options.source, options.routine ?? "run");
  const callFor = (entry: TimelineEntry) => calls.find((call) => call.line === entry.line && call.text === entry.text);
  const log = new Sampler("Crimson Oct 19 2026 08:12:44");
  const w = log.writer;

  const t0 = BOOT;
  for (const [name, schema] of Object.entries(STRUCT_SCHEMAS)) w.schema(name, schema, log.us(t0));
  const metadata: Record<string, string> = {
    Build: "timestamp=Oct 19 2026 08:12:44,file=sample.wpilog",
    Ports:
      "intake=12,vision=16,imu=20,leftDriveA=11,leftDriveB=-18,rightDriveA=-1,rightDriveB=19,elevatorA=-10,elevatorB=8," +
      "pivot=7,claw=4,verticalOdom=17,horizontalOdom=16,intakeLift=B,pullToggle=A",
    Drivetrain: `trackWidth=${TRACK_WIDTH},wheelDiameter=${DRIVE_WHEEL},rpm=360,horizontalDrift=2`,
    Odometry: `trackingWheelDiameter=${TRACKING_WHEEL},verticalOffset=${VERTICAL_OFFSET},horizontalOffset=${HORIZONTAL_OFFSET}`,
    LinearPID: "kP=9.5,kI=0,kD=12,windupRange=1,smallError=0.2,smallErrorTimeout=100,largeError=1,largeErrorTimeout=500,slew=40",
    AngularPID: "kP=5.5,kI=0,kD=40,windupRange=3,smallError=1,smallErrorTimeout=50,largeError=3,largeErrorTimeout=300,slew=0",
    DriveCurves: "throttleDeadband=2,throttleMinOutput=2.5,throttleCurve=1.019,steerDeadband=2,steerMinOutput=2.5,steerCurve=1",
    Units: UNITS,
  };
  for (const [name, text] of Object.entries(metadata)) log.value(`${METADATA_PREFIX}${name}`, TYPE.string, t0, text);

  const motions = sim.timeline.filter((e) => e.kind === "motion" && e.start < AUTON_LENGTH);
  const resets = sim.timeline.filter((e) => e.kind === "pose" && e.start < AUTON_LENGTH);
  const resetFrames = new Map(resets.map((e) => [Math.round(e.start / SIM_DT), e]));
  const lastFrame = Math.min(sim.frameCount - 1, Math.round(AUTON_LENGTH / SIM_DT));
  const simPose = (frame: number): Pose => {
    const k = Math.min(Math.max(frame, 0), sim.frameCount - 1);
    return { x: sim.x[k], y: sim.y[k], theta: sim.theta[k] };
  };

  const state: DriveState = { pose: { x: 0, y: 0, theta: 0 }, v: 0, w: 0 };
  const odom = state.pose;
  const raw: Pose = { x: 0, y: 0, theta: 0 };
  const truthError = { x: 0, y: 0 };
  let imuRotation = 0;
  let anchored = false;
  let frameDone = -1;
  let vertical = 0;
  let horizontal = 0;
  let wheelV = { v: 0, h: 0 };
  let slipping = false;
  let turnRate = 0;
  const drive = { left: 0, right: 0, leftV: 0, rightV: 0, leftA: 0, rightA: 0 };
  let motionId = 0;

  const step = (from: Pose, to: Pose, dt: number, hit: boolean) => {
    const mid = from.theta + (to.theta - from.theta) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const f = dx * forward(mid).x + dy * forward(mid).y;
    const r = dx * rightOf(mid).x + dy * rightOf(mid).y;
    const dTheta = to.theta - from.theta;
    const dRad = toRadians(dTheta);
    imuRotation += dTheta;
    turnRate = dt > 0 ? dTheta / dt : 0;
    const rawMid = raw.theta + dTheta / 2;
    raw.x += f * forward(rawMid).x + r * rightOf(rawMid).x;
    raw.y += f * forward(rawMid).y + r * rightOf(rawMid).y;
    raw.theta += dTheta;
    const fTrue = f / ODOM_LINEAR;
    truthError.x += (fTrue - f) * forward(mid).x + 0.03 * Math.abs(dRad) * rightOf(mid).x;
    truthError.y += (fTrue - f) * forward(mid).y + 0.03 * Math.abs(dRad) * rightOf(mid).y;
    const vIn = f - VERTICAL_OFFSET * dRad;
    const hIn = r - HORIZONTAL_OFFSET * dRad + 0.02 * gauss() * Math.abs(dRad);
    const toCentideg = (inches: number) => (inches / (Math.PI * TRACKING_WHEEL)) * 36000;
    vertical += toCentideg(vIn);
    horizontal += toCentideg(hIn);
    wheelV = { v: dt > 0 ? toCentideg(vIn) / dt : 0, h: dt > 0 ? toCentideg(hIn) / dt : 0 };
    const slip = hit ? 1.25 : 1;
    slipping = hit && (Math.abs(f) > 1e-3 || Math.abs(dRad) > 1e-4);
    const leftIn = (fTrue + (dRad * EFFECTIVE_TRACK) / 2) * slip;
    const rightIn = (fTrue - (dRad * EFFECTIVE_TRACK) / 2) * slip;
    const toMotorDeg = (inches: number) => (inches / (Math.PI * DRIVE_WHEEL)) * 360 * DRIVE_GEAR;
    drive.left += toMotorDeg(leftIn);
    drive.right += toMotorDeg(rightIn);
    const leftV = dt > 0 ? leftIn / dt : 0;
    const rightV = dt > 0 ? rightIn / dt : 0;
    drive.leftA = dt > 0 ? (leftV - drive.leftV) / dt : 0;
    drive.rightA = dt > 0 ? (rightV - drive.rightV) / dt : 0;
    drive.leftV = leftV;
    drive.rightV = rightV;
  };

  const advanceAuton = (simT: number) => {
    const target = Math.min(lastFrame, Math.floor(simT / SIM_DT + 1e-9));
    for (let k = frameDone + 1; k <= target; k++) {
      const reset = resetFrames.get(k);
      const after = simPose(k);
      if (reset) {
        const from = { ...odom };
        const t = AUTON_START + reset.start + 0.0002;
        log.struct(KEY.resetFrom, "Pose", t, from);
        log.struct(KEY.resetTo, "Pose", t, { ...after });
        log.value(KEY.resetSource, TYPE.string, t, `${sourcePath}:${reset.line}`);
        Object.assign(odom, after);
        truthError.x = 0;
        truthError.y = 0;
        if (!anchored) {
          Object.assign(raw, after);
          anchored = true;
        }
      } else if (k > 0) {
        step({ ...odom }, after, SIM_DT, sim.hit[k] === 1);
        Object.assign(odom, after);
      }
      frameDone = k;
    }
  };

  const mechanismEvents = sim.timeline
    .filter((e) => (e.kind === "mechanism" || e.kind === "instant") && e.start < AUTON_LENGTH)
    .sort((a, b) => a.start - b.start);
  const mech = {
    claw: 0,
    intake: 0,
    intakeLift: false,
    pullToggle: false,
    macro: "idle",
    macroEnd: 0,
    elevator: { target: 0, position: 0, velocity: 0, settledFor: 1 } as MechanismState,
    pivot: { target: 0, position: 0, velocity: 0, settledFor: 1 } as MechanismState,
  };
  let mechanismIndex = 0;
  const applyMechanisms = (simT: number) => {
    while (mechanismIndex < mechanismEvents.length && mechanismEvents[mechanismIndex].start <= simT) {
      const e = mechanismEvents[mechanismIndex++];
      const call = callFor(e);
      const firstArg = call?.args[0]?.kind === "expr" ? call.args[0].text : undefined;
      const text = e.text;
      if (text.startsWith("claw::spin")) mech.claw = number(firstArg, 0);
      else if (text.startsWith("intake::spin")) mech.intake = number(firstArg, 0);
      else if (text.startsWith("intake::stop")) mech.intake = 0;
      else if (text.startsWith("intake::lift")) mech.intakeLift = true;
      else if (text.startsWith("intake::drop")) mech.intakeLift = false;
      else if (text.startsWith("pull_toggle.extend")) mech.pullToggle = true;
      else if (text.startsWith("pull_toggle.retract")) mech.pullToggle = false;
      else if (text.startsWith("pivot::move_to")) {
        mech.pivot.target = (text.includes("kScored") ? 330 : 0) + (text.includes("450") ? 450 : 0);
      } else if (text.startsWith("macros::")) {
        const name = /macros::(\w+)/.exec(text)?.[1] ?? "macro";
        mech.macro = name;
        mech.macroEnd = e.end;
        if (name in ELEVATOR_TARGETS) mech.elevator.target = ELEVATOR_TARGETS[name];
        if (name === "flip_out") mech.pivot.target = 640;
        if (name === "home") mech.pivot.target = 0;
      }
    }
    if (mech.macro !== "idle" && simT >= mech.macroEnd) mech.macro = "idle";
  };
  const moveMechanism = (state: MechanismState, dt: number, stiffness: number, tolerance: number) => {
    const accel = stiffness * (state.target - state.position) - 2 * 0.75 * Math.sqrt(stiffness) * state.velocity;
    state.velocity += accel * dt;
    state.position += state.velocity * dt;
    const close = Math.abs(state.target - state.position) < tolerance && Math.abs(state.velocity) < tolerance * 4;
    state.settledFor = close ? state.settledFor + dt : 0;
  };

  const temps: Record<MotorName, number> = {
    LeftA: 33, LeftB: 34, RightA: 32, RightB: 34, ElevatorA: 30, ElevatorB: 31, Intake: 52, Claw: 36, Pivot: 30,
  };
  const motorState = {} as Record<MotorName, MotorSample>;
  for (const name of MOTORS) motorState[name] = { position: 0, velocity: 0, voltage: 0, current: 0, temperature: temps[name] };

  const visionWindows: Array<[number, number]> = [];
  for (let t = AUTON_START + 0.6; t < DRIVER_END; t += 0.9 + rand() * 1.4) visionWindows.push([t, t + 0.18 + rand() * 0.3]);

  const joystick = (t: number) => {
    const d = t - DRIVER_START;
    if (d < 0 || d >= DRIVER_END - DRIVER_START) return { leftY: 0, rightX: 0, buttons: 0 };
    const ramp = (a: number, b: number) => Math.max(0, Math.min(1, (d - a) / 0.15, (b - d) / 0.15));
    const leftY = Math.round(70 * ramp(1.2, 2.8) + 55 * ramp(3.6, 4.6) - 60 * ramp(5.2, 6.2));
    const rightX = Math.round(-75 * ramp(0.3, 1.1) + 70 * ramp(3, 3.5) + 30 * Math.sin(d * 2.1) * ramp(5.2, 6.2));
    const buttons = (d > 2 && d < 4.4 ? 1 << 2 : 0) | (d > 6.4 && d < 6.9 ? 1 << 0 : 0);
    return { leftY, rightX, buttons };
  };

  let overruns = 0;
  let previous = 0;
  const seenWindows = new Set<number>();
  const ticks = Math.floor((LOG_END - BOOT) / TICK);
  for (let n = 0; n <= ticks; n++) {
    const t = BOOT + n * TICK + Math.floor(rand() * 400) / 1e6;
    const enabled = t >= AUTON_START && t < DRIVER_END;
    const auton = t >= AUTON_START && t < DRIVER_START;
    const slow = n % 10 === 0;
    const fast = enabled || slow;
    const dt = TICK;

    if (auton) {
      const simT = t - AUTON_START;
      log.changed(KEY.autonRunning, TYPE.boolean, AUTON_START, true);
      advanceAuton(simT);
      applyMechanisms(simT);
      for (const motion of motions) {
        const start = AUTON_START + motion.start;
        if (start > t || start <= previous) continue;
        const call = callFor(motion);
        const struct = call ? motionStruct(call) : null;
        if (!struct) continue;
        motionId++;
        log.struct(KEY.motionCommand, "Motion", start, struct);
        log.value(KEY.motionSource, TYPE.string, start, `${sourcePath}:${motion.line}`);
        log.value(KEY.motionId, TYPE.int64, start, motionId);
      }
    } else if (t >= DRIVER_START && t < DRIVER_END) {
      const stick = joystick(t);
      const before = { ...odom };
      const vTarget = (stick.leftY / 127) * MAX_SPEED;
      const wTarget = (stick.rightX / 127) * 240;
      state.v += Math.max(-140 * dt, Math.min(140 * dt, vTarget - state.v));
      state.w += Math.max(-1800 * dt, Math.min(1800 * dt, wTarget - state.w));
      integrate(state, dt);
      odom.theta += IMU_BIAS * dt;
      step(before, odom, dt, false);
      mech.intake = stick.buttons & (1 << 2) ? 127 : 0;
    } else {
      const before = { ...odom };
      odom.theta += IMU_BIAS * dt;
      step(before, odom, dt, false);
    }

    const simT = t - AUTON_START;
    const motionActive = auton && motions.some((m) => m.start <= simT && simT < Math.min(m.end, AUTON_LENGTH));

    moveMechanism(mech.elevator, dt, 90, 8);
    moveMechanism(mech.pivot, dt, 25, 4);
    const intakeJam = mech.intake !== 0 && Math.sin(t * 1.7) > 0.55;
    const clawHolding = mech.claw !== 0;

    const driveMotor = (name: MotorName, inchesDeg: number, ips: number, accel: number) => {
      const s = motorState[name];
      const rpm = (ips / (Math.PI * DRIVE_WHEEL)) * 60 * DRIVE_GEAR;
      s.position = inchesDeg + gauss() * 0.3;
      s.velocity = rpm + gauss() * (0.1 + 0.01 * Math.abs(rpm));
      s.voltage = Math.max(-12000, Math.min(12000, 12000 * (ips / MAX_SPEED + accel / 600)));
      s.current = slipping ? 2500 : Math.min(2400, 250 + 900 * Math.min(1, Math.abs(accel) / 140) + (500 * Math.abs(ips)) / MAX_SPEED + 30 * gauss());
    };
    driveMotor("LeftA", drive.left, drive.leftV, drive.leftA);
    driveMotor("LeftB", drive.left * 1.0004, drive.leftV, drive.leftA);
    driveMotor("RightA", drive.right, drive.rightV, drive.rightA);
    driveMotor("RightB", drive.right * 0.9996, drive.rightV, drive.rightA);
    for (const [name, state, rpmPerUnit, hold] of [
      ["ElevatorA", mech.elevator, 1 / 6, mech.elevator.target > 0 ? 450 : 80],
      ["ElevatorB", mech.elevator, 1 / 6, mech.elevator.target > 0 ? 430 : 80],
      ["Pivot", mech.pivot, 1 / 6, 150],
    ] as Array<[MotorName, MechanismState, number, number]>) {
      const s = motorState[name];
      s.velocity = state.velocity * rpmPerUnit;
      s.position += s.velocity * (dt / 60) * 360;
      s.voltage = Math.max(-12000, Math.min(12000, s.velocity * 20 + hold * 2));
      s.current = Math.min(2400, hold + Math.abs(s.velocity) * 2 + 20 * gauss());
    }
    const intake = motorState.Intake;
    intake.velocity = mech.intake === 0 ? 0 : (mech.intake / 127) * (intakeJam ? 60 : 540) + gauss() * 4;
    intake.voltage = (mech.intake / 127) * 12000;
    intake.current = mech.intake === 0 ? 30 : intakeJam ? 2450 : 1250 + 60 * gauss();
    intake.position += intake.velocity * (dt / 60) * 360;
    const claw = motorState.Claw;
    claw.velocity = clawHolding ? (mech.claw / 127) * 12 : 0;
    claw.voltage = (mech.claw / 127) * 12000;
    claw.current = clawHolding ? 1650 + 40 * gauss() : 20;
    claw.position += claw.velocity * (dt / 60) * 360;
    for (const name of MOTORS) {
      const s = motorState[name];
      const amps = s.current / 1000;
      s.temperature += ((name === "Intake" ? 0.32 : 0.12) * amps * amps - 0.004 * (s.temperature - 25)) * dt;
    }

    const totalAmps = MOTORS.reduce((sum, name) => sum + motorState[name].current / 1000, 0.35);
    const batteryMv = 12620 - (t - BOOT) * 6 - totalAmps * 95 + gauss() * 8;

    if (fast) {
      log.struct(KEY.robotPose, "Pose", t, { ...odom });
      log.struct(KEY.rawPose, "Pose", t, { ...raw });
      log.struct(KEY.verticalWheel, "Wheel", t, { position: Math.round(vertical), velocity: Math.round(wheelV.v), angle: Math.round(((vertical % 36000) + 36000) % 36000) });
      log.struct(KEY.horizontalWheel, "Wheel", t, { position: Math.round(horizontal), velocity: Math.round(wheelV.h), angle: Math.round(((horizontal % 36000) + 36000) % 36000) });
      log.struct(KEY.imu, "Imu", t, {
        heading: wrap360(imuRotation),
        rotation: imuRotation,
        pitch: 0.4 + gauss() * 0.05,
        roll: -0.2 + gauss() * 0.05,
        yaw: ((imuRotation + 180) % 360 + 360) % 360 - 180,
        gyroX: gauss() * 0.3,
        gyroY: gauss() * 0.3,
        gyroZ: -turnRate + gauss() * 0.4,
        accelX: (drive.leftA + drive.rightA) / 2 / 386.1 + gauss() * 0.01,
        accelY: gauss() * 0.01,
        accelZ: 1 + gauss() * 0.01,
        status: 0,
      });
      for (const name of MOTORS) {
        const s = motorState[name];
        const power = Math.abs((s.voltage / 1000) * (s.current / 1000)) * 0.9;
        log.struct(motorKey(name), "Motor", t, {
          position: s.position,
          velocity: s.velocity,
          voltage: s.voltage / 1000,
          current: s.current / 1000,
          power,
          torque: (s.current / 1000) * 0.32,
        });
      }
      log.changed(KEY.motionActive, TYPE.boolean, t, motionActive);
      const mechT = t + 0.00015;
      log.struct(KEY.elevator, "Mechanism", mechT, { target: mech.elevator.target, position: mech.elevator.position, settled: mech.elevator.settledFor >= 0.1 });
      log.struct(KEY.pivot, "Mechanism", mechT, { target: mech.pivot.target, position: mech.pivot.position, settled: mech.pivot.settledFor >= 0.1 });
      log.value(KEY.elevatorManual, TYPE.double, mechT, 0);
      log.value(KEY.clawPower, TYPE.double, mechT, mech.claw);
      log.changed(KEY.macroMode, TYPE.string, mechT, mech.macro);
      log.changed(KEY.tilted, TYPE.boolean, mechT, false);
      log.changed(KEY.offsetOn, TYPE.boolean, mechT, false);
      log.changed(KEY.intakeLift, TYPE.boolean, mechT, mech.intakeLift);
      log.changed(KEY.pullToggle, TYPE.boolean, mechT, mech.pullToggle);

      const sysT = t + 0.0003;
      const stick = joystick(t);
      log.changedStruct(KEY.controller, "Controller", sysT, { leftX: 0, leftY: stick.leftY, rightX: stick.rightX, rightY: 0, buttons: stick.buttons });
      log.changed(KEY.controllerConnected, TYPE.boolean, sysT, true);
      log.changed(KEY.dsConnected, TYPE.boolean, sysT, true);
      log.changed(KEY.fieldControl, TYPE.boolean, sysT, false);
      log.changed(KEY.enabled, TYPE.boolean, sysT, enabled);
      log.changed(KEY.autonomous, TYPE.boolean, sysT, auton);
      log.changed(KEY.autonSelected, TYPE.string, sysT, "TeamBad");
      log.changed(KEY.autonRunning, TYPE.boolean, sysT, auton);

      const visT = t + 0.00045;
      const window = visionWindows.find(([a, b]) => t >= a && t < b);
      log.changed(KEY.visionConnected, TYPE.boolean, visT, true);
      log.changed(KEY.visionTagCount, TYPE.int64, visT, window ? 1 + Math.round(rand() * 0.6) : 0);
      if (window) {
        const tag = 1 + Math.floor((window[0] * 7) % 8);
        log.changed(KEY.visionPrimaryTag, TYPE.int64, visT, tag);
        log.value(KEY.visionTx, TYPE.double, visT, 12 * Math.sin(window[0] * 3) + gauss() * 0.4);
        log.value(KEY.visionTy, TYPE.double, visT, 4 + gauss() * 0.3);
        if (!seenWindows.has(window[0])) {
          seenWindows.add(window[0]);
          log.struct(KEY.visionPose, "Pose", visT, { x: odom.x + truthError.x + gauss() * 0.7, y: odom.y + truthError.y + gauss() * 0.7, theta: odom.theta });
        }
      }
    }

    if (slow) {
      const slowT = t + 0.0006;
      for (const name of MOTORS) {
        const s = motorState[name];
        const reported = Math.floor(s.temperature / 5) * 5;
        const overTemp = s.temperature >= 55;
        const overCurrent = s.current >= 2500;
        const moving = Math.abs(s.velocity) > 5;
        log.struct(motorHealthKey(name), "MotorHealth", slowT, {
          temperature: reported,
          efficiency: moving ? Math.min(85, 25 + 60 * Math.min(1, Math.abs(s.velocity) / 500)) : 0,
          faults: (overTemp ? 0x01 : 0) | (overCurrent ? 0x04 : 0),
          flags: moving ? 0 : 0x02,
          overTemp,
          overCurrent,
        });
      }
      log.struct(KEY.battery, "Battery", slowT, { voltage: batteryMv / 1000, current: totalAmps, capacity: 91 - (t - BOOT) * 0.04, temperature: 27 + (t - BOOT) * 0.02 });
      log.value(KEY.controllerBattery, TYPE.int64, slowT, 78);
      if (t > AUTON_START + 6.4 && overruns === 0) overruns = 1;
      log.value(KEY.loggerDropped, TYPE.int64, slowT, 0);
      log.value(KEY.loggerOverruns, TYPE.int64, slowT, overruns);
      log.value(KEY.loggerBytes, TYPE.int64, slowT, w.size);
    }
    previous = t;
  }
  return w.toBytes();
}
