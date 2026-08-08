import { holmAdjust } from "./multiplicity.ts";
import { chiSquareSurvival, fSurvival, studentizedRangeSurvival } from "./special-functions.ts";

export interface BlockObservation {
  block_id: string;
  treatment_id: string;
  value: number;
}

/** Mid-ranks, ascending: tied values share the mean of the ranks they occupy. */
export function midRanks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (
      end + 1 < order.length &&
      (order[end + 1]?.value ?? Number.NaN) === (order[position]?.value ?? Number.NaN)
    ) {
      end += 1;
    }
    const shared = (position + end) / 2 + 1;
    for (let index = position; index <= end; index += 1) {
      const entry = order[index];
      if (entry !== undefined) {
        ranks[entry.index] = shared;
      }
    }
    position = end + 1;
  }
  return ranks.map((rank) => rank ?? Number.NaN);
}

export interface FriedmanResult {
  method: "friedman_tie_corrected";
  blocks: number;
  treatments: number;
  average_ranks: Array<{ treatment_id: string; average_rank: number }>;
  statistic: number;
  degrees_of_freedom: number;
  p_value: number;
  iman_davenport: {
    statistic: number;
    numerator_degrees_of_freedom: number;
    denominator_degrees_of_freedom: number;
    p_value: number;
  };
}

interface RankedDesign {
  blocks: string[];
  treatments: string[];
  rankSums: Map<string, number>;
  sumOfSquaredRanks: number;
}

function rankCompleteBlockDesign(observations: BlockObservation[]): RankedDesign {
  const treatments = [...new Set(observations.map((row) => row.treatment_id))].sort();
  const blocks = [...new Set(observations.map((row) => row.block_id))].sort();
  if (treatments.length < 2) {
    throw new Error("a blocked rank test requires at least two treatments");
  }
  if (blocks.length < 2) {
    throw new Error("a blocked rank test requires at least two blocks");
  }
  if (observations.length !== treatments.length * blocks.length) {
    throw new Error("a blocked rank test requires exactly one observation per block and treatment");
  }
  const byBlock = new Map<string, Map<string, number>>();
  for (const row of observations) {
    const cells = byBlock.get(row.block_id) ?? new Map<string, number>();
    if (cells.has(row.treatment_id)) {
      throw new Error(
        `duplicate observation for block ${row.block_id} and treatment ${row.treatment_id}`,
      );
    }
    if (!Number.isFinite(row.value)) {
      throw new Error("a blocked rank test requires finite observations");
    }
    cells.set(row.treatment_id, row.value);
    byBlock.set(row.block_id, cells);
  }
  const rankSums = new Map<string, number>(treatments.map((treatment) => [treatment, 0]));
  let sumOfSquaredRanks = 0;
  for (const block of blocks) {
    const cells = byBlock.get(block);
    if (cells === undefined || cells.size !== treatments.length) {
      throw new Error(`block ${block} does not observe every treatment`);
    }
    const ranks = midRanks(treatments.map((treatment) => cells.get(treatment) ?? Number.NaN));
    treatments.forEach((treatment, index) => {
      const rank = ranks[index] ?? Number.NaN;
      rankSums.set(treatment, (rankSums.get(treatment) ?? 0) + rank);
      sumOfSquaredRanks += rank * rank;
    });
  }
  return { blocks, treatments, rankSums, sumOfSquaredRanks };
}

/**
 * Friedman test for a complete block design, in Conover's tie-corrected form, with the
 * Iman-Davenport F refinement that Demsar (2006) recommends over the conservative chi-square.
 *
 * Blocks are cases and treatments are systems: this is the omnibus test H2 needs before any pairwise
 * statement is admissible.
 */
export function friedmanTest(observations: BlockObservation[]): FriedmanResult {
  const design = rankCompleteBlockDesign(observations);
  const n = design.blocks.length;
  const k = design.treatments.length;
  // Conover's tie-corrected form: T1 = (k - 1) (sum R_j^2 - n C1) / (A1 - C1), with
  // C1 = n k (k + 1)^2 / 4 the null expectation and A1 the sum of squared cell ranks. Without ties
  // A1 - C1 collapses to n k (k + 1) (k - 1) / 12 and T1 to the classical Friedman statistic.
  const c1 = (n * k * (k + 1) * (k + 1)) / 4;
  const sumOfSquaredRankSums = design.treatments.reduce((total, treatment) => {
    const sum = design.rankSums.get(treatment) ?? 0;
    return total + sum * sum;
  }, 0);
  const within = design.sumOfSquaredRanks - c1;
  const statistic = within === 0 ? 0 : ((k - 1) * (sumOfSquaredRankSums - n * c1)) / within;
  const degreesOfFreedom = k - 1;
  const imanDenominator = n * (k - 1) - statistic;
  const imanStatistic =
    imanDenominator <= 0 ? Number.POSITIVE_INFINITY : ((n - 1) * statistic) / imanDenominator;
  return {
    method: "friedman_tie_corrected",
    blocks: n,
    treatments: k,
    average_ranks: design.treatments.map((treatment) => ({
      treatment_id: treatment,
      average_rank: (design.rankSums.get(treatment) ?? 0) / n,
    })),
    statistic,
    degrees_of_freedom: degreesOfFreedom,
    p_value: chiSquareSurvival(statistic, degreesOfFreedom),
    iman_davenport: {
      statistic: imanStatistic,
      numerator_degrees_of_freedom: k - 1,
      denominator_degrees_of_freedom: (k - 1) * (n - 1),
      p_value: Number.isFinite(imanStatistic)
        ? fSurvival(imanStatistic, k - 1, (k - 1) * (n - 1))
        : 0,
    },
  };
}

export interface NemenyiComparison {
  treatment_a: string;
  treatment_b: string;
  average_rank_a: number;
  average_rank_b: number;
  rank_difference: number;
  statistic: number;
  p_value: number;
  holm_adjusted_p_value: number;
  exceeds_critical_difference: boolean;
}

export interface NemenyiResult {
  method: "nemenyi_studentized_range";
  blocks: number;
  treatments: number;
  alpha: number;
  standard_error: number;
  critical_difference: number;
  comparisons: NemenyiComparison[];
}

/**
 * Nemenyi post-hoc test over the Friedman average ranks, with Holm-adjusted p-values alongside the
 * critical difference.
 *
 * The two are reported together deliberately: the critical difference is what a CD diagram draws,
 * and the Holm-adjusted p-values are what a claim about a specific pair should rest on. Reporting
 * only the diagram invites reading a non-overlap as a per-pair test, which it is not.
 */
export function nemenyiPostHoc(
  observations: BlockObservation[],
  options: { alpha?: number } = {},
): NemenyiResult {
  const alpha = options.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error("alpha must be between zero and one");
  }
  const friedman = friedmanTest(observations);
  const n = friedman.blocks;
  const k = friedman.treatments;
  const standardError = Math.sqrt((k * (k + 1)) / (6 * n));
  const raw: Array<{
    label: { a: string; b: string; rankA: number; rankB: number; statistic: number };
    p_value: number;
  }> = [];
  for (let left = 0; left < k; left += 1) {
    for (let right = left + 1; right < k; right += 1) {
      const a = friedman.average_ranks[left];
      const b = friedman.average_ranks[right];
      if (a === undefined || b === undefined) {
        continue;
      }
      const statistic = Math.abs(a.average_rank - b.average_rank) / standardError;
      raw.push({
        label: {
          a: a.treatment_id,
          b: b.treatment_id,
          rankA: a.average_rank,
          rankB: b.average_rank,
          statistic,
        },
        p_value: studentizedRangeSurvival(statistic * Math.SQRT2, k),
      });
    }
  }
  const adjusted = holmAdjust(raw);
  const criticalDifference = criticalRangeQuantile(alpha, k) * standardError;
  return {
    method: "nemenyi_studentized_range",
    blocks: n,
    treatments: k,
    alpha,
    standard_error: standardError,
    critical_difference: criticalDifference,
    comparisons: adjusted.map((entry) => ({
      treatment_a: entry.label.a,
      treatment_b: entry.label.b,
      average_rank_a: entry.label.rankA,
      average_rank_b: entry.label.rankB,
      rank_difference: entry.label.rankA - entry.label.rankB,
      statistic: entry.label.statistic,
      p_value: entry.p_value,
      holm_adjusted_p_value: entry.adjusted_p_value,
      exceeds_critical_difference:
        Math.abs(entry.label.rankA - entry.label.rankB) > criticalDifference,
    })),
  };
}

/**
 * The Nemenyi critical value q_alpha: the studentized range quantile with infinite degrees of
 * freedom divided by sqrt(2). Solved by bisection rather than read from a printed table so that any
 * alpha is available and no transcription error can enter.
 */
export function criticalRangeQuantile(alpha: number, treatments: number): number {
  let lower = 0;
  let upper = 20;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (studentizedRangeSurvival(middle, treatments) > alpha) {
      lower = middle;
    } else {
      upper = middle;
    }
  }
  return (lower + upper) / 2 / Math.SQRT2;
}
