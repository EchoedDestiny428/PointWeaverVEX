export interface StructField {
  name: string;
  type: string;
  offset: number;
  size: number;
  count: number;
  array: boolean;
  nested?: StructSchema;
}

export interface StructSchema {
  name: string;
  schema: string;
  fields: StructField[];
  size: number;
}

export type StructScalar = number | boolean;
export type StructFieldValue = StructScalar | string | number[] | boolean[] | StructValue | StructValue[];
export interface StructValue {
  [field: string]: StructFieldValue;
}

export type StructInput = Record<string, StructFieldValue | undefined>;

export class StructSchemaError extends Error {}

const PRIMITIVE_SIZE: Record<string, number> = {
  bool: 1,
  char: 1,
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  int64: 8,
  uint64: 8,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

const FIELD = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?$/;

export const isPrimitive = (type: string): boolean => type in PRIMITIVE_SIZE;
export const isIntegerType = (type: string): boolean => /^u?int(8|16|32|64)$/.test(type);

export function parseStructSchema(name: string, schema: string, known: ReadonlyMap<string, StructSchema> = new Map()): StructSchema {
  const fields: StructField[] = [];
  let offset = 0;
  for (const raw of schema.split(";")) {
    const decl = raw.replace(/^\s*enum\s*\{[^}]*\}\s*/, "").trim();
    if (decl === "") continue;
    const match = FIELD.exec(decl);
    if (!match) throw new StructSchemaError(`Can't read struct field "${decl}" in ${name}.`);
    const [, type, fieldName, countText] = match;
    const nested = isPrimitive(type) ? undefined : known.get(type);
    const size = PRIMITIVE_SIZE[type] ?? nested?.size;
    if (size === undefined) throw new StructSchemaError(`Unknown type "${type}" in ${name}.`);
    const count = countText === undefined ? 1 : Number(countText);
    fields.push({ name: fieldName, type, offset, size, count, array: countText !== undefined, nested });
    offset += size * count;
  }
  return { name, schema, fields, size: offset };
}

function readPrimitive(view: DataView, type: string, at: number): StructScalar {
  switch (type) {
    case "bool":
      return view.getUint8(at) !== 0;
    case "char":
    case "uint8":
      return view.getUint8(at);
    case "int8":
      return view.getInt8(at);
    case "int16":
      return view.getInt16(at, true);
    case "uint16":
      return view.getUint16(at, true);
    case "int32":
      return view.getInt32(at, true);
    case "uint32":
      return view.getUint32(at, true);
    case "int64":
      return Number(view.getBigInt64(at, true));
    case "uint64":
      return Number(view.getBigUint64(at, true));
    case "float":
    case "float32":
      return view.getFloat32(at, true);
    default:
      return view.getFloat64(at, true);
  }
}

function writePrimitive(view: DataView, type: string, at: number, value: StructScalar | undefined): void {
  const n = typeof value === "boolean" ? (value ? 1 : 0) : (value ?? 0);
  switch (type) {
    case "bool":
    case "char":
    case "uint8":
      view.setUint8(at, n);
      return;
    case "int8":
      view.setInt8(at, n);
      return;
    case "int16":
      view.setInt16(at, n, true);
      return;
    case "uint16":
      view.setUint16(at, n, true);
      return;
    case "int32":
      view.setInt32(at, n, true);
      return;
    case "uint32":
      view.setUint32(at, n, true);
      return;
    case "int64":
      view.setBigInt64(at, BigInt(Math.trunc(n)), true);
      return;
    case "uint64":
      view.setBigUint64(at, BigInt(Math.trunc(n)), true);
      return;
    case "float":
    case "float32":
      view.setFloat32(at, n, true);
      return;
    default:
      view.setFloat64(at, n, true);
  }
}

export function decodeStruct(schema: StructSchema, view: DataView, base = 0): StructValue {
  const value: StructValue = {};
  for (const field of schema.fields) {
    const at = base + field.offset;
    if (field.nested) {
      const nested = field.nested;
      value[field.name] = field.array
        ? Array.from({ length: field.count }, (_, i) => decodeStruct(nested, view, at + i * nested.size))
        : decodeStruct(nested, view, at);
    } else if (field.type === "char" && field.array) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset + at, field.count);
      const end = bytes.indexOf(0);
      value[field.name] = new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
    } else if (field.array) {
      const items = Array.from({ length: field.count }, (_, i) => readPrimitive(view, field.type, at + i * field.size));
      value[field.name] = items as number[] | boolean[];
    } else {
      value[field.name] = readPrimitive(view, field.type, at);
    }
  }
  return value;
}

export function decodeStructBytes(schema: StructSchema, bytes: Uint8Array): StructValue | null {
  return bytes.length === schema.size ? decodeStruct(schema, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)) : null;
}

export function decodeStructArray(schema: StructSchema, bytes: Uint8Array): StructValue[] | null {
  if (schema.size === 0 || bytes.length % schema.size !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / schema.size }, (_, i) => decodeStruct(schema, view, i * schema.size));
}

function encodeInto(schema: StructSchema, value: StructInput, view: DataView, base: number): void {
  for (const field of schema.fields) {
    const at = base + field.offset;
    const item = value[field.name];
    if (field.nested) {
      const nested = field.nested;
      const list = (field.array ? item : [item]) as StructInput[] | undefined;
      for (let i = 0; i < field.count; i++) encodeInto(nested, list?.[i] ?? {}, view, at + i * nested.size);
    } else if (field.type === "char" && field.array) {
      const bytes = new TextEncoder().encode(typeof item === "string" ? item : "").subarray(0, field.count);
      new Uint8Array(view.buffer, view.byteOffset + at, field.count).set(bytes);
    } else if (field.array) {
      const list = (Array.isArray(item) ? item : []) as StructScalar[];
      for (let i = 0; i < field.count; i++) writePrimitive(view, field.type, at + i * field.size, list[i]);
    } else {
      writePrimitive(view, field.type, at, item as StructScalar | undefined);
    }
  }
}

export function encodeStruct(schema: StructSchema, value: StructInput): Uint8Array {
  const bytes = new Uint8Array(schema.size);
  encodeInto(schema, value, new DataView(bytes.buffer), 0);
  return bytes;
}
