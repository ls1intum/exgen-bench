#!/usr/bin/env bun

// Scores a run's candidate exercises with a process evaluator, writing the journal where the CLI
// writes it. `evaluate process` verifies a run's whole evidence manifest before scoring, so it
// cannot read a run committed under runs/, whose exported repositories' .git directories had to be
// removed for git to track them. See https://github.com/ls1intum/exgen-bench/issues/17.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import {
  evaluationRequestSchema,
  evaluationResponseSchema,
  type EvaluationRequest,
  type EvaluationResponse,
} from "../src/evaluation/contracts.ts";
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";

const runPath = process.argv[2];
const configPath = process.argv[3];
if (runPath === undefined || configPath === undefined) {
  process.stderr.write("usage: bun run scripts/score-run.ts <run-dir> <evaluator-config>\n");
  process.exit(2);
}

const runDirectory = resolve(runPath);
const configDirectory = resolve(configPath, "..");
const config = processEvaluatorConfigSchema.parse(parse(await readFile(configPath, "utf8")));
const manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8")) as {
  run_id: string;
};

async function score(attemptId: string): Promise<EvaluationResponse | undefined> {
  const attempt = join(runDirectory, "attempts", attemptId);
  const observation = JSON.parse(await readFile(join(attempt, "observation.json"), "utf8")) as {
    artifact_digest?: string;
    response?: { capture?: { completeness?: "complete" | "partial" } };
  };
  if (observation.artifact_digest === undefined) {
    return undefined;
  }
  const [caseId, systemId, replicate] = attemptId.split("--");
  const request: EvaluationRequest = evaluationRequestSchema.parse({
    protocol_version: "1",
    evaluation_id: createHash("sha256")
      .update(`${manifest.run_id}/${attemptId}/${config.evaluator.id}`)
      .digest("hex"),
    candidate: {
      experiment_id: manifest.run_id,
      attempt_id: attemptId,
      generation_key: observation.artifact_digest,
      case_id: caseId,
      system_id: systemId,
      replicate: Number((replicate ?? "r001").replace("r", "")),
      artifact_digest: observation.artifact_digest,
      capture_completeness: observation.response?.capture?.completeness ?? "complete",
      bundle_path: join(attempt, "output"),
    },
    evaluator: config.evaluator,
    suite: config.suite,
    requested_metrics: [...config.requested_metrics].sort(),
    timeout_ms: config.execution.timeout_ms,
  });
  const argv = config.process.argv.map((token) =>
    token === "{bun}" ? (process.execPath as string) : token,
  );
  const subprocess = Bun.spawn(argv, {
    cwd: configDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  subprocess.stdin.write(JSON.stringify(request));
  subprocess.stdin.end();
  const [exitCode, body] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${attemptId}: evaluator exited ${exitCode}`);
  }
  return evaluationResponseSchema.parse(JSON.parse(body));
}

const responses: EvaluationResponse[] = [];
for (const entry of (await readdir(join(runDirectory, "attempts"))).sort()) {
  const response = await score(entry);
  if (response !== undefined) {
    responses.push(response);
  }
}

const outputDirectory = join(runDirectory, "evaluations");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  join(outputDirectory, `${config.evaluator.id}.jsonl`),
  `${responses.map((response) => JSON.stringify(response)).join("\n")}\n`,
  "utf8",
);
process.stdout.write(`scored ${responses.length} candidate exercise(s) in ${manifest.run_id}\n`);
