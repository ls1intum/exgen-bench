#!/usr/bin/env bun

import { notApplicable, serveEvaluator } from "../../kit/protocol.ts";
import { METRIC_VERSION } from "./rubric.ts";

const NOT_IMPLEMENTED = "the Tier 2 LLM judge is a skeleton; no rubric judgement is made yet";

/**
 * Skeleton: answers every request in protocol and measures nothing. The gate is null, so the judge
 * can never decide acceptance; declare another evaluator authoritative for `strict_success`.
 */
if (import.meta.main) {
  await serveEvaluator(async (request) => ({
    gate: null,
    scores: request.requested_metrics.map((metricId) =>
      notApplicable(metricId, METRIC_VERSION, NOT_IMPLEMENTED),
    ),
  }));
}
