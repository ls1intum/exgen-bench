/**
 * pass@k, in the unbiased form of Chen et al. (2021), Appendix A.
 *
 * Decision D4 of the evaluation plan: pass@k is **descriptive only** in this benchmark. The rule and
 * the reason, both of which belong in the metric card:
 *
 *   - The resampling unit is the *case*. Replicates within a case estimate the generator's
 *     within-case stochasticity; they are not independent draws from the case population.
 *   - pass@k is computed *within* a case from that case's n replicates, then averaged across cases.
 *     The average is a point estimate with no interval attached here.
 *   - Consequently pass@k must never narrow an interval or back a comparison between systems. Any
 *     inferential statement uses the case-clustered estimators in this directory instead.
 *
 * `descriptive_only: true` travels with every result so a downstream consumer cannot lose the rule.
 */
export interface PassAtKResult {
  method: "pass_at_k_unbiased";
  descriptive_only: true;
  k: number;
  cases: number;
  per_case: Array<{
    case_id: string;
    samples: number;
    successes: number;
    pass_at_k: number | null;
  }>;
  eligible_cases: number;
  mean_pass_at_k: number | null;
}

/**
 * Unbiased pass@k for a single case: 1 - C(n - c, k) / C(n, k), evaluated as a product so that it
 * stays accurate when n - c is close to n.
 */
export function passAtK(samples: number, successes: number, k: number): number {
  if (
    !Number.isInteger(samples) ||
    !Number.isInteger(successes) ||
    !Number.isInteger(k) ||
    samples < 1 ||
    successes < 0 ||
    k < 1
  ) {
    throw new Error("pass@k requires positive integer samples and k with non-negative successes");
  }
  if (successes > samples) {
    throw new Error("pass@k successes cannot exceed samples");
  }
  if (k > samples) {
    throw new Error("pass@k requires k to be at most the number of samples for that case");
  }
  if (samples - successes < k) {
    return 1;
  }
  let probability = 1;
  for (let index = samples - successes + 1; index <= samples; index += 1) {
    probability *= 1 - k / index;
  }
  return 1 - probability;
}

export interface ReplicateOutcome {
  case_id: string;
  success: boolean;
}

/**
 * Case-averaged pass@k over replicate outcomes.
 *
 * A case with fewer than k replicates is *excluded* rather than truncated, and the count of excluded
 * cases is reported: silently averaging over a shrinking denominator is how a pass@k table starts
 * describing a different population than the one the study planned.
 */
export function caseAveragedPassAtK(outcomes: ReplicateOutcome[], k: number): PassAtKResult {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error("pass@k requires a positive integer k");
  }
  const byCase = new Map<string, { samples: number; successes: number }>();
  for (const outcome of outcomes) {
    const entry = byCase.get(outcome.case_id) ?? { samples: 0, successes: 0 };
    entry.samples += 1;
    entry.successes += outcome.success ? 1 : 0;
    byCase.set(outcome.case_id, entry);
  }
  const perCase = [...byCase.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([caseId, entry]) => ({
      case_id: caseId,
      samples: entry.samples,
      successes: entry.successes,
      pass_at_k: entry.samples >= k ? passAtK(entry.samples, entry.successes, k) : null,
    }));
  const eligible = perCase.filter(
    (entry): entry is (typeof perCase)[number] & { pass_at_k: number } => entry.pass_at_k !== null,
  );
  return {
    method: "pass_at_k_unbiased",
    descriptive_only: true,
    k,
    cases: perCase.length,
    per_case: perCase,
    eligible_cases: eligible.length,
    mean_pass_at_k:
      eligible.length === 0
        ? null
        : eligible.reduce((total, entry) => total + entry.pass_at_k, 0) / eligible.length,
  };
}
