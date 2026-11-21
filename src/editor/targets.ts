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
  /** for code comments and the inspector: "blue goal 2", "yellow pin", "red loader" */
  label: string;
}

const HALF = FIELD_SIZE / 2;
const PIN_KINDS = new Set(['cup-yellow-pin', 'cup-red-blue-pin', 'cup-blue-red-pin']);

function buildTargets(field: FieldDefinition): Target[] {
  // src/field draws the field the manual's way; Crimson's frame is that turned 180 degrees about the corner origin
  const at = (p: { x: number; y: number }) => ({ x: HALF - p.x, y: HALF - p.y });
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
  const loaders = field.loaders.map((l): Target => ({ id: l.id, kind: 'loader', ...at(l.position), label: `${l.alliance} loader` }));
  return [...goals, ...pins, ...loaders];
}

export const TARGETS: Target[] = buildTargets(DEFAULT_FIELD);
const BY_ID = new Map(TARGETS.map(t => [t.id, t]));

export const targetById = (id: string | null | undefined): Target | null => (id ? BY_ID.get(id) ?? null : null);

/** The same kind of spot on the other half of the field (the layout is point-symmetric). */
export function mirrorTarget(id: string | null | undefined): string | null {
  const t = targetById(id);
  if (!t) return null;
  const x = FIELD_SIZE - t.x;
  const y = FIELD_SIZE - t.y;
  const twin = TARGETS.find(o => o.kind === t.kind && Math.abs(o.x - x) < 0.5 && Math.abs(o.y - y) < 0.5);
  return twin?.id ?? null;
}

/** "(48, 24)" for code comments. */
export const where = (t: Target) => `(${Math.round(t.x * 10) / 10}, ${Math.round(t.y * 10) / 10})`;
