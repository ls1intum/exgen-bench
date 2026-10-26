#!/usr/bin/env bun

import { serveEvaluator } from "../../kit/protocol.ts";
import { readStatementAndTests } from "../../kit/statement-and-tests.ts";
import { buildScores, METRIC_VERSION } from "./scores.ts";
import { trace } from "./traceability.ts";

if (import.meta.main) {
  await serveEvaluator(
    async (request) => {
      const bundle = await readStatementAndTests(request.candidate.bundle_path);
      const report = trace(bundle.problemStatement, bundle.testFiles);
      return { gate: null, scores: buildScores(request.requested_metrics, report) };
    },
    { metricVersion: METRIC_VERSION },
  );
}
