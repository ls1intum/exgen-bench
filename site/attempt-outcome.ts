import type { AttemptAnalysisRow } from "../src/export/analysis.ts";

export type PublicAttemptOutcome =
  | "accepted"
  | "quality_failed"
  | "abstained"
  | "generation_failed"
  | "budget_exceeded"
  | "budget_unverifiable"
  | "infrastructure_failed"
  | "not_started";

export interface PublicAttemptClassificationInput {
  generation_state: string;
  generation_outcome: string | null;
  evaluation_status: string | null;
  evaluator_strict_success: boolean | null;
  strict_success: boolean | null;
  generation_budget_status: AttemptAnalysisRow["generation_budget_status"];
}

export function classifyPublicOutcome(
  attempt: PublicAttemptClassificationInput,
): PublicAttemptOutcome {
  if (attempt.generation_state === "planned") {
    return "not_started";
  }
  const generated =
    attempt.generation_state === "completed" && attempt.generation_outcome === "succeeded";
  if (attempt.generation_state === "completed" && attempt.generation_outcome === "abstained") {
    return "abstained";
  }
  if (attempt.generation_outcome === "infra_failed") {
    return "infrastructure_failed";
  }
  if (attempt.generation_state === "completed" && attempt.generation_outcome !== "succeeded") {
    return "generation_failed";
  }
  if (generated && attempt.generation_budget_status === "exceeded") {
    return "budget_exceeded";
  }
  if (generated && attempt.generation_budget_status === "unverifiable") {
    return "budget_unverifiable";
  }
  const evaluatorStrictSuccess = attempt.evaluator_strict_success ?? attempt.strict_success;
  if (
    generated &&
    (attempt.generation_budget_status === "compliant" ||
      attempt.generation_budget_status === "non_binding") &&
    attempt.evaluation_status === "succeeded" &&
    evaluatorStrictSuccess === true
  ) {
    return "accepted";
  }
  if (
    generated &&
    attempt.evaluation_status === "quality_failed" &&
    evaluatorStrictSuccess === false
  ) {
    return "quality_failed";
  }
  return "infrastructure_failed";
}
