import { DEFAULT_FIELD } from '../field';
import type { FieldDefinition } from '../field/types';
import { FIELD_SIZE } from './types';

/**
 * Spots a point can snap to, in Crimson's frame:
 * - goal: the robot's centre drives to the goal's centre (it clips into the goal; the code resets the pose there)
 * - pin, loader: the robot stops where its claw's centre is on the spot (the claw is on the front)
 */
export type TargetKind = 'goal' | 'pin' | 'loader';

export interface Target {
  id: string;
  kind: TargetKind;
  x: number;
  y: number;
  /** for code comments and the inspector: "blue goal 2", "yellow pin", "red left loader" */
  label: string;
}

const HALF = FIELD_SIZE / 2;
/** 2.4 rather than 2.4000000000000057: these land in saved paths */
const tidy = (v: number) => Math.round(v * 1e4) / 1e4;
const PIN_KINDS = new Set(['cup-yellow-pin', 'cup-red-blue-pin', 'cup-blue-red-pin']);

function buildTargets(field: FieldDefinition): Target[] {
  // src/field draws the field the manual's way; Crimson's frame is that turned 180 degrees about the corner origin
  const at = (p: { x: number; y: number }) => ({ x: tidy(HALF - p.x), y: tidy(HALF - p.y) });
  const goals = field.goals.map((g): Target => ({
    id: g.id,
    kind: 'goal',
    ...at(g.position),
    label: g.owner === 'neutral' ? `goal ${g.label}` : `${g.owner} goal ${g.label}`,
  }));
  const pins = field.elements.filter(e => PIN_KINDS.has(e.kind)).map((e): Target => ({
    id: e.id,
    kind: 'pin',
    ...at(e.position),
    label: e.kind === 'cup-yellow-pin' ? 'yellow pin' : 'red/blue pin',
  }));
  const loaders = field.loaders.map((l): Target => ({ id: l.id, kind: 'loader', ...at(l.position), label: `${LOADERS[l.id]?.name ?? l.alliance} loader` }));
  return [...goals, ...pins, ...loaders];
}

/**
 * The four loaders, named from that alliance's driver station: blue stands at X = 0 facing +X, so its right is the
 * Y = 0 side (Crimson's origin is blue's right corner); red faces the other way, so its right is the Y = 144 side.
 */
export const LOADERS: Record<string, { name: string }> = {
  'loader-blue-top': { name: 'blue right' },
  'loader-blue-bottom': { name: 'blue left' },
  'loader-red-top': { name: 'red left' },
  'loader-red-bottom': { name: 'red right' },
};

/** Where the manual puts each spot: names and pairing across the field never depend on how a field was built. */
const NOMINAL: Target[] = buildTargets(DEFAULT_FIELD);
const NOMINAL_BY_ID = new Map(NOMINAL.map(t => [t.id, t]));

/** Where each spot is on this field: the manual's spots with the loader offsets applied (setLoaderOffsets). */
export const TARGETS: Target[] = NOMINAL.map(t => ({ ...t }));
const BY_ID = new Map(TARGETS.map(t => [t.id, t]));

export const targetById = (id: string | null | undefined): Target | null => (id ? BY_ID.get(id) ?? null : null);

/**
 * How far each loader is from where the manual puts it, by id (in). Fields aren't all built right: the manual centres
 * a loader 12 in from the corner along its wall, so 0 is 12 in and +0.5 means 12.5 in (farther from the corner).
 */
export type LoaderOffsets = Record<string, number>;

export const LOADER_NOMINAL = 12; // in from the corner, along the wall the loader is on

let offsets: LoaderOffsets = {};
let field: FieldDefinition = DEFAULT_FIELD;

/** This field's loader offsets (0 for one that isn't set). */
export const loaderOffset = (id: string) => offsets[id] ?? 0;

/** The field as built: the manual's, with the loaders moved by their offsets. Draw this one. */
export const currentField = () => field;

/**
 * Moves the loaders to where this field has them. Spots and the field drawing follow; points snapped to a loader
 * follow through syncSpots (src/editor/pathOps.ts).
 */
export function setLoaderOffsets(next: LoaderOffsets) {
  offsets = Object.fromEntries(Object.entries(next).filter(([id, v]) => id in LOADERS && Number.isFinite(v) && v !== 0));
  // along the wall, away from the near corner: toward the field's centre line (Y = 72 in Crimson's frame)
  const along = (y: number) => (y < HALF ? 1 : -1);
  for (const t of TARGETS) {
    if (t.kind !== 'loader') continue;
    const n = NOMINAL_BY_ID.get(t.id)!;
    t.y = tidy(n.y + along(n.y) * loaderOffset(t.id));
  }
  // src/field is the manual's frame (Crimson's turned 180 degrees), so there it's toward y = 0 from either side
  field = {
    ...DEFAULT_FIELD,
    loaders: DEFAULT_FIELD.loaders.map(l => ({
      ...l,
      position: { x: l.position.x, y: l.position.y - Math.sign(l.position.y) * loaderOffset(l.id) },
    })),
  };
}

/** The same kind of spot on the other half of the field (the manual's layout is point-symmetric). */
export function mirrorTarget(id: string | null | undefined): string | null {
  const t = id ? NOMINAL_BY_ID.get(id) : null;
  if (!t) return null;
  const x = FIELD_SIZE - t.x;
  const y = FIELD_SIZE - t.y;
  const twin = NOMINAL.find(o => o.kind === t.kind && Math.abs(o.x - x) < 0.5 && Math.abs(o.y - y) < 0.5);
  return twin?.id ?? null;
}

/** "(48, 24)" for code comments. */
export const where = (t: Target) => `(${Math.round(t.x * 10) / 10}, ${Math.round(t.y * 10) / 10})`;
