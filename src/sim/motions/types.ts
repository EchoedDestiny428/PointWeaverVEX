import type { RobotConfig } from "../../robot/config";
import type { DriveState } from "../kinematics";

export type MotionStatus = "running" | "done";

export interface Motion {
  readonly timeoutMs: number;
  readonly keepsMoving: boolean;
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

/**
 * A fallback for the simulator's own simplifications (not a LemLib setting): a moveToPose that has settled close
 * by, facing the right way, but short of LemLib's ranges, ends after a while instead of waiting for its timeout.
 */
export const LARGE_EXIT_RANGE = 3;
export const LARGE_EXIT_SECONDS = 0.5;

export class LargeExit {
  private elapsed = 0;

  /** True once `close` has held for LARGE_EXIT_SECONDS in a row. */
  update(close: boolean, dt: number): boolean {
    this.elapsed = close ? this.elapsed + dt : 0;
    return this.elapsed >= LARGE_EXIT_SECONDS - 1e-9;
  }
}
