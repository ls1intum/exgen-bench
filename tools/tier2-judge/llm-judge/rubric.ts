/**
 * The rubric the Tier 2 judge will score. Declared here so the metric IDs, metric cards and
 * evaluator configuration agree before the judge exists; the dimensions are placeholders until the
 * rubric is fixed together with the instructor expert survey it will be calibrated against.
 */
export const METRIC_VERSION = "1";

export const RUBRIC_METRICS = [
  "judge.statement_clarity",
  "judge.task_solution_alignment",
  "judge.test_adequacy",
  "judge.pedagogical_fit",
  "judge.overall",
] as const;
