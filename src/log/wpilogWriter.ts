import { schemaKey, structType, TYPE } from "./keys";
import { encodeStruct, parseStructSchema } from "./struct";
import type { StructFieldValue, StructInput, StructSchema } from "./struct";
import { WPILOG_MAGIC, WPILOG_VERSION } from "./wpilog";

export type WritableValue = boolean | number | bigint | string | number[] | boolean[] | string[] | StructInput | Uint8Array;

const utf8 = new TextEncoder();

export function byteCount(value: number, max: number): number {
  let count = 1;
  let limit = 256;
  while (value >= limit && count < max) {
    count++;
    limit *= 256;
  }
  return count;
}

class ByteSink {
  private buffer = new Uint8Array(1 << 16);
  length = 0;

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  u8(value: number): void {
    this.reserve(1);
    this.buffer[this.length++] = value & 0xff;
  }

  uint(value: number, bytes: number): void {
    this.reserve(bytes);
    let rest = Math.trunc(value);
    for (let i = 0; i < bytes; i++) {
      this.buffer[this.length++] = rest % 256;
      rest = Math.floor(rest / 256);
    }
  }

  bytes(data: Uint8Array): void {
    this.reserve(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function lengthPrefixed(text: string): Uint8Array {
  const body = utf8.encode(text);
  return concat([u32(body.length), body]);
}

function packNumbers(values: number[], size: 4 | 8, write: (v: DataView, at: number, n: number) => void): Uint8Array {
  const out = new Uint8Array(values.length * size);
  const v = new DataView(out.buffer);
  values.forEach((n, i) => write(v, i * size, n));
  return out;
}

export function encodeValue(type: string, value: WritableValue, schemas?: ReadonlyMap<string, StructSchema>): Uint8Array {
  if (value instanceof Uint8Array) return value;
  switch (type) {
    case TYPE.boolean:
      return Uint8Array.of(value ? 1 : 0);
    case TYPE.int64: {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigInt64(0, typeof value === "bigint" ? value : BigInt(Math.trunc(value as number)), true);
      return out;
    }
    case "float":
      return packNumbers([value as number], 4, (v, at, n) => v.setFloat32(at, n, true));
    case TYPE.double:
      return packNumbers([value as number], 8, (v, at, n) => v.setFloat64(at, n, true));
    case TYPE.string:
    case TYPE.schema:
    case "json":
      return utf8.encode(value as string);
    case "boolean[]":
      return Uint8Array.from(value as boolean[], (b) => (b ? 1 : 0));
    case "int64[]":
      return packNumbers(value as number[], 8, (v, at, n) => v.setBigInt64(at, BigInt(Math.trunc(n)), true));
    case "float[]":
      return packNumbers(value as number[], 4, (v, at, n) => v.setFloat32(at, n, true));
    case "double[]":
      return packNumbers(value as number[], 8, (v, at, n) => v.setFloat64(at, n, true));
    case "string[]":
      return concat([u32((value as string[]).length), ...(value as string[]).map(lengthPrefixed)]);
  }
  if (type.startsWith("struct:")) {
    const isArray = type.endsWith("[]");
    const name = type.slice("struct:".length, isArray ? -2 : undefined);
    const schema = schemas?.get(name);
    if (!schema) throw new Error(`No schema registered for ${type}.`);
    return isArray
      ? concat((value as unknown as StructInput[]).map((item) => encodeStruct(schema, item)))
      : encodeStruct(schema, value as StructInput);
  }
  throw new Error(`Can't encode ${type}; pass the payload bytes instead.`);
}

export class WpilogWriter {
  private readonly sink = new ByteSink();
  private readonly ids = new Map<string, { id: number; type: string }>();
  readonly schemas = new Map<string, StructSchema>();
  private nextId = 1;

  constructor(extraHeader = "Crimson") {
    const extra = utf8.encode(extraHeader);
    this.sink.bytes(utf8.encode(WPILOG_MAGIC));
    this.sink.uint(WPILOG_VERSION, 2);
    this.sink.uint(extra.length, 4);
    this.sink.bytes(extra);
  }

  record(id: number, timestamp: number, payload: Uint8Array): void {
    const idLength = byteCount(id, 4);
    const sizeLength = byteCount(payload.length, 4);
    const timestampLength = byteCount(timestamp, 8);
    this.sink.u8((idLength - 1) | ((sizeLength - 1) << 2) | ((timestampLength - 1) << 4));
    this.sink.uint(id, idLength);
    this.sink.uint(payload.length, sizeLength);
    this.sink.uint(timestamp, timestampLength);
    this.sink.bytes(payload);
  }

  start(name: string, type: string, timestamp: number, metadata = "", id = this.nextId): number {
    this.nextId = Math.max(this.nextId, id + 1);
    this.ids.set(name, { id, type });
    this.record(0, timestamp, concat([Uint8Array.of(0), u32(id), lengthPrefixed(name), lengthPrefixed(type), lengthPrefixed(metadata)]));
    return id;
  }

  finish(id: number, timestamp: number): void {
    this.record(0, timestamp, concat([Uint8Array.of(1), u32(id)]));
    for (const [name, entry] of this.ids) if (entry.id === id) this.ids.delete(name);
  }

  setMetadata(id: number, timestamp: number, metadata: string): void {
    this.record(0, timestamp, concat([Uint8Array.of(2), u32(id), lengthPrefixed(metadata)]));
  }

  entry(name: string, type: string, timestamp: number): number {
    return this.ids.get(name)?.id ?? this.start(name, type, timestamp);
  }

  schema(name: string, schema: string, timestamp: number): StructSchema {
    const existing = this.schemas.get(name);
    if (existing) return existing;
    const parsed = parseStructSchema(name, schema, this.schemas);
    this.schemas.set(name, parsed);
    this.write(schemaKey(name), TYPE.schema, timestamp, schema);
    return parsed;
  }

  write(name: string, type: string, timestamp: number, value: WritableValue): void {
    const id = this.entry(name, type, timestamp);
    this.record(id, timestamp, encodeValue(type, value, this.schemas));
  }

  struct(name: string, structName: string, timestamp: number, value: Record<string, StructFieldValue | undefined>): void {
    this.write(name, structType(structName), timestamp, value);
  }

  get size(): number {
    return this.sink.length;
  }

  toBytes(): Uint8Array {
    return this.sink.result();
  }
}
