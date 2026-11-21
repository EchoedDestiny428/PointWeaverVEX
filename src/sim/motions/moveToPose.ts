import { angleError } from "../../core/angle";
import { dot, forward, length, scale, sub } from "../../core/geometry";
import type { Pose } from "../../core/geometry";
import type { RobotConfig } from "../../robot/config";
import { approach, integrate, speedFraction } from "../kinematics";
import type { DriveState } from "../kinematics";
import { driveToward } from "./moveToPoint";
import { HeldFor, LARGE_EXIT_RANGE, LargeExit, TURN_BRAKING_SHARE } from "./types";
import type { Motion, MotionStatus } from "./types";

export interface MoveToPoseParams {
  forwards: boolean;
  lead: number;
  maxSpeed: number;
  minSpeed: number;
  earlyExitRange: number;
}

const SETTLE_RANGE = 2.5;
const HEADING_DONE = 2;

export class MoveToPose implements Motion {
  traveled = 0;
  readonly keepsMoving: boolean;
  private readonly smallExit = new HeldFor();
  private readonly largeExit = new HeldFor();
  private readonly fallback = new LargeExit();

  constructor(
    readonly target: Pose,
    readonly timeoutMs: number,
    readonly params: MoveToPoseParams,
  ) {
    this.keepsMoving = params.minSpeed > 0;
  }

  step(state: DriveState, dt: number, robot: RobotConfig): MotionStatus {
    const remaining = length(sub(this.target, state.pose));
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

    if (remaining > SETTLE_RANGE) {
      const side = this.params.forwards ? 1 : -1;
      const lead = scale(forward(this.target.theta), side * this.params.lead * remaining);
      const carrot = sub(this.target, lead);
      driveToward(state, carrot, dt, robot, { ...this.params }, remaining);
    } else {
      // close: turn to the heading while closing the rest of the way along it (LemLib does both here)
      const cap = robot.maxTurnRate * speedFraction(this.params.maxSpeed);
      const braking = Math.sqrt(2 * TURN_BRAKING_SHARE * robot.turnAcceleration * Math.abs(headingError));
      const along = dot(sub(this.target, state.pose), forward(state.pose.theta));
      const reach = Math.min(robot.maxSpeed * speedFraction(this.params.maxSpeed), Math.sqrt(2 * robot.acceleration * Math.abs(along)));
      state.v = approach(state.v, Math.sign(along) * reach, robot.acceleration * dt);
      state.w = approach(state.w, Math.sign(headingError) * Math.min(cap, braking), robot.turnAcceleration * dt);
      integrate(state, dt);
    }
    this.traveled += Math.abs(state.v) * dt;
    return "running";
  }
}
