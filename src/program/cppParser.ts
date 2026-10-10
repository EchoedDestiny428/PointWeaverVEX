import type { Arg, Diagnostic, ParamsArg, ParsedFile, RoutineFunction, Stmt } from "./ast";

const CONTROL_KEYWORDS = new Set(["if", "else", "for", "while", "do", "switch", "return", "break", "continue", "goto", "try"]);
const PAIRS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
const MAX_TEXT = 96;

export function blankComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < source.length && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < source.length && source[i] === c) {
        out += c;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

function parseParams(text: string): ParamsArg {
  const inner = text.trim().slice(1, -1);
  const entries = splitTopLevel(inner).map((entry, index) => {
    const match = /^\.\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(entry);
    return match ? { key: match[1], value: match[2].trim() } : { key: `#${index}`, value: entry.trim() };
  });
  return { kind: "params", entries };
}

export function parseArgs(text: string): Arg[] {
  return splitTopLevel(text).map((part) =>
    part.startsWith("{") && part.endsWith("}") ? parseParams(part) : { kind: "expr", text: part },
  );
}

class Parser {
  private readonly lineStarts: number[] = [0];
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") this.lineStarts.push(i + 1);
    }
  }

  lineOf(index: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  snippet(from: number, to: number): string {
    const compact = this.text.slice(from, to).replace(/\s+/g, " ").trim();
    return compact.length > MAX_TEXT ? `${compact.slice(0, MAX_TEXT - 1)}…` : compact;
  }

  skipWs(pos: number, end: number): number {
    while (pos < end && /\s/.test(this.text[pos])) pos++;
    return pos;
  }

  findClose(open: number): number {
    const opener = this.text[open];
    const closer = PAIRS[opener];
    let depth = 0;
    for (let i = open; i < this.text.length; i++) {
      const c = this.text[i];
      if (c === '"' || c === "'") {
        i++;
        while (i < this.text.length && this.text[i] !== c) {
          if (this.text[i] === "\\") i++;
          i++;
        }
        continue;
      }
      if (c === opener) depth++;
      else if (c === closer) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  readName(pos: number): { name: string; next: number } | null {
    const match = /^[A-Za-z_]\w*(?:\s*(?:::|\.|->)\s*[A-Za-z_]\w*)*/.exec(this.text.slice(pos, pos + 256));
    if (!match) return null;
    return { name: match[0].replace(/\s+/g, "").replace(/->/g, "."), next: pos + match[0].length };
  }

  skipStatement(pos: number, end: number): number {
    let depth = 0;
    for (let i = pos; i < end; i++) {
      const c = this.text[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "{") {
        const close = this.findClose(i);
        if (close < 0) return end;
        if (depth === 0) {
          const after = this.skipWs(close + 1, end);
          return this.text[after] === ";" ? after + 1 : close + 1;
        }
        i = close;
      } else if (c === ";" && depth === 0) return i + 1;
    }
    return end;
  }

  skipControl(pos: number, end: number): number {
    let p = this.skipWs(pos, end);
    if (this.text[p] === "(") {
      const close = this.findClose(p);
      p = close < 0 ? end : this.skipWs(close + 1, end);
    }
    if (this.text[p] === "{") {
      const close = this.findClose(p);
      return close < 0 ? end : close + 1;
    }
    return this.skipStatement(p, end);
  }

  parseBlock(start: number, end: number): Stmt[] {
    const statements: Stmt[] = [];
    let pos = start;
    while (true) {
      pos = this.skipWs(pos, end);
      if (pos >= end) break;
      const c = this.text[pos];
      if (c === ";") {
        pos++;
        continue;
      }
      if (c === "{") {
        const close = this.findClose(pos);
        const blockEnd = close < 0 || close > end ? end : close;
        statements.push(...this.parseBlock(pos + 1, blockEnd));
        pos = blockEnd + 1;
        continue;
      }
      const result = this.parseStatement(pos, end);
      if (result.stmt) statements.push(result.stmt);
      pos = Math.max(result.next, pos + 1);
    }
    return statements;
  }

  unsupported(start: number, next: number, reason: string): { stmt: Stmt; next: number } {
    return { stmt: { kind: "unsupported", reason, line: this.lineOf(start), text: this.snippet(start, next) }, next };
  }

  parseStatement(pos: number, end: number): { stmt: Stmt | null; next: number } {
    const name = this.readName(pos);
    if (!name) {
      const next = this.skipStatement(pos, end);
      return this.unsupported(pos, next, "This line isn't a function call, so it's skipped.");
    }
    if (CONTROL_KEYWORDS.has(name.name)) {
      const next = this.skipControl(name.next, end);
      return this.unsupported(pos, next, `\`${name.name}\` statements aren't simulated yet, so this block is skipped.`);
    }
    const after = this.skipWs(name.next, end);
    if (name.name === "parallel" && this.text[after] === "(") {
      return this.parseParallel(pos, after, end);
    }
    if (this.text[after] !== "(") {
      const next = this.skipStatement(pos, end);
      return this.unsupported(pos, next, "Variables and assignments aren't simulated, so this line is skipped.");
    }
    const close = this.findClose(after);
    if (close < 0 || close > end) {
      this.diagnostics.push({ line: this.lineOf(pos), severity: "error", message: "This call is missing its closing `)`." });
      return { stmt: null, next: end };
    }
    const semi = this.skipWs(close + 1, end);
    if (this.text[semi] !== ";") {
      const next = this.skipStatement(pos, end);
      return this.unsupported(pos, next, "Only plain `name(...);` calls are simulated, so this line is skipped.");
    }
    return {
      stmt: {
        kind: "call",
        callee: name.name,
        args: parseArgs(this.text.slice(after + 1, close)),
        line: this.lineOf(pos),
        text: this.snippet(pos, semi + 1),
      },
      next: semi + 1,
    };
  }

  parseParallel(start: number, paren: number, end: number): { stmt: Stmt | null; next: number } {
    const closeParen = this.findClose(paren);
    const listStart = this.skipWs(paren + 1, end);
    if (closeParen < 0 || this.text[listStart] !== "{") {
      const next = this.skipStatement(start, end);
      return this.unsupported(start, next, "`parallel` needs a `{ ... }` list of tasks.");
    }
    const listEnd = this.findClose(listStart);
    const tasks: Stmt[][] = [];
    let q = listStart + 1;
    while (true) {
      q = this.skipWs(q, listEnd);
      if (q >= listEnd) break;
      if (this.text[q] === ",") {
        q++;
        continue;
      }
      if (this.text[q] === "[") {
        const captureEnd = this.findClose(q);
        let r = this.skipWs(captureEnd + 1, listEnd);
        if (this.text[r] === "(") r = this.skipWs(this.findClose(r) + 1, listEnd);
        while (r < listEnd && this.text[r] !== "{") r++;
        const bodyEnd = this.findClose(r);
        if (bodyEnd < 0) break;
        tasks.push(this.parseBlock(r + 1, bodyEnd));
        q = bodyEnd + 1;
        continue;
      }
      const name = this.readName(q);
      if (name) {
        tasks.push([{ kind: "call", callee: name.name, args: [], line: this.lineOf(q), text: `${name.name}()` }]);
        q = name.next;
        continue;
      }
      this.diagnostics.push({
        line: this.lineOf(q),
        severity: "warning",
        message: "A task in this `parallel` list wasn't recognised and is skipped.",
      });
      while (q < listEnd && this.text[q] !== ",") q++;
    }
    const semi = this.skipWs(closeParen + 1, end);
    const next = this.text[semi] === ";" ? semi + 1 : semi;
    return {
      stmt: { kind: "parallel", tasks, line: this.lineOf(start), text: `parallel (${tasks.length} tasks)` },
      next,
    };
  }

  parseFunctions(): RoutineFunction[] {
    const functions: RoutineFunction[] = [];
    const pattern = /\bvoid\s+([A-Za-z_]\w*)\s*\(\s*\)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(this.text))) {
      const open = match.index + match[0].length - 1;
      const close = this.findClose(open);
      if (close < 0) {
        this.diagnostics.push({ line: this.lineOf(open), severity: "error", message: `\`${match[1]}()\` is missing its closing \`}\`.` });
        break;
      }
      functions.push({ name: match[1], line: this.lineOf(match.index), body: this.parseBlock(open + 1, close) });
      pattern.lastIndex = close + 1;
    }
    return functions;
  }
}

export function parseCpp(source: string): ParsedFile {
  const parser = new Parser(blankComments(source));
  let functions = parser.parseFunctions();
  if (functions.length === 0) {
    functions = [{ name: "snippet", line: 1, body: parser.parseBlock(0, source.length) }];
  }
  return { functions, diagnostics: parser.diagnostics };
}

export function pickRoutine(file: ParsedFile, preferred?: string): RoutineFunction | undefined {
  return (
    file.functions.find((fn) => fn.name === preferred) ??
    file.functions.find((fn) => fn.name === "run") ??
    file.functions.find((fn) => fn.body.length > 0) ??
    file.functions[0]
  );
}
