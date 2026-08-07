#!/usr/bin/env bun

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { z } from "zod";
import {
  type EvaluationRequest,
  type EvaluationResponse,
  type EvaluationScore,
  evaluationRequestSchema,
  evaluationResponseSchema,
} from "../../src/evaluation/contracts.ts";
import { BundleIncomplete, readCandidateBundle } from "./bundle.ts";
import { chatCompletion, judgeClaims, type ModelLayerOutcome } from "./model.ts";
import { buildScores, METRIC_VERSION } from "./scores.ts";
import { trace } from "./traceability.ts";

const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
const timeoutMs = z.coerce.number().int().positive().max(600_000);

// stdout carries the evaluation response, so anything commander would print goes to stderr.
const options = new Command()
  .configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  })
  .description("Score one candidate exercise for promise traceability. Reads a request on stdin.")
  .option("--model <id>", "enable the exploratory model-assisted layer with this model")
  .option("--base-url <url>", "OpenAI-compatible endpoint, required with --model")
  .option("--model-timeout-ms <ms>", "per-request budget for the model-assisted layer", (value) => {
    const parsed = timeoutMs.safeParse(value);
    if (!parsed.success)
      throw new InvalidArgumentError("expected a positive integer of milliseconds");
    return parsed.data;
  })
  .parse()
  .opts();

function respond(
  request: EvaluationRequest,
  startedAt: string,
  monotonic: number,
  outcome:
    | { status: "succeeded"; scores: EvaluationScore[] }
    | { status: "quality_failed" | "infra_failed"; category: string; message: string },
): EvaluationResponse {
  const { bundle_path: _bundlePath, ...candidate } = request.candidate;
  const scores =
    outcome.status === "succeeded"
      ? outcome.scores
      : request.requested_metrics.map((metricId) => ({
          metric_id: metricId,
          metric_version: METRIC_VERSION,
          status:
            outcome.status === "quality_failed"
              ? ("quality_failure" as const)
              : ("infra_failure" as const),
          message: outcome.message,
          evidence: [],
        }));
  return evaluationResponseSchema.parse({
    protocol_version: "1",
    evaluation_id: request.evaluation_id,
    candidate,
    evaluator: request.evaluator,
    suite: request.suite,
    status: outcome.status,
    strict_success:
      outcome.status === "succeeded" ? true : outcome.status === "quality_failed" ? false : null,
    ...(outcome.status === "succeeded" ? {} : { failure_category: outcome.category }),
    scores,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: Math.round(Math.max(0, performance.now() - monotonic)),
  });
}

const startedAt = new Date().toISOString();
const monotonic = performance.now();
const request = evaluationRequestSchema.parse(JSON.parse(await Bun.stdin.text()));

let response: EvaluationResponse;
try {
  const bundle = await readCandidateBundle(request.candidate.bundle_path);
  const report = trace(bundle.problemStatement, bundle.testFiles);
  let model: ModelLayerOutcome | undefined;
  if (options.model !== undefined) {
    model =
      options.baseUrl === undefined
        ? { status: "failed", message: "--model requires --base-url" }
        : await judgeClaims(
            chatCompletion({
              baseUrl: options.baseUrl,
              model: options.model,
              apiKey: process.env.PROMISE_TRACEABILITY_API_KEY,
              timeoutMs: options.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
            }),
            bundle.problemStatement,
            bundle.testFiles.map((file) => `// ${file.path}\n${file.text}`).join("\n\n"),
          );
  }
  response = respond(request, startedAt, monotonic, {
    status: "succeeded",
    scores: buildScores(request.requested_metrics, report, model),
  });
} catch (error) {
  response =
    error instanceof BundleIncomplete
      ? respond(request, startedAt, monotonic, {
          status: "quality_failed",
          category: "candidate.incomplete",
          message: error.message,
        })
      : respond(request, startedAt, monotonic, {
          status: "infra_failed",
          category: "evaluator.crashed",
          message: error instanceof Error ? error.message : String(error),
        });
}

process.stdout.write(JSON.stringify(response));
