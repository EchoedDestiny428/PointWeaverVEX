import { createElement } from "lucide";
import type { IconNode } from "lucide";

export function icon(node: IconNode, size = 16): SVGElement {
  return createElement(node, {
    width: size,
    height: size,
    "stroke-width": 1.75,
    "aria-hidden": "true",
    class: "icon",
  });
}

export function setIcon(target: Element, node: IconNode, size = 16): void {
  const current = target.querySelector(":scope > svg.icon");
  const next = icon(node, size);
  if (current) current.replaceWith(next);
  else target.prepend(next);
}
