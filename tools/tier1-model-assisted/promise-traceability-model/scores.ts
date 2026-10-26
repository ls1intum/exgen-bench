import type { EvaluationScore } from "../../../src/evaluation/contracts.ts";
import { boundedEvidence, notApplicable, score } from "../../kit/protocol.ts";
import type { ModelClaimJudgement } from "./model.ts";

export const METRIC_VERSION = "2";

export const MODEL_ASSISTED_METRICS = [
  "promise.model_claims",
  "promise.model_unwitnessed_claims",
  "promise.model_witnessed_ratio",
] as const;

function modelScore(metricId: string, claims: ModelClaimJudgement[]): EvaluationScore {
  const unwitnessed = claims.filter((claim) => !claim.witnessed);
  const lines = claims.map(
    (claim) =>
      `${claim.witnessed ? "witnessed" : "UNWITNESSED"} ${claim.claim} — ${claim.rationale}`,
  );
  switch (metricId) {
    case "promise.model_claims":
      return score(metricId, METRIC_VERSION, claims.length, { evidence: boundedEvidence(lines) });
    case "promise.model_unwitnessed_claims":
      return score(metricId, METRIC_VERSION, unwitnessed.length, {
        evidence: boundedEvidence(lines.filter((line) => line.startsWith("UNWITNESSED"))),
      });
    case "promise.model_witnessed_ratio":
      return claims.length === 0
        ? notApplicable(metricId, METRIC_VERSION, "the model extracted no normative claim")
        : score(
            metricId,
            METRIC_VERSION,
            Number(((claims.length - unwitnessed.length) / claims.length).toFixed(6)),
            {
              numerator: claims.length - unwitnessed.length,
              denominator: claims.length,
              evidence: boundedEvidence(lines),
            },
          );
    default:
      return notApplicable(
        metricId,
        METRIC_VERSION,
        `${metricId} is not produced by the promise-traceability-model evaluator`,
      );
  }
}

export function buildModelScores(
  requestedMetrics: string[],
  claims: ModelClaimJudgement[],
): EvaluationScore[] {
  return requestedMetrics.map((metricId) => modelScore(metricId, claims));
}
