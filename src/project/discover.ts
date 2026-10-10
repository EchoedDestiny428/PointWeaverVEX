import type { Diagnostic, ParsedFile, RoutineFunction, Stmt } from "../program/ast";
import { parseCpp } from "../program/cppParser";
import type { TeamProfile } from "../profiles/types";
import { findMotionCommand } from "../sim/commands";
import { isSourceFile } from "./types";
import type { ProjectFile } from "./types";

export interface RoutineEntry {
  id: string;
  name: string;
  group: string;
  path: string;
  functionName: string;
  setupName: string | null;
  periodSeconds: number;
  isDefault: boolean;
  registered: boolean;
}

export interface SourceFile {
  path: string;
  source: string;
  namespace: string;
  parsed: ParsedFile;
}

export interface Discovery {
  routines: RoutineEntry[];
  files: Map<string, SourceFile>;
  hasRegistry: boolean;
}

export interface RoutineProgram {
  body: Stmt[];
  file: SourceFile;
  run: RoutineFunction;
  diagnostics: Diagnostic[];
}

const MATCH_SECONDS = 15;
const SKILLS_SECONDS = 60;

function namespaceOf(source: string): string {
  const names: string[] = [];
  for (const match of source.matchAll(/\bnamespace\s+([A-Za-z_][\w:]*)\s*\{/g)) {
    names.push(match[1]);
  }
  return names.join("::");
}

function stem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function groupOf(path: string): string {
  const parts = path.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

export function periodFor(group: string, name: string): number {
  return /skill/i.test(group) || /skill/i.test(name) ? SKILLS_SECONDS : MATCH_SECONDS;
}

function drivesChassis(stmts: Stmt[], profile: TeamProfile): boolean {
  for (const stmt of stmts) {
    if (stmt.kind === "parallel") {
      if (stmt.tasks.some((task) => drivesChassis(task, profile))) return true;
    } else if (stmt.kind === "call") {
      const dot = stmt.callee.lastIndexOf(".");
      if (dot < 0) continue;
      const owner = stmt.callee.slice(0, dot);
      const method = stmt.callee.slice(dot + 1);
      if (profile.chassisNames.includes(owner) && (method === "setPose" || findMotionCommand(method))) return true;
    }
  }
  return false;
}

function resolveRef(ref: string, files: SourceFile[]): { file: SourceFile; fn: RoutineFunction } | null {
  if (ref === "nullptr") return null;
  const parts = ref.split("::");
  const fnName = parts.pop() ?? "";
  const qualifier = parts.join("::");
  if (!qualifier) return null;
  for (const file of files) {
    if (file.namespace !== qualifier && !file.namespace.endsWith(`::${qualifier}`)) continue;
    const fn = file.parsed.functions.find((candidate) => candidate.name === fnName);
    if (fn) return { file, fn };
  }
  return null;
}

function entryFor(file: SourceFile, fn: RoutineFunction, name: string, registered: boolean): RoutineEntry {
  const group = groupOf(file.path);
  const setup = fn.name === "run" ? file.parsed.functions.find((candidate) => candidate.name === "setup") : undefined;
  return {
    id: `${file.path}#${fn.name}`,
    name,
    group,
    path: file.path,
    functionName: fn.name,
    setupName: setup ? setup.name : null,
    periodSeconds: periodFor(group, name),
    isDefault: false,
    registered,
  };
}

export function discoverRoutines(projectFiles: ProjectFile[], profile: TeamProfile): Discovery {
  const files = new Map<string, SourceFile>();
  for (const file of projectFiles) {
    if (!isSourceFile(file.path)) continue;
    files.set(file.path, { path: file.path, source: file.content, namespace: namespaceOf(file.content), parsed: parseCpp(file.content) });
  }
  const all = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));

  const routines: RoutineEntry[] = [];
  const taken = new Set<string>();
  let hasRegistry = false;
  let defaultName: string | undefined;

  if (profile.registry) {
    for (const file of all) {
      const entries = [...file.source.matchAll(new RegExp(profile.registry.entry.source, "g"))];
      if (entries.length === 0) continue;
      const fallbackDefault = profile.registry.defaultName ? file.source.match(profile.registry.defaultName)?.[1] : undefined;
      for (const [, name, setupRef, runRef] of entries) {
        const run = resolveRef(runRef, all);
        if (!run) continue;
        hasRegistry = true;
        defaultName ??= fallbackDefault;
        const entry = entryFor(run.file, run.fn, name, true);
        const setup = resolveRef(setupRef, all);
        entry.setupName = setup && setup.file === run.file ? setup.fn.name : null;
        if (taken.has(entry.id)) continue;
        taken.add(entry.id);
        routines.push(entry);
      }
    }
  }

  const extras: RoutineEntry[] = [];
  for (const file of all) {
    const candidates = file.parsed.functions.filter((fn) => drivesChassis(fn.body, profile));
    if (candidates.length === 0) continue;
    const runFirst = candidates.some((fn) => fn.name === "run") ? candidates.filter((fn) => fn.name !== "setup") : candidates;
    for (const fn of runFirst) {
      const id = `${file.path}#${fn.name}`;
      if (taken.has(id)) continue;
      if (hasRegistry && fn.name === "setup") continue;
      taken.add(id);
      const name = fn.name === "run" ? stem(file.path) : `${stem(file.path)} · ${fn.name}`;
      extras.push(entryFor(file, fn, name, !hasRegistry));
    }
  }
  extras.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  routines.push(...extras);

  if (defaultName) {
    for (const entry of routines) entry.isDefault = entry.name === defaultName;
  }
  return { routines, files, hasRegistry };
}

export function routineProgram(discovery: Discovery, entry: RoutineEntry): RoutineProgram | null {
  const file = discovery.files.get(entry.path);
  if (!file) return null;
  const run = file.parsed.functions.find((fn) => fn.name === entry.functionName);
  if (!run) return null;
  const setup = entry.setupName ? file.parsed.functions.find((fn) => fn.name === entry.setupName) : undefined;
  return {
    body: setup && setup !== run ? [...setup.body, ...run.body] : run.body,
    file,
    run,
    diagnostics: file.parsed.diagnostics,
  };
}
