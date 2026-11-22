import { angleError } from "../../core/angle";
import type { TurnDirection } from "../../core/angle";
import { add, forward, headingTo, rightOf, scale, sub } from "../../core/geometry";
import type { Vec2 } from "../../core/geometry";
import type { RobotConfig } from "../../robot/config";
import { approach, approachSpeed, integrate, speedFraction } from "../kinematics";
import type { DriveState } from "../kinematics";
import { HeldFor, TURN_BRAKING_SHARE } from "./types";
import type { Motion, MotionStatus } from "./types";

export interface TurnParams {
  direction: TurnDirection;
  maxSpeed: number;
  minSpeed: number;
  earlyExitRange: number;
}

const SETTLE_WINDOW = 10;

export abstract class TurnMotion implements Motion {
  traveled = 0;
  readonly keepsMoving: boolean;
  private fixedDirection: TurnDirection | null = null;
  private settling = false;
  private readonly smallExit = new HeldFor();
  private readonly largeExit = new HeldFor();

  constructor(
    readonly timeoutMs: number,
    readonly params: TurnParams,
  ) {
    this.keepsMoving = params.minSpeed > 0;
  }

  protected abstract targetHeading(state: DriveState): number;

  protected rotate(state: DriveState, dt: number, robot: RobotConfig): void {
    state.v = approachSpeed(state.v, 0, robot, dt);
    integrate(state, dt);
  }

  /** The fastest it turns (deg/s): the robot's turn rate at this turn's max speed. */
  protected rateCap(robot: RobotConfig): number {
    return robot.maxTurnRate * speedFraction(this.params.maxSpeed);
  }

  step(state: DriveState, dt: number, robot: RobotConfig): MotionStatus {
    const target = this.targetHeading(state);
    if (this.fixedDirection === null) {
      this.fixedDirection = angleError(target, state.pose.theta, this.params.direction) >= 0 ? "cw" : "ccw";
    }
    let error = angleError(target, state.pose.theta, this.settling ? "auto" : this.fixedDirection);
    if (!this.settling && Math.abs(error) < SETTLE_WINDOW) {
      this.settling = true;
      error = angleError(target, state.pose.theta, "auto");
    }

    // motion chaining (minSpeed): done on entering the early exit range
    if (this.keepsMoving && Math.abs(error) <= Math.max(this.params.earlyExitRange, 1)) return "done";
    // LemLib's exit conditions, with the robot's settings (the robot's donut uses the same angular ones)
    const small = this.smallExit.update(Math.abs(error) <= robot.angularSmallError, dt, robot.angularSmallTime);
    const large = this.largeExit.update(Math.abs(error) <= robot.angularLargeError, dt, robot.angularLargeTime);
    if (small || large) return "done";

    const cap = this.rateCap(robot);
    const floor = Math.min(cap, robot.maxTurnRate * speedFraction(this.params.minSpeed));
    const braking = Math.sqrt(2 * TURN_BRAKING_SHARE * robot.turnAcceleration * Math.abs(error));
    const magnitude = Math.max(floor, Math.min(cap, braking));
    state.w = approach(state.w, Math.sign(error) * magnitude, robot.turnAcceleration * dt);
    this.rotate(state, dt, robot);
    this.traveled += Math.abs(state.w) * dt;
    return "running";
  }
}

export class TurnToHeading extends TurnMotion {
  constructor(
    readonly heading: number,
    timeoutMs: number,
    params: TurnParams,
  ) {
    super(timeoutMs, params);
  }

  protected targetHeading(): number {
    return this.heading;
  }
}

export class TurnToPoint extends TurnMotion {
  constructor(
    readonly point: Vec2,
    readonly forwards: boolean,
    timeoutMs: number,
    params: TurnParams,
  ) {
    super(timeoutMs, params);
  }

  protected targetHeading(state: DriveState): number {
    return headingTo(state.pose, this.point) + (this.forwards ? 0 : 180);
  }
}

export type LockedSide = "left" | "right";

export class Swing extends TurnMotion {
  constructor(
    private readonly target: (state: DriveState) => number,
    readonly lockedSide: LockedSide,
    timeoutMs: number,
    params: TurnParams,
  ) {
    super(timeoutMs, params);
  }

  protected targetHeading(state: DriveState): number {
    return this.target(state);
  }

  protected override rotate(state: DriveState, dt: number, robot: RobotConfig): void {
    const offset = (this.lockedSide === "left" ? 1 : -1) * (robot.trackWidth / 2);
    const pivot = sub(state.pose, scale(rightOf(state.pose.theta), offset));
    state.pose.theta += state.w * dt;
    const center = add(pivot, scale(rightOf(state.pose.theta), offset));
    state.pose.x = center.x;
    state.pose.y = center.y;
    state.v = 0;
  }
}

export interface DonutParams {
  direction: TurnDirection;
  forwards: boolean;
  fastSpeed: number;
  slowSpeed: number;
  earlyExitRange: number;
}

export class Donut extends TurnMotion {
  constructor(
    readonly heading: number,
    timeoutMs: number,
    readonly donut: DonutParams,
  ) {
    super(timeoutMs, {
      direction: donut.direction,
      maxSpeed: (donut.fastSpeed + donut.slowSpeed) / 2,
      minSpeed: 0,
      earlyExitRange: donut.earlyExitRange,
    });
  }

  protected targetHeading(): number {
    return this.heading;
  }

  /** The robot's measured donut rate, scaled by how hard the wheels are driven (fast + slow, 175 by default). */
  protected override rateCap(robot: RobotConfig): number {
    const rate = robot.donutRate ?? robot.maxTurnRate * speedFraction((this.donut.fastSpeed + this.donut.slowSpeed) / 2);
    return Math.max(1, rate * ((this.donut.fastSpeed + this.donut.slowSpeed) / 175));
  }

  protected override rotate(state: DriveState, dt: number, robot: RobotConfig): void {
    // it orbits the goal it's on: the goal sits goalOffset in front (or behind)
    const reach = (this.donut.forwards ? 1 : -1) * (robot.goalOffset ?? robot.length / 2 + 1);
    const pivot = add(state.pose, scale(forward(state.pose.theta), reach));
    state.pose.theta += state.w * dt;
    const center = sub(pivot, scale(forward(state.pose.theta), reach));
    state.pose.x = center.x;
    state.pose.y = center.y;
    state.v = 0;
  }
}
