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

/**
 * One line above a kind of material that its tab label does not explain on its own: what it is and
 * how to read it. The problem statement needs none, and each part's instruction already explains
 * the tests and the findings.
 */
export const MATERIAL_CAPTION: Partial<Record<Material, string>> = {
  brief:
    "The request the exercise was generated from: topic, target level, course phase, and constraints.",
  template: "The files students start from, including the stubs they complete.",
  diff: "What students add or change: the template (−) turned into the sample solution (+).",
};
