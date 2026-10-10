import type { Vec2 } from "../core/geometry";

export const SVG_NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  parent?.appendChild(node);
  return node;
}

export const toSvg = (p: Vec2): Vec2 => ({ x: p.x, y: -p.y });

export function points(list: Vec2[]): string {
  return list.map((p) => `${p.x.toFixed(2)},${(-p.y).toFixed(2)}`).join(" ");
}
