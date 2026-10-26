#!/usr/bin/env bun

import { serveEvaluator } from "../../kit/protocol.ts";
import { CONSISTENCY_METRIC_VERSION, evaluateConsistency } from "./evaluate.ts";

if (import.meta.main) {
  await serveEvaluator(evaluateConsistency, { metricVersion: CONSISTENCY_METRIC_VERSION });
}
