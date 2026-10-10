import type { Arg, Stmt } from "./ast";

function emitArg(arg: Arg): string {
  if (arg.kind === "expr") {
    return arg.text;
  }
  const entries = arg.entries.map((entry) => (entry.key.startsWith("#") ? entry.value : `.${entry.key} = ${entry.value}`));
  return `{${entries.join(", ")}}`;
}

export function emitStatements(statements: Stmt[], indent = "    "): string {
  const lines: string[] = [];
  for (const stmt of statements) {
    if (stmt.kind === "call") {
      lines.push(`${indent}${stmt.callee}(${stmt.args.map(emitArg).join(", ")});`);
    } else if (stmt.kind === "parallel") {
      lines.push(`${indent}parallel({`);
      for (const task of stmt.tasks) {
        lines.push(`${indent}    [] {`);
        lines.push(emitStatements(task, `${indent}        `));
        lines.push(`${indent}    },`);
      }
      lines.push(`${indent}});`);
    } else {
      lines.push(`${indent}// skipped: ${stmt.text}`);
    }
  }
  return lines.filter((line) => line.length > 0).join("\n");
}

export function emitRoutine(name: string, statements: Stmt[]): string {
  return `void ${name}() {\n${emitStatements(statements)}\n}\n`;
}
