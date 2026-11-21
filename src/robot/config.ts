export interface RobotConfig {
  width: number;
  length: number;
  trackWidth: number;
  maxSpeed: number;
  acceleration: number;
  maxTurnRate: number;
  turnAcceleration: number;
  /** robot centre to the claw's centre, forward (in) */
  clawOffset: number;
  /** robot centre to the centre of the goal it's on (in): where a goal reset puts the robot, and the donut's pivot */
  goalOffset: number;
  /**
   * How fast a donut turns (deg/s) at the default fast 100 / slow 75; other speeds scale it by (fast + slow) / 175.
   * Measured, not worked out: the robot drags the goal and its wheels slide sideways, so it's far slower than a turn.
   */
  donutRate: number;
  /** ms added to every estimated timeout (after the extra quarter) */
  timeoutLeeway: number;
  /**
   * LemLib's exit conditions (lemlib::ControllerSettings smallError / smallErrorTimeout / largeError /
   * largeErrorTimeout in the robot's robotconfig.cpp): a move or turn is done once its error has stayed within the
   * small range for the small time, or within the large range for the large time.
   */
  linearSmallError: number;
  linearSmallTime: number;
  linearLargeError: number;
  linearLargeTime: number;
  angularSmallError: number;
  angularSmallTime: number;
  angularLargeError: number;
  angularLargeTime: number;
}

export const ROBOT_FIELDS: Array<{
  key: keyof RobotConfig;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** LemLib exit ranges, shown together */
  exit?: boolean;
}> = [
  { key: "width", label: "Width", unit: "in", min: 6, max: 24, step: 0.5 },
  { key: "length", label: "Length", unit: "in", min: 6, max: 24, step: 0.5 },
  { key: "trackWidth", label: "Track width", unit: "in", min: 4, max: 24, step: 0.25 },
  { key: "maxSpeed", label: "Top speed", unit: "in/s", min: 10, max: 120, step: 1 },
  { key: "acceleration", label: "Acceleration", unit: "in/s²", min: 20, max: 600, step: 10 },
  { key: "maxTurnRate", label: "Turn rate", unit: "°/s", min: 60, max: 1200, step: 10 },
  { key: "turnAcceleration", label: "Turn acceleration", unit: "°/s²", min: 200, max: 6000, step: 50 },
  { key: "clawOffset", label: "Claw offset (robot centre to claw centre)", unit: "in", min: 0, max: 15, step: 0.1 },
  { key: "goalOffset", label: "Goal offset (robot centre to the centre of the goal it's on)", unit: "in", min: 0, max: 15, step: 0.1 },
  { key: "timeoutLeeway", label: "Estimated timeout leeway (added to every estimate)", unit: "ms", min: 0, max: 3000, step: 50 },
  { key: "donutRate", label: "Donut turn rate at fast 100 / slow 75 (scales with fast + slow). Time a real donut: about 1 s for 90 deg is 100", unit: "°/s", min: 10, max: 720, step: 5 },
  { key: "linearSmallError", label: "Move small exit: within this far (linear_controller smallError)", unit: "in", min: 0.05, max: 6, step: 0.05, exit: true },
  { key: "linearSmallTime", label: "...for this long (linear_controller smallErrorTimeout)", unit: "ms", min: 0, max: 2000, step: 10, exit: true },
  { key: "linearLargeError", label: "Move large exit: within this far (linear_controller largeError)", unit: "in", min: 0.1, max: 12, step: 0.1, exit: true },
  { key: "linearLargeTime", label: "...for this long (linear_controller largeErrorTimeout)", unit: "ms", min: 0, max: 5000, step: 50, exit: true },
  { key: "angularSmallError", label: "Turn small exit: within this many degrees (angular_controller smallError)", unit: "°", min: 0.1, max: 20, step: 0.5, exit: true },
  { key: "angularSmallTime", label: "...for this long (angular_controller smallErrorTimeout)", unit: "ms", min: 0, max: 2000, step: 10, exit: true },
  { key: "angularLargeError", label: "Turn large exit: within this many degrees (angular_controller largeError)", unit: "°", min: 0.1, max: 45, step: 0.5, exit: true },
  { key: "angularLargeTime", label: "...for this long (angular_controller largeErrorTimeout)", unit: "ms", min: 0, max: 5000, step: 50, exit: true },
];
