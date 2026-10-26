#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { unzipSync } from "fflate";

import { ANALYSIS_SEED, surveyReport } from "./report.ts";
import { simulateExport } from "./simulate.ts";

/**
 * The analysis applied to simulated answers, committed under example/ so the study team can read
 * the report before any rater answers. `--check` regenerates both and fails on any difference,
 * which pins the simulation and the analysis to their committed output.
 */

const EXAMPLE = join(import.meta.dir, "example");
const check = process.argv.includes("--check");

const data = unzipSync(await simulateExport(ANALYSIS_SEED))["data.json"];
if (data === undefined) throw new Error("the simulated export has no data.json");
const input = join(EXAMPLE, "data.json");
if (check) {
  const committed = new Uint8Array(await readFile(input));
  if (Buffer.compare(Buffer.from(committed), Buffer.from(data)) !== 0) {
    throw new Error("example/data.json differs from the simulation; run bun run survey:example");
  }
} else {
  await writeFile(input, data);
}
const differences = await surveyReport(input, EXAMPLE, { check });
if (differences.length > 0) {
  throw new Error(
    `the example report differs in ${differences.join(", ")}; run bun run survey:example`,
  );
}
process.stdout.write(check ? "The example report is current.\n" : `${EXAMPLE}\n`);
