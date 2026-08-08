import { logBinomialCoefficient, logFactorial } from "./special-functions.ts";

export interface McNemarResult {
  method: "mcnemar_exact";
  discordant_positive: number;
  discordant_negative: number;
  discordant_pairs: number;
  concordant_pairs: number;
  proportion_difference: number;
  p_value: number;
}

/**
 * Exact McNemar test for paired binary outcomes.
 *
 * `positiveOnly` counts pairs where system A succeeded and system B did not; `negativeOnly` the
 * reverse. The exact test is the two-sided binomial test on the discordant pairs at p = 1/2, which
 * is what the design requires: the asymptotic chi-square version is not defensible at the
 * discordant-pair counts a 19-30 case benchmark produces.
 */
export function mcnemarExact(
  positiveOnly: number,
  negativeOnly: number,
  concordantPairs = 0,
): McNemarResult {
  if (
    !Number.isInteger(positiveOnly) ||
    !Number.isInteger(negativeOnly) ||
    !Number.isInteger(concordantPairs) ||
    positiveOnly < 0 ||
    negativeOnly < 0 ||
    concordantPairs < 0
  ) {
    throw new Error("McNemar counts must be non-negative integers");
  }
  const discordant = positiveOnly + negativeOnly;
  const total = discordant + concordantPairs;
  let pValue: number;
  if (discordant === 0) {
    pValue = 1;
  } else {
    const smaller = Math.min(positiveOnly, negativeOnly);
    let tail = 0;
    for (let successes = 0; successes <= smaller; successes += 1) {
      tail += Math.exp(logBinomialCoefficient(discordant, successes) - discordant * Math.LN2);
    }
    pValue = Math.min(1, 2 * tail);
  }
  return {
    method: "mcnemar_exact",
    discordant_positive: positiveOnly,
    discordant_negative: negativeOnly,
    discordant_pairs: discordant,
    concordant_pairs: concordantPairs,
    proportion_difference: total === 0 ? 0 : (positiveOnly - negativeOnly) / total,
    p_value: pValue,
  };
}

export interface FisherResult {
  method: "fisher_exact";
  table: [[number, number], [number, number]];
  odds_ratio: number | null;
  p_value_two_sided: number;
  p_value_greater: number;
  p_value_less: number;
}

function hypergeometricLogProbability(
  a: number,
  rowOne: number,
  rowTwo: number,
  columnOne: number,
): number {
  return (
    logBinomialCoefficient(rowOne, a) +
    logBinomialCoefficient(rowTwo, columnOne - a) -
    logBinomialCoefficient(rowOne + rowTwo, columnOne)
  );
}

/**
 * Fisher's exact test on a 2x2 table [[a, b], [c, d]].
 *
 * The two-sided p-value uses the conventional sum of all tables no more probable than the observed
 * one, with a relative tolerance so that floating-point ties are not silently dropped.
 */
export function fisherExact(table: [[number, number], [number, number]]): FisherResult {
  const [[a, b], [c, d]] = table;
  for (const count of [a, b, c, d]) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("Fisher's exact test requires non-negative integer cell counts");
    }
  }
  const rowOne = a + b;
  const rowTwo = c + d;
  const columnOne = a + c;
  const total = rowOne + rowTwo;
  if (total === 0) {
    throw new Error("Fisher's exact test requires a non-empty table");
  }
  const lowest = Math.max(0, columnOne - rowTwo);
  const highest = Math.min(rowOne, columnOne);
  const observed = hypergeometricLogProbability(a, rowOne, rowTwo, columnOne);
  let twoSided = 0;
  let greater = 0;
  let less = 0;
  for (let support = lowest; support <= highest; support += 1) {
    const logProbability = hypergeometricLogProbability(support, rowOne, rowTwo, columnOne);
    const probability = Math.exp(logProbability);
    if (logProbability <= observed + 1e-7) {
      twoSided += probability;
    }
    if (support >= a) {
      greater += probability;
    }
    if (support <= a) {
      less += probability;
    }
  }
  return {
    method: "fisher_exact",
    table,
    odds_ratio: b === 0 || c === 0 ? null : (a * d) / (b * c),
    p_value_two_sided: Math.min(1, twoSided),
    p_value_greater: Math.min(1, greater),
    p_value_less: Math.min(1, less),
  };
}

/** Natural logarithm of the multinomial-style normalising constant, exported for tests. */
export function logFactorialSum(values: number[]): number {
  return values.reduce((total, value) => total + logFactorial(value), 0);
}
