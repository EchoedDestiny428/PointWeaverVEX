import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { analyze, reportFileNames } from "../src/log/analyze";
import { buildLog } from "../src/log/model";
import { parseWpilog, WpilogError } from "../src/log/wpilog";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: npm run analyze -- <log.wpilog> [more.wpilog ...]");
  process.exit(1);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
for (const file of files) {
  const path = resolve(cwd, file);
  try {
    const log = buildLog(parseWpilog(new Uint8Array(readFileSync(path))));
    const report = analyze(log, { name: basename(path) });
    const out = reportFileNames(path);
    writeFileSync(out.report, report.markdown);
    writeFileSync(out.csv, report.csv);
    console.log(report.markdown);
    console.log(`Wrote ${out.report}\nWrote ${out.csv}`);
  } catch (error) {
    if (!(error instanceof WpilogError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.error(`${path}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
