import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD } from "../src/field";
import type { Vec2 } from "../src/core/geometry";

const field = DEFAULT_FIELD;
const TILE = 24;
const onGrid = (v: number): boolean => Math.abs(v / TILE - Math.round(v / TILE)) < 1e-9;
const inside = (p: Vec2): boolean => Math.abs(p.x) <= field.half && Math.abs(p.y) <= field.half;

describe("field grid", () => {
  it("is six 24 in tiles across", () => {
    expect(field.half).toBe(72);
    expect(field.tiles).toBe(6);
    expect((field.half * 2) / field.tiles).toBe(TILE);
  });

  it("puts every goal where four tiles meet", () => {
    for (const goal of field.goals) {
      expect(onGrid(goal.position.x) && onGrid(goal.position.y), goal.id).toBe(true);
      expect(Math.abs(goal.position.x), goal.id).toBeLessThan(field.half);
      expect(Math.abs(goal.position.y), goal.id).toBeLessThan(field.half);
    }
    const spots = field.goals.map((goal) => `${goal.owner} ${goal.label} ${goal.position.x},${goal.position.y}`).sort();
    expect(spots).toEqual(
      [
        "neutral 0 0,0",
        "neutral 1 -48,24",
        "neutral 1 48,-24",
        "neutral 4 -24,48",
        "neutral 4 24,-48",
        "red 2 -48,-24",
        "red 3 -24,-48",
        "blue 2 48,24",
        "blue 3 24,48",
      ].sort(),
    );
  });

  it("puts the crosses and centre cups on tile corners", () => {
    const tileAligned = field.elements.filter((element) => !element.id.startsWith("wall-"));
    expect(tileAligned.length).toBeGreaterThan(0);
    for (const element of tileAligned) {
      expect(onGrid(element.position.x) && onGrid(element.position.y), element.id).toBe(true);
    }
  });

  it("keeps everything inside the walls", () => {
    const points: Vec2[] = [
      ...field.elements.map((element) => element.position),
      ...field.midfield,
      ...field.tape.flatMap((line) => [line.from, line.to]),
      ...field.loadZones.flatMap((zone) => [zone.min, zone.max, ...zone.tape]),
      ...field.loaders.flatMap((loader) => [
        { x: loader.position.x - loader.width / 2, y: loader.position.y - loader.height / 2 },
        { x: loader.position.x + loader.width / 2, y: loader.position.y + loader.height / 2 },
      ]),
    ];
    for (const point of points) {
      expect(inside(point), `${point.x},${point.y}`).toBe(true);
    }
    for (const bar of field.wallBars) {
      expect(bar.length).toBeLessThan(field.half * 2);
    }
  });
});
