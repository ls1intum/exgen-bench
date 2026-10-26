#!/usr/bin/env bun

import { notApplicable, serveEvaluator } from "../../kit/protocol.ts";
import { METRIC_VERSION } from "./rubric.ts";

const NOT_IMPLEMENTED = "the Tier 2 LLM judge is a skeleton and makes no judgement";

/**
 * Skeleton: answers every request in protocol and measures nothing. Without a gate every answer is
 * `strict_success: true`, so a release must declare another evaluator authoritative.
 */
if (import.meta.main) {
  await serveEvaluator(async (request) => ({
    gate: null,
    scores: request.requested_metrics.map((metricId) =>
      notApplicable(metricId, METRIC_VERSION, NOT_IMPLEMENTED),
    ),
  }));
}
