import {
  type BudgetStatus,
  type GenerationState,
  generationAccepted,
  generationSucceeded,
  producedCandidate,
} from "./classification.ts";
import type { EvaluationResponse } from "./contracts.ts";

export type { GenerationState };

export interface GenerationObservation {
  attempt_id: string;
  case_id: string;
  system_id: string;
  replicate: number;
  seed: number;
  state: GenerationState;
  outcome: string | null;
  error_code: string | null;
  experiment_id?: string;
  started_at: string | null;
  finished_at: string | null;
  generation_key: string;
  artifact_digest: string | null;
  evidence_digest: string | null;
  capture_completeness?: "complete" | "partial" | "none" | null;
  budget_status: BudgetStatus;
  budget_violations: string[];
  budget_missing: string[];
  generation_duration_ms: number | null;
  model_calls: number | null;
  tool_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens: number | null;
  cost_amount: number | null;
  cost_currency: string | null;
  reference_cost_status?: "estimated" | "unavailable" | null;
  reference_cost_amount?: number | null;
  reference_cost_currency?: "USD" | null;
  reference_cost_source?: "openrouter_model_catalog" | null;
  reference_cost_model?: string | null;
  reference_cost_model_source?: "system_reported" | "configured" | null;
  reference_cost_retrieved_at?: string | null;
  reference_cost_quote_sha256?: string | null;
  reference_cost_prompt_rate?: string | null;
  reference_cost_completion_rate?: string | null;
  reference_cost_cache_read_rate?: string | null;
  reference_cost_request_rate?: string | null;
  reference_cost_assumptions?: string[];
  reference_cost_active_endpoint_count?: number | null;
  reference_cost_priced_active_endpoint_count?: number | null;
  reference_cost_active_endpoint_min?: number | null;
  reference_cost_active_endpoint_max?: number | null;
  reference_cost_unavailable_reason?: string | null;
  seed_status?: "honored" | "not_honored" | "unsupported" | "unverifiable" | null;
  effective_parameters_digest?: string | null;
  provider_request_ids_digest?: string | null;
  provider_request_ids_complete?: boolean | null;
}

export interface MetricSummary {
  metric_id: string;
  metric_version: string;
  evaluator_id: string;
  available: number;
  /**
   * Cases where the metric does not apply — a reference metric with no golden reference, a mutation
   * score before the container backend exists. Held apart from `missing` on purpose: an aggregate
   * that folds "not applicable" into "missing" reports a coverage gap that is not there, and an
   * aggregate that folds it into the denominator reports a rate over a population that never
   * existed.
   */
  not_applicable: number;
  missing: number;
  applicable_denominator: number;
  numeric_mean: number | null;
}

export interface EvaluatorSummary {
  evaluator_id: string;
  authoritative: boolean;
  evaluations: number;
  quality_outcomes: number;
  strict_successes: number;
  infrastructure_failures: number;
  failures: Record<string, number>;
}

export interface EvaluationSummary {
  schema_version: "1";
  denominators: {
    planned: number;
    generation_started: number;
    generation_completed: number;
    generated_candidates: number;
    candidates: number;
    /** Evaluations by the authoritative evaluator: the denominator of the primary estimand. */
    evaluated: number;
    /** Every evaluation across every evaluator, so multi-evaluator coverage stays visible. */
    evaluation_records: number;
    quality_outcomes: number;
    evaluator_strict_successes: number;
    strict_successes: number;
  };
  rates: {
    end_to_end_strict_success_over_planned: number | null;
    sensitivity_strict_success_over_started: number | null;
    sensitivity_strict_success_over_completed: number | null;
    generation_yield_over_planned: number | null;
    evaluation_coverage_over_candidates: number | null;
    conditional_strict_success_over_quality_outcomes: number | null;
    conditional_evaluator_acceptance_over_quality_outcomes: number | null;
  };
  missingness: {
    generation_not_started: number;
    generation_infra_failures: number;
    generated_not_evaluated: number;
    evaluation_infra_failures: number;
    budget_evidence_unavailable: number;
  };
  budget_accounting: {
    compliant: number;
    non_binding: number;
    exceeded: number;
    unverifiable: number;
    unavailable: number;
  };
  generation_failures: Record<string, number>;
  evaluation_failures: Record<string, number>;
  authoritative_evaluator_id: string | null;
  evaluators: EvaluatorSummary[];
  metrics_conditional_on_strict_success: MetricSummary[];
}

export interface EvaluationSummaryOptions {
  /**
   * The evaluator whose `strict_success` defines the primary estimand. Required once a run carries
   * more than one evaluator over the same candidate: the design needs an oracle, a static checker
   * and a reference evaluator side by side, but the leaderboard must stay single-valued and
   * pre-registrable, so exactly one of them decides acceptance.
   */
  authoritativeEvaluatorId?: string;
}

/**
 * The evaluator that decides `strict_success` for a run. With one evaluator it is that evaluator; with
 * several it must be declared, because picking one implicitly is how a benchmark silently changes its
 * primary outcome between releases.
 */
export function resolveAuthoritativeEvaluatorId(
  evaluations: EvaluationResponse[],
  declared?: string,
): string | null {
  const evaluatorIds = [...new Set(evaluations.map((response) => response.evaluator.id))].sort();
  if (declared !== undefined) {
    if (evaluatorIds.length > 0 && !evaluatorIds.includes(declared)) {
      throw new Error(`no evaluation was produced by the authoritative evaluator ${declared}`);
    }
    return declared;
  }
  if (evaluatorIds.length === 0) {
    return null;
  }
  if (evaluatorIds.length > 1) {
    throw new Error(
      `a run with several evaluators (${evaluatorIds.join(", ")}) must declare which one is authoritative for strict_success`,
    );
  }
  return evaluatorIds[0] ?? null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function increment(counts: Record<string, number>, category: string): void {
  counts[category] = (counts[category] ?? 0) + 1;
}

export function summarizeEvaluation(
  generations: GenerationObservation[],
  evaluations: EvaluationResponse[],
  options: EvaluationSummaryOptions = {},
): EvaluationSummary {
  const authoritativeEvaluatorId = resolveAuthoritativeEvaluatorId(
    evaluations,
    options.authoritativeEvaluatorId,
  );
  const attemptIds = new Set(generations.map((observation) => observation.attempt_id));
  if (attemptIds.size !== generations.length) {
    throw new Error("generation observations contain duplicate attempt IDs");
  }

  const generationStarted = generations.filter(
    (observation) => observation.state !== "planned",
  ).length;
  const generationCompleted = generations.filter(
    (observation) => observation.state === "completed",
  ).length;
  const acceptedGenerations = generations.filter(generationAccepted);
  const candidateCount = generations.filter(producedCandidate).length;
  const generationFailures: Record<string, number> = {};
  for (const observation of generations) {
    if (
      observation.state === "failed" ||
      observation.state === "cancelled" ||
      observation.state === "interrupted" ||
      (observation.state === "completed" && observation.outcome !== "succeeded")
    ) {
      increment(
        generationFailures,
        observation.error_code ?? observation.outcome ?? `state.${observation.state}`,
      );
    }
  }

  const seenEvaluations = new Set<string>();
  const generationByAttempt = new Map(
    generations.map((observation) => [observation.attempt_id, observation]),
  );
  const evaluationFailures: Record<string, number> = {};
  for (const response of evaluations) {
    const evaluationKey = `${response.candidate.attempt_id}\0${response.evaluator.id}`;
    if (seenEvaluations.has(evaluationKey)) {
      throw new Error(
        `evaluator ${response.evaluator.id} produced more than one evaluation for attempt ${response.candidate.attempt_id}`,
      );
    }
    seenEvaluations.add(evaluationKey);
    const generation = generationByAttempt.get(response.candidate.attempt_id);
    if (!generation) {
      throw new Error(`evaluation references unknown attempt ${response.candidate.attempt_id}`);
    }
    if (!producedCandidate(generation)) {
      throw new Error(
        `evaluation references attempt without a candidate ${response.candidate.attempt_id}`,
      );
    }
    if (
      response.candidate.case_id !== generation.case_id ||
      response.candidate.system_id !== generation.system_id ||
      response.candidate.replicate !== generation.replicate
    ) {
      throw new Error(
        `evaluation candidate identity disagrees with attempt ${response.candidate.attempt_id}`,
      );
    }
    if (
      (generation.experiment_id !== undefined &&
        response.candidate.experiment_id !== generation.experiment_id) ||
      response.candidate.generation_key !== generation.generation_key ||
      response.candidate.artifact_digest !== generation.artifact_digest
    ) {
      throw new Error(
        `evaluation artifact identity disagrees with attempt ${response.candidate.attempt_id}`,
      );
    }
    if (response.failure_category !== undefined) {
      increment(evaluationFailures, response.failure_category);
    }
  }

  const authoritative = evaluations.filter(
    (response) => response.evaluator.id === authoritativeEvaluatorId,
  );
  const authoritativeAttempts = new Set(
    authoritative.map((response) => response.candidate.attempt_id),
  );
  const qualityOutcomes = authoritative.filter((response) => response.strict_success !== null);
  const evaluatorStrictSuccesses = qualityOutcomes.filter(
    (response) => response.strict_success === true,
  );
  const acceptedQualityOutcomes = qualityOutcomes.filter((response) =>
    generationSucceeded(generationByAttempt.get(response.candidate.attempt_id)),
  );
  const strictSuccesses = acceptedQualityOutcomes.filter(
    (response) => response.strict_success === true,
  );
  const strictSuccessAttempts = new Set(
    strictSuccesses.map((response) => response.candidate.attempt_id),
  );

  const evaluatorIds = [...new Set(evaluations.map((response) => response.evaluator.id))].sort();
  const evaluatorSummaries = evaluatorIds.map((evaluatorId): EvaluatorSummary => {
    const responses = evaluations.filter((response) => response.evaluator.id === evaluatorId);
    const failures: Record<string, number> = {};
    for (const response of responses) {
      if (response.failure_category !== undefined) {
        increment(failures, response.failure_category);
      }
    }
    return {
      evaluator_id: evaluatorId,
      authoritative: evaluatorId === authoritativeEvaluatorId,
      evaluations: responses.length,
      quality_outcomes: responses.filter((response) => response.strict_success !== null).length,
      strict_successes: responses.filter((response) => response.strict_success === true).length,
      infrastructure_failures: responses.filter((response) => response.status === "infra_failed")
        .length,
      failures,
    };
  });

  const metricKeys = [
    ...new Set(
      evaluations.flatMap((response) =>
        response.scores
          .filter((score) => score.status !== "infra_failure")
          .map((score) => `${score.metric_id}\0${score.metric_version}\0${response.evaluator.id}`),
      ),
    ),
  ].sort();
  const metrics = metricKeys.map((metricKey): MetricSummary => {
    const [metricId, metricVersion, evaluatorId] = metricKey.split("\0");
    if (metricId === undefined || metricVersion === undefined || evaluatorId === undefined) {
      throw new Error("invalid internal metric identity");
    }
    const scores = evaluations
      .filter(
        (response) =>
          response.evaluator.id === evaluatorId &&
          strictSuccessAttempts.has(response.candidate.attempt_id),
      )
      .flatMap((response) => response.scores)
      .filter((score) => score.metric_id === metricId && score.metric_version === metricVersion);
    const values = scores.filter((score) => score.status === "ok");
    const notApplicable = scores.filter((score) => score.status === "not_applicable").length;
    const numericValues = values
      .map((score) => score.value)
      .filter((value): value is number => typeof value === "number");
    return {
      metric_id: metricId,
      metric_version: metricVersion,
      evaluator_id: evaluatorId,
      available: values.length,
      not_applicable: notApplicable,
      missing: strictSuccesses.length - values.length - notApplicable,
      applicable_denominator: strictSuccesses.length - notApplicable,
      numeric_mean:
        numericValues.length === 0
          ? null
          : numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length,
    };
  });

  return {
    schema_version: "1",
    denominators: {
      planned: generations.length,
      generation_started: generationStarted,
      generation_completed: generationCompleted,
      generated_candidates: acceptedGenerations.length,
      candidates: candidateCount,
      evaluated: authoritative.length,
      evaluation_records: evaluations.length,
      quality_outcomes: qualityOutcomes.length,
      evaluator_strict_successes: evaluatorStrictSuccesses.length,
      strict_successes: strictSuccesses.length,
    },
    rates: {
      end_to_end_strict_success_over_planned: ratio(strictSuccesses.length, generations.length),
      sensitivity_strict_success_over_started: ratio(strictSuccesses.length, generationStarted),
      sensitivity_strict_success_over_completed: ratio(strictSuccesses.length, generationCompleted),
      generation_yield_over_planned: ratio(acceptedGenerations.length, generations.length),
      evaluation_coverage_over_candidates: ratio(authoritative.length, candidateCount),
      conditional_strict_success_over_quality_outcomes: ratio(
        strictSuccesses.length,
        acceptedQualityOutcomes.length,
      ),
      conditional_evaluator_acceptance_over_quality_outcomes: ratio(
        evaluatorStrictSuccesses.length,
        qualityOutcomes.length,
      ),
    },
    missingness: {
      generation_not_started: generations.length - generationStarted,
      generation_infra_failures: generations.filter(
        (observation) => observation.outcome === "infra_failed",
      ).length,
      generated_not_evaluated: acceptedGenerations.filter(
        (observation) => !authoritativeAttempts.has(observation.attempt_id),
      ).length,
      evaluation_infra_failures: authoritative.filter(
        (response) => response.status === "infra_failed",
      ).length,
      budget_evidence_unavailable: acceptedGenerations.filter(
        (observation) => observation.budget_status === null,
      ).length,
    },
    budget_accounting: {
      non_binding: generations.filter((observation) => observation.budget_status === "non_binding")
        .length,
      compliant: generations.filter((observation) => observation.budget_status === "compliant")
        .length,
      exceeded: generations.filter((observation) => observation.budget_status === "exceeded")
        .length,
      unverifiable: generations.filter(
        (observation) => observation.budget_status === "unverifiable",
      ).length,
      unavailable: generations.filter((observation) => observation.budget_status === null).length,
    },
    generation_failures: generationFailures,
    evaluation_failures: evaluationFailures,
    authoritative_evaluator_id: authoritativeEvaluatorId,
    evaluators: evaluatorSummaries,
    metrics_conditional_on_strict_success: metrics,
  };
}
