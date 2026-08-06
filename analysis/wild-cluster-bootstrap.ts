import { seededRandom } from "./bootstrap.ts";

export interface ClusteredObservation {
  cluster_id: string;
  treatment: 0 | 1;
  outcome: number;
}

export type WildBootstrapWeights = "rademacher" | "webb";

export interface WildClusterBootstrapResult {
  method: "wild_cluster_bootstrap_restricted";
  weights: WildBootstrapWeights;
  clusters: number;
  observations: number;
  treated_observations: number;
  control_observations: number;
  null_effect: number;
  coefficient: number;
  cluster_robust_standard_error: number;
  t_statistic: number;
  resamples: number;
  seed: number;
  exceedances: number;
  degenerate_resamples: number;
  p_value: number;
  confidence_interval: [number, number] | null;
  confidence_level: number | null;
  enumerated: boolean;
  limitations: string[];
}

interface DesignFit {
  intercept: number;
  slope: number;
  standardError: number;
}

const WEBB_POINTS = [
  -Math.sqrt(3 / 2),
  -1,
  -Math.sqrt(1 / 2),
  Math.sqrt(1 / 2),
  1,
  Math.sqrt(3 / 2),
];

/**
 * Restricted wild cluster bootstrap (Cameron, Gelbach and Miller 2008) for a two-arm contrast.
 *
 * `docs/METHODOLOGY.md` records that a percentile cluster bootstrap over-rejects at the 19-30
 * clusters this benchmark has, and that no nominal 5 % claim is defensible without a refinement.
 * This is that refinement. The model is a linear probability model of the outcome on a treatment
 * indicator with the case as the cluster; the null is imposed before resampling (the "WCR" variant),
 * which is the version with the good small-G properties. Rademacher weights are the default and are
 * enumerated exactly when 2^G is small enough that sampling them would be the only source of noise.
 *
 * The p-value is (1 + #{|t*| >= |t|}) / (B + 1): the +1 keeps it a valid finite-sample p-value
 * rather than an estimate that can reach exactly zero.
 */
export function wildClusterBootstrapTest(
  observations: ClusteredObservation[],
  options: {
    seed: number;
    resamples: number;
    nullEffect?: number;
    weights?: WildBootstrapWeights;
    confidenceLevel?: number;
  },
): WildClusterBootstrapResult {
  if (!Number.isSafeInteger(options.resamples) || options.resamples < 1) {
    throw new Error("wild cluster bootstrap resamples must be a positive integer");
  }
  const nullEffect = options.nullEffect ?? 0;
  const weights = options.weights ?? "rademacher";
  const outcomes = observations.map((row) => row.outcome);
  const treatments = observations.map((row) => row.treatment);
  if (outcomes.some((value) => !Number.isFinite(value))) {
    throw new Error("wild cluster bootstrap requires finite outcomes");
  }
  const treated = treatments.filter((value) => value === 1).length;
  const control = treatments.length - treated;
  if (treated === 0 || control === 0) {
    throw new Error("wild cluster bootstrap requires both a treated and a control arm");
  }
  const clusterIds = [...new Set(observations.map((row) => row.cluster_id))].sort();
  if (clusterIds.length < 2) {
    throw new Error("wild cluster bootstrap requires at least two clusters");
  }
  const clusterIndex = new Map(clusterIds.map((id, index) => [id, index]));
  const membership = observations.map((row) => clusterIndex.get(row.cluster_id) ?? 0);

  const observedFit = fitClustered(outcomes, treatments, membership, clusterIds.length);
  const tObserved =
    observedFit.standardError === 0
      ? Number.POSITIVE_INFINITY
      : (observedFit.slope - nullEffect) / observedFit.standardError;

  // Restricted fit: impose the null, so the residuals carry no treatment effect.
  const adjusted = outcomes.map((value, index) => value - nullEffect * (treatments[index] ?? 0));
  const restrictedIntercept = adjusted.reduce((total, value) => total + value, 0) / adjusted.length;
  const restrictedResiduals = adjusted.map((value) => value - restrictedIntercept);
  const restrictedFitted = observations.map(
    (_, index) => restrictedIntercept + nullEffect * (treatments[index] ?? 0),
  );

  const enumerated =
    weights === "rademacher" &&
    clusterIds.length <= 20 &&
    2 ** clusterIds.length <= options.resamples;
  const draws = enumerated ? 2 ** clusterIds.length : options.resamples;
  const random = seededRandom(options.seed);
  let exceedances = 0;
  let degenerate = 0;
  const statistics: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    const clusterWeights = enumerated
      ? clusterIds.map((_, index) => ((draw >> index) & 1 ? 1 : -1))
      : clusterIds.map(() => drawWeight(weights, random));
    const resampled = restrictedFitted.map(
      (fitted, index) =>
        fitted + (clusterWeights[membership[index] ?? 0] ?? 1) * (restrictedResiduals[index] ?? 0),
    );
    const fit = fitClustered(resampled, treatments, membership, clusterIds.length);
    const statistic =
      fit.standardError === 0
        ? Number.POSITIVE_INFINITY
        : (fit.slope - nullEffect) / fit.standardError;
    if (!Number.isFinite(statistic)) {
      degenerate += 1;
      exceedances += 1;
      continue;
    }
    statistics.push(statistic);
    if (Math.abs(statistic) >= Math.abs(tObserved) - 1e-12) {
      exceedances += 1;
    }
  }

  const confidenceLevel = options.confidenceLevel ?? null;
  return {
    method: "wild_cluster_bootstrap_restricted",
    weights,
    clusters: clusterIds.length,
    observations: observations.length,
    treated_observations: treated,
    control_observations: control,
    null_effect: nullEffect,
    coefficient: observedFit.slope,
    cluster_robust_standard_error: observedFit.standardError,
    t_statistic: tObserved,
    resamples: draws,
    seed: options.seed,
    exceedances,
    degenerate_resamples: degenerate,
    p_value: (1 + exceedances) / (draws + 1),
    confidence_interval:
      confidenceLevel === null ? null : symmetricInterval(observedFit, statistics, confidenceLevel),
    confidence_level: confidenceLevel,
    enumerated,
    limitations: [
      "linear probability model: the coefficient is a risk difference, not a log-odds",
      ...(clusterIds.length < 12
        ? ["fewer than twelve clusters: prefer Webb weights and treat the p-value as approximate"]
        : []),
      ...(degenerate > 0
        ? [
            `${degenerate} resamples had a degenerate standard error and were counted as exceedances`,
          ]
        : []),
      ...(confidenceLevel === null
        ? []
        : [
            "the interval inverts the bootstrap t distribution at the null and is not a full grid inversion",
          ]),
    ],
  };
}

function drawWeight(weights: WildBootstrapWeights, random: () => number): number {
  if (weights === "rademacher") {
    return random() < 0.5 ? -1 : 1;
  }
  return (
    WEBB_POINTS[Math.min(WEBB_POINTS.length - 1, Math.floor(random() * WEBB_POINTS.length))] ?? 1
  );
}

function symmetricInterval(
  fit: DesignFit,
  statistics: number[],
  confidenceLevel: number,
): [number, number] | null {
  if (!(confidenceLevel > 0 && confidenceLevel < 1) || statistics.length === 0) {
    return null;
  }
  const magnitudes = statistics.map((value) => Math.abs(value)).sort((left, right) => left - right);
  const position = Math.min(
    magnitudes.length - 1,
    Math.max(0, Math.ceil(confidenceLevel * magnitudes.length) - 1),
  );
  const critical = magnitudes[position] ?? 0;
  const halfWidth = critical * fit.standardError;
  return [fit.slope - halfWidth, fit.slope + halfWidth];
}

/**
 * OLS of `outcomes` on an intercept and a binary treatment, with a CR1 cluster-robust standard error
 * for the treatment coefficient. Written out in closed form for the two-column design so that the
 * estimator is readable rather than hidden behind a matrix library.
 */
function fitClustered(
  outcomes: number[],
  treatments: Array<0 | 1>,
  membership: number[],
  clusters: number,
): DesignFit {
  const n = outcomes.length;
  const treated = treatments.reduce<number>((total, value) => total + value, 0);
  const control = n - treated;
  if (treated === 0 || control === 0) {
    return { intercept: 0, slope: 0, standardError: 0 };
  }
  let treatedSum = 0;
  let controlSum = 0;
  for (let index = 0; index < n; index += 1) {
    if (treatments[index] === 1) {
      treatedSum += outcomes[index] ?? 0;
    } else {
      controlSum += outcomes[index] ?? 0;
    }
  }
  const intercept = controlSum / control;
  const slope = treatedSum / treated - intercept;

  // (X'X)^-1 for X = [1, d] with d binary: [[1/n0, -1/n0], [-1/n0, 1/n0 + 1/n1]].
  const inverse: [[number, number], [number, number]] = [
    [1 / control, -1 / control],
    [-1 / control, 1 / control + 1 / treated],
  ];
  const scores = Array.from({ length: clusters }, () => [0, 0] as [number, number]);
  for (let index = 0; index < n; index += 1) {
    const residual = (outcomes[index] ?? 0) - intercept - slope * (treatments[index] ?? 0);
    const score = scores[membership[index] ?? 0];
    if (score === undefined) {
      continue;
    }
    score[0] += residual;
    score[1] += residual * (treatments[index] ?? 0);
  }
  let meat00 = 0;
  let meat01 = 0;
  let meat11 = 0;
  for (const score of scores) {
    meat00 += score[0] * score[0];
    meat01 += score[0] * score[1];
    meat11 += score[1] * score[1];
  }
  // CR1 finite-sample correction with two estimated parameters.
  const correction = clusters > 1 && n > 2 ? ((clusters / (clusters - 1)) * (n - 1)) / (n - 2) : 1;
  const row0 = inverse[1][0] * meat00 + inverse[1][1] * meat01;
  const row1 = inverse[1][0] * meat01 + inverse[1][1] * meat11;
  const variance = correction * (row0 * inverse[1][0] + row1 * inverse[1][1]);
  return { intercept, slope, standardError: variance > 0 ? Math.sqrt(variance) : 0 };
}
