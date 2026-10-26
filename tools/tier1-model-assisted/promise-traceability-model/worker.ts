#!/usr/bin/env bun

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { z } from "zod";
import { InfrastructureError, serveEvaluator } from "../../kit/protocol.ts";
import { readStatementAndTests } from "../../kit/statement-and-tests.ts";
import { chatCompletion, judgeClaims } from "./model.ts";
import { buildModelScores, METRIC_VERSION } from "./scores.ts";

const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
const timeoutMs = z.coerce.number().int().positive().max(600_000);

if (import.meta.main) {
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

  await serveEvaluator(
    async (request) => {
      const bundle = await readStatementAndTests(request.candidate.bundle_path);
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
      if (model.status === "failed") {
        throw new InfrastructureError(model.message);
      }
      return { gate: null, scores: buildModelScores(request.requested_metrics, model.claims) };
    },
    { metricVersion: METRIC_VERSION },
  );
}
