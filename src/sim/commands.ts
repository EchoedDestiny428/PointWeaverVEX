import type { TurnDirection } from "../core/angle";
import { headingTo } from "../core/geometry";
import type { Motion } from "./motions/types";
import { MoveToPoint } from "./motions/moveToPoint";
import { MoveToPose } from "./motions/moveToPose";
import { Donut, Swing, TurnToHeading, TurnToPoint } from "./motions/turn";
import type { LockedSide, TurnParams } from "./motions/turn";

export interface ArgReader {
  number(index: number, name: string): number;
  text(index: number): string | undefined;
  paramNumber(key: string, fallback: number): number;
  paramBool(key: string, fallback: boolean): boolean;
  paramDirection(key: string): TurnDirection;
}

export interface MotionCommand {
  method: string;
  paramsIndex: number;
  asyncIndex: number;
  create(args: ArgReader): Motion;
}

function turnParams(args: ArgReader): TurnParams {
  return {
    direction: args.paramDirection("direction"),
    maxSpeed: args.paramNumber("maxSpeed", 127),
    minSpeed: args.paramNumber("minSpeed", 0),
    earlyExitRange: args.paramNumber("earlyExitRange", 0),
  };
}

function lockedSide(args: ArgReader, index: number): LockedSide {
  return /RIGHT/i.test(args.text(index) ?? "") ? "right" : "left";
}

export const MOTION_COMMANDS: MotionCommand[] = [
  {
    method: "moveToPoint",
    paramsIndex: 3,
    asyncIndex: 4,
    create: (args) =>
      new MoveToPoint({ x: args.number(0, "x"), y: args.number(1, "y") }, args.number(2, "timeout"), {
        forwards: args.paramBool("forwards", true),
        maxSpeed: args.paramNumber("maxSpeed", 127),
        minSpeed: args.paramNumber("minSpeed", 0),
        earlyExitRange: args.paramNumber("earlyExitRange", 0),
      }),
  },
  {
    method: "moveToPose",
    paramsIndex: 4,
    asyncIndex: 5,
    create: (args) =>
      new MoveToPose(
        { x: args.number(0, "x"), y: args.number(1, "y"), theta: args.number(2, "theta") },
        args.number(3, "timeout"),
        {
          forwards: args.paramBool("forwards", true),
          lead: args.paramNumber("lead", 0.6),
          maxSpeed: args.paramNumber("maxSpeed", 127),
          minSpeed: args.paramNumber("minSpeed", 0),
          earlyExitRange: args.paramNumber("earlyExitRange", 0),
        },
      ),
  },
  {
    method: "turnToHeading",
    paramsIndex: 2,
    asyncIndex: 3,
    create: (args) => new TurnToHeading(args.number(0, "theta"), args.number(1, "timeout"), turnParams(args)),
  },
  {
    method: "turnToPoint",
    paramsIndex: 3,
    asyncIndex: 4,
    create: (args) =>
      new TurnToPoint(
        { x: args.number(0, "x"), y: args.number(1, "y") },
        args.paramBool("forwards", true),
        args.number(2, "timeout"),
        turnParams(args),
      ),
  },
  {
    method: "swingToHeading",
    paramsIndex: 3,
    asyncIndex: 4,
    create: (args) => {
      const heading = args.number(0, "theta");
      return new Swing(() => heading, lockedSide(args, 1), args.number(2, "timeout"), turnParams(args));
    },
  },
  {
    method: "swingToPoint",
    paramsIndex: 4,
    asyncIndex: 5,
    create: (args) => {
      const point = { x: args.number(0, "x"), y: args.number(1, "y") };
      const offset = args.paramBool("forwards", true) ? 0 : 180;
      return new Swing(
        (state) => headingTo(state.pose, point) + offset,
        lockedSide(args, 2),
        args.number(3, "timeout"),
        turnParams(args),
      );
    },
  },
  {
    method: "donut",
    paramsIndex: 2,
    asyncIndex: 3,
    create: (args) =>
      new Donut(args.number(0, "theta"), args.number(1, "timeout"), {
        direction: args.paramDirection("direction"),
        forwards: args.paramBool("forwards", true),
        // The robot's DonutParams defaults (include/motion/chassis.hpp).
        fastSpeed: args.paramNumber("fastSpeed", 127),
        slowSpeed: args.paramNumber("slowSpeed", 15),
        earlyExitRange: args.paramNumber("earlyExitRange", 0),
      }),
  },
];

export function findMotionCommand(method: string): MotionCommand | undefined {
  return MOTION_COMMANDS.find((command) => command.method === method);
}
