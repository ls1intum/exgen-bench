import {
  type EvaluationResponse,
  evaluationResponseSchema,
} from "../../src/evaluation/contracts.ts";
import type { GenerationObservation } from "../../src/evaluation/summary.ts";

export function generationObservation(
  overrides: Partial<GenerationObservation> & Pick<GenerationObservation, "attempt_id">,
): GenerationObservation {
  return {
    case_id: "case-1",
    system_id: "system-a",
    replicate: 1,
    seed: 1,
    state: "completed",
    outcome: "succeeded",
    error_code: null,
    experiment_id: "experiment",
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    generation_key: "b".repeat(64),
    artifact_digest: "c".repeat(64),
    evidence_digest: "d".repeat(64),
    budget_status: "compliant",
    budget_violations: [],
    budget_missing: [],
    generation_duration_ms: 1000,
    model_calls: null,
    tool_calls: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_amount: null,
    cost_currency: null,
    ...overrides,
  };
}

const terminalOutcome = {
  succeeded: { strict_success: true },
  quality_failed: { strict_success: false, failure_category: "tests.failed" },
  infra_failed: { strict_success: null, failure_category: "evaluator.crashed" },
} as const;

/** Parsed rather than cast, so a fixture that contradicts the response contract fails loudly. */
export function evaluationResponse(
  overrides: Partial<Omit<EvaluationResponse, "candidate">> & {
    candidate?: Partial<EvaluationResponse["candidate"]>;
  } = {},
): EvaluationResponse {
  const { candidate, ...rest } = overrides;
  return evaluationResponseSchema.parse({
    protocol_version: "1",
    evaluation_id: "a".repeat(64),
    evaluator: {
      id: "test-evaluator",
      version: "1.0.0",
      revision: "revision",
      target_profile: "generic",
      implementation_digest: "d".repeat(64),
    },
    suite: { id: "suite", version: "1.0.0", digest: "e".repeat(64) },
    status: "succeeded",
    ...terminalOutcome[rest.status ?? "succeeded"],
    scores: [],
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    duration_ms: 1000,
    ...rest,
    candidate: {
      experiment_id: "experiment",
      attempt_id: "attempt-1",
      generation_key: "b".repeat(64),
      case_id: "case-1",
      system_id: "system-a",
      replicate: 1,
      artifact_digest: "c".repeat(64),
      ...candidate,
    },
  });
}
