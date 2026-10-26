/**
 * The didactical dimensions the Tier 2 judge rates, each a verdict derived from yes/no checklist
 * items, plus the overall readiness level. The judge and the Tier 3 expert answer the same checklist.
 */
export const METRIC_VERSION = "0";

export const RUBRIC_METRICS = [
  "judge.clarity",
  "judge.solvability",
  "judge.objective_alignment",
  "judge.difficulty_fit",
  "judge.scaffolding",
  "judge.feedback_quality",
  "judge.readiness",
] as const;
