import type { Vec2 } from "../core/geometry";

export type Alliance = "red" | "blue";
export type GoalOwner = Alliance | "neutral";

export interface Goal {
  id: string;
  label: string;
  position: Vec2;
  owner: GoalOwner;
  size: number;
}

export interface Loader {
  id: string;
  position: Vec2;
  width: number;
  height: number;
  alliance: Alliance;
}

export interface LoadZone {
  id: string;
  alliance: Alliance;
  min: Vec2;
  max: Vec2;
  tape: Vec2[];
}

export interface TapeLine {
  from: Vec2;
  to: Vec2;
  double: boolean;
}

export interface WallBar {
  id: string;
  side: "top" | "bottom" | "left" | "right";
  length: number;
}

export type ElementKind = "four-pin-cross" | "cup-yellow-pin" | "cup-red-blue-pin" | "cup-blue-red-pin" | "cup";

export interface FieldElement {
  id: string;
  kind: ElementKind;
  position: Vec2;
  radius: number;
}

export interface FieldDefinition {
  id: string;
  name: string;
  season: string;
  half: number;
  tiles: number;
  goals: Goal[];
  loaders: Loader[];
  loadZones: LoadZone[];
  tape: TapeLine[];
  midfield: Vec2[];
  wallBars: WallBar[];
  elements: FieldElement[];
}
