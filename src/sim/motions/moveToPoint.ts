import { toRadians, wrap180 } from "../../core/angle";
import { clamp, dot, forward, headingTo, length, scale, sub } from "../../core/geometry";
import type { Vec2 } from "../../core/geometry";
import type { RobotConfig } from "../../robot/config";
import { approach, approachSpeed, brakeRate, integrate, speedFraction } from "../kinematics";
import type { DriveState } from "../kinematics";
import { HeldFor } from "./types";
import type { Motion, MotionStatus } from "./types";

export interface MoveToPointParams {
  forwards: boolean;
  maxSpeed: number;
  minSpeed: number;
  earlyExitRange: number;
}

const HEADING_GAIN = 6;
const NO_TURN_RANGE = 3;
/**
 * LemLib 0.5 (moveToPoint.cpp, moveToPose.cpp): within this many inches of the target the robot stops steering
 * toward it, only closes the distance along its heading, and its speed limit is raised to at least 60.
 */
export const CLOSE_RANGE = 7.5;
export const CLOSE_MIN_SPEED = 60;

/**
 * How fast (in/s) LemLib drives a move with `remaining` in to go, before its floor. A chained move (a minSpeed of its
 * own, more than the early exit's 1) follows the lateral PID: kP x the distance, out of 127, so it only slows from
 * 127 / kP in out (and its braking can't keep up). A stop follows the ideal braking curve the ghost is tuned on.
 */
export function approachTarget(robot: RobotConfig, minSpeed: number, cap: number, remaining: number): number {
  if (minSpeed > 1) return Math.min(cap, robot.maxSpeed * Math.min(1, ((robot.linearKP ?? 9.5) * remaining) / 127));
  return Math.min(cap, Math.sqrt(2 * brakeRate(robot) * remaining));
}

export function driveToward(
  state: DriveState,
  target: Vec2,
  dt: number,
  robot: RobotConfig,
  params: MoveToPointParams,
  remaining: number,
  /** a lower top speed for this step (in/s), e.g. moveToPose's curve cap */
  speedCap = Infinity,
): void {
  const desired = headingTo(state.pose, target) + (params.forwards ? 0 : 180);
  const error = wrap180(desired - state.pose.theta);
  const turnCap = robot.maxTurnRate * speedFraction(params.maxSpeed);
  const wTarget = remaining > NO_TURN_RANGE ? clamp(error * HEADING_GAIN, -turnCap, turnCap) : 0;

  const cap = Math.min(speedCap, robot.maxSpeed * speedFraction(params.maxSpeed));
  const floor = robot.maxSpeed * speedFraction(params.minSpeed);
  // LemLib's PID slows every move down toward its target; a minSpeed only puts a floor under it (moveToPoint.cpp)
  const braking = approachTarget(robot, params.minSpeed, cap, remaining);
  const alignment = Math.max(0, Math.cos(toRadians(error)));
  const magnitude = Math.max(floor, braking) * alignment;

  state.v = approachSpeed(state.v, params.forwards ? magnitude : -magnitude, robot, dt);
  state.w = approach(state.w, wTarget, robot.turnAcceleration * dt);
  integrate(state, dt);
}

/**
 * LemLib 0.5's moveToPoint: steer toward the target until CLOSE_RANGE, then drive straight along the heading to
 * settle on it (the exit conditions only count from then on; there is no "passed it" exit). With motion chaining
 * (minSpeed), it ends when the robot crosses the line through the target, square to the start direction, moved
 * earlyExitRange back toward the start.
 */
export class MoveToPoint implements Motion {
  traveled = 0;
  readonly keepsMoving: boolean;
  readonly linear = true;
  private startDirection: Vec2 | null = null;
  private readonly smallExit = new HeldFor();
  private readonly largeExit = new HeldFor();
  private close = false;
  private maxSpeed: number;
  /** last output, LemLib units */
  private prevOut = 0;
  private prevSide: boolean | null = null;

  constructor(
    readonly target: Vec2,
    readonly timeoutMs: number,
    readonly params: MoveToPointParams,
  ) {
    this.keepsMoving = params.minSpeed > 0;
    this.maxSpeed = params.maxSpeed;
  }

  step(state: DriveState, dt: number, robot: RobotConfig): MotionStatus {
    const toTarget = sub(this.target, state.pose);
    const remaining = length(toTarget);
    if (!this.startDirection) {
      this.startDirection = remaining > 1e-6 ? scale(toTarget, 1 / remaining) : { x: 0, y: 1 };
    }
    if (remaining < CLOSE_RANGE && !this.close) {
      this.close = true;
      this.maxSpeed = Math.max(Math.abs(this.prevOut), CLOSE_MIN_SPEED);
    }
    // motion chaining: done once the robot is past the exit line (earlyExitRange short of the target)
    if (this.params.minSpeed !== 0) {
      const side = -dot(toTarget, this.startDirection) >= -Math.abs(this.params.earlyExitRange);
      if (this.prevSide !== null && side !== this.prevSide) return "done";
      this.prevSide = side;
    }
    // distance along the heading (negative when the target is behind)
    const along = dot(toTarget, forward(state.pose.theta));
    const small = this.smallExit.update(Math.abs(along) <= robot.linearSmallError, dt, robot.linearSmallTime);
    const large = this.largeExit.update(Math.abs(along) <= robot.linearLargeError, dt, robot.linearLargeTime);
    if (this.close && (small || large)) return "done";
    if (!this.close) {
      driveToward(state, this.target, dt, robot, { ...this.params, maxSpeed: this.maxSpeed }, remaining);
    } else {
      const cap = robot.maxSpeed * speedFraction(this.maxSpeed);
      let v = Math.sign(along) * approachTarget(robot, this.params.minSpeed, cap, Math.abs(along));
      const floor = robot.maxSpeed * speedFraction(this.params.minSpeed);
      if (this.params.forwards && v > 0 && v < floor) v = floor;
      if (!this.params.forwards && v < 0 && -v < floor) v = -floor;
      state.v = approachSpeed(state.v, v, robot, dt);
      state.w = approach(state.w, 0, robot.turnAcceleration * dt);
      integrate(state, dt);
    }
    this.prevOut = (state.v / robot.maxSpeed) * 127;
    this.traveled += Math.abs(state.v) * dt;
    return "running";
  }
}
