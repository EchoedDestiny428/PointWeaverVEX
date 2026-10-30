import { wrap180 } from "../core/angle";
import type { LogAnalysis } from "../log/analyze";
import { poseAt } from "../log/model";
import type { ReplayLog, Series } from "../log/model";
import type { RoutineEntry } from "../project/discover";
import type { FieldSeriesId } from "../render/replayScene";

export interface SeriesDef {
  id: FieldSeriesId;
  label: string;
  slot: number;
  title: string;
}

export interface ChannelPick {
  key: string;
  slot: number;
}

export interface ChannelNode {
  name: string;
  key: string | null;
  children: Map<string, ChannelNode>;
}

export const FIXED_SERIES: SeriesDef[] = [
  { id: "robot", label: "Robot", slot: 1, title: "Corrected pose · /Odometry/Robot" },
  { id: "raw", label: "Raw", slot: 2, title: "Raw odometry, never reset · /Odometry/Raw" },
  { id: "vision", label: "Vision", slot: 3, title: "Vision pose fixes · /Vision/Pose" },
  { id: "target", label: "Target", slot: 4, title: "Active motion target · /Motion/Command" },
];

export const CHANNEL_SLOTS = [5, 6, 7, 8];

const UNIT_KEYS: Array<[RegExp, string]> = [
  [/^Motors\/[^/]+\/position$/, "motorPosition"],
  [/^Motors\/[^/]+\/velocity$/, "motorVelocity"],
  [/^Motors\/[^/]+\/voltage$/, "motorVoltage"],
  [/^Motors\/[^/]+\/current$/, "motorCurrent"],
  [/^Motors\/[^/]+\/power$/, "motorPower"],
  [/^Motors\/[^/]+\/torque$/, "motorTorque"],
  [/^Motors\/[^/]+\/Health\/temperature$/, "motorTemperature"],
  [/^Motors\/[^/]+\/Health\/efficiency$/, "motorEfficiency"],
  [/^Odometry\/\w+Wheel\/(position|angle)$/, "wheel"],
  [/^Odometry\/\w+Wheel\/velocity$/, "wheelVelocity"],
  [/^Odometry\/Imu\/(heading|rotation|pitch|roll|yaw)$/, "imuAngle"],
  [/^Odometry\/Imu\/gyro[XYZ]$/, "imuGyro"],
  [/^Odometry\/Imu\/accel[XYZ]$/, "imuAccel"],
  [/^System\/Battery\/voltage$/, "batteryVoltage"],
  [/^System\/Battery\/current$/, "batteryCurrent"],
  [/^System\/Battery\/capacity$/, "batteryCapacity"],
  [/^System\/Battery\/temperature$/, "batteryTemperature"],
  [/^(Odometry\/(Robot|Raw|ResetFrom|ResetTo)|Vision\/Pose|Motion\/Command)\/[xy]$/, "distance"],
  [/^(Odometry\/(Robot|Raw|ResetFrom|ResetTo)|Vision\/Pose|Motion\/Command)\/theta$/, "heading"],
  [/^Mechanisms\/Elevator\/(target|position)$/, "mechanismElevator"],
  [/^Mechanisms\/Pivot\/(target|position)$/, "mechanismPivot"],
  [/^(Controller\/Master\/(left|right)[XY]|Mechanisms\/(ElevatorManual|ClawPower))$/, "power"],
];

const UNIT_LABELS: Record<string, string> = { deg: "°", pct: "%", C: "°C", centideg: "c°", motorDeg: "°", "-127..127": "" };

export function unitFor(key: string, units: Record<string, string> | undefined): string {
  const found = UNIT_KEYS.find(([pattern]) => pattern.test(key));
  const unit = found && units ? units[found[1]] : undefined;
  if (unit === undefined) return "";
  return UNIT_LABELS[unit] ?? unit;
}

export function shortChannel(key: string): string {
  const parts = key.split("/").filter((part) => part !== "Health" && part !== "");
  return (parts.length >= 3 ? parts.slice(1) : parts).join(" ");
}

export function nextSlot(picks: ChannelPick[]): number | null {
  return CHANNEL_SLOTS.find((slot) => !picks.some((pick) => pick.slot === slot)) ?? null;
}

export function channelTree(keys: Iterable<string>): ChannelNode {
  const root: ChannelNode = { name: "", key: null, children: new Map() };
  for (const key of keys) {
    let node = root;
    for (const part of key.split("/")) {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, key: null, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.key = key;
  }
  return root;
}

export function searchChannels(keys: Iterable<string>, query: string, limit = 200): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (words.every((word) => lower.includes(word))) out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

export function matchRoutine(log: ReplayLog, routines: RoutineEntry[]): RoutineEntry | null {
  const selected = log.autons.at(-1)?.name ?? log.text.get("Auton/Selected")?.v.at(-1) ?? "";
  const wanted = normalize(selected);
  if (wanted) {
    const named = routines.find((routine) => normalize(routine.name) === wanted || normalize(routine.functionName) === wanted);
    if (named) return named;
  }
  const file = log.motions.find((motion) => motion.file)?.file;
  if (!file) return null;
  return routines.find((routine) => routine.path === file || routine.path.endsWith(`/${file}`) || file.endsWith(`/${routine.path}`)) ?? null;
}

export function targetHeadings(log: ReplayLog, analysis: LogAnalysis): number[] {
  return log.motions.map((motion, index) => {
    const theta = Number.isFinite(motion.target.theta) ? motion.target.theta : (analysis.motions[index]?.targetHeading ?? Number.NaN);
    if (!Number.isFinite(theta)) return Number.NaN;
    const near = poseAt(log.poses.robot, motion.end)?.theta;
    return near !== undefined && Number.isFinite(near) ? near + wrap180(theta - near) : theta;
  });
}

export function voltScale(series: Series | undefined, declared: string | undefined): number {
  if (declared === "mV") return 0.001;
  if (declared === "V" || !series) return 1;
  let peak = 0;
  for (let i = 0; i < series.v.length; i++) if (Number.isFinite(series.v[i])) peak = Math.max(peak, Math.abs(series.v[i]));
  return peak > 100 ? 0.001 : 1;
}
