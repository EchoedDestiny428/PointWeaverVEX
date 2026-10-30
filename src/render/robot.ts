import type { Pose } from "../core/geometry";
import type { RobotConfig } from "../robot/config";
import { svg } from "./svg";

export interface RobotGlyph {
  group: SVGGElement;
  body: SVGRectElement;
  front: SVGLineElement;
}

export function robotGlyph(parent: Element, className = "robot"): RobotGlyph {
  const group = svg("g", { class: className }, parent);
  const body = svg("rect", { class: "robot-body", rx: 1.6 }, group);
  const front = svg("line", { class: "robot-front" }, group);
  svg("circle", { cx: 0, cy: 0, r: 0.8, class: "robot-center" }, group);
  return { group, body, front };
}

export function sizeRobot(glyph: RobotGlyph, robot: RobotConfig): void {
  const w = robot.width;
  const l = robot.length;
  glyph.body.setAttribute("x", String(-w / 2));
  glyph.body.setAttribute("y", String(-l / 2));
  glyph.body.setAttribute("width", String(w));
  glyph.body.setAttribute("height", String(l));
  glyph.front.setAttribute("x1", String(-w / 2 + 2));
  glyph.front.setAttribute("x2", String(w / 2 - 2));
  glyph.front.setAttribute("y1", String(-l / 2 + 1.1));
  glyph.front.setAttribute("y2", String(-l / 2 + 1.1));
}

export function placeRobot(glyph: RobotGlyph, pose: Pose | null): void {
  glyph.group.removeAttribute("visibility");
  if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) {
    glyph.group.setAttribute("visibility", "hidden");
    return;
  }
  const theta = Number.isFinite(pose.theta) ? pose.theta : 0;
  glyph.group.setAttribute("transform", `translate(${pose.x.toFixed(3)} ${(-pose.y).toFixed(3)}) rotate(${theta.toFixed(2)})`);
}
