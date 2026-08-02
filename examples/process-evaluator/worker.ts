import { stat } from "node:fs/promises";
import { evaluationRequestSchema } from "../../src/evaluation/contracts.ts";

const request = evaluationRequestSchema.parse(JSON.parse(await Bun.stdin.text()));
const startedAt = new Date();
let bundleReadable = false;
try {
  bundleReadable = (await stat(request.candidate.bundle_path)).isDirectory();
} catch {}
const finishedAt = new Date();
const { bundle_path: _, ...candidate } = request.candidate;

process.stdout.write(
  JSON.stringify({
    protocol_version: "1",
    evaluation_id: request.evaluation_id,
    candidate,
    evaluator: request.evaluator,
    suite: request.suite,
    status: bundleReadable ? "succeeded" : "quality_failed",
    strict_success: bundleReadable,
    ...(bundleReadable ? {} : { failure_category: "candidate.invalid" }),
    scores: request.requested_metrics.map((metricId) => ({
      metric_id: metricId,
      metric_version: "1",
      status: bundleReadable ? "ok" : "quality_failure",
      ...(bundleReadable ? { value: true } : { message: "candidate bundle is not readable" }),
      evidence: [],
    })),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  }),
);
