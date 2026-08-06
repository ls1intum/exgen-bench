import type { EvaluationRequest } from "../../src/evaluation/contracts.ts";
import { readCandidateBundle } from "../shared/bundle.ts";
import { score, type EvaluationOutcome } from "../shared/protocol.ts";
import { checkConsistency } from "./check.ts";

export const CONSISTENCY_METRIC_VERSION = "1";

export const CONSISTENCY_METRICS = [
  "consistency.residual_count",
  "consistency.ungrounded_statement_identifiers",
  "consistency.unmentioned_public_api",
  "consistency.contradicted_constructs",
  "consistency.unsupported_statement_values",
  "consistency.satisfied",
] as const;

/**
 * The cross-artifact consistency evaluator.
 *
 * Its verdict is its own: `consistency.satisfied` gates *this* evaluator's `strict_success` and never
 * the benchmark's, which stays with `java-oracle`. An exercise can be perfectly buildable and still
 * describe something other than what it tests, and the design wants both facts recorded separately.
 */
export async function evaluateConsistency(request: EvaluationRequest): Promise<EvaluationOutcome> {
  const bundle = await readCandidateBundle(request.candidate.bundle_path);
  const report = checkConsistency(bundle);
  const evidence = report.residuals
    .slice(0, 32)
    .map((residual) => `${residual.kind}:${residual.detail}`);
  const satisfied = report.residuals.length === 0;
  return {
    gate: { metricId: "consistency.satisfied", satisfied },
    scores: [
      score("consistency.residual_count", CONSISTENCY_METRIC_VERSION, report.residuals.length, {
        evidence,
      }),
      score(
        "consistency.ungrounded_statement_identifiers",
        CONSISTENCY_METRIC_VERSION,
        report.counts.ungrounded_statement_identifier,
      ),
      score(
        "consistency.unmentioned_public_api",
        CONSISTENCY_METRIC_VERSION,
        report.counts.unmentioned_public_api,
      ),
      score(
        "consistency.contradicted_constructs",
        CONSISTENCY_METRIC_VERSION,
        report.counts.contradicted_construct,
      ),
      score(
        "consistency.unsupported_statement_values",
        CONSISTENCY_METRIC_VERSION,
        report.counts.unsupported_statement_value,
      ),
      {
        metric_id: "consistency.satisfied",
        metric_version: CONSISTENCY_METRIC_VERSION,
        status: "ok" as const,
        value: satisfied,
        ...(satisfied
          ? {}
          : {
              message: report.residuals
                .map((residual) => residual.detail)
                .join("; ")
                .slice(0, 900),
            }),
        evidence,
      },
    ],
  };
}
