import { SCHEMA_PREFIX, TYPE } from "./keys";
import { decodeStructArray, decodeStructBytes, parseStructSchema, StructSchemaError } from "./struct";
import type { StructSchema, StructValue } from "./struct";

export type LogValue = boolean | number | string | number[] | boolean[] | string[] | StructValue | StructValue[] | Uint8Array;

export interface WpilogRecord {
  timestamp: number;
  value: LogValue;
}

export interface WpilogEntry {
  id: number;
  name: string;
  type: string;
  metadata: string;
  start: number;
  finish: number | null;
  records: WpilogRecord[];
}

export interface ParsedWpilog {
  version: number;
  extraHeader: string;
  entries: WpilogEntry[];
  byName: Map<string, WpilogEntry>;
  schemas: Map<string, StructSchema>;
  truncated: boolean;
  recordCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
  warnings: string[];
}

export class WpilogError extends Error {}

export const WPILOG_MAGIC = "WPILOG";
export const WPILOG_VERSION = 0x0100;

const CONTROL_START = 0;
const CONTROL_FINISH = 1;
const CONTROL_SET_METADATA = 2;
const STRUCT_PREFIX = "struct:";
const MAX_LEAP_US = 6 * 3600e6;
const MAX_BAD_RUN = 8;

const utf8 = new TextDecoder("utf-8");

function readUint(bytes: Uint8Array, at: number, length: number): number {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < length; i++) {
    value += bytes[at + i] * scale;
    scale *= 256;
  }
  return value;
}

class Cursor {
  constructor(
    readonly bytes: Uint8Array,
    public at: number,
    readonly end: number,
  ) {}

  u8(): number {
    if (this.at + 1 > this.end) throw new RangeError();
    return this.bytes[this.at++];
  }

  u32(): number {
    if (this.at + 4 > this.end) throw new RangeError();
    const value = readUint(this.bytes, this.at, 4);
    this.at += 4;
    return value;
  }

  text(): string {
    const length = this.u32();
    if (this.at + length > this.end) throw new RangeError();
    const value = utf8.decode(this.bytes.subarray(this.at, this.at + length));
    this.at += length;
    return value;
  }
}

function view(payload: Uint8Array): DataView {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

function decodeArray(payload: Uint8Array, size: number, read: (v: DataView, at: number) => number): number[] {
  const v = view(payload);
  const out: number[] = [];
  for (let at = 0; at + size <= payload.length; at += size) out.push(read(v, at));
  return out;
}

function decodeStringArray(payload: Uint8Array): string[] {
  const cursor = new Cursor(payload, 0, payload.length);
  const count = cursor.u32();
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(cursor.text());
  return out;
}

function decodePayload(type: string, payload: Uint8Array): LogValue {
  switch (type) {
    case TYPE.boolean:
      return payload.length > 0 && payload[0] !== 0;
    case TYPE.int64:
      return payload.length >= 8 ? Number(view(payload).getBigInt64(0, true)) : Number.NaN;
    case "float":
      return payload.length >= 4 ? view(payload).getFloat32(0, true) : Number.NaN;
    case TYPE.double:
      return payload.length >= 8 ? view(payload).getFloat64(0, true) : Number.NaN;
    case TYPE.string:
    case TYPE.schema:
    case "json":
      return utf8.decode(payload);
    case "boolean[]":
      return Array.from(payload, (b) => b !== 0);
    case "int64[]":
      return decodeArray(payload, 8, (v, at) => Number(v.getBigInt64(at, true)));
    case "float[]":
      return decodeArray(payload, 4, (v, at) => v.getFloat32(at, true));
    case "double[]":
      return decodeArray(payload, 8, (v, at) => v.getFloat64(at, true));
    case "string[]":
      try {
        return decodeStringArray(payload);
      } catch {
        return [];
      }
    default:
      return payload;
  }
}

function resolveSchemas(texts: Map<string, string>, warnings: string[]): Map<string, StructSchema> {
  const schemas = new Map<string, StructSchema>();
  const visiting = new Set<string>();
  const resolve = (name: string): StructSchema | undefined => {
    const done = schemas.get(name);
    if (done || visiting.has(name)) return done;
    const text = texts.get(name);
    if (text === undefined) return undefined;
    visiting.add(name);
    for (const decl of text.split(";")) {
      const type = /^\s*(?:enum\s*\{[^}]*\}\s*)?([A-Za-z_]\w*)\s+/.exec(decl)?.[1];
      if (type && texts.has(type) && type !== name) resolve(type);
    }
    visiting.delete(name);
    try {
      const schema = parseStructSchema(name, text, schemas);
      schemas.set(name, schema);
      return schema;
    } catch (error) {
      if (!(error instanceof StructSchemaError)) throw error;
      warnings.push(error.message);
      return undefined;
    }
  };
  for (const name of texts.keys()) resolve(name);
  return schemas;
}

export function parseWpilog(bytes: Uint8Array): ParsedWpilog {
  if (bytes.length < 12 || utf8.decode(bytes.subarray(0, 6)) !== WPILOG_MAGIC) {
    throw new WpilogError("Not a WPILOG file.");
  }
  const version = readUint(bytes, 6, 2);
  if (version >> 8 !== 1) {
    throw new WpilogError(`Unsupported WPILOG version ${version >> 8}.${version & 0xff}.`);
  }
  const extraLength = readUint(bytes, 8, 4);
  if (12 + extraLength > bytes.length) {
    throw new WpilogError("The WPILOG header is cut off.");
  }
  const extraHeader = utf8.decode(bytes.subarray(12, 12 + extraLength));

  const entries: WpilogEntry[] = [];
  const byName = new Map<string, WpilogEntry>();
  const active = new Map<number, WpilogEntry>();
  const warnings: string[] = [];
  let unknownIds = 0;
  let strayTimes = 0;
  let badRun = 0;
  let badFrom = 0;
  let corrupt = false;
  let truncated = false;
  let recordCount = 0;
  let firstTimestamp = Number.POSITIVE_INFINITY;
  let lastTimestamp = Number.NEGATIVE_INFINITY;
  let at = 12 + extraLength;

  const control = (payload: Uint8Array, timestamp: number): boolean => {
    try {
      const cursor = new Cursor(payload, 0, payload.length);
      const kind = cursor.u8();
      const entryId = cursor.u32();
      if (kind === CONTROL_START) {
        const name = cursor.text();
        const type = cursor.text();
        const metadata = cursor.text();
        let entry = byName.get(name);
        if (entry && entry.type !== type) {
          warnings.push(`${name} restarted as ${type} (was ${entry.type}); later records are kept apart.`);
          entry = undefined;
        }
        if (!entry) {
          entry = { id: entryId, name, type, metadata, start: timestamp, finish: null, records: [] };
          entries.push(entry);
          if (!byName.has(name)) byName.set(name, entry);
        } else {
          entry.id = entryId;
          entry.metadata = metadata;
          entry.finish = null;
        }
        active.set(entryId, entry);
      } else if (kind === CONTROL_FINISH) {
        const entry = active.get(entryId);
        if (entry) entry.finish = timestamp;
        active.delete(entryId);
      } else if (kind === CONTROL_SET_METADATA) {
        const entry = active.get(entryId);
        if (entry) entry.metadata = cursor.text();
      } else {
        warnings.push(`Unknown control record ${kind} at ${timestamp} µs.`);
        return false;
      }
      return true;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      warnings.push(`Malformed control record at ${timestamp} µs.`);
      return false;
    }
  };

  while (at < bytes.length) {
    const lengths = bytes[at];
    const idLength = (lengths & 0x3) + 1;
    const sizeLength = ((lengths >> 2) & 0x3) + 1;
    const timestampLength = ((lengths >> 4) & 0x7) + 1;
    const headerLength = 1 + idLength + sizeLength + timestampLength;
    if (at + headerLength > bytes.length) {
      truncated = true;
      break;
    }
    const id = readUint(bytes, at + 1, idLength);
    const size = readUint(bytes, at + 1 + idLength, sizeLength);
    const timestamp = readUint(bytes, at + 1 + idLength + sizeLength, timestampLength);
    const payloadStart = at + headerLength;
    if (payloadStart + size > bytes.length) {
      truncated = true;
      break;
    }
    const payload = bytes.subarray(payloadStart, payloadStart + size);
    const recordAt = at;
    at = payloadStart + size;

    let ok = false;
    if (recordCount > 0 && timestamp > lastTimestamp + MAX_LEAP_US) {
      strayTimes++;
    } else if (id === 0) {
      ok = control(payload, timestamp);
    } else {
      const entry = active.get(id);
      if (entry) {
        entry.records.push({ timestamp, value: entry.type.startsWith(STRUCT_PREFIX) ? payload : decodePayload(entry.type, payload) });
        ok = true;
      } else {
        unknownIds++;
      }
    }
    if (!ok) {
      if (badRun++ === 0) badFrom = recordAt;
      if (badRun < MAX_BAD_RUN) continue;
      corrupt = true;
      truncated = true;
      warnings.push(`The file is unreadable from byte ${badFrom} on (after ${recordCount} records); the rest is ignored.`);
      break;
    }
    badRun = 0;
    recordCount++;
    firstTimestamp = Math.min(firstTimestamp, timestamp);
    lastTimestamp = Math.max(lastTimestamp, timestamp);
  }

  if (badRun > 0 && !truncated) {
    corrupt = true;
    truncated = true;
    warnings.push(`The file is unreadable from byte ${badFrom} on (after ${recordCount} records); the rest is ignored.`);
  }
  if (unknownIds > 0) warnings.push(`${unknownIds} records point at entries that were never started.`);
  if (strayTimes > 0) warnings.push(`${strayTimes} records with timestamps hours past the rest of the log were skipped.`);
  if (truncated && !corrupt) warnings.push(`The file ends mid-record after ${recordCount} records; the partial record is ignored.`);

  for (const entry of entries) {
    if (entry.records.some((record, i) => i > 0 && record.timestamp < entry.records[i - 1].timestamp)) {
      entry.records.sort((x, y) => x.timestamp - y.timestamp);
    }
  }

  const schemaTexts = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== TYPE.schema || !entry.name.startsWith(`${SCHEMA_PREFIX}${STRUCT_PREFIX}`)) continue;
    const last = entry.records.at(-1);
    if (last && typeof last.value === "string") schemaTexts.set(entry.name.slice(SCHEMA_PREFIX.length + STRUCT_PREFIX.length), last.value);
  }
  const schemas = resolveSchemas(schemaTexts, warnings);

  for (const entry of entries) {
    if (!entry.type.startsWith(STRUCT_PREFIX)) continue;
    const isArray = entry.type.endsWith("[]");
    const name = entry.type.slice(STRUCT_PREFIX.length, isArray ? -2 : undefined);
    const schema = schemas.get(name);
    if (!schema) {
      warnings.push(`${entry.name} uses ${entry.type}, which has no schema; its values stay raw bytes.`);
      continue;
    }
    let bad = 0;
    for (const record of entry.records) {
      const raw = record.value as Uint8Array;
      const decoded = isArray ? decodeStructArray(schema, raw) : decodeStructBytes(schema, raw);
      if (decoded) record.value = decoded;
      else bad++;
    }
    if (bad > 0) warnings.push(`${bad} ${entry.name} records don't match the ${name} schema size (${schema.size} bytes).`);
  }

  return {
    version,
    extraHeader,
    entries,
    byName,
    schemas,
    truncated,
    recordCount,
    firstTimestamp: recordCount > 0 ? firstTimestamp : Number.NaN,
    lastTimestamp: recordCount > 0 ? lastTimestamp : Number.NaN,
    warnings,
  };
}
