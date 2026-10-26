#!/usr/bin/env bun

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadBenchmark } from "../../../src/core/load.ts";
import { createPlan } from "../../../src/core/plan.ts";
import { runPlan } from "../../../src/core/run.ts";
import { planTier1, runToolPlan } from "../../../src/evaluation/tools.ts";
import { buildStudy } from "../builder/build.ts";
import { serveSurvey } from "../server/app.ts";
import { SurveyStore } from "../server/store.ts";
import { loadStudy } from "../server/study.ts";
import { currentSurveyWeb } from "../web/build.ts";

/**
 * The demo study end to end, exactly as a study team would run it: generate the exercises, evaluate
 * them with the Tier 1 tools, build the study, and serve it with a fresh database. The personal
 * links are printed and written to `.exgen/survey-demo/links.json`.
 */

const { values } = parseArgs({
  options: { port: { type: "string", default: "4180" } },
});
const root = resolve(import.meta.dir, "../../..");
const work = join(root, ".exgen/survey-demo");
const run = join(root, ".exgen/runs/survey-demo");
const study = import.meta.dir;

await rm(run, { recursive: true, force: true });
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

const benchmark = await loadBenchmark(join(study, "benchmark.yaml"));
await runPlan(benchmark, await createPlan(benchmark), "survey-demo", run, { create: true });
await runToolPlan(
  await planTier1(
    ["tier1-deterministic"],
    new Map([
      ["java-oracle", join(root, "tools/tier1-deterministic/java-oracle/evaluator.fixture.yaml")],
    ]),
  ),
  { runDirectory: run, retryInfrastructure: false },
);
await buildStudy(study, { rebuild: true });

const loaded = await loadStudy(study);
const store = SurveyStore.open(join(work, "survey.sqlite"), loaded, { create: true });
const port = Number(values.port);
const base = `http://127.0.0.1:${port}`;
const links = Object.fromEntries(
  [...loaded.study.raters.map((rater) => rater.id), "admin"].map((holder) => [
    holder,
    `${base}/r/${store.issueLink(holder === "admin" ? null : holder)}`,
  ]),
);
await writeFile(join(work, "links.json"), `${JSON.stringify(links, null, 2)}\n`);

const server = serveSurvey({
  loaded,
  store,
  web: await currentSurveyWeb(),
  port,
  secureCookies: false,
});
process.stdout.write(
  `Survey demo: ${server.url}\n${Object.entries(links)
    .map(([holder, link]) => `  ${holder}\t${link}`)
    .join("\n")}\n`,
);
