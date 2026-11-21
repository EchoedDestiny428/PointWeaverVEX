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
}

export const ROBOT_FIELDS: Array<{ key: keyof RobotConfig; label: string; unit: string; min: number; max: number; step: number }> = [
  { key: "width", label: "Width", unit: "in", min: 6, max: 24, step: 0.5 },
  { key: "length", label: "Length", unit: "in", min: 6, max: 24, step: 0.5 },
  { key: "trackWidth", label: "Track width", unit: "in", min: 4, max: 24, step: 0.25 },
  { key: "maxSpeed", label: "Top speed", unit: "in/s", min: 10, max: 120, step: 1 },
  { key: "acceleration", label: "Acceleration", unit: "in/s²", min: 20, max: 600, step: 10 },
  { key: "maxTurnRate", label: "Turn rate", unit: "°/s", min: 60, max: 1200, step: 10 },
  { key: "turnAcceleration", label: "Turn acceleration", unit: "°/s²", min: 200, max: 6000, step: 50 },
  { key: "clawOffset", label: "Claw offset (robot centre to claw centre)", unit: "in", min: 0, max: 15, step: 0.1 },
  { key: "goalOffset", label: "Goal offset (robot centre to the centre of the goal it's on)", unit: "in", min: 0, max: 15, step: 0.1 },
];
