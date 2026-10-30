import type { ProjectSnapshot } from "../project/types";
import type { TeamProfile } from "../profiles/types";
import type { RobotConfig } from "../robot/config";
import { DEFAULT_OBSTACLES } from "../sim/collisions";
import type { ObstacleFilter } from "../sim/collisions";

export type ThemeChoice = "system" | "light" | "dark";
export type InspectorTab = "timeline" | "collisions" | "code" | "settings" | "log";
export type FieldRotation = 0 | 90 | 180 | 270;

export interface SimPrefs {
  obstacles: ObstacleFilter;
  robot: RobotConfig;
  mechanismOverrides: Record<string, number>;
  fieldRotation: FieldRotation;
}

export interface AppState {
  routineId: string;
  periods: Record<string, number>;
  theme: ThemeChoice;
  speed: number;
  tab: InspectorTab;
  prefs: SimPrefs;
  logChannels: string[];
  hiddenSeries: string[];
  snapshot: ProjectSnapshot | null;
}

const STORAGE_KEY = "pointweaver:v2";
const TABS: InspectorTab[] = ["timeline", "collisions", "code", "settings", "log"];
const THEMES: ThemeChoice[] = ["system", "light", "dark"];
export const ROTATIONS: FieldRotation[] = [0, 90, 180, 270];
export const MAX_LOG_CHANNELS = 4;

export function validRotation(value: unknown): FieldRotation {
  return ROTATIONS.includes(value as FieldRotation) ? (value as FieldRotation) : 0;
}

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))].slice(0, max) : [];

export function defaultPrefs(profile: TeamProfile): SimPrefs {
  return {
    obstacles: { ...DEFAULT_OBSTACLES },
    robot: { ...profile.robot },
    mechanismOverrides: {},
    fieldRotation: 0,
  };
}

export function defaultState(profile: TeamProfile): AppState {
  return {
    routineId: "",
    periods: {},
    theme: "system",
    speed: 1,
    tab: "timeline",
    prefs: defaultPrefs(profile),
    logChannels: [],
    hiddenSeries: [],
    snapshot: null,
  };
}

export function loadState(fallback: AppState): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<AppState>;
    const snapshot = saved.snapshot;
    return {
      routineId: typeof saved.routineId === "string" ? saved.routineId : fallback.routineId,
      periods: { ...saved.periods },
      theme: THEMES.includes(saved.theme as ThemeChoice) ? (saved.theme as ThemeChoice) : fallback.theme,
      speed: typeof saved.speed === "number" && saved.speed > 0 ? saved.speed : fallback.speed,
      tab: TABS.includes(saved.tab as InspectorTab) ? (saved.tab as InspectorTab) : fallback.tab,
      prefs: {
        obstacles: { ...fallback.prefs.obstacles, ...saved.prefs?.obstacles },
        robot: { ...fallback.prefs.robot, ...saved.prefs?.robot },
        mechanismOverrides: { ...saved.prefs?.mechanismOverrides },
        fieldRotation: validRotation(saved.prefs?.fieldRotation),
      },
      logChannels: strings(saved.logChannels, MAX_LOG_CHANNELS),
      hiddenSeries: strings(saved.hiddenSeries, 64),
      snapshot: snapshot && Array.isArray(snapshot.files) ? snapshot : null,
    };
  } catch {
    return fallback;
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, snapshot: null }));
    } catch {
      return;
    }
  }
}
