import type { FieldDefinition } from "../field/types";
import { drawElement, drawGoal } from "./icons";
import { points, svg } from "./svg";

export interface FieldView {
  obstacleNodes: Map<string, SVGGraphicsElement>;
  wall: SVGRectElement;
}

const DOUBLE_TAPE_GAP = 0.8;
const WALL_BAR_THICKNESS = 1.4;

export function renderField(root: SVGGElement, field: FieldDefinition): FieldView {
  root.replaceChildren();
  const half = field.half;
  const tile = (half * 2) / field.tiles;
  const obstacleNodes = new Map<string, SVGGraphicsElement>();

  svg("rect", { x: -half, y: -half, width: half * 2, height: half * 2, class: "tiles" }, root);
  for (let i = 1; i < field.tiles; i++) {
    const v = -half + i * tile;
    svg("line", { x1: v, x2: v, y1: -half, y2: half, class: "tile-seam" }, root);
    svg("line", { x1: -half, x2: half, y1: v, y2: v, class: "tile-seam" }, root);
  }

  for (const zone of field.loadZones) {
    svg(
      "rect",
      {
        x: zone.min.x,
        y: -zone.max.y,
        width: zone.max.x - zone.min.x,
        height: zone.max.y - zone.min.y,
        class: `zone zone-${zone.alliance}`,
      },
      root,
    );
    svg("polyline", { points: points(zone.tape), class: `zone-tape zone-tape-${zone.alliance}` }, root);
  }

  if (field.midfield.length > 0) {
    svg("polygon", { points: points(field.midfield), class: "midfield" }, root);
  }

  for (const line of field.tape) {
    const dx = line.to.x - line.from.x;
    const dy = line.to.y - line.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    for (const offset of line.double ? [-DOUBLE_TAPE_GAP, DOUBLE_TAPE_GAP] : [0]) {
      svg(
        "line",
        {
          x1: line.from.x + nx * offset,
          y1: -(line.from.y + ny * offset),
          x2: line.to.x + nx * offset,
          y2: -(line.to.y + ny * offset),
          class: "tape",
        },
        root,
      );
    }
  }

  const wall = svg("rect", { x: -half, y: -half, width: half * 2, height: half * 2, rx: 0.6, class: "wall" }, root);

  for (const bar of field.wallBars) {
    const along = bar.length;
    const gap = 0.25;
    const t = WALL_BAR_THICKNESS;
    const rect =
      bar.side === "top"
        ? { x: -along / 2, y: -half - gap - t, width: along, height: t }
        : bar.side === "bottom"
          ? { x: -along / 2, y: half + gap, width: along, height: t }
          : bar.side === "left"
            ? { x: -half - gap - t, y: -along / 2, width: t, height: along }
            : { x: half + gap, y: -along / 2, width: t, height: along };
    svg("rect", { ...rect, rx: 0.4, class: "wall-bar" }, root);
  }

  for (const loader of field.loaders) {
    const node = svg(
      "rect",
      {
        x: loader.position.x - loader.width / 2,
        y: -loader.position.y - loader.height / 2,
        width: loader.width,
        height: loader.height,
        rx: 0.5,
        class: `loader loader-${loader.alliance}`,
      },
      root,
    );
    obstacleNodes.set(loader.id, node);
  }

  for (const element of field.elements) {
    obstacleNodes.set(element.id, drawElement(root, element));
  }

  for (const goal of field.goals) {
    obstacleNodes.set(goal.id, drawGoal(root, goal));
  }

  for (let i = 0; i <= field.tiles; i++) {
    const v = -half + i * tile;
    const label = (Math.round(v * 10) / 10).toString();
    const bottom = svg("text", { x: v, y: half + 4.6, "text-anchor": "middle", class: "axis" }, root);
    bottom.textContent = label;
    const left = svg("text", { x: -half - 2.4, y: -v + 0.8, "text-anchor": "end", class: "axis" }, root);
    left.textContent = label;
  }
  return { obstacleNodes, wall };
}
