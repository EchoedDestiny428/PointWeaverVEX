const KEYWORDS = new Set([
  "auto",
  "bool",
  "break",
  "case",
  "class",
  "const",
  "constexpr",
  "continue",
  "double",
  "else",
  "false",
  "float",
  "for",
  "if",
  "include",
  "int",
  "namespace",
  "nullptr",
  "return",
  "static",
  "struct",
  "switch",
  "true",
  "using",
  "void",
  "while",
]);

export interface Token {
  text: string;
  kind: "plain" | "comment" | "string" | "number" | "keyword" | "call";
}

export function highlightLines(source: string): Token[][] {
  const lines: Token[][] = [];
  let inBlock = false;
  for (const line of source.split(/\r?\n/)) {
    const tokens: Token[] = [];
    let i = 0;
    let plain = "";
    const flush = (): void => {
      if (plain) tokens.push({ text: plain, kind: "plain" });
      plain = "";
    };
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        flush();
        if (end < 0) {
          tokens.push({ text: line.slice(i), kind: "comment" });
          i = line.length;
        } else {
          tokens.push({ text: line.slice(i, end + 2), kind: "comment" });
          i = end + 2;
          inBlock = false;
        }
        continue;
      }
      const rest = line.slice(i);
      if (rest.startsWith("//")) {
        flush();
        tokens.push({ text: rest, kind: "comment" });
        break;
      }
      if (rest.startsWith("/*")) {
        flush();
        const end = line.indexOf("*/", i + 2);
        if (end < 0) {
          tokens.push({ text: line.slice(i), kind: "comment" });
          inBlock = true;
          i = line.length;
        } else {
          tokens.push({ text: line.slice(i, end + 2), kind: "comment" });
          i = end + 2;
        }
        continue;
      }
      const string = /^"(?:[^"\\]|\\.)*"?/.exec(rest);
      if (rest[0] === '"' && string) {
        flush();
        tokens.push({ text: string[0], kind: "string" });
        i += string[0].length;
        continue;
      }
      const number = /^\d+(?:\.\d+)?[fFlL]?/.exec(rest);
      if (number && !/[\w.]/.test(line[i - 1] ?? "")) {
        flush();
        tokens.push({ text: number[0], kind: "number" });
        i += number[0].length;
        continue;
      }
      const word = /^[A-Za-z_]\w*/.exec(rest);
      if (word) {
        const after = line.slice(i + word[0].length);
        flush();
        tokens.push({ text: word[0], kind: KEYWORDS.has(word[0]) ? "keyword" : /^\s*\(/.test(after) ? "call" : "plain" });
        i += word[0].length;
        continue;
      }
      plain += line[i];
      i++;
    }
    flush();
    lines.push(tokens);
  }
  return lines;
}
