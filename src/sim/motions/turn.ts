import { angleError } from "../../core/angle";
import type { TurnDirection } from "../../core/angle";
import { add, forward, headingTo, rightOf, scale, sub } from "../../core/geometry";
import type { Vec2 } from "../../core/geometry";
import type { RobotConfig } from "../../robot/config";
import { approach, integrate, speedFraction } from "../kinematics";
import type { DriveState } from "../kinematics";
import type { Motion, MotionStatus } from "./types";

export interface TurnParams {
  direction: TurnDirection;
  maxSpeed: number;
  minSpeed: number;
  earlyExitRange: number;
}

const SETTLE_WINDOW = 10;
const SETTLED_TURN_RATE = 60;

export abstract class TurnMotion implements Motion {
  traveled = 0;
  readonly keepsMoving: boolean;
  private fixedDirection: TurnDirection | null = null;
  private settling = false;

  constructor(
    readonly timeoutMs: number,
    readonly params: TurnParams,
  ) {
    this.keepsMoving = params.minSpeed > 0;
  }

  protected abstract targetHeading(state: DriveState): number;

  protected rotate(state: DriveState, dt: number, robot: RobotConfig): void {
    state.v = approach(state.v, 0, robot.acceleration * dt);
    integrate(state, dt);
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

    const exitRange = Math.max(this.params.earlyExitRange, 1);
    if (Math.abs(error) <= exitRange && (this.keepsMoving || Math.abs(state.w) < SETTLED_TURN_RATE)) {
      return "done";
    }

    const cap = robot.maxTurnRate * speedFraction(this.params.maxSpeed);
    const floor = robot.maxTurnRate * speedFraction(this.params.minSpeed);
    const braking = Math.sqrt(2 * robot.turnAcceleration * Math.abs(error));
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
