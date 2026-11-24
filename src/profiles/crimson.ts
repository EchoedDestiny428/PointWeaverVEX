import type { TeamProfile } from "./types";

export const CRIMSON_PROFILE: TeamProfile = {
  id: "crimson",
  name: "Crimson",
  robot: {
    width: 15,
    length: 15,
    // measured on the new bot (2026-11-22): top speed from the motors, acceleration from a launch (braking tipped
    // the robot), turn rate from the IMU both ways; track width is robotconfig.cpp's kTrackWidthIn (28.5 cm)
    trackWidth: 11.2,
    maxSpeed: 63,
    acceleration: 250,
    deceleration: 84, // about 0.75 s from top speed to a stop (the team's estimate, 2026-11-23; braking harder tips the robot)
    maxTurnRate: 660,
    turnAcceleration: 1950,
    clawOffset: 6.3, // 16 cm
    goalOffset: 7.5,
    donutRate: 100, // measured: about 1 s for a 90 deg donut
    timeoutLeeway: 100,
    horizontalDrift: 2, // robotconfig.cpp kHorizontalDrift (omni wheels)
    // lemlib::ControllerSettings in robotconfig.cpp (prelude-to-chaos): linear_controller(..., 0.2, 100, 1, 500, ...),
    // angular_controller(..., 1, 50, 3, 300, ...)
    linearSmallError: 0.2,
    linearSmallTime: 100,
    linearLargeError: 1,
    linearLargeTime: 500,
    angularSmallError: 1,
    angularSmallTime: 50,
    angularLargeError: 3,
    angularLargeTime: 300,
    linearKP: 9.5, // linear_controller(9.5, 0, 12, ...)
    // early exits in the code (2026-11-24): on the field every stop ran to its timeout waiting for the exits above
    exitMove: 1,
    // 1.5 in before the robot touches the goal (goalOffset 7.5, confirmed by the team 2026-11-24) and it coasts the
    // rest: room for a goal a bit off its spot and for odometry drift since the last reset
    exitGoal: 9,
    exitTurn: 1, // 2 and 3 were 0.3 s faster over skills-148, but left the claw up to 0.7 in to the side of a wall pin
    exitDonut: 1.5,
  },
  chassisNames: ["chassis"],
  mechanismTimes: {
    "macros::flip_out": 900,
    "macros::go_to": 900,
    "macros::home": 900,
    "macros::dual_setup": 1000,
    "macros::dual_pickup": 900,
    "macros::dual_pickup_height": 1300,
    "elevator::wait_until_settled": 600,
    "pivot::wait_until_settled": 400,
  },
  instantCalls: [
    "claw::",
    "intake::",
    "pivot::",
    "elevator::",
    "subsystems::",
    "macros::cancel",
    "intake_lift.",
    "pull_toggle.",
    "controller.",
  ],
  registry: {
    entry: /\{\s*"([^"]+)"\s*,\s*([A-Za-z_][\w:]*|nullptr)\s*,\s*([A-Za-z_][\w:]*|nullptr)\s*\}/g,
    defaultName: /kDefaultRoutine\s*=\s*"([^"]+)"/,
  },
};

export const PROFILES: TeamProfile[] = [CRIMSON_PROFILE];
