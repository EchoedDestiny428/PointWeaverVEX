import type { Vec2 } from "../core/geometry";
import type { FieldElement, Goal } from "../field/types";
import { svg } from "./svg";

function hexagon(parent: Element, center: Vec2, radius: number, className: string): void {
  const corners: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    corners.push(`${(center.x + radius * Math.cos(a)).toFixed(2)},${(-center.y + radius * Math.sin(a)).toFixed(2)}`);
  }
  svg("polygon", { points: corners.join(" "), class: className }, parent);
}

function cross(parent: Element, center: Vec2): void {
  const x = center.x;
  const y = -center.y;
  const arm = 5.2;
  svg("line", { x1: x - arm, y1: y, x2: x + arm, y2: y, class: "el-arm" }, parent);
  svg("line", { x1: x, y1: y - arm, x2: x, y2: y + arm, class: "el-arm" }, parent);
  svg("circle", { cx: x, cy: y, r: 1.2, class: "el-cup" }, parent);
}

export function drawElement(parent: Element, element: FieldElement): SVGGElement {
  const group = svg("g", { class: "element" }, parent);
  const x = element.position.x;
  const y = -element.position.y;
  if (element.kind === "four-pin-cross") {
    cross(group, element.position);
  } else {
    svg("circle", { cx: x, cy: y, r: 2.3, class: "el-cup" }, group);
    if (element.kind !== "cup") svg("circle", { cx: x, cy: y, r: 0.9, class: "el-pin" }, group);
  }
  return group;
}

export function drawGoal(parent: Element, goal: Goal, showLabel = true): SVGGElement {
  const group = svg("g", { class: `goal goal-${goal.owner}` }, parent);
  const x = goal.position.x;
  const y = -goal.position.y;
  const s = goal.size;
  svg("rect", { x: x - s / 2, y: y - s / 2, width: s, height: s, rx: 1, class: "goal-body" }, group);
  if (goal.owner === "neutral") {
    hexagon(group, goal.position, s * 0.3, "goal-mark");
  } else {
    svg("circle", { cx: x, cy: y, r: s * 0.24, class: `goal-dot goal-dot-${goal.owner}` }, group);
  }
  if (showLabel) {
    const label = svg("text", { x: x + s * 0.62, y: y - s * 0.5, "data-px": x, "data-py": y, class: "goal-label" }, group);
    label.textContent = goal.label;
  }
  return group;
}
