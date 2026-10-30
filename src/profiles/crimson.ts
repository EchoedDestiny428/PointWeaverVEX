import type { TeamProfile } from "./types";

export const CRIMSON_PROFILE: TeamProfile = {
  id: "crimson",
  name: "Crimson",
  robot: {
    width: 15,
    length: 15,
    trackWidth: 12.5,
    maxSpeed: 55,
    acceleration: 140,
    maxTurnRate: 360,
    turnAcceleration: 1800,
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
