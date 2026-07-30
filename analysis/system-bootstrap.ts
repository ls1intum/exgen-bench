import type { AttemptAnalysisRow } from "../src/export/analysis.ts";
import { mean, quantileType7, resampledClusterMean, seededRandom } from "./bootstrap.ts";

export interface SystemBootstrapResult {
  method: "case_clustered_bootstrap";
  estimand: "end_to_end_within_budget_strict_success_rate";
  system_id: string;
  seed: number;
  resamples: number;
  confidence_level: number;
  cases: number;
  planned_attempts: number;
  observed_rate: number;
  confidence_interval: [number, number];
}

export function systemCaseBootstrap(
  input: AttemptAnalysisRow[],
  options: { seed: number; resamples: number; confidenceLevel?: number },
): SystemBootstrapResult {
  if (input.length === 0) {
    throw new Error("system bootstrap requires at least one planned attempt");
  }
  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1) {
    throw new Error("bootstrap resamples must be a positive integer");
  }
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new Error("confidence level must be between zero and one");
  }
  const systemIds = new Set(input.map((row) => row.system_id));
  if (systemIds.size !== 1) {
    throw new Error("system bootstrap input must contain exactly one system");
  }
  const byCase = new Map<string, number[]>();
  for (const row of input) {
    const outcomes = byCase.get(row.case_id) ?? [];
    outcomes.push(Number(row.strict_success === true));
    byCase.set(row.case_id, outcomes);
  }
  const caseOutcomes = [...byCase.values()];
  const random = seededRandom(options.seed);
  const draws = Array.from({ length: options.resamples }, () =>
    resampledClusterMean(caseOutcomes, random),
  ).sort((left, right) => left - right);
  const alpha = 1 - confidenceLevel;
  const systemId = input[0]?.system_id;
  if (systemId === undefined) {
    throw new Error("system bootstrap has no first row");
  }
  return {
    method: "case_clustered_bootstrap",
    estimand: "end_to_end_within_budget_strict_success_rate",
    system_id: systemId,
    seed: options.seed,
    resamples: options.resamples,
    confidence_level: confidenceLevel,
    cases: caseOutcomes.length,
    planned_attempts: input.length,
    observed_rate: mean(input.map((row) => Number(row.strict_success === true))),
    confidence_interval: [quantileType7(draws, alpha / 2), quantileType7(draws, 1 - alpha / 2)],
  };
}
