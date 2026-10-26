#!/usr/bin/env bun

import { serveEvaluator } from "../../kit/protocol.ts";
import { evaluateConsistency } from "./evaluate.ts";

if (import.meta.main) {
  await serveEvaluator(evaluateConsistency);
}
