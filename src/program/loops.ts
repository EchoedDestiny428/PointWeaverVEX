import type { Arg, LoopIteration, Stmt } from "./ast";

export const MAX_LOOP_PASSES = 200;

export interface LoopPasses {
  values: string[];
  capped: boolean;
}

function asValue(value: string): string {
  const text = value.trim();
  return /^[A-Za-z_][\w:.]*$/.test(text) || /^\d+(?:\.\d+)?[fFlLuU]*$/.test(text) ? text : `(${text})`;
}

export function replaceName(text: string, name: string, value: string): string {
  const replacement = asValue(value);
  return text.replace(new RegExp(`(?<![\\w.:>])${name}(?!\\w|\\s*::)`, "g"), () => replacement);
}

function substituteArg(arg: Arg, name: string, value: string): Arg {
  if (arg.kind === "expr") return { ...arg, text: replaceName(arg.text, name, value) };
  return { ...arg, entries: arg.entries.map((entry) => ({ ...entry, value: replaceName(entry.value, name, value) })) };
}

function substituteIteration(iteration: LoopIteration, name: string, value: string): LoopIteration {
  if (iteration.kind === "range") {
    return { ...iteration, items: iteration.items.map((item) => replaceName(item, name, value)) };
  }
  return {
    ...iteration,
    start: replaceName(iteration.start, name, value),
    end: replaceName(iteration.end, name, value),
    step: replaceName(iteration.step, name, value),
  };
}

export function substitute(statements: Stmt[], name: string, value: string): Stmt[] {
  return statements.map((stmt): Stmt => {
    switch (stmt.kind) {
      case "call":
        return {
          ...stmt,
          args: stmt.args.map((arg) => substituteArg(arg, name, value)),
          text: replaceName(stmt.text, name, value),
        };
      case "parallel":
        return { ...stmt, tasks: stmt.tasks.map((task) => substitute(task, name, value)) };
      case "loop":
        return {
          ...stmt,
          iteration: substituteIteration(stmt.iteration, name, value),
          body: stmt.iteration.variable === name ? stmt.body : substitute(stmt.body, name, value),
        };
      default:
        return stmt;
    }
  });
}

export function loopPasses(iteration: LoopIteration, evaluate: (text: string) => number): LoopPasses {
  if (iteration.kind === "range") return { values: iteration.items, capped: false };
  const number = (text: string): number => evaluate(text.replace(/\b(\d+)[uUlL]+\b/g, "$1"));
  const start = number(iteration.start);
  const end = number(iteration.end);
  const step = number(iteration.step);
  const keepGoing = (value: number): boolean => {
    switch (iteration.compare) {
      case "<":
        return value < end;
      case "<=":
        return value <= end;
      case ">":
        return value > end;
      case ">=":
        return value >= end;
      default:
        return Math.abs(value - end) > 1e-9;
    }
  };
  const values: string[] = [];
  for (let value = start; keepGoing(value); value += step) {
    if (values.length >= MAX_LOOP_PASSES) return { values, capped: true };
    values.push(String(Number(value.toFixed(6))));
  }
  return { values, capped: false };
}
