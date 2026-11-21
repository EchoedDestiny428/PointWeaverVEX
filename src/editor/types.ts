/**
 * Autons and paths, as saved in the app folder (Documents/PointWeaver).
 *
 * Coordinates are Crimson's field frame (include/constants/field_constants.hpp): (0, 0) is the corner on blue's
 * right as they face red, x and y run 0 to 144 in, +X points from the blue wall to the red wall and +Y to blue's
 * left. Heading 0 faces red (+X) and turns clockwise, so heading 90 faces -Y. Inches and degrees throughout.
 */

/** What a point does with its heading. */
export type HeadingAction =
  /** chassis.moveToPose: arrive already facing the heading */
  | 'pose'
  /** chassis.moveToPoint, then chassis.turnToHeading in place */
  | 'turn'
  /** chassis.moveToPoint, then chassis.donut (orbit turn) to the heading */
  | 'donut';

export type TurnDirection = 'auto' | 'cw' | 'ccw';

/** LemLib settings. Unset (null/undefined) = the path's default, then LemLib's. */
export interface MoveParams {
  /** ms */
  timeout?: number | null;
  /** drive backwards into the point (LemLib forwards = false) */
  reverse?: boolean | null;
  /** 0-127 */
  maxSpeed?: number | null;
  /** 0-127 */
  minSpeed?: number | null;
  /** in */
  earlyExitRange?: number | null;
  /** ms, for the turn or donut after arriving */
  turnTimeout?: number | null;
  turnDirection?: TurnDirection | null;
  /** donut: 0-127 */
  donutFast?: number | null;
  /** donut: 0-127 */
  donutSlow?: number | null;
  /** donut: orbit a point behind the robot (forwards = false). Unset = the move's own direction. */
  donutBehind?: boolean | null;
  /** slow down for this last part of the move (0-1): waitUntil, cancelMotion, then the same move at slowSpeed */
  slowdown?: number | null;
  /** 0-127, max speed for the slow part */
  slowSpeed?: number | null;
  /** at a goal: chassis.setPoseFromGoal once there (unset = on) */
  goalReset?: boolean | null;
}

export interface PathPoint {
  x: number;
  y: number;
  /** heading target (deg); null = translation only (moveToPoint). On point 0 it's the start heading. */
  theta?: number | null;
  /** what to do with theta; unset = 'pose'. A donut needs a goal. */
  action?: HeadingAction | null;
  /** snapped to a goal, pin or loader (src/editor/targets.ts); x/y are then that spot */
  target?: string | null;
  params?: MoveParams | null;
}

export interface PathDefinition {
  /** point 0 is where the path starts; the robot drives to points 1..n */
  points: PathPoint[];
  /** defaults for every point */
  params: MoveParams | null;
  /** chassis.setPose at point 0 when the path starts (the first path of an auton always sets the start pose) */
  resetPose?: boolean | null;
}

export interface AutonStep {
  /** a path's name */
  path: string;
  /** use the path turned 180 degrees about the field centre (the other half of the field) */
  rotate?: boolean | null;
}

export interface AutonDefinition {
  steps: AutonStep[];
  /** 60 s skills instead of a 15 s match auton */
  skills?: boolean | null;
}

export interface Library {
  paths: Record<string, PathDefinition>;
  autons: Record<string, AutonDefinition>;
}

export const FIELD_SIZE = 144;
export const NAME_RE = /^[A-Za-z0-9_\- ]+$/;

/** What LemLib (and Crimson's donut) use when nothing is set. */
export const DEFAULTS = {
  timeout: 2000,
  turnTimeout: 1000,
  maxSpeed: 127,
  minSpeed: 0,
  earlyExitRange: 0,
  donutFast: 100,
  donutSlow: 75,
  slowSpeed: 50,
} as const;
