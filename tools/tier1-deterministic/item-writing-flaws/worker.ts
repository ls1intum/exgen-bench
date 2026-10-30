#!/usr/bin/env bun

import { serveEvaluator } from "../../kit/protocol.ts";
import { evaluateFlaws, FLAWS_METRIC_VERSION } from "./evaluate.ts";

if (import.meta.main) {
  await serveEvaluator(evaluateFlaws, { metricVersion: FLAWS_METRIC_VERSION });
}
