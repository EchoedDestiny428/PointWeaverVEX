import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g;

function fix(file) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(SPECIFIER, (match, lead, quote, spec) => {
    if (/\.(c|m)?js$|\.json$/.test(spec)) return match;
    const base = resolve(dirname(file), spec);
    if (existsSync(`${base}.js`)) return `${lead}${quote}${spec}.js${quote}`;
    if (existsSync(join(base, "index.js"))) return `${lead}${quote}${spec}/index.js${quote}`;
    return match;
  });
  if (next !== text) writeFileSync(file, next);
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".js")) fix(path);
  }
}

walk(resolve(process.argv[2] ?? "dist-cli"));
