#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import {
  evaluationRequestSchema,
  evaluationResponseSchema,
  type EvaluationRequest,
  type EvaluationResponse,
} from "../src/evaluation/contracts.ts";
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";

const corpusPath = process.argv[2];
const configPath = process.argv[3];
if (corpusPath === undefined || configPath === undefined) {
  process.stderr.write("usage: bun run scripts/score-corpus.ts <corpus-dir> <evaluator-config>\n");
  process.exit(2);
}

const corpusDirectory = resolve(corpusPath);
const configDirectory = resolve(configPath, "..");
const config = processEvaluatorConfigSchema.parse(parse(await readFile(configPath, "utf8")));
const manifest = JSON.parse(await readFile(join(corpusDirectory, "manifest.json"), "utf8")) as {
  id: string;
  entries: {
    slug: string;
    case_id: string;
    system_id: string;
    has_candidate: boolean;
    artifact_digest: string | null;
  }[];
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function score(entry: (typeof manifest.entries)[number]): Promise<EvaluationResponse> {
  const bundlePath = join(corpusDirectory, "attempts", entry.slug);
  const candidate = {
    experiment_id: manifest.id,
    attempt_id: entry.slug,
    generation_key: entry.artifact_digest as string,
    case_id: entry.case_id,
    system_id: entry.system_id,
    replicate: 1,
    artifact_digest: entry.artifact_digest as string,
    capture_completeness: "complete",
    bundle_path: bundlePath,
  } as const;
  const request: EvaluationRequest = evaluationRequestSchema.parse({
    protocol_version: "1",
    evaluation_id: digest(`${manifest.id}/${entry.slug}/${config.evaluator.id}`),
    candidate,
    evaluator: config.evaluator,
    suite: config.suite,
    requested_metrics: config.requested_metrics,
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
    throw new Error(`${entry.slug}: evaluator exited ${exitCode}`);
  }
  return evaluationResponseSchema.parse(JSON.parse(body));
}

const responses: EvaluationResponse[] = [];
for (const entry of manifest.entries.filter((entry) => entry.has_candidate)) {
  responses.push(await score(entry));
}

const outputDirectory = join(corpusDirectory, "evaluations");
await mkdir(outputDirectory, { recursive: true });
const journal = `${responses.map((response) => JSON.stringify(response)).join("\n")}\n`;
await writeFile(join(outputDirectory, `${config.evaluator.id}.jsonl`), journal, "utf8");

const failed = responses.filter((response) => response.status !== "succeeded");
process.stdout.write(
  `scored ${responses.length} candidate(s) from ${manifest.id}` +
    `${failed.length === 0 ? "" : `, ${failed.length} not succeeded`}\n`,
);
