import { normalQuantile } from "./special-functions.ts";

export interface WilsonInterval {
  method: "wilson_score";
  continuity_corrected: boolean;
  successes: number;
  trials: number;
  point_estimate: number;
  confidence_level: number;
  confidence_interval: [number, number];
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * This is an interval for *independent* Bernoulli trials. In this benchmark the resampling unit is
 * the case, not the attempt, so a Wilson interval over attempts understates uncertainty whenever
 * replicates within a case are correlated. Use it for a single replicate per case, or for reporting
 * a within-case rate; the case-clustered bootstrap remains the estimator for the primary estimand.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  options: { confidenceLevel?: number; continuityCorrection?: boolean } = {},
): WilsonInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials <= 0 || successes < 0) {
    throw new Error("a Wilson interval requires integer successes in a positive number of trials");
  }
  if (successes > trials) {
    throw new Error("successes cannot exceed trials");
  }
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new Error("confidence level must be between zero and one");
  }
  const continuityCorrection = options.continuityCorrection ?? false;
  const z = normalQuantile(1 - (1 - confidenceLevel) / 2);
  const proportion = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  let lower: number;
  let upper: number;
  if (continuityCorrection) {
    const centre = 2 * trials * proportion + zSquared;
    const spread = (radius: number): number =>
      z * Math.sqrt(zSquared - 1 / trials + 4 * trials * proportion * (1 - proportion) + radius);
    lower =
      successes === 0
        ? 0
        : Math.max(0, (centre - 1 - spread(4 * proportion - 2)) / (2 * (trials + zSquared)));
    upper =
      successes === trials
        ? 1
        : Math.min(1, (centre + 1 + spread(2 - 4 * proportion)) / (2 * (trials + zSquared)));
  } else {
    const centre = proportion + zSquared / (2 * trials);
    const halfWidth =
      z * Math.sqrt((proportion * (1 - proportion)) / trials + zSquared / (4 * trials * trials));
    lower = successes === 0 ? 0 : Math.max(0, (centre - halfWidth) / denominator);
    upper = successes === trials ? 1 : Math.min(1, (centre + halfWidth) / denominator);
  }
  return {
    method: "wilson_score",
    continuity_corrected: continuityCorrection,
    successes,
    trials,
    point_estimate: proportion,
    confidence_level: confidenceLevel,
    confidence_interval: [lower, upper],
  };
}
