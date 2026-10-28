#!/usr/bin/env bun

import { join, resolve } from "node:path";

import { surveyReport } from "./report.ts";

/**
 * The analysis applied to simulated answers, committed under example/ so the study team can read
 * the report before any rater answers. The simulation runs in the survey server's tests
 * (SimulationTest), against the real database and export, and writes example/data.json; `--check`
 * regenerates the report from the committed data.json and fails on any difference. The server's
 * tests fail when data.json no longer matches the simulation.
 */

const EXAMPLE = join(import.meta.dir, "example");
const check = process.argv.includes("--check");

if (!check) {
  const simulation = Bun.spawnSync(
    [
      "./gradlew",
      "--quiet",
      "test",
      "--rerun",
      "--tests",
      "exgen.survey.SimulationTest",
      "-Dsurvey.example.write=true",
    ],
    { cwd: resolve(import.meta.dir, "../server"), stdout: "inherit", stderr: "inherit" },
  );
  if (simulation.exitCode !== 0) {
    throw new Error("the simulation failed; see the server's test report");
  }
}
const differences = await surveyReport(join(EXAMPLE, "data.json"), EXAMPLE, { check });
if (differences.length > 0) {
  throw new Error(
    `the example report differs in ${differences.join(", ")}; run bun run survey:example`,
  );
}
process.stdout.write(check ? "The example report is current.\n" : `${EXAMPLE}\n`);
