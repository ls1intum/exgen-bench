export type GenerationState =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type BudgetStatus = "compliant" | "exceeded" | "unverifiable" | "non_binding" | null;

interface GenerationFacts {
  state: GenerationState;
  outcome: string | null;
  artifact_digest: string | null;
  budget_status: BudgetStatus;
}

export function producedCandidate(
  generation: Pick<GenerationFacts, "state" | "artifact_digest">,
): boolean {
  return generation.state === "completed" && generation.artifact_digest !== null;
}

export function generationAccepted(
  generation: Pick<GenerationFacts, "state" | "outcome">,
): boolean {
  return generation.state === "completed" && generation.outcome === "succeeded";
}

function withinBudget(status: BudgetStatus): boolean {
  return status === "compliant" || status === "non_binding";
}

/**
 * A candidate retained from a run the system did not accept is scorable evidence, and it is never
 * a strict success.
 */
export function generationSucceeded(
  generation: Pick<GenerationFacts, "state" | "outcome" | "budget_status"> | undefined,
): boolean {
  return (
    generation !== undefined &&
    generationAccepted(generation) &&
    withinBudget(generation.budget_status)
  );
}
