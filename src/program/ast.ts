export interface SourceRef {
  line: number;
  text: string;
}

export interface ExprArg {
  kind: "expr";
  text: string;
}

export interface ParamEntry {
  key: string;
  value: string;
}

export interface ParamsArg {
  kind: "params";
  entries: ParamEntry[];
}

export type Arg = ExprArg | ParamsArg;

export interface CallStmt extends SourceRef {
  kind: "call";
  callee: string;
  args: Arg[];
}

export interface ParallelStmt extends SourceRef {
  kind: "parallel";
  tasks: Stmt[][];
  captures?: string[];
}

export type LoopCompare = "<" | "<=" | ">" | ">=" | "!=";

export interface RangeLoop {
  kind: "range";
  variable: string;
  items: string[];
}

export interface CountLoop {
  kind: "count";
  variable: string;
  start: string;
  compare: LoopCompare;
  end: string;
  step: string;
}

export type LoopIteration = RangeLoop | CountLoop;

export interface LoopStmt extends SourceRef {
  kind: "loop";
  header: string;
  iteration: LoopIteration;
  body: Stmt[];
}

export interface UnsupportedStmt extends SourceRef {
  kind: "unsupported";
  reason: string;
}

export type Stmt = CallStmt | ParallelStmt | LoopStmt | UnsupportedStmt;

export interface RoutineFunction {
  name: string;
  line: number;
  body: Stmt[];
}

export interface Diagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
}

export interface ParsedFile {
  functions: RoutineFunction[];
  diagnostics: Diagnostic[];
}

export function findParam(arg: Arg | undefined, key: string): string | undefined {
  if (!arg || arg.kind !== "params") {
    return undefined;
  }
  return arg.entries.find((entry) => entry.key === key)?.value;
}
