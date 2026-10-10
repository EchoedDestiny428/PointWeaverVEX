export type TurnDirection = "auto" | "cw" | "ccw";

const DEGREES_PER_RADIAN = 180 / Math.PI;

export const toRadians = (degrees: number): number => degrees / DEGREES_PER_RADIAN;
export const toDegrees = (radians: number): number => radians * DEGREES_PER_RADIAN;

export function wrap360(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function wrap180(degrees: number): number {
  const wrapped = wrap360(degrees + 180) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function angleError(target: number, current: number, direction: TurnDirection = "auto"): number {
  const raw = target - current;
  if (direction === "cw") {
    return wrap360(raw);
  }
  if (direction === "ccw") {
    const clockwise = wrap360(raw);
    return clockwise === 0 ? 0 : clockwise - 360;
  }
  return wrap180(raw);
}
