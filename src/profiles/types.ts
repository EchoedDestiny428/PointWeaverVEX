import type { RobotConfig } from "../robot/config";

export interface RoutineRegistry {
  entry: RegExp;
  defaultName?: RegExp;
}

export interface TeamProfile {
  id: string;
  name: string;
  robot: RobotConfig;
  chassisNames: string[];
  mechanismTimes: Record<string, number>;
  instantCalls: string[];
  registry?: RoutineRegistry;
}

export function mechanismDuration(profile: TeamProfile, callee: string, overrides: Record<string, number>): number | undefined {
  if (callee in overrides) {
    return overrides[callee];
  }
  if (callee in profile.mechanismTimes) {
    return profile.mechanismTimes[callee];
  }
  if (profile.instantCalls.some((prefix) => callee.startsWith(prefix))) {
    return 0;
  }
  return undefined;
}
