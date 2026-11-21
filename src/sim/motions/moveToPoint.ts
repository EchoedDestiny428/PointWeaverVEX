import { toRadians, wrap180 } from "../../core/angle";
import { clamp, dot, headingTo, length, scale, sub } from "../../core/geometry";
import type { Vec2 } from "../../core/geometry";
import type { RobotConfig } from "../../robot/config";
import { approach, integrate, speedFraction } from "../kinematics";
import type { DriveState } from "../kinematics";
import { LARGE_EXIT_RANGE, LargeExit } from "./types";
import type { Motion, MotionStatus } from "./types";

export interface MoveToPointParams {
  forwards: boolean;
  maxSpeed: number;
  minSpeed: number;
  earlyExitRange: number;
}

const HEADING_GAIN = 6;
const STOP_RANGE = 0.75;
const NO_TURN_RANGE = 3;
const PASSED_CHECK_RANGE = 8;

export function driveToward(
  state: DriveState,
  target: Vec2,
  dt: number,
  robot: RobotConfig,
  params: MoveToPointParams,
  remaining: number,
): void {
  const desired = headingTo(state.pose, target) + (params.forwards ? 0 : 180);
  const error = wrap180(desired - state.pose.theta);
  const turnCap = robot.maxTurnRate * speedFraction(params.maxSpeed);
  const wTarget = remaining > NO_TURN_RANGE ? clamp(error * HEADING_GAIN, -turnCap, turnCap) : 0;

  const cap = robot.maxSpeed * speedFraction(params.maxSpeed);
  const floor = robot.maxSpeed * speedFraction(params.minSpeed);
  const braking = params.minSpeed > 0 ? cap : Math.min(cap, Math.sqrt(2 * robot.acceleration * remaining));
  const alignment = Math.max(0, Math.cos(toRadians(error)));
  const magnitude = Math.max(floor, braking) * alignment;

  state.v = approach(state.v, params.forwards ? magnitude : -magnitude, robot.acceleration * dt);
  state.w = approach(state.w, wTarget, robot.turnAcceleration * dt);
  integrate(state, dt);
}

export class MoveToPoint implements Motion {
  traveled = 0;
  readonly keepsMoving: boolean;
  private startDirection: Vec2 | null = null;
  private readonly largeExit = new LargeExit();

  constructor(
    readonly target: Vec2,
    readonly timeoutMs: number,
    readonly params: MoveToPointParams,
  ) {
    this.keepsMoving = params.minSpeed > 0;
  }

  step(state: DriveState, dt: number, robot: RobotConfig): MotionStatus {
    const toTarget = sub(this.target, state.pose);
    const remaining = length(toTarget);
    if (!this.startDirection) {
      this.startDirection = remaining > 1e-6 ? scale(toTarget, 1 / remaining) : { x: 0, y: 1 };
    }
    const exitRange = this.params.minSpeed > 0 ? Math.max(this.params.earlyExitRange, 1) : STOP_RANGE;
    const passed = remaining < PASSED_CHECK_RANGE && dot(toTarget, this.startDirection) <= 0;
    if (remaining <= exitRange || passed || this.largeExit.update(remaining <= LARGE_EXIT_RANGE, dt)) {
      return "done";
    }
    driveToward(state, this.target, dt, robot, this.params, remaining);
    this.traveled += Math.abs(state.v) * dt;
    return "running";
  }
}
