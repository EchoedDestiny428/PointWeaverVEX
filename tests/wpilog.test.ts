import { describe, expect, it } from "vitest";
import { CONTROLLER_BUTTONS, KEY, schemaKey, STRUCT_SCHEMAS, structType, TYPE } from "../src/log/keys";
import type { StructName } from "../src/log/keys";
import { buildLog } from "../src/log/model";
import { parseStructSchema } from "../src/log/struct";
import type { StructSchema, StructValue } from "../src/log/struct";
import { parseWpilog, WpilogError } from "../src/log/wpilog";
import type { WpilogEntry } from "../src/log/wpilog";
import { byteCount, encodeValue, WpilogWriter } from "../src/log/wpilogWriter";

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const records = (entry: WpilogEntry | undefined) => entry?.records.map((r) => r.value);

const SAMPLE_VALUES: Record<StructName, StructValue> = {
  Pose: { x: -31.25, y: 47.5, theta: 721.75 },
  Motor: { position: 1234.5, velocity: -512.25, voltage: 11800, current: 2100, power: 9.5, torque: 0.75 },
  MotorHealth: { temperature: 55, efficiency: 62.5, faults: 0x05, flags: 0x02, overTemp: true, overCurrent: false },
  Imu: {
    heading: 359.875,
    rotation: -1440.125,
    pitch: 1.5,
    roll: -0.25,
    yaw: -0.125,
    gyroX: 2,
    gyroY: -3,
    gyroZ: 240.5,
    accelX: 0.5,
    accelY: -0.25,
    accelZ: 1,
    status: 0x01,
  },
  Wheel: { position: -2147483000, velocity: 36000, angle: 35999 },
  Battery: { voltage: 12450, current: 8250, capacity: 91.5, temperature: 27.25 },
  Controller: { leftX: -127, leftY: 127, rightX: 0, rightY: -1, buttons: 0b1000_0000_0101 },
  Mechanism: { target: 13.5, position: 13.25, settled: true },
  Motion: {
    kind: 7,
    x: Number.NaN,
    y: Number.NaN,
    theta: -180,
    timeout: 1500,
    maxSpeed: Number.NaN,
    minSpeed: Number.NaN,
    earlyExit: 2.5,
    forwards: false,
    async: true,
  },
};

const STRUCT_SIZES: Record<StructName, number> = {
  Pose: 24,
  Motor: 24,
  MotorHealth: 18,
  Imu: 53,
  Wheel: 12,
  Battery: 16,
  Controller: 6,
  Mechanism: 17,
  Motion: 43,
};

describe("WPILOG container", () => {
  it("writes the contract header", () => {
    const bytes = new WpilogWriter("Crimson Oct 19 2026 08:12:44").toBytes();
    expect(ascii(bytes.subarray(0, 6))).toBe("WPILOG");
    expect([bytes[6], bytes[7]]).toEqual([0x00, 0x01]);
    const extra = new DataView(bytes.buffer).getUint32(8, true);
    expect(extra).toBe("Crimson Oct 19 2026 08:12:44".length);
    expect(ascii(bytes.subarray(12, 12 + extra))).toBe("Crimson Oct 19 2026 08:12:44");
    const parsed = parseWpilog(bytes);
    expect(parsed.version).toBe(0x0100);
    expect(parsed.extraHeader).toBe("Crimson Oct 19 2026 08:12:44");
    expect(parsed.entries).toEqual([]);
  });

  it("uses the smallest field widths in the record header", () => {
    expect([byteCount(0, 4), byteCount(255, 4), byteCount(256, 4), byteCount(70000, 4), byteCount(2 ** 32, 8)]).toEqual([1, 1, 2, 3, 5]);
    const writer = new WpilogWriter("");
    const id = writer.start("/big", TYPE.string, 0, "", 300);
    const start = writer.toBytes().length;
    writer.record(id, 2 ** 33 + 7, new Uint8Array(70000).fill(65));
    const bytes = writer.toBytes();
    expect(bytes[start]).toBe((2 - 1) | ((3 - 1) << 2) | ((5 - 1) << 4));
    expect(Array.from(bytes.subarray(start + 1, start + 3))).toEqual([300 & 0xff, 300 >> 8]);
    expect(Array.from(bytes.subarray(start + 3, start + 6))).toEqual([70000 & 0xff, (70000 >> 8) & 0xff, 70000 >> 16]);
    const parsed = parseWpilog(bytes);
    const big = parsed.byName.get("/big")!;
    expect(big.id).toBe(300);
    expect(big.records[0].timestamp).toBe(2 ** 33 + 7);
    expect((big.records[0].value as string).length).toBe(70000);
  });

  it("encodes the Start control record byte for byte", () => {
    const writer = new WpilogWriter("");
    writer.start("/a", "int64", 5, "m");
    const bytes = writer.toBytes().subarray(12);
    const payload = [0, 1, 0, 0, 0, 2, 0, 0, 0, 0x2f, 0x61, 5, 0, 0, 0, ...Array.from("int64", (c) => c.charCodeAt(0)), 1, 0, 0, 0, 0x6d];
    expect(Array.from(bytes)).toEqual([0x00, 0, payload.length, 5, ...payload]);
  });

  it("rejects files that aren't WPILOG", () => {
    expect(() => parseWpilog(new TextEncoder().encode("time,x,y\n0,1,2\n"))).toThrow(WpilogError);
    expect(() => parseWpilog(new Uint8Array([0x57, 0x50, 0x49, 0x4c, 0x4f, 0x47, 0, 2, 0, 0, 0, 0]))).toThrow(/version/);
  });
});

describe("value types", () => {
  it("round-trips every scalar and array type", () => {
    const writer = new WpilogWriter();
    writer.write("/b", TYPE.boolean, 1, true);
    writer.write("/b", TYPE.boolean, 2, false);
    writer.write("/i", TYPE.int64, 3, -42);
    writer.write("/i", TYPE.int64, 4, 2 ** 40 + 3);
    writer.write("/i", TYPE.int64, 5, -(2n ** 50n));
    writer.write("/f", "float", 6, 1.5);
    writer.write("/d", TYPE.double, 7, -0.1);
    writer.write("/s", TYPE.string, 8, "héllo · 24°");
    writer.write("/s", TYPE.string, 9, "");
    writer.write("/ba", "boolean[]", 10, [true, false, true]);
    writer.write("/ia", "int64[]", 11, [1, -2, 3]);
    writer.write("/fa", "float[]", 12, [0.5, -0.25]);
    writer.write("/da", "double[]", 13, [Math.PI, -1e9]);
    writer.write("/sa", "string[]", 14, ["a", "", "ünï"]);
    writer.write("/raw", "raw", 15, Uint8Array.of(1, 2, 3));
    const parsed = parseWpilog(writer.toBytes());
    const get = (name: string) => records(parsed.byName.get(name));
    expect(get("/b")).toEqual([true, false]);
    expect(get("/i")).toEqual([-42, 2 ** 40 + 3, -(2 ** 50)]);
    expect(get("/f")).toEqual([1.5]);
    expect(get("/d")).toEqual([-0.1]);
    expect(get("/s")).toEqual(["héllo · 24°", ""]);
    expect(get("/ba")).toEqual([[true, false, true]]);
    expect(get("/ia")).toEqual([[1, -2, 3]]);
    expect(get("/fa")).toEqual([[0.5, -0.25]]);
    expect(get("/da")).toEqual([[Math.PI, -1e9]]);
    expect(get("/sa")).toEqual([["a", "", "ünï"]]);
    expect(get("/raw")).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(parsed.byName.get("/d")!.records[0].timestamp).toBe(7);
    expect(parsed.firstTimestamp).toBe(1);
    expect(parsed.lastTimestamp).toBe(15);
    expect(parsed.warnings).toEqual([]);
  });

  it("round-trips every contract struct with no padding", () => {
    const writer = new WpilogWriter();
    for (const [name, schema] of Object.entries(STRUCT_SCHEMAS)) writer.schema(name, schema, 0);
    for (const name of Object.keys(STRUCT_SCHEMAS) as StructName[]) writer.struct(`/${name}`, name, 10, SAMPLE_VALUES[name]);
    const parsed = parseWpilog(writer.toBytes());
    for (const name of Object.keys(STRUCT_SCHEMAS) as StructName[]) {
      const schemaEntry = parsed.byName.get(schemaKey(name))!;
      expect(schemaEntry.type).toBe("structschema");
      expect(schemaEntry.records[0].value).toBe(STRUCT_SCHEMAS[name]);
      expect(parsed.schemas.get(name)!.size, name).toBe(STRUCT_SIZES[name]);
      const entry = parsed.byName.get(`/${name}`)!;
      expect(entry.type).toBe(structType(name));
      const decoded = entry.records[0].value as StructValue;
      for (const field of parsed.schemas.get(name)!.fields) {
        const expected = SAMPLE_VALUES[name][field.name];
        const actual = decoded[field.name];
        if (field.type === "float" && typeof expected === "number") expect(actual, `${name}.${field.name}`).toBe(Math.fround(expected));
        else expect(actual, `${name}.${field.name}`).toEqual(expected);
      }
    }
  });

  it("packs a Pose as three little-endian doubles", () => {
    const writer = new WpilogWriter("");
    writer.schema("Pose", STRUCT_SCHEMAS.Pose, 0);
    const before = writer.toBytes().length;
    writer.struct(KEY.robotPose, "Pose", 20000, { x: 1, y: -2, theta: 90 });
    const tail = writer.toBytes().subarray(before);
    const payload = tail.subarray(tail.length - 24);
    const view = new DataView(payload.buffer, payload.byteOffset, 24);
    expect([view.getFloat64(0, true), view.getFloat64(8, true), view.getFloat64(16, true)]).toEqual([1, -2, 90]);
  });

  it("decodes nested structs, fixed arrays and enum annotations generically", () => {
    const writer = new WpilogWriter();
    writer.schema("Inner", "int16 a;uint8 b", 0);
    writer.schema("Outer", "enum {off=0, on=1} int8 mode;Inner inner;double v[3];char tag[4];bool flags[2];Inner list[2]", 0);
    writer.struct("/outer", "Outer", 1, {
      mode: 1,
      inner: { a: -300, b: 250 },
      v: [1, 2, 3],
      tag: "ab",
      flags: [true, false],
      list: [{ a: 1, b: 2 }, { a: 3, b: 4 }],
    });
    const value = parseWpilog(writer.toBytes()).byName.get("/outer")!.records[0].value;
    expect(value).toEqual({
      mode: 1,
      inner: { a: -300, b: 250 },
      v: [1, 2, 3],
      tag: "ab",
      flags: [true, false],
      list: [{ a: 1, b: 2 }, { a: 3, b: 4 }],
    });
  });

  it("decodes struct records that arrive before their schema", () => {
    const schema = parseStructSchema("Pose", STRUCT_SCHEMAS.Pose);
    const writer = new WpilogWriter();
    writer.schemas.set("Pose", schema);
    writer.struct("/p", "Pose", 1, { x: 1, y: 2, theta: 3 });
    writer.write(schemaKey("Pose"), TYPE.schema, 2, STRUCT_SCHEMAS.Pose);
    expect(records(parseWpilog(writer.toBytes()).byName.get("/p"))).toEqual([{ x: 1, y: 2, theta: 3 }]);
  });

  it("keeps raw bytes and warns when a struct has no schema", () => {
    const writer = new WpilogWriter();
    const id = writer.start("/mystery", "struct:Mystery", 0);
    writer.record(id, 1, Uint8Array.of(9, 9));
    const parsed = parseWpilog(writer.toBytes());
    expect(parsed.byName.get("/mystery")!.records[0].value).toEqual(Uint8Array.of(9, 9));
    expect(parsed.warnings.join(" ")).toMatch(/no schema/);
  });
});

describe("control records", () => {
  it("applies Start, SetMetadata and Finish", () => {
    const writer = new WpilogWriter();
    const a = writer.start("/a", TYPE.double, 100, "unit=in");
    writer.write("/a", TYPE.double, 200, 1);
    writer.setMetadata(a, 250, "unit=mm");
    writer.finish(a, 300);
    writer.record(a, 400, new Uint8Array(8));
    const b = writer.start("/b", TYPE.boolean, 500, "", a);
    writer.write("/b", TYPE.boolean, 600, true);
    const parsed = parseWpilog(writer.toBytes());
    const entryA = parsed.byName.get("/a")!;
    expect(entryA.metadata).toBe("unit=mm");
    expect(entryA.start).toBe(100);
    expect(entryA.finish).toBe(300);
    expect(records(entryA)).toEqual([1]);
    expect(b).toBe(a);
    expect(records(parsed.byName.get("/b"))).toEqual([true]);
    expect(parsed.warnings.join(" ")).toMatch(/never started/);
  });

  it("tolerates a truncated tail", () => {
    const writer = new WpilogWriter();
    writer.write("/x", TYPE.double, 1, 1);
    writer.write("/x", TYPE.double, 2, 2);
    writer.write("/x", TYPE.double, 3, 3);
    const bytes = writer.toBytes();
    for (const cut of [1, 5, 11]) {
      const parsed = parseWpilog(bytes.subarray(0, bytes.length - cut));
      expect(parsed.truncated).toBe(true);
      expect(records(parsed.byName.get("/x"))).toEqual([1, 2]);
      expect(parsed.warnings.join(" ")).toMatch(/ends mid-record/);
    }
    expect(parseWpilog(bytes).truncated).toBe(false);
  });

  it("stops at a garbage tail without letting it stretch the time range", () => {
    const writer = new WpilogWriter();
    writer.write("/x", TYPE.double, 1_000_000, 1);
    writer.write("/x", TYPE.double, 2_000_000, 2);
    const good = [...writer.toBytes()];
    const far = [0x70, 1, 8, ...Array(8).fill(0xff), ...Array(8).fill(0)];
    const unknown = Array.from({ length: 10 }, () => [0x73, 0xff, 0xff, 0xff, 0x7f, 0, ...Array(8).fill(0xff)]).flat();
    for (const tail of [[...far, ...unknown], Array(64).fill(0)]) {
      const parsed = parseWpilog(Uint8Array.from([...good, ...tail]));
      expect(parsed.firstTimestamp).toBe(1_000_000);
      expect(parsed.lastTimestamp).toBe(2_000_000);
      expect(records(parsed.byName.get("/x"))).toEqual([1, 2]);
      expect(parsed.truncated).toBe(true);
      expect(parsed.warnings.join(" ")).toMatch(/unreadable from byte \d+/);
    }
  });
});

const GOLDEN_HEADER = "Crimson Oct 19 2026 12:00:00";
const GOLDEN_INIT_US = 1_250_000;
const GOLDEN_TICK_US = 1_270_000;
const GOLDEN_MOTION_US = 17_123_456;
const GOLDEN_POSE = { x: 23.5, y: -47.25, theta: 450.5 };
const GOLDEN_MOTOR = { position: 1234.5, velocity: -512.25, voltage: 11.75, current: 2.5, power: 9.5, torque: Number.NaN };
const GOLDEN_CONTROLLER = { leftX: -127, leftY: 127, rightX: 0, rightY: -1, buttons: 0x0909 };
const GOLDEN_MOTION = {
  kind: 1,
  x: 24,
  y: -48,
  theta: Number.NaN,
  timeout: 1500,
  maxSpeed: 127,
  minSpeed: 0,
  earlyExit: 0,
  forwards: true,
  async: true,
};
const GOLDEN_SOURCE = "src/autons/match/teambad.cpp:20";

const GOLDEN_RECORDS: Array<[string, string]> = [
  [
    "header",
    `57 50 49 4c 4f 47 00 01 1c 00 00 00 43 72 69 6d 73 6f 6e 20 4f 63 74 20 31 39 20 32 30 32 36 20 31 32 3a 30
     30 3a 30 30`,
  ],
  [
    "start 1 /.schema/struct:Pose",
    `20 00 31 d0 12 13 00 01 00 00 00 14 00 00 00 2f 2e 73 63 68 65 6d 61 2f 73 74 72 75 63 74 3a 50 6f 73 65 0c
     00 00 00 73 74 72 75 63 74 73 63 68 65 6d 61 00 00 00 00`,
  ],
  ["/.schema/struct:Pose", "20 01 1e d0 12 13 64 6f 75 62 6c 65 20 78 3b 64 6f 75 62 6c 65 20 79 3b 64 6f 75 62 6c 65 20 74 68 65 74 61"],
  [
    "start 2 /.schema/struct:Motor",
    `20 00 32 d0 12 13 00 02 00 00 00 15 00 00 00 2f 2e 73 63 68 65 6d 61 2f 73 74 72 75 63 74 3a 4d 6f 74 6f 72
     0c 00 00 00 73 74 72 75 63 74 73 63 68 65 6d 61 00 00 00 00`,
  ],
  [
    "/.schema/struct:Motor",
    `20 02 52 d0 12 13 66 6c 6f 61 74 20 70 6f 73 69 74 69 6f 6e 3b 66 6c 6f 61 74 20 76 65 6c 6f 63 69 74 79 3b
     66 6c 6f 61 74 20 76 6f 6c 74 61 67 65 3b 66 6c 6f 61 74 20 63 75 72 72 65 6e 74 3b 66 6c 6f 61 74 20 70 6f
     77 65 72 3b 66 6c 6f 61 74 20 74 6f 72 71 75 65`,
  ],
  [
    "start 7 /.schema/struct:Controller",
    `20 00 37 d0 12 13 00 07 00 00 00 1a 00 00 00 2f 2e 73 63 68 65 6d 61 2f 73 74 72 75 63 74 3a 43 6f 6e 74 72
     6f 6c 6c 65 72 0c 00 00 00 73 74 72 75 63 74 73 63 68 65 6d 61 00 00 00 00`,
  ],
  [
    "/.schema/struct:Controller",
    `20 07 3c d0 12 13 69 6e 74 38 20 6c 65 66 74 58 3b 69 6e 74 38 20 6c 65 66 74 59 3b 69 6e 74 38 20 72 69 67
     68 74 58 3b 69 6e 74 38 20 72 69 67 68 74 59 3b 75 69 6e 74 31 36 20 62 75 74 74 6f 6e 73`,
  ],
  [
    "start 9 /.schema/struct:Motion",
    `20 00 33 d0 12 13 00 09 00 00 00 16 00 00 00 2f 2e 73 63 68 65 6d 61 2f 73 74 72 75 63 74 3a 4d 6f 74 69 6f
     6e 0c 00 00 00 73 74 72 75 63 74 73 63 68 65 6d 61 00 00 00 00`,
  ],
  [
    "/.schema/struct:Motion",
    `20 09 7e d0 12 13 75 69 6e 74 38 20 6b 69 6e 64 3b 64 6f 75 62 6c 65 20 78 3b 64 6f 75 62 6c 65 20 79 3b 64
     6f 75 62 6c 65 20 74 68 65 74 61 3b 69 6e 74 33 32 20 74 69 6d 65 6f 75 74 3b 66 6c 6f 61 74 20 6d 61 78 53
     70 65 65 64 3b 66 6c 6f 61 74 20 6d 69 6e 53 70 65 65 64 3b 66 6c 6f 61 74 20 65 61 72 6c 79 45 78 69 74 3b
     62 6f 6f 6c 20 66 6f 72 77 61 72 64 73 3b 62 6f 6f 6c 20 61 73 79 6e 63`,
  ],
  [
    "start 21 /Motion/Command",
    `20 00 2d d0 12 13 00 15 00 00 00 0f 00 00 00 2f 4d 6f 74 69 6f 6e 2f 43 6f 6d 6d 61 6e 64 0d 00 00 00 73 74
     72 75 63 74 3a 4d 6f 74 69 6f 6e 00 00 00 00`,
  ],
  [
    "start 22 /Motion/Source",
    `20 00 25 d0 12 13 00 16 00 00 00 0e 00 00 00 2f 4d 6f 74 69 6f 6e 2f 53 6f 75 72 63 65 06 00 00 00 73 74 72
     69 6e 67 00 00 00 00`,
  ],
  [
    "start 23 /Motion/Id",
    `20 00 20 d0 12 13 00 17 00 00 00 0a 00 00 00 2f 4d 6f 74 69 6f 6e 2f 49 64 05 00 00 00 69 6e 74 36 34 00 00
     00 00`,
  ],
  [
    "start 30 /Odometry/Robot",
    `20 00 2b fc 60 13 00 1e 00 00 00 0f 00 00 00 2f 4f 64 6f 6d 65 74 72 79 2f 52 6f 62 6f 74 0b 00 00 00 73 74
     72 75 63 74 3a 50 6f 73 65 00 00 00 00`,
  ],
  ["/Odometry/Robot", "20 1e 18 f0 60 13 00 00 00 00 00 80 37 40 00 00 00 00 00 a0 47 c0 00 00 00 00 00 28 7c 40"],
  [
    "start 36 /Motors/LeftA",
    `20 00 2a 04 61 13 00 24 00 00 00 0d 00 00 00 2f 4d 6f 74 6f 72 73 2f 4c 65 66 74 41 0c 00 00 00 73 74 72 75
     63 74 3a 4d 6f 74 6f 72 00 00 00 00`,
  ],
  ["/Motors/LeftA", "20 24 18 f0 60 13 00 50 9a 44 00 10 00 c4 00 00 3c 41 00 00 20 40 00 00 18 41 00 00 c0 7f"],
  [
    "start 63 /Controller/Master",
    `20 00 34 18 61 13 00 3f 00 00 00 12 00 00 00 2f 43 6f 6e 74 72 6f 6c 6c 65 72 2f 4d 61 73 74 65 72 11 00 00
     00 73 74 72 75 63 74 3a 43 6f 6e 74 72 6f 6c 6c 65 72 00 00 00 00`,
  ],
  ["/Controller/Master", "20 3f 06 f0 60 13 81 7f 00 ff 09 09"],
  ["/Motion/Id", "30 17 08 80 48 05 01 01 00 00 00 00 00 00 00"],
  [
    "/Motion/Source",
    `30 16 1f 80 48 05 01 73 72 63 2f 61 75 74 6f 6e 73 2f 6d 61 74 63 68 2f 74 65 61 6d 62 61 64 2e 63 70 70 3a
     32 30`,
  ],
  [
    "/Motion/Command",
    `30 15 2b 80 48 05 01 01 00 00 00 00 00 00 38 40 00 00 00 00 00 00 48 c0 00 00 00 00 00 00 f8 7f dc 05 00 00
     00 00 fe 42 00 00 00 00 00 00 00 00 01 01`,
  ],
];

const hexBytes = (text: string) => Uint8Array.from(text.trim().split(/\s+/), (byte) => Number.parseInt(byte, 16));
const GOLDEN = Uint8Array.from(GOLDEN_RECORDS.flatMap(([, text]) => Array.from(hexBytes(text))));

describe("golden bytes from Crimson's C++ encoder", () => {
  it("decodes the header, Start records and every struct exactly", () => {
    const parsed = parseWpilog(GOLDEN);
    expect(parsed.version).toBe(0x0100);
    expect(parsed.extraHeader).toBe(GOLDEN_HEADER);
    expect(parsed.truncated).toBe(false);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.recordCount).toBe(GOLDEN_RECORDS.length - 1);
    expect(parsed.firstTimestamp).toBe(GOLDEN_INIT_US);
    expect(parsed.lastTimestamp).toBe(GOLDEN_MOTION_US);
    expect(parsed.entries.map((entry) => [entry.id, entry.name, entry.type, entry.metadata])).toEqual([
      [1, schemaKey("Pose"), TYPE.schema, ""],
      [2, schemaKey("Motor"), TYPE.schema, ""],
      [7, schemaKey("Controller"), TYPE.schema, ""],
      [9, schemaKey("Motion"), TYPE.schema, ""],
      [21, KEY.motionCommand, structType("Motion"), ""],
      [22, KEY.motionSource, TYPE.string, ""],
      [23, KEY.motionId, TYPE.int64, ""],
      [30, KEY.robotPose, structType("Pose"), ""],
      [36, "/Motors/LeftA", structType("Motor"), ""],
      [63, KEY.controller, structType("Controller"), ""],
    ]);
    expect([...parsed.schemas].map(([name, schema]) => [name, schema.schema, schema.size])).toEqual([
      ["Pose", STRUCT_SCHEMAS.Pose, 24],
      ["Motor", STRUCT_SCHEMAS.Motor, 24],
      ["Controller", STRUCT_SCHEMAS.Controller, 6],
      ["Motion", STRUCT_SCHEMAS.Motion, 43],
    ]);

    const robot = parsed.byName.get(KEY.robotPose)!;
    expect(robot.start).toBe(GOLDEN_TICK_US + 12);
    expect(robot.records).toEqual([{ timestamp: GOLDEN_TICK_US, value: GOLDEN_POSE }]);

    const motor = parsed.byName.get("/Motors/LeftA")!.records;
    expect(motor.map((r) => r.timestamp)).toEqual([GOLDEN_TICK_US]);
    const { torque, ...motorFinite } = motor[0].value as StructValue;
    expect(motorFinite).toEqual({ position: 1234.5, velocity: -512.25, voltage: 11.75, current: 2.5, power: 9.5 });
    expect(Number.isNaN(torque)).toBe(true);

    const controller = parsed.byName.get(KEY.controller)!.records;
    expect(controller).toEqual([{ timestamp: GOLDEN_TICK_US, value: GOLDEN_CONTROLLER }]);
    const buttons = (controller[0].value as StructValue).buttons as number;
    expect(CONTROLLER_BUTTONS.filter((_, bit) => buttons & (1 << bit))).toEqual(["L1", "R2", "X", "A"]);

    expect(records(parsed.byName.get(KEY.motionId))).toEqual([1]);
    expect(records(parsed.byName.get(KEY.motionSource))).toEqual([GOLDEN_SOURCE]);
    const command = parsed.byName.get(KEY.motionCommand)!.records;
    expect(command.map((r) => r.timestamp)).toEqual([GOLDEN_MOTION_US]);
    const { theta, ...motion } = command[0].value as StructValue;
    expect({ ...motion, theta: 0 }).toEqual({ ...GOLDEN_MOTION, theta: 0 });
    expect(Number.isNaN(theta)).toBe(true);
  });

  it("pairs the golden motion with its id and source line", () => {
    const log = buildLog(parseWpilog(GOLDEN));
    expect(log.t0).toBe(GOLDEN_INIT_US);
    expect(log.poses.robot.t[0]).toBeCloseTo((GOLDEN_TICK_US - GOLDEN_INIT_US) / 1e6, 9);
    expect(Array.from(log.poses.robot.theta)).toEqual([450.5]);
    expect(log.motions).toHaveLength(1);
    const motion = log.motions[0];
    expect(motion.t).toBeCloseTo((GOLDEN_MOTION_US - GOLDEN_INIT_US) / 1e6, 9);
    expect([motion.id, motion.kindName, motion.file, motion.line]).toEqual([1, "moveToPoint", "src/autons/match/teambad.cpp", 20]);
    expect([motion.target.x, motion.target.y, Number.isNaN(motion.target.theta)]).toEqual([24, -48, true]);
    expect([motion.timeoutMs, motion.maxSpeed, motion.minSpeed, motion.earlyExit, motion.forwards, motion.async]).toEqual([1500, 127, 0, 0, true, true]);
    expect(log.channels.get("Controller/Master/buttons")?.discrete).toBe(true);
  });

  it("is reproduced byte for byte by the TypeScript writer", () => {
    const schemas = new Map<string, StructSchema>();
    const writer = new WpilogWriter(GOLDEN_HEADER);
    for (const [name, id] of [["Pose", 1], ["Motor", 2], ["Controller", 7], ["Motion", 9]] as const) {
      schemas.set(name, parseStructSchema(name, STRUCT_SCHEMAS[name]));
      writer.start(schemaKey(name), TYPE.schema, GOLDEN_INIT_US, "", id);
      writer.record(id, GOLDEN_INIT_US, encodeValue(TYPE.schema, STRUCT_SCHEMAS[name]));
    }
    writer.start(KEY.motionCommand, structType("Motion"), GOLDEN_INIT_US, "", 21);
    writer.start(KEY.motionSource, TYPE.string, GOLDEN_INIT_US, "", 22);
    writer.start(KEY.motionId, TYPE.int64, GOLDEN_INIT_US, "", 23);
    writer.start(KEY.robotPose, structType("Pose"), GOLDEN_TICK_US + 12, "", 30);
    writer.record(30, GOLDEN_TICK_US, encodeValue(structType("Pose"), GOLDEN_POSE, schemas));
    writer.start("/Motors/LeftA", structType("Motor"), GOLDEN_TICK_US + 20, "", 36);
    writer.record(36, GOLDEN_TICK_US, encodeValue(structType("Motor"), GOLDEN_MOTOR, schemas));
    writer.start(KEY.controller, structType("Controller"), GOLDEN_TICK_US + 40, "", 63);
    writer.record(63, GOLDEN_TICK_US, encodeValue(structType("Controller"), GOLDEN_CONTROLLER, schemas));
    writer.record(23, GOLDEN_MOTION_US, encodeValue(TYPE.int64, 1));
    writer.record(22, GOLDEN_MOTION_US, encodeValue(TYPE.string, GOLDEN_SOURCE));
    writer.record(21, GOLDEN_MOTION_US, encodeValue(structType("Motion"), GOLDEN_MOTION, schemas));
    expect(Array.from(writer.toBytes())).toEqual(Array.from(GOLDEN));
  });
});
