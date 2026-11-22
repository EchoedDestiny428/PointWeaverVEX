import { clamp, forward } from "../core/geometry";
import type { Pose } from "../core/geometry";
import type { RobotConfig } from "../robot/config";

export interface DriveState {
  pose: Pose;
  v: number;
  w: number;
}

export function approach(current: number, target: number, maxDelta: number): number {
  return current < target ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta);
}

/** How fast the robot slows down (in/s^2): its deceleration, or its acceleration when that isn't set. */
export const brakeRate = (robot: RobotConfig): number => (robot.deceleration > 0 ? robot.deceleration : robot.acceleration);

/**
 * Moves the drive speed toward target: speeding up at the robot's acceleration, slowing down (or reversing, which
 * stops first) at its deceleration.
 */
export function approachSpeed(v: number, target: number, robot: RobotConfig, dt: number): number {
  const reversing = v !== 0 && Math.sign(target) !== Math.sign(v);
  if (reversing) {
    const braked = approach(v, 0, brakeRate(robot) * dt);
    return braked === 0 && target !== 0 ? approach(0, target, robot.acceleration * dt) : braked;
  }
  return approach(v, target, (Math.abs(target) < Math.abs(v) ? brakeRate(robot) : robot.acceleration) * dt);
}

export function integrate(state: DriveState, dt: number): void {
  const mid = state.pose.theta + (state.w * dt) / 2;
  const f = forward(mid);
  state.pose.x += f.x * state.v * dt;
  state.pose.y += f.y * state.v * dt;
  state.pose.theta += state.w * dt;
}

export const speedFraction = (lemlibSpeed: number): number => clamp(Math.abs(lemlibSpeed) / 127, 0, 1);
