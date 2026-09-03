import type { PublicAttempt } from "../contracts.ts";

export type OutcomeTone = "success" | "warning" | "danger" | "muted";

export const OUTCOMES: ReadonlyArray<readonly [PublicAttempt["outcome"], string, OutcomeTone]> = [
  ["accepted", "Strictly accepted", "success"],
  ["budget_unverifiable", "Budget unverifiable", "warning"],
  ["budget_exceeded", "Budget exceeded", "danger"],
  ["quality_failed", "Quality failed", "danger"],
  ["generation_failed", "Generation failed", "danger"],
  ["abstained", "Abstained", "muted"],
  ["infrastructure_failed", "Infrastructure failed", "danger"],
  ["not_started", "Not started", "muted"],
];

export function outcomeLabel(outcome: PublicAttempt["outcome"]): string {
  return OUTCOMES.find(([key]) => key === outcome)?.[1] ?? outcome;
}

export function outcomeTone(outcome: PublicAttempt["outcome"]): OutcomeTone {
  return OUTCOMES.find(([key]) => key === outcome)?.[2] ?? "muted";
}
