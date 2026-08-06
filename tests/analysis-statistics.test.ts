import { describe, expect, test } from "bun:test";
import { spearmanCorrelation } from "../analysis/correlation.ts";
import { fisherExact, logFactorialSum, mcnemarExact } from "../analysis/contingency-tests.ts";
import { cliffsDelta } from "../analysis/effect-size.ts";
import { holmAdjust } from "../analysis/multiplicity.ts";
import { caseAveragedPassAtK, passAtK } from "../analysis/pass-at-k.ts";
import { wilsonInterval } from "../analysis/proportion-interval.ts";
import {
  criticalRangeQuantile,
  friedmanTest,
  midRanks,
  nemenyiPostHoc,
  type BlockObservation,
} from "../analysis/rank-tests.ts";
import {
  chiSquareSurvival,
  fSurvival,
  logGamma,
  normalCdf,
  normalQuantile,
  regularizedIncompleteBeta,
  studentizedRangeSurvival,
  studentTTwoSided,
} from "../analysis/special-functions.ts";
import {
  wildClusterBootstrapTest,
  type ClusteredObservation,
} from "../analysis/wild-cluster-bootstrap.ts";

describe("special functions", () => {
  test("log-gamma reproduces exact factorials", () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
  });

  test("the normal distribution matches published quantiles", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 15);
    expect(normalCdf(1.959_963_984_540_054)).toBeCloseTo(0.975, 12);
    expect(normalCdf(-3)).toBeCloseTo(0.001_349_898_031_630_1, 15);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959_963_984_540_054, 10);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959_963_984_540_054, 10);
    expect(normalQuantile(1e-8)).toBeCloseTo(-5.612_001_243_305_69, 8);
  });

  test("the normal quantile inverts the normal CDF", () => {
    for (const probability of [0.001, 0.05, 0.2, 0.5, 0.8, 0.95, 0.999]) {
      expect(normalCdf(normalQuantile(probability))).toBeCloseTo(probability, 12);
    }
  });

  test("chi-square, Student t and F reproduce their 5 % critical values", () => {
    expect(chiSquareSurvival(3.841_459, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquareSurvival(5.991_465, 2)).toBeCloseTo(0.05, 6);
    expect(studentTTwoSided(2.228_139, 10)).toBeCloseTo(0.05, 6);
    expect(studentTTwoSided(1.959_963_984_540_054, 1e9)).toBeCloseTo(0.05, 6);
    expect(fSurvival(4.964_603, 1, 10)).toBeCloseTo(0.05, 6);
    expect(fSurvival(4.102_821, 2, 10)).toBeCloseTo(0.05, 5);
  });

  test("the incomplete beta matches closed-form values", () => {
    expect(regularizedIncompleteBeta(2, 3, 0.5)).toBeCloseTo(0.6875, 12);
    expect(regularizedIncompleteBeta(1, 1, 0.37)).toBeCloseTo(0.37, 12);
    expect(regularizedIncompleteBeta(5, 5, 0.5)).toBeCloseTo(0.5, 12);
  });

  test("the studentized range reproduces the tabulated infinite-df critical values", () => {
    const tabulated: Array<[number, number]> = [
      [2, 2.772],
      [3, 3.314],
      [4, 3.633],
      [5, 3.858],
      [6, 4.03],
      [10, 4.474],
    ];
    for (const [groups, critical] of tabulated) {
      expect(studentizedRangeSurvival(critical, groups)).toBeCloseTo(0.05, 3);
    }
  });
});

describe("Wilson score interval", () => {
  test("matches the closed-form roots of the score equation", () => {
    const interval = wilsonInterval(8, 20);
    // (n + z^2) p^2 - (2 n p-hat + z^2) p + n p-hat^2 = 0
    const z = normalQuantile(0.975);
    const zSquared = z * z;
    const a = 20 + zSquared;
    const b = -(2 * 8 + zSquared);
    const c = 8 * 0.4;
    const discriminant = Math.sqrt(b * b - 4 * a * c);
    expect(interval.confidence_interval[0]).toBeCloseTo((-b - discriminant) / (2 * a), 12);
    expect(interval.confidence_interval[1]).toBeCloseTo((-b + discriminant) / (2 * a), 12);
    expect(interval.point_estimate).toBe(0.4);
  });

  test("stays inside the unit interval at the boundaries", () => {
    expect(wilsonInterval(0, 10).confidence_interval[0]).toBe(0);
    expect(wilsonInterval(10, 10).confidence_interval[1]).toBe(1);
    const corrected = wilsonInterval(0, 10, { continuityCorrection: true });
    expect(corrected.confidence_interval[0]).toBe(0);
    expect(corrected.confidence_interval[1]).toBeGreaterThan(
      wilsonInterval(0, 10).confidence_interval[1],
    );
  });

  test("narrows as the sample grows and widens with confidence", () => {
    const [smallLow, smallHigh] = wilsonInterval(40, 100).confidence_interval;
    const [largeLow, largeHigh] = wilsonInterval(400, 1000).confidence_interval;
    expect(largeHigh - largeLow).toBeLessThan(smallHigh - smallLow);
    const wide = wilsonInterval(40, 100, { confidenceLevel: 0.99 }).confidence_interval;
    expect(wide[1] - wide[0]).toBeGreaterThan(smallHigh - smallLow);
  });

  test("rejects impossible counts", () => {
    expect(() => wilsonInterval(11, 10)).toThrow(/cannot exceed/);
    expect(() => wilsonInterval(1, 0)).toThrow(/positive number of trials/);
  });
});

describe("exact McNemar", () => {
  test("reproduces the two-sided binomial tail", () => {
    // 2 * P(X <= 3), X ~ Binomial(15, 1/2) = 2 * 576 / 32768.
    expect(mcnemarExact(3, 12).p_value).toBeCloseTo(1152 / 32768, 15);
    expect(mcnemarExact(12, 3).p_value).toBeCloseTo(1152 / 32768, 15);
  });

  test("is one when there is no discordance and symmetric otherwise", () => {
    expect(mcnemarExact(0, 0, 30).p_value).toBe(1);
    expect(mcnemarExact(5, 5).p_value).toBe(1);
    expect(mcnemarExact(1, 0).p_value).toBeCloseTo(1, 12);
    expect(mcnemarExact(0, 6).p_value).toBeCloseTo(2 / 64, 15);
  });

  test("reports the paired proportion difference over all pairs", () => {
    const result = mcnemarExact(8, 2, 10);
    expect(result.discordant_pairs).toBe(10);
    expect(result.proportion_difference).toBeCloseTo(0.3, 12);
  });

  test("rejects counts that are not non-negative integers", () => {
    expect(() => mcnemarExact(-1, 2)).toThrow(/non-negative integers/);
    expect(() => mcnemarExact(1.5, 2)).toThrow(/non-negative integers/);
    expect(() => mcnemarExact(1, 2, -3)).toThrow(/non-negative integers/);
  });
});

describe("Fisher's exact test", () => {
  test("reproduces the tea-tasting table", () => {
    const result = fisherExact([
      [3, 1],
      [1, 3],
    ]);
    expect(result.p_value_two_sided).toBeCloseTo(0.485_714_285_714_285_7, 12);
    expect(result.p_value_greater).toBeCloseTo(0.242_857_142_857_142_9, 12);
    expect(result.odds_ratio).toBeCloseTo(9, 12);
  });

  test("sums to one over the hypergeometric support", () => {
    const result = fisherExact([
      [1, 9],
      [11, 3],
    ]);
    expect(result.p_value_greater + result.p_value_less).toBeGreaterThan(1);
    expect(result.p_value_two_sided).toBeLessThan(0.01);
    expect(result.p_value_two_sided).toBeGreaterThan(0);
  });

  test("is one for a table with no association", () => {
    const result = fisherExact([
      [5, 5],
      [5, 5],
    ]);
    expect(result.p_value_two_sided).toBeCloseTo(1, 12);
    expect(result.odds_ratio).toBeCloseTo(1, 12);
  });

  test("reports no odds ratio when a cell would divide by zero", () => {
    expect(
      fisherExact([
        [4, 0],
        [0, 4],
      ]).odds_ratio,
    ).toBeNull();
  });

  test("rejects a malformed or empty table", () => {
    expect(() =>
      fisherExact([
        [-1, 2],
        [3, 4],
      ]),
    ).toThrow(/non-negative integer cell counts/);
    expect(() =>
      fisherExact([
        [0, 0],
        [0, 0],
      ]),
    ).toThrow(/non-empty table/);
  });

  test("log-factorial sums are additive", () => {
    expect(logFactorialSum([3, 4])).toBeCloseTo(Math.log(6) + Math.log(24), 12);
    expect(logFactorialSum([])).toBe(0);
  });
});

describe("Holm adjustment", () => {
  test("is monotone and matches the step-down definition", () => {
    const adjusted = holmAdjust([
      { label: "a", p_value: 0.01 },
      { label: "b", p_value: 0.04 },
      { label: "c", p_value: 0.03 },
    ]);
    expect(adjusted.map((entry) => entry.adjusted_p_value)).toEqual([0.03, 0.06, 0.06]);
  });

  test("never lowers a p-value and caps at one", () => {
    const adjusted = holmAdjust([
      { label: 1, p_value: 0.5 },
      { label: 2, p_value: 0.6 },
      { label: 3, p_value: 0.9 },
    ]);
    for (const entry of adjusted) {
      expect(entry.adjusted_p_value).toBeGreaterThanOrEqual(entry.p_value);
      expect(entry.adjusted_p_value).toBeLessThanOrEqual(1);
    }
  });
});

describe("Friedman and Nemenyi", () => {
  const observations: BlockObservation[] = [
    ["b1", ["a", 1], ["b", 2], ["c", 3]],
    ["b2", ["a", 1], ["b", 2], ["c", 3]],
    ["b3", ["a", 1], ["b", 3], ["c", 2]],
    ["b4", ["a", 2], ["b", 1], ["c", 3]],
    ["b5", ["a", 1], ["b", 2], ["c", 3]],
    ["b6", ["a", 1], ["b", 2], ["c", 3]],
  ].flatMap(([block, ...cells]) =>
    (cells as Array<[string, number]>).map(([treatment, value]) => ({
      block_id: block as string,
      treatment_id: treatment,
      value,
    })),
  );

  test("mid-ranks average tied positions", () => {
    expect(midRanks([10, 20, 20, 40])).toEqual([1, 2.5, 2.5, 4]);
    expect(midRanks([5, 5, 5])).toEqual([2, 2, 2]);
  });

  test("reduces to the classical statistic without ties", () => {
    const result = friedmanTest(observations);
    const n = 6;
    const k = 3;
    const rankSums = result.average_ranks.map((entry) => entry.average_rank * n);
    const classical =
      (12 / (n * k * (k + 1))) * rankSums.reduce((total, sum) => total + sum * sum, 0) -
      3 * n * (k + 1);
    expect(result.statistic).toBeCloseTo(classical, 12);
    expect(result.statistic).toBeCloseTo(25 / 3, 12);
    expect(result.p_value).toBeCloseTo(Math.exp(-25 / 6), 12);
    expect(result.degrees_of_freedom).toBe(2);
  });

  test("reports the Iman-Davenport refinement", () => {
    const result = friedmanTest(observations);
    expect(result.iman_davenport.statistic).toBeCloseTo((5 * (25 / 3)) / (12 - 25 / 3), 12);
    expect(result.iman_davenport.p_value).toBeLessThan(result.p_value);
    expect(result.iman_davenport.denominator_degrees_of_freedom).toBe(10);
  });

  test("is invariant to a strictly increasing transform of the observations", () => {
    const transformed = observations.map((row) => ({ ...row, value: Math.exp(row.value) }));
    expect(friedmanTest(transformed).statistic).toBeCloseTo(
      friedmanTest(observations).statistic,
      12,
    );
  });

  test("rejects an incomplete design", () => {
    expect(() => friedmanTest(observations.slice(1))).toThrow(/one observation per block/);
  });

  test("the Nemenyi critical value is the studentized range quantile over root two", () => {
    // Demsar's q_alpha table is this quantile divided by sqrt(2), printed to three truncated
    // decimals; asserting against the underlying studentized range keeps full precision.
    const tabulated: Array<[number, number]> = [
      [2, 2.772],
      [3, 3.314],
      [4, 3.633],
      [10, 4.474],
    ];
    for (const [treatments, critical] of tabulated) {
      expect(criticalRangeQuantile(0.05, treatments) * Math.SQRT2).toBeCloseTo(critical, 2);
    }
    expect(criticalRangeQuantile(0.05, 2)).toBeCloseTo(normalQuantile(0.975), 3);
    expect(criticalRangeQuantile(0.1, 3)).toBeCloseTo(2.052, 2);
  });

  test("post-hoc comparisons are Holm adjusted and ordered", () => {
    const result = nemenyiPostHoc(observations);
    expect(result.comparisons).toHaveLength(3);
    for (const comparison of result.comparisons) {
      expect(comparison.holm_adjusted_p_value).toBeGreaterThanOrEqual(comparison.p_value);
    }
    const extreme = result.comparisons.find(
      (comparison) => comparison.treatment_a === "a" && comparison.treatment_b === "c",
    );
    expect(extreme?.rank_difference).toBeCloseTo(-10 / 6, 12);
    expect(extreme?.p_value).toBeLessThan(0.05);
    expect(result.critical_difference).toBeCloseTo(
      criticalRangeQuantile(0.05, 3) * Math.sqrt((3 * 4) / (6 * 6)),
      12,
    );
  });
});

describe("Cliff's delta", () => {
  test("is minus one, zero and one at the extremes", () => {
    expect(cliffsDelta([1, 2, 3], [4, 5, 6]).delta).toBe(-1);
    expect(cliffsDelta([4, 5, 6], [1, 2, 3]).delta).toBe(1);
    const identical = cliffsDelta([1, 2, 3], [1, 2, 3]);
    expect(identical.delta).toBe(0);
    expect(identical.a12).toBe(0.5);
  });

  test("A12 and delta are two views of the same quantity", () => {
    const result = cliffsDelta([1, 3, 5, 7], [2, 3, 4]);
    expect(result.a12).toBeCloseTo((result.delta + 1) / 2, 12);
    expect(result.greater + result.lesser + result.ties).toBe(12);
  });

  test("labels magnitude by the Romano thresholds", () => {
    expect(cliffsDelta([1, 2, 3], [4, 5, 6]).magnitude).toBe("large");
    expect(cliffsDelta([1, 2, 3], [1, 2, 3]).magnitude).toBe("negligible");
  });

  test("rejects an empty sample", () => {
    expect(() => cliffsDelta([], [1])).toThrow(/non-empty/);
  });
});

describe("Spearman's rho", () => {
  test("matches a hand-computed tied example", () => {
    const result = spearmanCorrelation([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]);
    expect(result.rho).toBeCloseTo(8 / Math.sqrt(95), 12);
    expect(result.tied_y).toBe(true);
    expect(result.tied_x).toBe(false);
  });

  test("is one for a monotone relation and minus one when reversed", () => {
    expect(spearmanCorrelation([1, 2, 3, 4], [10, 20, 30, 40]).rho).toBeCloseTo(1, 12);
    expect(spearmanCorrelation([1, 2, 3, 4], [40, 30, 20, 10]).rho).toBeCloseTo(-1, 12);
  });

  test("agrees with the t approximation for its p-value", () => {
    const result = spearmanCorrelation(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [2, 1, 4, 3, 6, 5, 8, 7, 10, 9],
    );
    expect(result.p_value).toBeCloseTo(
      studentTTwoSided(result.statistic, result.degrees_of_freedom),
      15,
    );
    expect(result.p_value).toBeLessThan(0.01);
  });

  test("rejects a constant variable", () => {
    expect(() => spearmanCorrelation([1, 1, 1], [1, 2, 3])).toThrow(/every value/);
  });
});

describe("pass@k", () => {
  test("matches the closed-form combinatorial definition", () => {
    expect(passAtK(5, 2, 3)).toBeCloseTo(0.9, 12);
    expect(passAtK(5, 0, 1)).toBe(0);
    expect(passAtK(5, 5, 1)).toBe(1);
    expect(passAtK(10, 1, 1)).toBeCloseTo(0.1, 12);
  });

  test("is non-decreasing in k", () => {
    let previous = 0;
    for (let k = 1; k <= 5; k += 1) {
      const value = passAtK(5, 2, k);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  test("excludes cases with fewer than k replicates and says so", () => {
    const result = caseAveragedPassAtK(
      [
        { case_id: "a", success: true },
        { case_id: "a", success: false },
        { case_id: "a", success: false },
        { case_id: "b", success: false },
        { case_id: "b", success: false },
      ],
      3,
    );
    expect(result.descriptive_only).toBe(true);
    expect(result.cases).toBe(2);
    expect(result.eligible_cases).toBe(1);
    expect(result.per_case[1]?.pass_at_k).toBeNull();
    expect(result.mean_pass_at_k).toBeCloseTo(1, 12);
  });

  test("rejects a k larger than a case's replicate count", () => {
    expect(() => passAtK(2, 1, 3)).toThrow(/at most the number of samples/);
  });
});

describe("wild cluster bootstrap", () => {
  /**
   * A balanced two-arm design in which exactly `rate * clusters * replicates` observations succeed
   * in each arm, spread across clusters so that the arms differ by construction.
   */
  function design(
    treatedSuccessRate: number,
    controlSuccessRate: number,
    clusters: number,
    replicates: number,
  ): ClusteredObservation[] {
    const perArm = clusters * replicates;
    const treatedSuccesses = Math.round(treatedSuccessRate * perArm);
    const controlSuccesses = Math.round(controlSuccessRate * perArm);
    const rows: ClusteredObservation[] = [];
    let index = 0;
    for (let cluster = 0; cluster < clusters; cluster += 1) {
      for (let replicate = 0; replicate < replicates; replicate += 1) {
        rows.push({
          cluster_id: `case-${cluster}`,
          treatment: 1,
          outcome: index < treatedSuccesses ? 1 : 0,
        });
        rows.push({
          cluster_id: `case-${cluster}`,
          treatment: 0,
          outcome: index < controlSuccesses ? 1 : 0,
        });
        index += 1;
      }
    }
    return rows;
  }

  test("recovers the risk difference as the coefficient", () => {
    const result = wildClusterBootstrapTest(design(0.8, 0.3, 20, 1), {
      seed: 7,
      resamples: 199,
    });
    expect(result.coefficient).toBeCloseTo(0.5, 12);
    expect(result.clusters).toBe(20);
    expect(result.observations).toBe(40);
    expect(result.cluster_robust_standard_error).toBeGreaterThan(0);
  });

  test("does not reject when the arms are identical", () => {
    const identical: ClusteredObservation[] = [];
    for (let cluster = 0; cluster < 19; cluster += 1) {
      const outcome = cluster % 3 === 0 ? 1 : 0;
      identical.push({ cluster_id: `case-${cluster}`, treatment: 1, outcome });
      identical.push({ cluster_id: `case-${cluster}`, treatment: 0, outcome });
    }
    const result = wildClusterBootstrapTest(identical, { seed: 11, resamples: 999 });
    expect(result.coefficient).toBe(0);
    expect(result.p_value).toBeGreaterThan(0.5);
  });

  test("rejects a large, consistent difference", () => {
    const separated: ClusteredObservation[] = [];
    for (let cluster = 0; cluster < 20; cluster += 1) {
      separated.push({ cluster_id: `case-${cluster}`, treatment: 1, outcome: 1 });
      separated.push({
        cluster_id: `case-${cluster}`,
        treatment: 0,
        outcome: cluster < 18 ? 0 : 1,
      });
    }
    const result = wildClusterBootstrapTest(separated, { seed: 3, resamples: 999 });
    expect(result.coefficient).toBeCloseTo(0.9, 12);
    expect(result.p_value).toBeLessThan(0.05);
  });

  test("enumerates Rademacher weights exactly when the cluster count allows it", () => {
    const rows = design(0.7, 0.4, 8, 1);
    const first = wildClusterBootstrapTest(rows, { seed: 1, resamples: 999 });
    const second = wildClusterBootstrapTest(rows, { seed: 999, resamples: 999 });
    expect(first.enumerated).toBe(true);
    expect(first.resamples).toBe(256);
    expect(second.p_value).toBe(first.p_value);
  });

  test("is deterministic under a seed when it samples", () => {
    const rows = design(0.7, 0.4, 25, 2);
    const first = wildClusterBootstrapTest(rows, { seed: 42, resamples: 499 });
    const second = wildClusterBootstrapTest(rows, { seed: 42, resamples: 499 });
    const different = wildClusterBootstrapTest(rows, { seed: 43, resamples: 499 });
    expect(first.enumerated).toBe(false);
    expect(second.p_value).toBe(first.p_value);
    expect(different.seed).toBe(43);
  });

  test("p-values are bounded below by the resample count", () => {
    const result = wildClusterBootstrapTest(design(1, 0, 19, 1), { seed: 5, resamples: 99 });
    expect(result.p_value).toBeGreaterThanOrEqual(1 / 100);
    expect(result.p_value).toBeLessThanOrEqual(1);
  });

  test("records its modelling limitations", () => {
    const result = wildClusterBootstrapTest(design(0.6, 0.5, 5, 2), {
      seed: 2,
      resamples: 99,
      weights: "webb",
      confidenceLevel: 0.95,
    });
    expect(result.limitations[0]).toContain("linear probability model");
    expect(result.limitations.some((entry) => entry.includes("twelve clusters"))).toBe(true);
    expect(result.confidence_interval).not.toBeNull();
    expect(result.confidence_interval?.[0]).toBeLessThanOrEqual(result.coefficient);
  });

  test("rejects a single-arm or single-cluster design", () => {
    expect(() =>
      wildClusterBootstrapTest(
        [
          { cluster_id: "a", treatment: 1, outcome: 1 },
          { cluster_id: "b", treatment: 1, outcome: 0 },
        ],
        { seed: 1, resamples: 9 },
      ),
    ).toThrow(/treated and a control/);
    expect(() =>
      wildClusterBootstrapTest(
        [
          { cluster_id: "a", treatment: 1, outcome: 1 },
          { cluster_id: "a", treatment: 0, outcome: 0 },
        ],
        { seed: 1, resamples: 9 },
      ),
    ).toThrow(/at least two clusters/);
  });
});
