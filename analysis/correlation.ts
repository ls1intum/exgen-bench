import { midRanks } from "./rank-tests.ts";
import { studentTTwoSided } from "./special-functions.ts";

export interface SpearmanResult {
  method: "spearman_rho";
  pairs: number;
  rho: number;
  tied_x: boolean;
  tied_y: boolean;
  statistic: number;
  degrees_of_freedom: number;
  p_value: number;
}

/**
 * Spearman's rank correlation with tie handling, and the two-sided t approximation for its p-value.
 *
 * H4 relates a generation-side quantity to a quality outcome across cases, so the pair is the case
 * and n is the number of cases, not the number of attempts. The t approximation is adequate from
 * roughly n >= 10; below that the p-value is reported but should not carry a claim, which the metric
 * card records as a limitation.
 */
export function spearmanCorrelation(x: number[], y: number[]): SpearmanResult {
  if (x.length !== y.length) {
    throw new Error("Spearman's rho requires paired observations");
  }
  if (x.length < 3) {
    throw new Error("Spearman's rho requires at least three pairs");
  }
  if ([...x, ...y].some((value) => !Number.isFinite(value))) {
    throw new Error("Spearman's rho requires finite observations");
  }
  const rankedX = midRanks(x);
  const rankedY = midRanks(y);
  const n = x.length;
  const meanRank = (n + 1) / 2;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < n; index += 1) {
    const deviationX = (rankedX[index] ?? Number.NaN) - meanRank;
    const deviationY = (rankedY[index] ?? Number.NaN) - meanRank;
    covariance += deviationX * deviationY;
    varianceX += deviationX * deviationX;
    varianceY += deviationY * deviationY;
  }
  if (varianceX === 0 || varianceY === 0) {
    throw new Error("Spearman's rho is undefined when every value of a variable is tied");
  }
  const rho = covariance / Math.sqrt(varianceX * varianceY);
  const degreesOfFreedom = n - 2;
  const statistic =
    Math.abs(rho) >= 1
      ? Number.POSITIVE_INFINITY
      : rho * Math.sqrt(degreesOfFreedom / (1 - rho * rho));
  return {
    method: "spearman_rho",
    pairs: n,
    rho,
    tied_x: new Set(x).size !== n,
    tied_y: new Set(y).size !== n,
    statistic,
    degrees_of_freedom: degreesOfFreedom,
    p_value: Number.isFinite(statistic) ? studentTTwoSided(statistic, degreesOfFreedom) : 0,
  };
}
