import { boxHitsShape, boxLeavesSquare } from "../core/geometry";
import type { OrientedBox, Shape, Vec2 } from "../core/geometry";
import type { FieldDefinition } from "../field/types";

export type ObstacleKind = "wall" | "goal" | "loader" | "element";

export interface Obstacle {
  id: string;
  name: string;
  kind: ObstacleKind;
  shape: Shape | null;
}

export const WALL: Obstacle = { id: "wall", name: "Field wall", kind: "wall", shape: null };

const OWNER_NAMES = { neutral: "Neutral", red: "Red", blue: "Blue" } as const;

export interface ObstacleFilter {
  walls: boolean;
  goals: boolean;
  loaders: boolean;
  elements: boolean;
}

export const DEFAULT_OBSTACLES: ObstacleFilter = { walls: true, goals: true, loaders: true, elements: false };

export function buildObstacles(field: FieldDefinition, filter: ObstacleFilter): Obstacle[] {
  const obstacles: Obstacle[] = filter.walls ? [WALL] : [];
  for (const goal of filter.goals ? field.goals : []) {
    obstacles.push({
      id: goal.id,
      name: `${OWNER_NAMES[goal.owner]} goal ${goal.label}`,
      kind: "goal",
      shape: { type: "rect", center: goal.position, width: goal.size, height: goal.size },
    });
  }
  for (const loader of filter.loaders ? field.loaders : []) {
    obstacles.push({
      id: loader.id,
      name: `${OWNER_NAMES[loader.alliance]} loader`,
      kind: "loader",
      shape: { type: "rect", center: loader.position, width: loader.width, height: loader.height },
    });
  }
  if (filter.elements) {
    for (const element of field.elements) {
      obstacles.push({
        id: element.id,
        name: element.kind.startsWith("cup") ? "Cup" : "Pin cross",
        kind: "element",
        shape: { type: "circle", center: element.position, radius: element.radius },
      });
    }
  }
  return obstacles;
}

export function overlapping(box: OrientedBox, obstacles: Obstacle[], half: number): Obstacle[] {
  return obstacles.filter((obstacle) =>
    obstacle.shape === null ? boxLeavesSquare(box, half) : boxHitsShape(box, obstacle.shape),
  );
}

export interface CollisionEvent {
  id: number;
  obstacleId: string;
  obstacleName: string;
  kind: ObstacleKind;
  start: number;
  end: number;
  position: Vec2;
  line: number | null;
  command: string | null;
}

export interface CollisionContext {
  line: number | null;
  command: string | null;
}

export class CollisionTracker {
  readonly events: CollisionEvent[] = [];
  private readonly open = new Map<string, CollisionEvent>();
  private nextId = 1;

  constructor(
    private readonly obstacles: Obstacle[],
    private readonly half: number,
  ) {}

  update(time: number, box: OrientedBox, context: CollisionContext): boolean {
    const hits = overlapping(box, this.obstacles, this.half);
    const ids = new Set(hits.map((hit) => hit.id));
    for (const [id, event] of this.open) {
      if (!ids.has(id)) {
        event.end = time;
        this.open.delete(id);
      }
    }
    for (const hit of hits) {
      if (!this.open.has(hit.id)) {
        const event: CollisionEvent = {
          id: this.nextId++,
          obstacleId: hit.id,
          obstacleName: hit.name,
          kind: hit.kind,
          start: time,
          end: Number.NaN,
          position: { ...box.center },
          line: context.line,
          command: context.command,
        };
        this.open.set(hit.id, event);
        this.events.push(event);
      }
    }
    return hits.length > 0;
  }

  closeAll(time: number): void {
    for (const event of this.open.values()) {
      event.end = time;
    }
    this.open.clear();
  }
}
