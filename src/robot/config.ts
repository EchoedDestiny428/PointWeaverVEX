export interface RobotConfig {
  width: number;
  length: number;
  trackWidth: number;
  maxSpeed: number;
  acceleration: number;
  /** how fast it slows down (in/s^2); 0 uses acceleration. Braking is gentler than launching on a robot that tips */
  deceleration: number;
  maxTurnRate: number;
  turnAcceleration: number;
  /** robot centre to the claw's centre, forward (in) */
  clawOffset: number;
  /** robot centre to the centre of the goal it's on (in): where a goal reset puts the robot, and the donut's pivot */
  goalOffset: number;
  /**
   * How fast a donut turns (deg/s) at fast 100 / slow 75; other speeds scale it by (fast + slow) / 175. (A reference
   * point only: the default donut is now 127 / 15, which turns at 142 / 175 of this.)
   * Measured, not worked out: the robot drags the goal and its wheels slide sideways, so it's far slower than a turn.
   */
  donutRate: number;
  /** ms added to every estimated timeout (after the extra quarter) */
  timeoutLeeway: number;
  /**
   * LemLib's horizontalDrift (lemlib::Drivetrain in the robot's robotconfig.cpp: 2 for omni wheels, 8 for traction).
   * moveToPose caps its forward power on a curve to sqrt(horizontalDrift * radius * 9.8) out of 127, so a tight curve
   * is driven slowly. 0 turns the cap off.
   */
  horizontalDrift: number;
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
  /**
   * The lateral PID's kP (lemlib::ControllerSettings linear_controller in robotconfig.cpp): its output is kP x the
   * distance left (out of 127), so a chained move (one with a minSpeed of its own) only slows from 127 / kP in out.
   */
  linearKP: number;
  /**
   * Early exits, written into the code so a stop doesn't wait out LemLib's exit conditions (the real robot rarely
   * settles inside them, so every stop ran to its timeout). 0 turns that one off.
   * exitMove: a move to a point, pin or loader ends this far (in) before it.
   */
  exitMove: number;
  /** a move into a goal ends when the robot's centre is this far (in) from the goal's centre: goalOffset is touching */
  exitGoal: number;
  /** a turn ends this close (deg) to its heading */
  exitTurn: number;
  /** a donut ends this close (deg) to its heading */
  exitDonut: number;
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
  /** the code's early exits, shown together */
  early?: boolean;
}> = [
  { key: "width", label: "Width", unit: "in", min: 6, max: 24, step: 0.5 },
  { key: "length", label: "Length", unit: "in", min: 6, max: 24, step: 0.5 },
  { key: "trackWidth", label: "Track width", unit: "in", min: 4, max: 24, step: 0.25 },
  { key: "maxSpeed", label: "Top speed", unit: "in/s", min: 10, max: 120, step: 1 },
  { key: "acceleration", label: "Acceleration", unit: "in/s²", min: 20, max: 600, step: 10 },
  { key: "deceleration", label: "Braking (slowing down; 0 = same as acceleration)", unit: "in/s²", min: 0, max: 600, step: 5 },
  { key: "maxTurnRate", label: "Turn rate", unit: "°/s", min: 60, max: 1200, step: 10 },
  { key: "turnAcceleration", label: "Turn acceleration", unit: "°/s²", min: 200, max: 6000, step: 50 },
  { key: "clawOffset", label: "Claw offset (robot centre to claw centre)", unit: "in", min: 0, max: 15, step: 0.1 },
  { key: "goalOffset", label: "Goal offset (robot centre to the centre of the goal it's on)", unit: "in", min: 0, max: 15, step: 0.1 },
  { key: "timeoutLeeway", label: "Estimated timeout leeway (added to every estimate)", unit: "ms", min: 0, max: 3000, step: 50 },
  { key: "horizontalDrift", label: "LemLib horizontalDrift (robotconfig.cpp): moveToPose slows on curves to sqrt(drift x radius x 9.8) / 127. 2 for omni wheels, 8 for traction, 0 off", unit: "", min: 0, max: 20, step: 0.5 },
  { key: "donutRate", label: "Donut turn rate at fast 100 / slow 75 (scales with fast + slow). Time a real donut: about 1 s for 90 deg is 100", unit: "°/s", min: 10, max: 720, step: 5 },
  { key: "linearSmallError", label: "Move small exit: within this far (linear_controller smallError)", unit: "in", min: 0.05, max: 6, step: 0.05, exit: true },
  { key: "linearSmallTime", label: "...for this long (linear_controller smallErrorTimeout)", unit: "ms", min: 0, max: 2000, step: 10, exit: true },
  { key: "linearLargeError", label: "Move large exit: within this far (linear_controller largeError)", unit: "in", min: 0.1, max: 12, step: 0.1, exit: true },
  { key: "linearLargeTime", label: "...for this long (linear_controller largeErrorTimeout)", unit: "ms", min: 0, max: 5000, step: 50, exit: true },
  { key: "angularSmallError", label: "Turn small exit: within this many degrees (angular_controller smallError)", unit: "°", min: 0.1, max: 20, step: 0.5, exit: true },
  { key: "angularSmallTime", label: "...for this long (angular_controller smallErrorTimeout)", unit: "ms", min: 0, max: 2000, step: 10, exit: true },
  { key: "angularLargeError", label: "Turn large exit: within this many degrees (angular_controller largeError)", unit: "°", min: 0.1, max: 45, step: 0.5, exit: true },
  { key: "angularLargeTime", label: "...for this long (angular_controller largeErrorTimeout)", unit: "ms", min: 0, max: 5000, step: 50, exit: true },
  { key: "linearKP", label: "Move kP (linear_controller kP): a chained move (its own minSpeed) slows down from 127 / kP in out", unit: "", min: 0.5, max: 60, step: 0.5, exit: true },
  { key: "exitMove", label: "A stop at a point, pin or loader ends this far before it (minSpeed 1 + earlyExitRange; a straight moveToPose is written as a moveToPoint to end early). 0 waits for LemLib's exit", unit: "in", min: 0, max: 6, step: 0.25, early: true },
  { key: "exitGoal", label: "A move into a goal ends when the robot's centre is this far from the goal's centre: more than the goal offset (touching), with room for the field. Up to the goal offset waits for the timeout", unit: "in", min: 0, max: 15, step: 0.25, early: true },
  { key: "exitTurn", label: "A turn ends this close to its heading (minSpeed 1 + earlyExitRange). 0 waits for LemLib's exit", unit: "°", min: 0, max: 20, step: 0.5, early: true },
  { key: "exitDonut", label: "A donut ends this close to its heading (earlyExitRange). 0 waits for LemLib's exit", unit: "°", min: 0, max: 30, step: 0.5, early: true },
];
