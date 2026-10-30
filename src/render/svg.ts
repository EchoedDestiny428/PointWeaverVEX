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

export function uprightTexts(root: Element, rotation: number): void {
  const a = (-rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  for (const text of root.querySelectorAll<SVGTextElement>("text")) {
    const data = text.dataset;
    if (data.x === undefined || data.y === undefined) {
      data.x = text.getAttribute("x") ?? "0";
      data.y = text.getAttribute("y") ?? "0";
    }
    const x = Number(data.x);
    const y = Number(data.y);
    const px = data.px === undefined ? x : Number(data.px);
    const py = data.py === undefined ? y : Number(data.py);
    const nx = (px + (x - px) * cos - (y - py) * sin).toFixed(2);
    const ny = (py + (x - px) * sin + (y - py) * cos).toFixed(2);
    text.setAttribute("x", nx);
    text.setAttribute("y", ny);
    if (rotation) text.setAttribute("transform", `rotate(${-rotation} ${nx} ${ny})`);
    else text.removeAttribute("transform");
  }
}
