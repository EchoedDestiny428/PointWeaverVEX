import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeSampleLog } from "../src/log/sample";

const examples = new URL("../../examples/", import.meta.url);
const source = readFileSync(new URL("crimson-teambad.cpp", examples), "utf8");
const bytes = makeSampleLog({ source, sourcePath: "src/autons/match/teambad.cpp", routine: "run" });
const out = fileURLToPath(new URL("sample.wpilog", examples));
writeFileSync(out, bytes);
console.log(`Wrote ${out} (${Math.round(bytes.length / 1024)} KB)`);
