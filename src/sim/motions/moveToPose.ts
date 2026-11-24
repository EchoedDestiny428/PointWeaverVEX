import { angleError } from "../../core/angle";
import { dot, forward, headingTo, length, scale, sub } from "../../core/geometry";
import type { Pose, Vec2 } from "../../core/geometry";
import type { RobotConfig } from "../../robot/config";
import { approach, approachSpeed, integrate, speedFraction } from "../kinematics";
import type { DriveState } from "../kinematics";
import { approachTarget, CLOSE_MIN_SPEED, CLOSE_RANGE, driveToward } from "./moveToPoint";
import { Latched, TURN_BRAKING_SHARE } from "./types";
import type { Motion, MotionStatus } from "./types";

export interface MoveToPoseParams {
  forwards: boolean;
  lead: number;
  maxSpeed: number;
  minSpeed: number;
  earlyExitRange: number;
}

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

/**
 * LemLib 0.5.6's moveToPose: a boomerang toward a carrot point until CLOSE_RANGE, then settling on the pose. It's done
 * once it's close, its lateral exits (distance along the heading) have both been met (the small one and the large
 * one: at least largeErrorTimeout in range), and one of its angular exits has. Exits stay met once met. With a
 * minSpeed it ends when the robot and the carrot are on different sides of the exit line, which happens as soon as
 * it's close: the carrot jumps to the target there.
 */
export class MoveToPose implements Motion {
  traveled = 0;
  readonly keepsMoving: boolean;
  readonly linear = true;
  private readonly lateralSmall = new Latched();
  private readonly lateralLarge = new Latched();
  private readonly angularSmall = new Latched();
  private readonly angularLarge = new Latched();
  private lateralSettled = false;
  private prevSameSide = false;
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
    if (this.lateralLarge.done && this.lateralSmall.done) this.lateralSettled = true;
    if (this.close && this.lateralSettled && (this.angularSmall.done || this.angularLarge.done)) return "done";
    const headingError = angleError(this.target.theta, state.pose.theta);
    // the way it drives at the end, and the carrot it aims at (the target itself once close)
    const travel = scale(forward(this.target.theta), this.params.forwards ? 1 : -1);
    const carrot = this.close ? this.target : sub(this.target, scale(travel, this.params.lead * remaining));

    // motion chaining: robot and carrot on different sides of the exit line (earlyExitRange short of the target)
    if (this.keepsMoving) {
      const before = (p: Vec2) => dot(sub(this.target, p), travel) <= Math.abs(this.params.earlyExitRange);
      const sameSide = before(state.pose) === before(carrot);
      if (!sameSide && this.prevSameSide && this.close) return "done";
      this.prevSameSide = sameSide;
    }

    // LemLib's exit conditions, with the robot's settings. Lateral: the distance along the heading once close (far
    // out it's the distance to the carrot, never in range). Angular: to the heading once close, to the carrot before.
    const along = dot(sub(this.target, state.pose), forward(state.pose.theta));
    const lateral = this.close ? Math.abs(along) : Infinity;
    const aim = this.params.forwards ? state.pose.theta : state.pose.theta + 180;
    const angular = Math.abs(this.close ? headingError : angleError(headingTo(state.pose, carrot), aim));
    this.lateralSmall.update(lateral <= robot.linearSmallError, dt, robot.linearSmallTime);
    this.lateralLarge.update(lateral <= robot.linearLargeError, dt, robot.linearLargeTime);
    this.angularSmall.update(angular <= robot.angularSmallError, dt, robot.angularSmallTime);
    this.angularLarge.update(angular <= robot.angularLargeError, dt, robot.angularLargeTime);

    if (!this.close) {
      driveToward(state, carrot, dt, robot, { ...this.params, maxSpeed: this.maxSpeed }, remaining, slipCap(state.pose, carrot, robot));
    } else {
      // close: turn to the heading while closing the rest of the way along it (LemLib does both here)
      const cap = robot.maxTurnRate * speedFraction(this.maxSpeed);
      const braking = Math.sqrt(2 * TURN_BRAKING_SHARE * robot.turnAcceleration * Math.abs(headingError));
      let v = Math.sign(along) * approachTarget(robot, this.params.minSpeed, robot.maxSpeed * speedFraction(this.maxSpeed), Math.abs(along));
      // LemLib's minSpeed floor, as in moveToPoint
      const floor = robot.maxSpeed * speedFraction(this.params.minSpeed);
      if (this.params.forwards && v > 0 && v < floor) v = floor;
      if (!this.params.forwards && v < 0 && -v < floor) v = -floor;
      state.v = approachSpeed(state.v, v, robot, dt);
      state.w = approach(state.w, Math.sign(headingError) * Math.min(cap, braking), robot.turnAcceleration * dt);
      integrate(state, dt);
    }
    this.prevOut = (state.v / robot.maxSpeed) * 127;
    this.traveled += Math.abs(state.v) * dt;
    return "running";
  }
}
