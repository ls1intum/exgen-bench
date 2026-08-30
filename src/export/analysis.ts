import {
  generationAccepted,
  generationSucceeded,
  producedCandidate,
} from "../evaluation/classification.ts";
import type { EvaluationResponse } from "../evaluation/contracts.ts";
import {
  resolveAuthoritativeEvaluatorId,
  type GenerationObservation,
} from "../evaluation/summary.ts";

export interface AttemptAnalysisRow {
  attempt_id: string;
  case_id: string;
  system_id: string;
  replicate: number;
  seed: number;
  generation_key: string;
  generation_state: GenerationObservation["state"];
  generation_outcome: string | null;
  generation_error: string | null;
  generation_started_at: string | null;
  generation_finished_at: string | null;
  artifact_digest: string | null;
  evidence_digest: string | null;
  generation_budget_status: GenerationObservation["budget_status"];
  budget_violations: string;
  budget_missing: string;
  generation_duration_ms: number | null;
  model_calls: number | null;
  tool_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cost_amount: number | null;
  cost_currency: string | null;
  reference_cost_status: GenerationObservation["reference_cost_status"];
  reference_cost_amount: number | null;
  reference_cost_currency: string | null;
  reference_cost_source: GenerationObservation["reference_cost_source"];
  reference_cost_model: string | null;
  reference_cost_model_source: GenerationObservation["reference_cost_model_source"];
  reference_cost_retrieved_at: string | null;
  reference_cost_quote_sha256: string | null;
  reference_cost_prompt_rate: string | null;
  reference_cost_completion_rate: string | null;
  reference_cost_cache_read_rate: string | null;
  reference_cost_request_rate: string | null;
  reference_cost_assumptions: string;
  reference_cost_active_endpoint_count: number | null;
  reference_cost_priced_active_endpoint_count: number | null;
  reference_cost_active_endpoint_min: number | null;
  reference_cost_active_endpoint_max: number | null;
  reference_cost_unavailable_reason: string | null;
  seed_status: GenerationObservation["seed_status"];
  effective_parameters_digest: string | null;
  provider_request_ids_digest: string | null;
  provider_request_ids_complete: boolean | null;
  evaluation_status: EvaluationResponse["status"] | null;
  evaluator_strict_success: boolean | null;
  strict_success: boolean | null;
  evaluation_failure: string | null;
}

export interface ScoreAnalysisRow {
  attempt_id: string;
  case_id: string;
  system_id: string;
  replicate: number;
  evaluator_id: string;
  metric_id: string;
  metric_version: string;
  score_status: string;
  value: string | number | boolean | null;
  numerator: number | null;
  denominator: number | null;
}

/**
 * One row per evaluation, which under the tiered design is one row per (attempt, evaluator). The
 * wide attempt row stays keyed on the authoritative evaluator; everything else is read from here, so
 * adding an evaluator does not add a column block to the attempt table or to the release contract.
 */
export interface EvaluationAnalysisRow {
  attempt_id: string;
  case_id: string;
  system_id: string;
  replicate: number;
  evaluator_id: string;
  evaluator_version: string;
  suite_id: string;
  suite_version: string;
  authoritative: boolean;
  evaluation_status: EvaluationResponse["status"];
  evaluator_strict_success: boolean | null;
  evaluation_failure: string | null;
  duration_ms: number;
}

export interface PairedAnalysisRow {
  case_id: string;
  replicate: number;
  system_a: string;
  system_b: string;
  strict_success_a: number | null;
  strict_success_b: number | null;
  /**
   * Whether each arm's attempt reached an evaluated quality verdict (as opposed to, say, an
   * unresolved evaluator infrastructure failure). This is unrelated to whether the row itself was
   * emitted -- a row only ever exists once both arms have a planned attempt for the case and
   * replicate, so there was never a `pair_complete` flag worth reading; these two fields are what a
   * complete-quality sensitivity analysis filters on.
   */
  quality_outcome_available_a: boolean;
  quality_outcome_available_b: boolean;
}

export interface SystemAnalysisSummary {
  system_id: string;
  planned: number;
  generated: number;
  candidates: number;
  evaluated: number;
  quality_outcomes: number;
  evaluator_strict_successes: number;
  strict_successes: number;
  end_to_end_strict_success_rate: number | null;
  conditional_strict_success_rate: number | null;
  evaluation_coverage: number | null;
  evaluation_infra_failures: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildAnalysisRecords(
  generations: GenerationObservation[],
  evaluations: EvaluationResponse[],
  options: { authoritativeEvaluatorId?: string } = {},
): {
  attempts: AttemptAnalysisRow[];
  scores: ScoreAnalysisRow[];
  evaluations: EvaluationAnalysisRow[];
  pairs: PairedAnalysisRow[];
  systems: SystemAnalysisSummary[];
} {
  const authoritativeEvaluatorId = resolveAuthoritativeEvaluatorId(
    evaluations,
    options.authoritativeEvaluatorId,
  );
  const authoritativeEvaluations = evaluations.filter(
    (response) => response.evaluator.id === authoritativeEvaluatorId,
  );
  const evaluationByAttempt = new Map(
    authoritativeEvaluations.map((response) => [response.candidate.attempt_id, response]),
  );
  const acceptedAttempts = new Set(
    generations.filter(generationSucceeded).map((generation) => generation.attempt_id),
  );
  const attempts = generations
    .map((generation): AttemptAnalysisRow => {
      const evaluation = evaluationByAttempt.get(generation.attempt_id);
      const evaluatorStrictSuccess = evaluation?.strict_success ?? null;
      const strictSuccess =
        evaluatorStrictSuccess === null
          ? null
          : evaluatorStrictSuccess === true && acceptedAttempts.has(generation.attempt_id);
      return {
        attempt_id: generation.attempt_id,
        case_id: generation.case_id,
        system_id: generation.system_id,
        replicate: generation.replicate,
        seed: generation.seed,
        generation_key: generation.generation_key,
        generation_state: generation.state,
        generation_outcome: generation.outcome,
        generation_error: generation.error_code,
        generation_started_at: generation.started_at,
        generation_finished_at: generation.finished_at,
        artifact_digest: generation.artifact_digest,
        evidence_digest: generation.evidence_digest,
        generation_budget_status: generation.budget_status,
        budget_violations: JSON.stringify(generation.budget_violations),
        budget_missing: JSON.stringify(generation.budget_missing),
        generation_duration_ms: generation.generation_duration_ms,
        model_calls: generation.model_calls,
        tool_calls: generation.tool_calls,
        input_tokens: generation.input_tokens,
        output_tokens: generation.output_tokens,
        cached_input_tokens: generation.cached_input_tokens ?? null,
        reasoning_tokens: generation.reasoning_tokens ?? null,
        total_tokens: generation.total_tokens,
        cost_amount: generation.cost_amount,
        cost_currency: generation.cost_currency,
        reference_cost_status: generation.reference_cost_status ?? null,
        reference_cost_amount: generation.reference_cost_amount ?? null,
        reference_cost_currency: generation.reference_cost_currency ?? null,
        reference_cost_source: generation.reference_cost_source ?? null,
        reference_cost_model: generation.reference_cost_model ?? null,
        reference_cost_model_source: generation.reference_cost_model_source ?? null,
        reference_cost_retrieved_at: generation.reference_cost_retrieved_at ?? null,
        reference_cost_quote_sha256: generation.reference_cost_quote_sha256 ?? null,
        reference_cost_prompt_rate: generation.reference_cost_prompt_rate ?? null,
        reference_cost_completion_rate: generation.reference_cost_completion_rate ?? null,
        reference_cost_cache_read_rate: generation.reference_cost_cache_read_rate ?? null,
        reference_cost_request_rate: generation.reference_cost_request_rate ?? null,
        reference_cost_assumptions: JSON.stringify(generation.reference_cost_assumptions ?? []),
        reference_cost_active_endpoint_count:
          generation.reference_cost_active_endpoint_count ?? null,
        reference_cost_priced_active_endpoint_count:
          generation.reference_cost_priced_active_endpoint_count ?? null,
        reference_cost_active_endpoint_min: generation.reference_cost_active_endpoint_min ?? null,
        reference_cost_active_endpoint_max: generation.reference_cost_active_endpoint_max ?? null,
        reference_cost_unavailable_reason: generation.reference_cost_unavailable_reason ?? null,
        seed_status: generation.seed_status ?? null,
        effective_parameters_digest: generation.effective_parameters_digest ?? null,
        provider_request_ids_digest: generation.provider_request_ids_digest ?? null,
        provider_request_ids_complete: generation.provider_request_ids_complete ?? null,
        evaluation_status: evaluation?.status ?? null,
        evaluator_strict_success: evaluatorStrictSuccess,
        strict_success: strictSuccess,
        evaluation_failure: evaluation?.failure_category ?? null,
      };
    })
    .sort(
      (left, right) =>
        compareText(left.case_id, right.case_id) ||
        left.replicate - right.replicate ||
        compareText(left.system_id, right.system_id),
    );

  const scores = evaluations
    .flatMap((response): ScoreAnalysisRow[] =>
      response.scores.map((score) => ({
        attempt_id: response.candidate.attempt_id,
        case_id: response.candidate.case_id,
        system_id: response.candidate.system_id,
        replicate: response.candidate.replicate,
        evaluator_id: response.evaluator.id,
        metric_id: score.metric_id,
        metric_version: score.metric_version,
        score_status: score.status,
        value: score.value ?? null,
        numerator: score.numerator ?? null,
        denominator: score.denominator ?? null,
      })),
    )
    .sort(
      (left, right) =>
        compareText(left.case_id, right.case_id) ||
        left.replicate - right.replicate ||
        compareText(left.system_id, right.system_id) ||
        compareText(left.evaluator_id, right.evaluator_id) ||
        compareText(left.metric_id, right.metric_id),
    );

  const evaluationRows = evaluations
    .map(
      (response): EvaluationAnalysisRow => ({
        attempt_id: response.candidate.attempt_id,
        case_id: response.candidate.case_id,
        system_id: response.candidate.system_id,
        replicate: response.candidate.replicate,
        evaluator_id: response.evaluator.id,
        evaluator_version: response.evaluator.version,
        suite_id: response.suite.id,
        suite_version: response.suite.version,
        authoritative: response.evaluator.id === authoritativeEvaluatorId,
        evaluation_status: response.status,
        evaluator_strict_success: response.strict_success,
        evaluation_failure: response.failure_category ?? null,
        duration_ms: response.duration_ms,
      }),
    )
    .sort(
      (left, right) =>
        compareText(left.case_id, right.case_id) ||
        left.replicate - right.replicate ||
        compareText(left.system_id, right.system_id) ||
        compareText(left.evaluator_id, right.evaluator_id),
    );

  const systemIds = [...new Set(generations.map((row) => row.system_id))].sort();
  const pairs: PairedAnalysisRow[] = [];
  for (let leftIndex = 0; leftIndex < systemIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < systemIds.length; rightIndex += 1) {
      const systemA = systemIds[leftIndex];
      const systemB = systemIds[rightIndex];
      if (systemA === undefined || systemB === undefined) {
        continue;
      }
      const rowsA = attempts.filter((row) => row.system_id === systemA);
      const rowBByPair = new Map(
        attempts
          .filter((row) => row.system_id === systemB)
          .map((row) => [`${row.case_id}\0${row.replicate}`, row]),
      );
      for (const rowA of rowsA) {
        const rowB = rowBByPair.get(`${rowA.case_id}\0${rowA.replicate}`);
        if (!rowB) {
          continue;
        }
        const valueA = Number(rowA.strict_success === true);
        const valueB = Number(rowB.strict_success === true);
        pairs.push({
          case_id: rowA.case_id,
          replicate: rowA.replicate,
          system_a: systemA,
          system_b: systemB,
          strict_success_a: valueA,
          strict_success_b: valueB,
          quality_outcome_available_a:
            rowA.strict_success !== null && acceptedAttempts.has(rowA.attempt_id),
          quality_outcome_available_b:
            rowB.strict_success !== null && acceptedAttempts.has(rowB.attempt_id),
        });
      }
    }
  }

  const systems = systemIds.map((systemId): SystemAnalysisSummary => {
    const rows = attempts.filter((row) => row.system_id === systemId);
    const qualityOutcomes = rows.filter((row) => row.evaluator_strict_success !== null);
    const acceptedQualityOutcomes = qualityOutcomes.filter((row) =>
      acceptedAttempts.has(row.attempt_id),
    );
    const evaluatorSuccesses = qualityOutcomes.filter(
      (row) => row.evaluator_strict_success === true,
    ).length;
    const successes = qualityOutcomes.filter((row) => row.strict_success === true).length;
    const generated = rows.filter((row) =>
      generationAccepted({ state: row.generation_state, outcome: row.generation_outcome }),
    ).length;
    const candidates = rows.filter((row) =>
      producedCandidate({ state: row.generation_state, artifact_digest: row.artifact_digest }),
    ).length;
    return {
      system_id: systemId,
      planned: rows.length,
      generated,
      candidates,
      evaluated: rows.filter((row) => row.evaluation_status !== null).length,
      quality_outcomes: qualityOutcomes.length,
      evaluator_strict_successes: evaluatorSuccesses,
      strict_successes: successes,
      end_to_end_strict_success_rate: rows.length === 0 ? null : successes / rows.length,
      conditional_strict_success_rate:
        acceptedQualityOutcomes.length === 0 ? null : successes / acceptedQualityOutcomes.length,
      evaluation_coverage:
        candidates === 0
          ? null
          : rows.filter((row) => row.evaluation_status !== null).length / candidates,
      evaluation_infra_failures: rows.filter((row) => row.evaluation_status === "infra_failed")
        .length,
    };
  });

  return { attempts, scores, evaluations: evaluationRows, pairs, systems };
}
