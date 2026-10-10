import { wrap180 } from "../core/angle";
import type { RobotConfig } from "../robot/config";
import type { SimResult } from "../sim/runtime";
import type { FieldView } from "./fieldRenderer";
import { points, svg } from "./svg";

const PATH_STRIDE = 3;

export class Scene {
  private readonly planned: SVGPolylineElement;
  private readonly traveled: SVGPolylineElement;
  private readonly markers: SVGGElement;
  private readonly robot: SVGGElement;
  private readonly body: SVGRectElement;
  private readonly front: SVGLineElement;
  private result: SimResult | null = null;
  private samples: string[] = [];
  private highlighted = new Set<string>();

  constructor(
    root: SVGGElement,
    private readonly field: FieldView,
  ) {
    this.planned = svg("polyline", { class: "path-planned", points: "" }, root);
    this.traveled = svg("polyline", { class: "path-traveled", points: "" }, root);
    this.markers = svg("g", { class: "markers" }, root);
    this.robot = svg("g", { class: "robot" }, root);
    this.body = svg("rect", { class: "robot-body", rx: 1.6 }, this.robot);
    this.front = svg("line", { class: "robot-front" }, this.robot);
    svg("circle", { cx: 0, cy: 0, r: 0.8, class: "robot-center" }, this.robot);
  }

  load(result: SimResult, robot: RobotConfig): void {
    this.result = result;
    const w = robot.width;
    const l = robot.length;
    this.body.setAttribute("x", String(-w / 2));
    this.body.setAttribute("y", String(-l / 2));
    this.body.setAttribute("width", String(w));
    this.body.setAttribute("height", String(l));
    this.front.setAttribute("x1", String(-w / 2 + 2));
    this.front.setAttribute("x2", String(w / 2 - 2));
    this.front.setAttribute("y1", String(-l / 2 + 1.1));
    this.front.setAttribute("y2", String(-l / 2 + 1.1));

    this.samples = [];
    for (let i = 0; i < result.frameCount; i += PATH_STRIDE) {
      this.samples.push(`${result.x[i].toFixed(2)},${(-result.y[i]).toFixed(2)}`);
    }
    this.planned.setAttribute("points", this.samples.join(" "));

    this.markers.replaceChildren();
    for (const reset of result.poseResets) {
      svg("polyline", { points: points([reset.from, reset.to]), class: "reset-jump" }, this.markers);
      svg("circle", { cx: reset.to.x, cy: -reset.to.y, r: 0.7, class: "reset-dot" }, this.markers);
    }
    result.collisions.forEach((event, index) => {
      const g = svg("g", { class: "hit-marker" }, this.markers);
      svg("circle", { cx: event.position.x, cy: -event.position.y, r: 1.9 }, g);
      const label = svg("text", { x: event.position.x, y: -event.position.y + 0.8, "text-anchor": "middle" }, g);
      label.textContent = String(index + 1);
    });
  }

  showTime(time: number): void {
    const result = this.result;
    if (!result || result.frameCount === 0) return;
    const exact = Math.max(0, Math.min(result.frameCount - 1, time / result.dt));
    const i = Math.floor(exact);
    const j = Math.min(result.frameCount - 1, i + 1);
    const a = exact - i;
    const x = result.x[i] + (result.x[j] - result.x[i]) * a;
    const y = result.y[i] + (result.y[j] - result.y[i]) * a;
    const theta = result.theta[i] + wrap180(result.theta[j] - result.theta[i]) * a;
    this.robot.setAttribute("transform", `translate(${x.toFixed(3)} ${(-y).toFixed(3)}) rotate(${theta.toFixed(2)})`);
    this.robot.classList.toggle("is-hit", result.hit[Math.round(exact)] === 1);

    const count = Math.floor(i / PATH_STRIDE) + 1;
    const head = this.samples.slice(0, count).join(" ");
    this.traveled.setAttribute("points", `${head} ${x.toFixed(2)},${(-y).toFixed(2)}`);

    const active = new Set(
      result.collisions.filter((event) => event.start <= time && time < event.end).map((event) => event.obstacleId),
    );
    for (const id of this.highlighted) {
      if (!active.has(id)) this.node(id)?.classList.remove("is-hit");
    }
    for (const id of active) this.node(id)?.classList.add("is-hit");
    this.highlighted = active;
  }

  private node(id: string): Element | undefined {
    return id === "wall" ? this.field.wall : this.field.obstacleNodes.get(id);
  }
}
