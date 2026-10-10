import { clamp, forward } from "../core/geometry";
import type { Pose } from "../core/geometry";

export interface DriveState {
  pose: Pose;
  v: number;
  w: number;
}

export function approach(current: number, target: number, maxDelta: number): number {
  return current < target ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta);
}

export function integrate(state: DriveState, dt: number): void {
  const mid = state.pose.theta + (state.w * dt) / 2;
  const f = forward(mid);
  state.pose.x += f.x * state.v * dt;
  state.pose.y += f.y * state.v * dt;
  state.pose.theta += state.w * dt;
}

export const speedFraction = (lemlibSpeed: number): number => clamp(Math.abs(lemlibSpeed) / 127, 0, 1);
