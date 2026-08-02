import { evaluationRequestSchema } from "../../src/evaluation/contracts.ts";

const mode = process.argv[2];
const markerPath = process.argv[3];
const input = JSON.parse(await Bun.stdin.text()) as unknown;
const request = evaluationRequestSchema.parse(
  typeof input === "object" && input !== null && "request" in input ? input.request : input,
);

if (mode === "recover") {
  if (!markerPath) {
    throw new Error("recover mode requires a marker path");
  }
  await Bun.write(markerPath, request.evaluation_id);
} else if (mode === "recovery-fails") {
  process.exitCode = 1;
} else if (mode === "hang") {
  if (!markerPath) {
    throw new Error("hang mode requires a marker path");
  }
  await Bun.write(markerPath, String(process.pid));
  process.on("SIGTERM", () => undefined);
  await new Promise(() => undefined);
} else if (mode === "oversized") {
  process.stdout.write("x".repeat(1024 * 1024));
} else {
  const { bundle_path: _, ...candidate } = request.candidate;
  process.stdout.write(
    JSON.stringify({
      protocol_version: "1",
      evaluation_id: request.evaluation_id,
      candidate,
      evaluator: request.evaluator,
      suite: request.suite,
      status: "succeeded",
      strict_success: true,
      scores: request.requested_metrics.map((metricId) => ({
        metric_id: metricId,
        metric_version: "1",
        status: "ok",
        value: true,
        evidence: [],
      })),
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:00.001Z",
      duration_ms: 1,
      ...(mode === "invalid" ? { unexpected: true } : {}),
    }),
  );
}
