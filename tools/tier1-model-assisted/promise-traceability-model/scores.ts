import type { EvaluationScore } from "../../../src/evaluation/contracts.ts";
import type { ModelClaimJudgement } from "./model.ts";

export const METRIC_VERSION = "1";

export const MODEL_ASSISTED_METRICS = [
  "promise.model_claims",
  "promise.model_unwitnessed_claims",
  "promise.model_witnessed_ratio",
] as const;

const MAXIMUM_EVIDENCE_ENTRIES = 48;
const MAXIMUM_EVIDENCE_CHARACTERS = 240;

function evidence(lines: string[]): string[] {
  const kept = lines
    .filter((line) => line.trim() !== "")
    .map((line) =>
      line.length > MAXIMUM_EVIDENCE_CHARACTERS
        ? `${line.slice(0, MAXIMUM_EVIDENCE_CHARACTERS - 1)}…`
        : line,
    );
  return kept.length > MAXIMUM_EVIDENCE_ENTRIES
    ? [
        ...kept.slice(0, MAXIMUM_EVIDENCE_ENTRIES - 1),
        `… ${kept.length - MAXIMUM_EVIDENCE_ENTRIES + 1} further entries omitted`,
      ]
    : kept;
}

function notApplicable(metricId: string, message: string): EvaluationScore {
  return {
    metric_id: metricId,
    metric_version: METRIC_VERSION,
    status: "not_applicable",
    message,
    evidence: [],
  };
}

function modelScore(metricId: string, claims: ModelClaimJudgement[]): EvaluationScore {
  const unwitnessed = claims.filter((claim) => !claim.witnessed);
  const lines = claims.map(
    (claim) =>
      `${claim.witnessed ? "witnessed" : "UNWITNESSED"} ${claim.claim} — ${claim.rationale}`,
  );
  switch (metricId) {
    case "promise.model_claims":
      return {
        metric_id: metricId,
        metric_version: METRIC_VERSION,
        status: "ok",
        value: claims.length,
        evidence: evidence(lines),
      };
    case "promise.model_unwitnessed_claims":
      return {
        metric_id: metricId,
        metric_version: METRIC_VERSION,
        status: "ok",
        value: unwitnessed.length,
        evidence: evidence(lines.filter((line) => line.startsWith("UNWITNESSED"))),
      };
    case "promise.model_witnessed_ratio":
      return claims.length === 0
        ? notApplicable(metricId, "the model extracted no normative claim")
        : {
            metric_id: metricId,
            metric_version: METRIC_VERSION,
            status: "ok",
            value: Number(((claims.length - unwitnessed.length) / claims.length).toFixed(6)),
            numerator: claims.length - unwitnessed.length,
            denominator: claims.length,
            evidence: evidence(lines),
          };
    default:
      return notApplicable(
        metricId,
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
