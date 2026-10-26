#!/usr/bin/env bun

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { z } from "zod";
import {
  type EvaluationFailureCategory,
  type EvaluationRequest,
  type EvaluationResponse,
  type EvaluationScore,
  evaluationRequestSchema,
  evaluationResponseSchema,
} from "../../../src/evaluation/contracts.ts";
import { BundleIncomplete, readCandidateBundle } from "../../kit/statement-and-tests.ts";
import { chatCompletion, judgeClaims } from "./model.ts";
import { buildModelScores, METRIC_VERSION } from "./scores.ts";

const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
const timeoutMs = z.coerce.number().int().positive().max(600_000);

// stdout carries the evaluation response, so anything commander would print goes to stderr.
const options = new Command()
  .configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  })
  .description(
    "Extract normative claims with a language model and judge whether the tests witness them. Reads a request on stdin.",
  )
  .requiredOption("--model <id>", "model identifier sent to the endpoint")
  .requiredOption("--base-url <url>", "OpenAI-compatible endpoint")
  .option("--model-timeout-ms <ms>", "per-request budget for the model", (value) => {
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
    | {
        status: "quality_failed" | "infra_failed";
        category: EvaluationFailureCategory;
        message: string;
      },
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
  const model = await judgeClaims(
    chatCompletion({
      baseUrl: options.baseUrl,
      model: options.model,
      apiKey: process.env.PROMISE_TRACEABILITY_API_KEY,
      timeoutMs: options.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    }),
    bundle.problemStatement,
    bundle.testFiles.map((file) => `// ${file.path}\n${file.text}`).join("\n\n"),
  );
  // The model is this evaluator's only instrument, so a model failure measured nothing: it is an
  // infrastructure failure the journal may retry, never a verdict about the candidate.
  response =
    model.status === "ok"
      ? respond(request, startedAt, monotonic, {
          status: "succeeded",
          scores: buildModelScores(request.requested_metrics, model.claims),
        })
      : respond(request, startedAt, monotonic, {
          status: "infra_failed",
          category: "infrastructure.unavailable",
          message: model.message,
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
