import { angleError } from "../../core/angle";
import { dot, forward, length, scale, sub } from "../../core/geometry";
import type { Pose, Vec2 } from "../../core/geometry";
import type { RobotConfig } from "../../robot/config";
import { approach, approachSpeed, brakeRate, integrate, speedFraction } from "../kinematics";
import type { DriveState } from "../kinematics";
import { CLOSE_MIN_SPEED, CLOSE_RANGE, driveToward } from "./moveToPoint";
import { HeldFor, LARGE_EXIT_RANGE, LargeExit, TURN_BRAKING_SHARE } from "./types";
import type { Motion, MotionStatus } from "./types";

export interface MoveToPoseParams {
  forwards: boolean;
  lead: number;
  maxSpeed: number;
  minSpeed: number;
  earlyExitRange: number;
}

const HEADING_DONE = 2;

/**
 * LemLib moveToPose's curve cap: the arc from the robot (along the way it's driving) to the carrot has radius
 * d^2 / (2 * sideways offset), and forward power is held to sqrt(horizontalDrift * radius * 9.8) out of 127.
 */
export function slipCap(pose: Pose, carrot: Vec2, robot: RobotConfig): number {
  const drift = robot.horizontalDrift ?? 0;
  if (!(drift > 0)) return Infinity;
  const f = forward(pose.theta);
  const dx = carrot.x - pose.x, dy = carrot.y - pose.y;
  const d2 = dx * dx + dy * dy;
  const side = Math.abs(f.x * dy - f.y * dx); // the same whichever way it drives
  if (side < 1e-6) return Infinity;
  const radius = d2 / (2 * side);
  return robot.maxSpeed * Math.min(1, Math.sqrt(drift * radius * 9.8) / 127);
}

export class MoveToPose implements Motion {
  traveled = 0;
  readonly keepsMoving: boolean;
  private readonly smallExit = new HeldFor();
  private readonly largeExit = new HeldFor();
  private readonly fallback = new LargeExit();
  private close = false;
  private maxSpeed: number;
  private prevOut = 0;

  constructor(
    readonly target: Pose,
    readonly timeoutMs: number,
    readonly params: MoveToPoseParams,
  ) {
    this.keepsMoving = params.minSpeed > 0;
    this.maxSpeed = params.maxSpeed;
  }

  step(state: DriveState, dt: number, robot: RobotConfig): MotionStatus {
    const remaining = length(sub(this.target, state.pose));
    // LemLib: within CLOSE_RANGE it aims at the target itself and its speed limit is raised to at least 60
    if (remaining < CLOSE_RANGE && !this.close) {
      this.close = true;
      this.maxSpeed = Math.max(Math.abs(this.prevOut), CLOSE_MIN_SPEED);
    }
    const headingError = angleError(this.target.theta, state.pose.theta);

    if (this.keepsMoving && remaining <= Math.max(this.params.earlyExitRange, 1)) {
      return "done";
    }
    // LemLib's exit conditions, with the robot's settings: in range and facing the heading, for long enough
    const heading = Math.abs(headingError);
    const small = this.smallExit.update(
      remaining <= robot.linearSmallError && heading <= robot.angularSmallError, dt, robot.linearSmallTime);
    const large = this.largeExit.update(
      remaining <= robot.linearLargeError && heading <= robot.angularLargeError, dt, robot.linearLargeTime);
    if (small || large) return "done";
    // settled close by, facing the right way, but short of those ranges (the simulator's simplification)
    if (this.fallback.update(remaining <= LARGE_EXIT_RANGE && heading <= HEADING_DONE * 1.5, dt)) {
      return "done";
    }

    if (!this.close) {
      const side = this.params.forwards ? 1 : -1;
      const lead = scale(forward(this.target.theta), side * this.params.lead * remaining);
      const carrot = sub(this.target, lead);
      driveToward(state, carrot, dt, robot, { ...this.params, maxSpeed: this.maxSpeed }, remaining, slipCap(state.pose, carrot, robot));
    } else {
      // close: turn to the heading while closing the rest of the way along it (LemLib does both here)
      const cap = robot.maxTurnRate * speedFraction(this.maxSpeed);
      const braking = Math.sqrt(2 * TURN_BRAKING_SHARE * robot.turnAcceleration * Math.abs(headingError));
      const along = dot(sub(this.target, state.pose), forward(state.pose.theta));
      const reach = Math.min(robot.maxSpeed * speedFraction(this.maxSpeed), Math.sqrt(2 * brakeRate(robot) * Math.abs(along)));
      state.v = approachSpeed(state.v, Math.sign(along) * reach, robot, dt);
      state.w = approach(state.w, Math.sign(headingError) * Math.min(cap, braking), robot.turnAcceleration * dt);
      integrate(state, dt);
    }
    this.prevOut = (state.v / robot.maxSpeed) * 127;
    this.traveled += Math.abs(state.v) * dt;
    return "running";
  }
}
