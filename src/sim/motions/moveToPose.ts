import { angleError } from "../../core/angle";
import { forward, length, scale, sub } from "../../core/geometry";
import type { Pose } from "../../core/geometry";
import type { RobotConfig } from "../../robot/config";
import { approach, integrate, speedFraction } from "../kinematics";
import type { DriveState } from "../kinematics";
import { driveToward } from "./moveToPoint";
import { LARGE_EXIT_RANGE, LargeExit } from "./types";
import type { Motion, MotionStatus } from "./types";

export interface MoveToPoseParams {
  forwards: boolean;
  lead: number;
  maxSpeed: number;
  minSpeed: number;
  earlyExitRange: number;
}

const SETTLE_RANGE = 2.5;
const POSITION_DONE = 0.75;
const HEADING_DONE = 2;

export class MoveToPose implements Motion {
  traveled = 0;
  readonly keepsMoving: boolean;
  private readonly largeExit = new LargeExit();

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
    if (remaining <= POSITION_DONE && Math.abs(headingError) <= HEADING_DONE) {
      return "done";
    }
    // settled close by, facing the right way, but short of the tight range: LemLib's large-error exit ends it
    if (this.largeExit.update(remaining <= LARGE_EXIT_RANGE && Math.abs(headingError) <= HEADING_DONE * 1.5, dt)) {
      return "done";
    }

    if (remaining > SETTLE_RANGE) {
      const side = this.params.forwards ? 1 : -1;
      const lead = scale(forward(this.target.theta), side * this.params.lead * remaining);
      const carrot = sub(this.target, lead);
      driveToward(state, carrot, dt, robot, { ...this.params }, remaining);
    } else {
      const cap = robot.maxTurnRate * speedFraction(this.params.maxSpeed);
      const braking = Math.sqrt(2 * robot.turnAcceleration * Math.abs(headingError));
      state.v = approach(state.v, 0, robot.acceleration * dt);
      state.w = approach(state.w, Math.sign(headingError) * Math.min(cap, braking), robot.turnAcceleration * dt);
      integrate(state, dt);
    }
    this.traveled += Math.abs(state.v) * dt;
    return "running";
  }
}
