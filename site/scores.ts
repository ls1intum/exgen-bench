import type { MetricCard } from "../src/export/metric-card.ts";
import type { PublicMetricSummary, PublicScore } from "./contracts.ts";

export const ATTEMPT_COLUMNS = [
  "observation_id",
  "case_id",
  "system_id",
  "replicate",
  "lifecycle",
  "outcome",
  "strict_accepted",
  "evaluator_strict_accepted",
  "candidate_produced",
  "generation_completed",
  "cost_usd",
  "generation_duration_seconds",
  "model_calls",
  "total_tokens",
] as const;

export const SCORE_COLUMNS = [
  "observation_id",
  "case_id",
  "system_id",
  "replicate",
  "evaluator_id",
  "metric_id",
  "metric_version",
  "score_status",
  "value",
  "numerator",
  "denominator",
] as const;

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[midpoint - 1] ?? 0) + (ordered[midpoint] ?? 0)) / 2
    : (ordered[midpoint] ?? 0);
}

function summaryKey(score: {
  metric_id: string;
  metric_version: string;
  evaluator_id: string;
  system_id: string;
}): string {
  return `${score.evaluator_id}\0${score.metric_id}\0${score.metric_version}\0${score.system_id}`;
}

export function summarizeScores(scores: PublicScore[]): PublicMetricSummary[] {
  const groups = Map.groupBy(scores, summaryKey);
  return [...groups.keys()].sort().map((key) => {
    const group = groups.get(key) ?? [];
    const first = group[0];
    if (!first) throw new Error("empty score group");
    const count = (status: PublicScore["score_status"]) =>
      group.filter((score) => score.score_status === status).length;
    const values = group.flatMap((score) =>
      score.score_status === "ok" && typeof score.value === "number" ? [score.value] : [],
    );
    return {
      metric_id: first.metric_id,
      metric_version: first.metric_version,
      evaluator_id: first.evaluator_id,
      system_id: first.system_id,
      measured: count("ok"),
      not_applicable: count("not_applicable"),
      quality_failure: count("quality_failure"),
      infra_failure: count("infra_failure"),
      distribution:
        values.length === 0
          ? null
          : {
              mean: mean(values),
              median: median(values),
              minimum: Math.min(...values),
              maximum: Math.max(...values),
            },
    };
  });
}

export function evaluatedObservations(scores: PublicScore[]): Map<string, number> {
  const observations = new Map<string, Set<string>>();
  for (const score of scores) {
    const known = observations.get(score.evaluator_id) ?? new Set<string>();
    known.add(score.observation_id);
    observations.set(score.evaluator_id, known);
  }
  return new Map([...observations].map(([evaluator, known]) => [evaluator, known.size]));
}

export function scoreValueProblem(card: MetricCard, score: PublicScore): string | null {
  if (score.score_status !== "ok") return null;
  const value = score.value;
  switch (card.value_type) {
    case "boolean":
      return typeof value === "boolean" ? null : "expected a boolean value";
    case "string":
      if (typeof value !== "string") return "expected a string value";
      return card.allowed_values === undefined || card.allowed_values.includes(value)
        ? null
        : "value is not among the allowed values";
    case "count":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return "expected a non-negative integer";
      }
      break;
    case "proportion":
      if (typeof value !== "number" || value < 0 || value > 1) {
        return "expected a proportion between 0 and 1";
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a finite number";
      break;
  }
  if (
    card.valid_range !== undefined &&
    typeof value === "number" &&
    (value < card.valid_range.minimum || value > card.valid_range.maximum)
  ) {
    return "value is outside the metric card's valid range";
  }
  return null;
}
