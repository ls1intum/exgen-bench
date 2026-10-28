#!/usr/bin/env bun

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadBenchmark } from "../../../src/core/load.ts";
import { createPlan } from "../../../src/core/plan.ts";
import { runPlan } from "../../../src/core/run.ts";
import { planTier1, runToolPlan } from "../../../src/evaluation/tools.ts";
import { buildStudy } from "../builder/build.ts";
import { readStudy } from "../builder/study.ts";
import { currentSurveyWeb } from "../web/build.ts";

/**
 * The demo study end to end, exactly as a study team would run it: generate the exercises, evaluate
 * them with the Tier 1 tools, build the study, and serve it with the survey server on a fresh
 * PostgreSQL. Needs Docker and a JDK. The personal links are printed and written to
 * `.exgen/survey-demo/links.json`; Ctrl+C stops the server and removes the database.
 */

const { values } = parseArgs({
  options: { port: { type: "string", default: "4180" } },
});
const root = resolve(import.meta.dir, "../../..");
const work = join(root, ".exgen/survey-demo");
const run = join(root, ".exgen/runs/survey-demo");
const study = import.meta.dir;
const server = resolve(import.meta.dir, "../server");
const port = Number(values.port);
const database = { container: "exgen-survey-demo-db", port: port + 2 };

async function exec(command: string[], options: { cwd?: string; quiet?: boolean } = {}) {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0 && !options.quiet) {
    throw new Error(`${command.slice(0, 3).join(" ")} failed:\n${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

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

// A fresh database on every start, held in memory, so the demo never resumes an earlier session.
await exec(["docker", "rm", "--force", database.container], { quiet: true });
await exec([
  "docker",
  "run",
  "--detach",
  "--rm",
  "--name",
  database.container,
  "--tmpfs",
  "/var/lib/postgresql",
  "--env",
  "POSTGRES_USER=survey",
  "--env",
  "POSTGRES_PASSWORD=survey",
  "--env",
  "POSTGRES_DB=survey",
  "--publish",
  `127.0.0.1:${database.port}:5432`,
  "postgres:18.6-alpine",
]);
const stopDatabase = () =>
  Bun.spawnSync(["docker", "rm", "--force", database.container], {
    stdout: "ignore",
    stderr: "ignore",
  });
for (let attempt = 0; ; attempt += 1) {
  const ready = Bun.spawnSync(
    ["docker", "exec", database.container, "pg_isready", "--host=127.0.0.1", "--username=survey"],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (ready.exitCode === 0) break;
  if (attempt > 60) throw new Error("the demo database did not start");
  await Bun.sleep(500);
}

const web = await currentSurveyWeb().catch((error: unknown) => {
  stopDatabase();
  throw error;
});
await exec(["./gradlew", "--quiet", "bootJar"], { cwd: server }).catch((error: unknown) => {
  stopDatabase();
  throw error;
});
const jar = join(server, "build/libs/survey.jar");
const base = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  SPRING_DATASOURCE_URL: `jdbc:postgresql://127.0.0.1:${database.port}/survey`,
  SURVEY_STUDY: study,
  SURVEY_INSTRUMENT: resolve(import.meta.dir, "../instrument.yaml"),
  SURVEY_WEB: web,
  SURVEY_PUBLIC_URL: base,
  SURVEY_SECURE_COOKIES: "false",
  // The templates a deployment fills in, so the demo shows where the legal documents appear.
  SURVEY_LEGAL_IMPRINT: resolve(import.meta.dir, "../deploy/legal/imprint.example.md"),
  SURVEY_LEGAL_PRIVACY: resolve(import.meta.dir, "../deploy/legal/privacy.example.md"),
  SERVER_ADDRESS: "127.0.0.1",
  SERVER_PORT: String(port),
  MANAGEMENT_SERVER_PORT: String(port + 1),
};

const holders = (await readStudy(study)).raters.map((rater) => rater.id);
const linked = Bun.spawn(
  ["java", "-jar", jar, "link", ...holders.flatMap((id) => ["--rater", id]), "--admin"],
  { env: environment, stdout: "pipe", stderr: "inherit" },
);
const output = await new Response(linked.stdout).text();
if ((await linked.exited) !== 0) {
  stopDatabase();
  throw new Error("issuing the demo links failed");
}
const links = Object.fromEntries(
  output
    .trim()
    .split("\n")
    .map((line) => line.split("\t"))
    .map(([holder, link]) => [holder === "study team" ? "admin" : holder, link]),
);
await writeFile(join(work, "links.json"), `${JSON.stringify(links, null, 2)}\n`);

const survey = Bun.spawn(["java", "-jar", jar], {
  env: environment,
  stdout: "inherit",
  stderr: "inherit",
});
const stop = () => {
  survey.kill();
  stopDatabase();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdout.write(
  `Survey demo: ${base}/\n${Object.entries(links)
    .map(([holder, link]) => `  ${holder}\t${link}`)
    .join("\n")}\n`,
);
const code = await survey.exited;
stopDatabase();
process.exit(code);
