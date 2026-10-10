export type Resolver = (name: string) => number | undefined;

export class ExpressionError extends Error {}

type Token = { type: "num"; value: number } | { type: "ident"; value: string } | { type: "op"; value: string };

const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)[fFlL]?|([A-Za-z_]\w*(?:\s*(?:::|\.|->)\s*[A-Za-z_]\w*|\s*\(\s*\))*)|([-+*/()]))/y;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) {
      throw new ExpressionError(`Can't read \`${text.slice(start).trim()}\`.`);
    }
    if (match[1] !== undefined) tokens.push({ type: "num", value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: "ident", value: match[2].replace(/\s+/g, "").replace(/->/g, ".") });
    else tokens.push({ type: "op", value: match[3] });
  }
  return tokens;
}

export function evaluate(text: string, resolve: Resolver): number {
  const tokens = tokenize(text);
  let index = 0;
  const peek = (): Token | undefined => tokens[index];

  const expression = (): number => {
    let value = term();
    for (let t = peek(); t && t.type === "op" && (t.value === "+" || t.value === "-"); t = peek()) {
      index++;
      const right = term();
      value = t.value === "+" ? value + right : value - right;
    }
    return value;
  };

  const term = (): number => {
    let value = factor();
    for (let t = peek(); t && t.type === "op" && (t.value === "*" || t.value === "/"); t = peek()) {
      index++;
      const right = factor();
      value = t.value === "*" ? value * right : value / right;
    }
    return value;
  };

  const factor = (): number => {
    const t = tokens[index++];
    if (!t) throw new ExpressionError(`\`${text}\` ends too early.`);
    if (t.type === "num") return t.value;
    if (t.type === "ident") {
      const value = resolve(t.value);
      if (value === undefined) throw new ExpressionError(`\`${t.value}\` has no known value.`);
      return value;
    }
    if (t.value === "-") return -factor();
    if (t.value === "+") return factor();
    if (t.value === "(") {
      const value = expression();
      const closing = tokens[index++];
      if (!closing || closing.value !== ")") throw new ExpressionError(`\`${text}\` is missing a \`)\`.`);
      return value;
    }
    throw new ExpressionError(`Unexpected \`${t.value}\` in \`${text}\`.`);
  };

  const value = expression();
  if (index < tokens.length) {
    throw new ExpressionError(`Can't read \`${text}\`.`);
  }
  return value;
}
