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
 * LemLib's "large error" exit: a move also ends once the robot has stayed close to the target for a while, even
 * if it never gets inside the tight stop range (it arrived at an angle and the target is now beside it).
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
