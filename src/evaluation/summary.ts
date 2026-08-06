import type { EvaluationResponse } from "./contracts.ts";

export type GenerationState =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  artifact_digest?: string | null;
  evidence_digest: string | null;
  capture_completeness?: "complete" | "partial" | "none" | null;
  budget_status: "compliant" | "exceeded" | "unverifiable" | "non_binding" | null;
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
  available: number;
  missing: number;
  numeric_mean: number | null;
}

export interface EvaluationSummary {
  schema_version: "1";
  denominators: {
    planned: number;
    generation_started: number;
    generation_completed: number;
    generated_candidates: number;
    candidates: number;
    evaluated: number;
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
  metrics_conditional_on_strict_success: MetricSummary[];
}

function withinBudget(status: GenerationObservation["budget_status"] | undefined): boolean {
  return status === "compliant" || status === "non_binding";
}

/**
 * Widening what may be evaluated must not widen what counts. A candidate retained from a run the
 * system did not accept is scorable evidence, and it is never a strict success.
 */
function generationSucceeded(observation: GenerationObservation | undefined): boolean {
  return (
    observation !== undefined &&
    observation.state === "completed" &&
    observation.outcome === "succeeded" &&
    withinBudget(observation.budget_status)
  );
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
): EvaluationSummary {
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
  const generatedCandidates = generations.filter(
    (observation) => observation.state === "completed" && observation.outcome === "succeeded",
  ).length;
  const candidateCount = generations.filter(
    (observation) => observation.state === "completed" && Boolean(observation.artifact_digest),
  ).length;
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

  const seenEvaluationAttempts = new Set<string>();
  const generationByAttempt = new Map(
    generations.map((observation) => [observation.attempt_id, observation]),
  );
  const evaluationFailures: Record<string, number> = {};
  for (const response of evaluations) {
    if (seenEvaluationAttempts.has(response.candidate.attempt_id)) {
      throw new Error("evaluation responses contain duplicate attempt IDs");
    }
    seenEvaluationAttempts.add(response.candidate.attempt_id);
    const generation = generationByAttempt.get(response.candidate.attempt_id);
    if (!generation) {
      throw new Error(`evaluation references unknown attempt ${response.candidate.attempt_id}`);
    }
    if (generation.state !== "completed" || !generation.artifact_digest) {
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
      (generation.generation_key !== undefined &&
        response.candidate.generation_key !== generation.generation_key) ||
      (generation.artifact_digest !== undefined &&
        response.candidate.artifact_digest !== generation.artifact_digest)
    ) {
      throw new Error(
        `evaluation artifact identity disagrees with attempt ${response.candidate.attempt_id}`,
      );
    }
    if (response.failure_category !== undefined) {
      increment(evaluationFailures, response.failure_category);
    }
  }

  const qualityOutcomes = evaluations.filter((response) => response.strict_success !== null);
  const evaluatorStrictSuccesses = qualityOutcomes.filter(
    (response) => response.strict_success === true,
  );
  const strictSuccesses = evaluatorStrictSuccesses.filter((response) =>
    generationSucceeded(generationByAttempt.get(response.candidate.attempt_id)),
  );
  const allMetricKeys = [
    ...new Set(
      evaluations.flatMap((response) =>
        response.scores
          .filter((score) => score.status !== "infra_failure")
          .map((score) => `${score.metric_id}\0${score.metric_version}`),
      ),
    ),
  ].sort();
  const metrics = allMetricKeys.map((metricKey): MetricSummary => {
    const [metricId, metricVersion] = metricKey.split("\0");
    if (metricId === undefined || metricVersion === undefined) {
      throw new Error("invalid internal metric identity");
    }
    const values = strictSuccesses
      .flatMap((response) => response.scores)
      .filter(
        (score) =>
          score.metric_id === metricId &&
          score.metric_version === metricVersion &&
          score.status === "ok",
      );
    const numericValues = values
      .map((score) => score.value)
      .filter((value): value is number => typeof value === "number");
    return {
      metric_id: metricId,
      metric_version: metricVersion,
      available: values.length,
      missing: strictSuccesses.length - values.length,
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
      generated_candidates: generatedCandidates,
      candidates: candidateCount,
      evaluated: evaluations.length,
      quality_outcomes: qualityOutcomes.length,
      evaluator_strict_successes: evaluatorStrictSuccesses.length,
      strict_successes: strictSuccesses.length,
    },
    rates: {
      end_to_end_strict_success_over_planned: ratio(strictSuccesses.length, generations.length),
      sensitivity_strict_success_over_started: ratio(strictSuccesses.length, generationStarted),
      sensitivity_strict_success_over_completed: ratio(strictSuccesses.length, generationCompleted),
      generation_yield_over_planned: ratio(generatedCandidates, generations.length),
      evaluation_coverage_over_candidates: ratio(evaluations.length, candidateCount),
      conditional_strict_success_over_quality_outcomes: ratio(
        strictSuccesses.length,
        qualityOutcomes.length,
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
      generated_not_evaluated: Math.max(0, generatedCandidates - evaluations.length),
      evaluation_infra_failures: evaluations.filter(
        (response) => response.status === "infra_failed",
      ).length,
      budget_evidence_unavailable: generations.filter(
        (observation) =>
          observation.state === "completed" &&
          observation.outcome === "succeeded" &&
          observation.budget_status === null,
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
    metrics_conditional_on_strict_success: metrics,
  };
}
