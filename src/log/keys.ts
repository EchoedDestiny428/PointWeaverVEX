export const STRUCT_SCHEMAS = {
  Pose: "double x;double y;double theta",
  Motor: "float position;float velocity;float voltage;float current;float power;float torque",
  MotorHealth: "float temperature;float efficiency;uint32 faults;uint32 flags;bool overTemp;bool overCurrent",
  Imu: "double heading;double rotation;float pitch;float roll;float yaw;float gyroX;float gyroY;float gyroZ;float accelX;float accelY;float accelZ;uint8 status",
  Wheel: "int32 position;int32 velocity;int32 angle",
  Battery: "float voltage;float current;float capacity;float temperature",
  Controller: "int8 leftX;int8 leftY;int8 rightX;int8 rightY;uint16 buttons",
  Mechanism: "double target;double position;bool settled",
  Motion: "uint8 kind;double x;double y;double theta;int32 timeout;float maxSpeed;float minSpeed;float earlyExit;bool forwards;bool async",
} as const;

export type StructName = keyof typeof STRUCT_SCHEMAS;

export const TYPE = {
  boolean: "boolean",
  int64: "int64",
  double: "double",
  string: "string",
  schema: "structschema",
} as const;

export const SCHEMA_PREFIX = "/.schema/";
export const METADATA_PREFIX = "/Metadata/";
export const structType = (name: StructName | string): string => `struct:${name}`;
export const schemaKey = (name: StructName | string): string => `${SCHEMA_PREFIX}${structType(name)}`;

export const KEY = {
  robotPose: "/Odometry/Robot",
  rawPose: "/Odometry/Raw",
  resetFrom: "/Odometry/ResetFrom",
  resetTo: "/Odometry/ResetTo",
  resetSource: "/Odometry/ResetSource",
  verticalWheel: "/Odometry/VerticalWheel",
  horizontalWheel: "/Odometry/HorizontalWheel",
  imu: "/Odometry/Imu",
  motionCommand: "/Motion/Command",
  motionSource: "/Motion/Source",
  motionId: "/Motion/Id",
  motionActive: "/Motion/Active",
  elevator: "/Mechanisms/Elevator",
  pivot: "/Mechanisms/Pivot",
  elevatorManual: "/Mechanisms/ElevatorManual",
  clawPower: "/Mechanisms/ClawPower",
  macroMode: "/Mechanisms/MacroMode",
  tilted: "/Mechanisms/Tilted",
  offsetOn: "/Mechanisms/OffsetOn",
  intakeLift: "/Pneumatics/IntakeLift",
  pullToggle: "/Pneumatics/PullToggle",
  visionConnected: "/Vision/Connected",
  visionTagCount: "/Vision/TagCount",
  visionPrimaryTag: "/Vision/PrimaryTag",
  visionTx: "/Vision/Tx",
  visionTy: "/Vision/Ty",
  visionPose: "/Vision/Pose",
  battery: "/System/Battery",
  controller: "/Controller/Master",
  controllerConnected: "/Controller/Connected",
  controllerBattery: "/Controller/Battery",
  enabled: "/DriverStation/Enabled",
  autonomous: "/DriverStation/Autonomous",
  dsConnected: "/DriverStation/Connected",
  fieldControl: "/DriverStation/FieldControl",
  autonSelected: "/Auton/Selected",
  autonRunning: "/Auton/Running",
  loggerDropped: "/Logger/Dropped",
  loggerBytes: "/Logger/Bytes",
  loggerOverruns: "/Logger/LoopOverruns",
} as const;

export const MOTORS = ["LeftA", "LeftB", "RightA", "RightB", "ElevatorA", "ElevatorB", "Intake", "Claw", "Pivot"] as const;
export type MotorName = (typeof MOTORS)[number];
export const LEFT_DRIVE: MotorName[] = ["LeftA", "LeftB"];
export const RIGHT_DRIVE: MotorName[] = ["RightA", "RightB"];
export const motorKey = (name: MotorName | string): string => `/Motors/${name}`;
export const motorHealthKey = (name: MotorName | string): string => `/Motors/${name}/Health`;

export const KEY_TYPES: Record<string, string> = {
  [KEY.robotPose]: structType("Pose"),
  [KEY.rawPose]: structType("Pose"),
  [KEY.resetFrom]: structType("Pose"),
  [KEY.resetTo]: structType("Pose"),
  [KEY.resetSource]: TYPE.string,
  [KEY.verticalWheel]: structType("Wheel"),
  [KEY.horizontalWheel]: structType("Wheel"),
  [KEY.imu]: structType("Imu"),
  [KEY.motionCommand]: structType("Motion"),
  [KEY.motionSource]: TYPE.string,
  [KEY.motionId]: TYPE.int64,
  [KEY.motionActive]: TYPE.boolean,
  [KEY.elevator]: structType("Mechanism"),
  [KEY.pivot]: structType("Mechanism"),
  [KEY.elevatorManual]: TYPE.double,
  [KEY.clawPower]: TYPE.double,
  [KEY.macroMode]: TYPE.string,
  [KEY.tilted]: TYPE.boolean,
  [KEY.offsetOn]: TYPE.boolean,
  [KEY.intakeLift]: TYPE.boolean,
  [KEY.pullToggle]: TYPE.boolean,
  [KEY.visionConnected]: TYPE.boolean,
  [KEY.visionTagCount]: TYPE.int64,
  [KEY.visionPrimaryTag]: TYPE.int64,
  [KEY.visionTx]: TYPE.double,
  [KEY.visionTy]: TYPE.double,
  [KEY.visionPose]: structType("Pose"),
  [KEY.battery]: structType("Battery"),
  [KEY.controller]: structType("Controller"),
  [KEY.controllerConnected]: TYPE.boolean,
  [KEY.controllerBattery]: TYPE.int64,
  [KEY.enabled]: TYPE.boolean,
  [KEY.autonomous]: TYPE.boolean,
  [KEY.dsConnected]: TYPE.boolean,
  [KEY.fieldControl]: TYPE.boolean,
  [KEY.autonSelected]: TYPE.string,
  [KEY.autonRunning]: TYPE.boolean,
  [KEY.loggerDropped]: TYPE.int64,
  [KEY.loggerBytes]: TYPE.int64,
  [KEY.loggerOverruns]: TYPE.int64,
  ...Object.fromEntries(MOTORS.flatMap((name) => [
    [motorKey(name), structType("Motor")],
    [motorHealthKey(name), structType("MotorHealth")],
  ])),
};

export const EVENT_KEYS: ReadonlySet<string> = new Set([KEY.motionCommand, KEY.resetFrom, KEY.resetTo]);

export const MOTION_KINDS = {
  1: "moveToPoint",
  2: "moveToPose",
  3: "turnToPoint",
  4: "turnToHeading",
  5: "swingToPoint",
  6: "swingToHeading",
  7: "donut",
} as const;
export type MotionKindId = keyof typeof MOTION_KINDS;
export type MotionKindName = (typeof MOTION_KINDS)[MotionKindId];

export const CONTROLLER_BUTTONS = ["L1", "L2", "R1", "R2", "UP", "DOWN", "LEFT", "RIGHT", "X", "B", "Y", "A"] as const;

export const METADATA = {
  build: "Build",
  ports: "Ports",
  drivetrain: "Drivetrain",
  odometry: "Odometry",
  linear: "LinearPID",
  angular: "AngularPID",
} as const;
