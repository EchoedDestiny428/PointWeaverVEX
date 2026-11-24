import type { RobotConfig } from "../../robot/config";
import type { DriveState } from "../kinematics";

export type MotionStatus = "running" | "done";

export interface Motion {
  readonly timeoutMs: number;
  readonly keepsMoving: boolean;
  /** traveled is inches driven (a move), not degrees turned */
  readonly linear?: boolean;
  traveled: number;
  step(state: DriveState, dt: number, robot: RobotConfig): MotionStatus;
}

/**
 * Turns plan their braking with this share of the turn acceleration, leaving room for the one-step lag of the
 * simulation; braking on all of it overshoots by a couple of degrees and swings back.
 */
export const TURN_BRAKING_SHARE = 0.7;

/** LemLib's ExitCondition: true once the error has stayed within its range for the given time, in a row. */
export class HeldFor {
  private elapsed = 0;

  update(within: boolean, dt: number, ms: number): boolean {
    this.elapsed = within ? this.elapsed + dt : 0;
    return within && this.elapsed * 1000 >= ms - 1e-6;
  }
}

/** LemLib's ExitCondition as the robot runs it: met once the error has stayed in range for the time, and met from then on. */
export class Latched {
  done = false;
  private elapsed = 0;

  update(within: boolean, dt: number, ms: number): boolean {
    if (this.done) return true;
    this.elapsed = within ? this.elapsed + dt : 0;
    if (within && this.elapsed * 1000 >= ms - 1e-6) this.done = true;
    return this.done;
  }
}
