import type { Vec2 } from "../core/geometry";
import type { FieldDefinition, FieldElement, Goal, LoadZone, Loader, TapeLine } from "./types";

const mm = (value: number): number => value / 25.4;
const at = (xMm: number, yMm: number): Vec2 => ({ x: mm(xMm), y: mm(yMm) });

const HALF = mm(1783.2);
const ZONE_X = mm(1492);
const ZONE_Y = mm(1173);
const DIAGONAL_END = mm(1492);
const MIDFIELD = mm(600);
const GOAL_SIZE = 5;
const CUP_RADIUS = 2.5;
const WALL_CUP_SPACING = mm(200);

const goals: Goal[] = [
  { id: "goal-0", label: "0", position: at(0, 0), owner: "neutral", size: GOAL_SIZE },
  { id: "goal-1a", label: "1", position: at(-1200, 600), owner: "neutral", size: GOAL_SIZE },
  { id: "goal-1b", label: "1", position: at(1200, -600), owner: "neutral", size: GOAL_SIZE },
  { id: "goal-4a", label: "4", position: at(-600, 1200), owner: "neutral", size: GOAL_SIZE },
  { id: "goal-4b", label: "4", position: at(600, -1200), owner: "neutral", size: GOAL_SIZE },
  { id: "goal-red-2", label: "2", position: at(-1200, -600), owner: "red", size: GOAL_SIZE },
  { id: "goal-red-3", label: "3", position: at(-600, -1200), owner: "red", size: GOAL_SIZE },
  { id: "goal-blue-2", label: "2", position: at(1200, 600), owner: "blue", size: GOAL_SIZE },
  { id: "goal-blue-3", label: "3", position: at(600, 1200), owner: "blue", size: GOAL_SIZE },
];

const loaders: Loader[] = [-1, 1].flatMap((sx) =>
  [-1, 1].map((sy) => ({
    id: `loader-${sx < 0 ? "red" : "blue"}-${sy < 0 ? "bottom" : "top"}`,
    position: at(sx * 1740, sy * 1490),
    width: 3,
    height: 4.6,
    alliance: sx < 0 ? ("red" as const) : ("blue" as const),
  })),
);

const loadZones: LoadZone[] = [-1, 1].flatMap((sx) =>
  [-1, 1].map((sy) => ({
    id: `zone-${sx < 0 ? "red" : "blue"}-${sy < 0 ? "bottom" : "top"}`,
    alliance: sx < 0 ? ("red" as const) : ("blue" as const),
    min: { x: Math.min(sx * ZONE_X, sx * HALF), y: Math.min(sy * ZONE_Y, sy * HALF) },
    max: { x: Math.max(sx * ZONE_X, sx * HALF), y: Math.max(sy * ZONE_Y, sy * HALF) },
    tape: [
      { x: sx * ZONE_X, y: sy * HALF },
      { x: sx * ZONE_X, y: sy * ZONE_Y },
      { x: sx * HALF, y: sy * ZONE_Y },
    ],
  })),
);

const tape: TapeLine[] = [
  { sx: -1, sy: 1, double: true },
  { sx: 1, sy: 1, double: false },
  { sx: -1, sy: -1, double: false },
  { sx: 1, sy: -1, double: true },
].map(({ sx, sy, double }) => ({
  from: { x: (sx * MIDFIELD) / 2, y: (sy * MIDFIELD) / 2 },
  to: { x: sx * DIAGONAL_END, y: sy * DIAGONAL_END },
  double,
}));

const innerElements: FieldElement[] = [
  { id: "cross-1", kind: "four-pin-cross", position: at(-1200, 1200), radius: 3.5 },
  { id: "cross-2", kind: "four-pin-cross", position: at(-600, 600), radius: 3.5 },
  { id: "cross-3", kind: "four-pin-cross", position: at(600, -600), radius: 3.5 },
  { id: "cross-4", kind: "four-pin-cross", position: at(1200, -1200), radius: 3.5 },
  { id: "cup-yellow-1", kind: "cup-yellow-pin", position: at(1200, 1200), radius: CUP_RADIUS },
  { id: "cup-yellow-2", kind: "cup-yellow-pin", position: at(600, 600), radius: CUP_RADIUS },
  { id: "cup-yellow-3", kind: "cup-yellow-pin", position: at(-600, -600), radius: CUP_RADIUS },
  { id: "cup-yellow-4", kind: "cup-yellow-pin", position: at(-1200, -1200), radius: CUP_RADIUS },
  { id: "cup-pin-top", kind: "cup-blue-red-pin", position: at(0, 600), radius: CUP_RADIUS },
  { id: "cup-pin-bottom", kind: "cup-red-blue-pin", position: at(0, -600), radius: CUP_RADIUS },
  { id: "cup-pin-left", kind: "cup-red-blue-pin", position: at(-600, 0), radius: CUP_RADIUS },
  { id: "cup-pin-right", kind: "cup-blue-red-pin", position: at(600, 0), radius: CUP_RADIUS },
];

const wallSpots: Array<{ x: number; y: number; along: "x" | "y" }> = [
  { x: -600, y: 1745, along: "x" },
  { x: 600, y: 1745, along: "x" },
  { x: -600, y: -1745, along: "x" },
  { x: 600, y: -1745, along: "x" },
  { x: -1745, y: 600, along: "y" },
  { x: -1745, y: -600, along: "y" },
  { x: 1745, y: 600, along: "y" },
  { x: 1745, y: -600, along: "y" },
];

const wallElements: FieldElement[] = wallSpots.flatMap((spot, i) => {
  const center = at(spot.x, spot.y);
  const dx = spot.along === "x" ? WALL_CUP_SPACING : 0;
  const dy = spot.along === "y" ? WALL_CUP_SPACING : 0;
  return [
    { id: `wall-cup-${i}-a`, kind: "cup" as const, position: { x: center.x - dx, y: center.y - dy }, radius: CUP_RADIUS },
    { id: `wall-cup-${i}-b`, kind: "cup" as const, position: { x: center.x + dx, y: center.y + dy }, radius: CUP_RADIUS },
    { id: `wall-pin-${i}`, kind: "cup-yellow-pin" as const, position: center, radius: CUP_RADIUS },
  ];
});

export const OVERRIDE_FIELD: FieldDefinition = {
  id: "v5rc-2026-override",
  name: "V5RC Override",
  season: "2026-2027",
  half: HALF,
  tiles: 6,
  goals,
  loaders,
  loadZones,
  tape,
  midfield: [
    { x: 0, y: MIDFIELD },
    { x: MIDFIELD, y: 0 },
    { x: 0, y: -MIDFIELD },
    { x: -MIDFIELD, y: 0 },
  ],
  wallBars: [
    { id: "toggle-top", side: "top", length: mm(666) },
    { id: "toggle-bottom", side: "bottom", length: mm(666) },
    { id: "toggle-left", side: "left", length: mm(666) },
    { id: "toggle-right", side: "right", length: mm(666) },
  ],
  elements: [...innerElements, ...wallElements],
};
