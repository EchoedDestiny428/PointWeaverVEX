import type { RobotConfig } from "../../robot/config";
import type { DriveState } from "../kinematics";

export type MotionStatus = "running" | "done";

export interface Motion {
  readonly timeoutMs: number;
  readonly keepsMoving: boolean;
  traveled: number;
  step(state: DriveState, dt: number, robot: RobotConfig): MotionStatus;
}
