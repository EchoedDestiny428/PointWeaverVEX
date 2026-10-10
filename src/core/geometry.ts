import { toDegrees, toRadians } from "./angle";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Pose extends Vec2 {
  theta: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (v: Vec2, k: number): Vec2 => ({ x: v.x * k, y: v.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const length = (v: Vec2): number => Math.hypot(v.x, v.y);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function forward(headingDeg: number): Vec2 {
  const r = toRadians(headingDeg);
  return { x: Math.sin(r), y: Math.cos(r) };
}

export function rightOf(headingDeg: number): Vec2 {
  const r = toRadians(headingDeg);
  return { x: Math.cos(r), y: -Math.sin(r) };
}

export function headingTo(from: Vec2, to: Vec2): number {
  return toDegrees(Math.atan2(to.x - from.x, to.y - from.y));
}

export interface OrientedBox {
  center: Vec2;
  halfWidth: number;
  halfLength: number;
  heading: number;
}

export type Shape =
  | { type: "circle"; center: Vec2; radius: number }
  | { type: "rect"; center: Vec2; width: number; height: number };

export function robotBox(pose: Pose, width: number, length: number): OrientedBox {
  return { center: { x: pose.x, y: pose.y }, halfWidth: width / 2, halfLength: length / 2, heading: pose.theta };
}

export function boxCorners(box: OrientedBox): Vec2[] {
  const f = scale(forward(box.heading), box.halfLength);
  const r = scale(rightOf(box.heading), box.halfWidth);
  const c = box.center;
  return [add(add(c, f), scale(r, -1)), add(add(c, f), r), sub(sub(c, f), scale(r, -1)), sub(sub(c, f), r)];
}

export function boxHitsCircle(box: OrientedBox, center: Vec2, radius: number): boolean {
  const f = forward(box.heading);
  const r = rightOf(box.heading);
  const d = sub(center, box.center);
  const localX = clamp(dot(d, r), -box.halfWidth, box.halfWidth);
  const localY = clamp(dot(d, f), -box.halfLength, box.halfLength);
  const closest = add(box.center, add(scale(r, localX), scale(f, localY)));
  return distance(closest, center) < radius;
}

function projectionOverlaps(axis: Vec2, a: Vec2[], b: Vec2[]): boolean {
  let aMin = Infinity;
  let aMax = -Infinity;
  let bMin = Infinity;
  let bMax = -Infinity;
  for (const p of a) {
    const v = dot(p, axis);
    aMin = Math.min(aMin, v);
    aMax = Math.max(aMax, v);
  }
  for (const p of b) {
    const v = dot(p, axis);
    bMin = Math.min(bMin, v);
    bMax = Math.max(bMax, v);
  }
  return aMax > bMin && bMax > aMin;
}

export function rectCorners(center: Vec2, width: number, height: number): Vec2[] {
  const hw = width / 2;
  const hh = height / 2;
  return [
    { x: center.x - hw, y: center.y - hh },
    { x: center.x + hw, y: center.y - hh },
    { x: center.x + hw, y: center.y + hh },
    { x: center.x - hw, y: center.y + hh },
  ];
}

export function boxHitsRect(box: OrientedBox, center: Vec2, width: number, height: number): boolean {
  const boxPoints = boxCorners(box);
  const rectPoints = rectCorners(center, width, height);
  const axes = [vec(1, 0), vec(0, 1), forward(box.heading), rightOf(box.heading)];
  return axes.every((axis) => projectionOverlaps(axis, boxPoints, rectPoints));
}

export function boxHitsShape(box: OrientedBox, shape: Shape): boolean {
  return shape.type === "circle"
    ? boxHitsCircle(box, shape.center, shape.radius)
    : boxHitsRect(box, shape.center, shape.width, shape.height);
}

export function boxLeavesSquare(box: OrientedBox, half: number): boolean {
  return boxCorners(box).some((p) => Math.abs(p.x) > half || Math.abs(p.y) > half);
}
