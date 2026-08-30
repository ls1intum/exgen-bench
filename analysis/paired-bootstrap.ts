import type { PairedAnalysisRow } from "../src/export/analysis.ts";
import { mean, percentileInterval, resampledClusterMean, seededRandom } from "./bootstrap.ts";
import type { ClusteredObservation } from "./wild-cluster-bootstrap.ts";

export interface PairedBootstrapResult {
  method: "case_clustered_paired_bootstrap";
  /** `degenerate` means every case showed the same difference, so the interval is a point and
   * carries no coverage. There is no binomial fallback for a difference. */
  interval_method: "percentile_bootstrap" | "degenerate";
  estimand: "end_to_end_within_budget_strict_success_rate_difference";
  system_a: string;
  system_b: string;
  seed: number;
  resamples: number;
  confidence_level: number;
  cases: number;
  complete_attempt_pairs: number;
  pairs_with_both_quality_outcomes: number;
  observed_difference: number;
  confidence_interval: [number, number];
}

/**
 * The same complete pairs `pairedCaseBootstrap` resamples, reshaped as one observation per arm per
 * case rather than a per-case difference -- what `wildClusterBootstrapTest`'s two-arm design needs.
 * An incomplete pair contributes nothing to either estimator, for the same reason: an attempt with no
 * quality verdict is not evidence about a difference.
 */
export function pairedClusteredObservations(input: PairedAnalysisRow[]): ClusteredObservation[] {
  return input
    .filter(
      (
        row,
      ): row is PairedAnalysisRow & {
        strict_success_a: number;
        strict_success_b: number;
      } => row.pair_complete && row.strict_success_a !== null && row.strict_success_b !== null,
    )
    .flatMap((row) => [
      { cluster_id: row.case_id, treatment: 1 as const, outcome: row.strict_success_a },
      { cluster_id: row.case_id, treatment: 0 as const, outcome: row.strict_success_b },
    ]);
}

export function pairedCaseBootstrap(
  input: PairedAnalysisRow[],
  options: { seed: number; resamples: number; confidenceLevel?: number },
): PairedBootstrapResult {
  const rows = input.filter(
    (
      row,
    ): row is PairedAnalysisRow & {
      strict_success_a: number;
      strict_success_b: number;
    } => row.strict_success_a !== null && row.strict_success_b !== null,
  );
  if (rows.length === 0) {
    throw new Error("paired bootstrap requires at least one complete pair");
  }
  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1) {
    throw new Error("bootstrap resamples must be a positive integer");
  }
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new Error("confidence level must be between zero and one");
  }
  const systems = new Set(rows.flatMap((row) => [row.system_a, row.system_b]));
  if (systems.size !== 2) {
    throw new Error("paired bootstrap input must contain exactly one system comparison");
  }

  const byCase = new Map<string, number[]>();
  for (const row of rows) {
    const effects = byCase.get(row.case_id) ?? [];
    effects.push(row.strict_success_a - row.strict_success_b);
    byCase.set(row.case_id, effects);
  }
  const caseEffects = [...byCase.values()];
  const random = seededRandom(options.seed);
  const draws = Array.from({ length: options.resamples }, () =>
    resampledClusterMean(caseEffects, random),
  );
  const percentile = percentileInterval(draws, confidenceLevel);
  const first = rows[0];
  if (!first) {
    throw new Error("paired bootstrap has no first row");
  }
  return {
    method: "case_clustered_paired_bootstrap",
    estimand: "end_to_end_within_budget_strict_success_rate_difference",
    system_a: first.system_a,
    system_b: first.system_b,
    seed: options.seed,
    resamples: options.resamples,
    confidence_level: confidenceLevel,
    cases: caseEffects.length,
    complete_attempt_pairs: rows.length,
    pairs_with_both_quality_outcomes: rows.filter(
      (row) => row.quality_outcome_available_a && row.quality_outcome_available_b,
    ).length,
    observed_difference: mean(rows.map((row) => row.strict_success_a - row.strict_success_b)),
    interval_method: percentile.degenerate ? "degenerate" : "percentile_bootstrap",
    confidence_interval: percentile.interval,
  };
}
