import { OVERRIDE_FIELD } from "./override";
import type { FieldDefinition } from "./types";

export const FIELDS: FieldDefinition[] = [OVERRIDE_FIELD];
export const DEFAULT_FIELD = OVERRIDE_FIELD;

export function findField(id: string): FieldDefinition {
  return FIELDS.find((field) => field.id === id) ?? DEFAULT_FIELD;
}

export type { FieldDefinition } from "./types";
