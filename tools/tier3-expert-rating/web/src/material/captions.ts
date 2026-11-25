import type { Material } from "../../../shared/instrument.ts";

/** The tab label of each kind of material. */
export const MATERIAL_LABEL: Record<Material, string> = {
  brief: "Brief",
  statement: "Problem statement",
  template: "Template",
  diff: "Solution changes",
  tests: "Tests",
  findings: "Findings",
};

export const STUDY_MATERIAL_LABEL = {
  ...MATERIAL_LABEL,
  brief: "Prompt",
  template: "Starter code",
};

export const STUDY_MATERIAL_CAPTION: Partial<Record<Material, string>> = {
  brief: "What the instructor asked the AI to create.",
  template: "The files students start with.",
  diff: "Changes from the starter code to one sample solution. Other solutions can be correct.",
};

export const STUDY_TEST_COPY = {
  code: "starter code",
  messageSource:
    "Messages come from tests run on the starter code unless a row shows a change made to the sample solution. Some tests are meant to pass on the starter code.",
  changedSolution:
    "This test produced the message below after a deliberate change to the sample solution:",
  changeLabel: "Change made:",
  emptyTitle: "No tests to show",
  emptyDescription: "No test results were recorded for the starter code.",
};

export const STUDY_FINDING_GUIDANCE =
  "A category can show “None reported” even when some checks couldn’t run. The checks cover parts of the code and tests. Use your own judgment about whether the exercise is clear and suitable for the course.";

/** Each kind of material inside a sentence, such as "Part C, which adds the tests". */
export const MATERIAL_NOUN: Record<Material, string> = {
  brief: "the brief",
  statement: "the problem statement",
  template: "the template",
  diff: "the solution changes",
  tests: "the tests",
  findings: "the automatic findings",
};

/**
 * One line above a kind of material that its tab label does not explain on its own: what it is and
 * how to read it. The problem statement needs none, and each part's instruction already explains
 * the tests and the automatic findings.
 */
export const MATERIAL_CAPTION: Partial<Record<Material, string>> = {
  brief: "The instructor's brief, which the AI pipeline received as its input.",
  template: "The files students start from, including the stubs they complete.",
  diff: "What students add or change: the template (−) turned into the sample solution (+).",
};
